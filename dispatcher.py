#!/usr/bin/env python3
"""
Dispatcher:
 - subscribes to Redis stream 'waves' (XREAD loop),
 - maintains per-station circular buffer (30s by default),
 - exposes FastAPI WebSocket endpoint for frontends to subscribe to stations,
 - provides REST endpoint to fetch last 30s window for a station,
 - forwards binary payload + small meta to subscribed clients (binary frames).
"""
import asyncio
import json
import os
import signal
import time
from collections import defaultdict
from typing import Dict, Set

import numpy as np
import redis.asyncio as redis
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from starlette.middleware.cors import CORSMiddleware

# Config
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
STREAM_KEY = os.getenv("STREAM_KEY", "waves")
WINDOW_SEC = int(os.getenv("WINDOW_SEC", "30"))
SR = int(os.getenv("SAMPLE_RATE", "100"))
NSAMPLE = WINDOW_SEC * SR
DTYPE = np.int16  # matches reader
BYTES_PER_SAMPLE = 2

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Redis client
r = redis.from_url(REDIS_URL)

# In-memory buffers
buffers: Dict[str, np.ndarray] = {}        # station -> numpy array shape=(NSAMPLE,)
write_idx: Dict[str, int] = {}            # station -> next write position (int)
locks: Dict[str, asyncio.Lock] = {}       # station -> asyncio.Lock for safe writes

# WebSocket subscription management
clients_for_station: Dict[str, Set[WebSocket]] = defaultdict(set)
stations_for_client: Dict[WebSocket, Set[str]] = defaultdict(set)

# Simple metrics
metrics = {
    "messages_received": 0,
    "forwards": 0,
    "buffers_count": 0
}

async def ensure_station_buffer(station: str):
    if station not in buffers:
        buffers[station] = np.zeros(NSAMPLE, dtype=DTYPE)
        write_idx[station] = 0
        locks[station] = asyncio.Lock()
        metrics["buffers_count"] = len(buffers)

async def circular_write(station: str, arr: np.ndarray):
    await ensure_station_buffer(station)
    async with locks[station]:
        idx = write_idx[station]
        n = arr.size
        if n >= NSAMPLE:
            # if incoming chunk larger than window, keep only last NSAMPLE
            buffers[station][:] = arr[-NSAMPLE:]
            write_idx[station] = 0
            return
        end = (idx + n) % NSAMPLE
        if idx + n <= NSAMPLE:
            buffers[station][idx:idx + n] = arr
        else:
            a = NSAMPLE - idx
            buffers[station][idx:] = arr[:a]
            buffers[station][:end] = arr[a:]
        write_idx[station] = end

def assemble_last_window(station: str) -> np.ndarray:
    """Return a contiguous copy of last NSAMPLE samples for station"""
    if station not in buffers:
        return np.zeros(NSAMPLE, dtype=DTYPE)
    idx = write_idx.get(station, 0)
    buf = buffers[station]
    if idx == 0:
        return buf.copy()
    else:
        # last window is buf[idx:] + buf[:idx]
        return np.concatenate((buf[idx:], buf[:idx])).copy()

async def redis_reader_loop():
    """Simple XREAD loop: maintain last_id and block for new entries."""
    last_id = "0-0"  # start from earliest for PoC; in production use consumer group
    while True:
        try:
            # XREAD block for 1000 ms for new entries
            res = await r.xread({STREAM_KEY: last_id}, block=1000, count=100)
            if not res:
                continue
            # res is list of (stream_name, [(id, {field: value}), ...])
            for stream_name, entries in res:
                for entry_id, fields in entries:
                    last_id = entry_id
                    metrics["messages_received"] += 1
                    meta_b = fields.get(b"meta") or fields.get("meta")
                    payload_b = fields.get(b"payload") or fields.get("payload")
                    try:
                        meta = json.loads(meta_b.decode("utf-8"))
                    except Exception:
                        continue
                    station = meta.get("station")
                    if not station:
                        continue
                    # convert payload to numpy (assume int16)
                    arr = np.frombuffer(payload_b, dtype=DTYPE).copy()
                    # write to circular buffer
                    await circular_write(station, arr)
                    # forward to any subscribed clients
                    subs = clients_for_station.get(station)
                    if subs:
                        # send small meta JSON and binary payload
                        meta_ws = {
                            "type": "meta",
                            "station": station,
                            "nsamp": int(meta.get("nsamp", arr.size)),
                            "samprate": meta.get("samprate", SR),
                            "startt": meta.get("startt"),
                            "endt": meta.get("endt"),
                            "datatype": meta.get("datatype", "i2"),
                        }
                        # broadcast
                        dead = []
                        for ws in list(subs):
                            try:
                                await ws.send_json(meta_ws)
                                await ws.send_bytes(payload_b)
                                metrics["forwards"] += 1
                            except Exception:
                                dead.append(ws)
                        for d in dead:
                            subs.discard(d)
        except Exception as e:
            print("redis_reader_loop error:", e)
            await asyncio.sleep(0.1)

@app.on_event("startup")
async def startup_event():
    # start redis reader background task
    asyncio.create_task(redis_reader_loop())

@app.get("/api/station_window/{station}")
async def get_station_window(station: str):
    """Return last 30s window as bytes (binary) with JSON metadata first"""
    arr = assemble_last_window(station)
    meta = {"station": station, "nsamp": NSAMPLE, "samprate": SR, "datatype": "i2"}
    # return JSON meta with base64? For simplicity deliver as JSON + binary in multipart is not possible in HTTP easily.
    # So return JSON object with raw samples as list (not ideal for large), but provide a binary endpoint below.
    return JSONResponse({"meta": meta, "samples": arr.tolist()})

@app.get("/api/station_window_bin/{station}")
async def get_station_window_bin(station: str):
    """Return binary payload only (raw int16 bytes)"""
    arr = assemble_last_window(station)
    return bytes(arr.tobytes())

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    client_subs = set()
    try:
        while True:
            data = await ws.receive_text()
            # expect JSON command
            try:
                cmd = json.loads(data)
            except Exception:
                continue
            action = cmd.get("action")
            if action == "subscribe":
                station = cmd.get("station")
                if not station:
                    continue
                clients_for_station[station].add(ws)
                client_subs.add(station)
            elif action == "unsubscribe":
                station = cmd.get("station")
                if station and ws in clients_for_station.get(station, set()):
                    clients_for_station[station].discard(ws)
                    client_subs.discard(station)
            elif action == "fetch_window":
                station = cmd.get("station")
                arr = assemble_last_window(station)
                # send meta then binary
                meta_ws = {"type": "window_meta", "station": station, "nsamp": NSAMPLE, "samprate": SR, "datatype": "i2"}
                await ws.send_json(meta_ws)
                await ws.send_bytes(arr.tobytes())
    except WebSocketDisconnect:
        # cleanup subscriptions
        for sta in client_subs:
            clients_for_station.get(sta, set()).discard(ws)
    except Exception as e:
        print("websocket error:", e)
        for sta in client_subs:
            clients_for_station.get(sta, set()).discard(ws)

@app.get("/api/metrics")
async def get_metrics():
    return metrics

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("dispatcher:app", host="0.0.0.0", port=8000, log_level="info")