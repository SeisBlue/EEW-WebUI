#!/usr/bin/env python3
"""
Reader bridge: PyEW -> Redis Streams (async).

Behavior:
- attach PyEW.EWModule
- round-robin copymsg_type / get_wave to obtain raw bytes (prefer copymsg_type if available)
- push minimal (meta, payload) into an asyncio.Queue (bounded)
- background coroutine consumes the queue and writes to Redis Stream using xadd,
  with optional batching/pipelining.

Notes:
- Requires PyEW importable in this Python environment.
- Redis must be reachable (same host recommended).
"""
import os
import asyncio
import json
import time
import logging
from typing import Tuple

import numpy as np
import redis

try:
    import PyEW
except Exception as e:
    raise RuntimeError("PyEW import failed; ensure PyEW is installed and Earthworm headers available") from e

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
STREAM_KEY = os.getenv("STREAM_KEY", "waves")
QUEUE_MAXSIZE = int(os.getenv("QUEUE_MAXSIZE", "5000"))
BATCH_MAX = int(os.getenv("BATCH_MAX", "50"))
BATCH_TIMEOUT = float(os.getenv("BATCH_TIMEOUT", "0.05"))
EW_DEF_RING = int(os.getenv("EW_DEF_RING", "1000"))
EW_MOD = int(os.getenv("EW_MOD", "2"))
EW_INST = int(os.getenv("EW_INST", "255"))
EW_RINGS = os.getenv("EW_RINGS", "1000, 1030, 1005, 1035")  # e.g. "1034,1000"

LOGLEVEL = os.getenv("LOGLEVEL", "INFO")
logging.basicConfig(level=LOGLEVEL)
logger = logging.getLogger("reader_pyew_redis")

# Helper
def parse_ring_list(s: str):
    return [int(p) for p in s.split(",") if p.strip()] if s else []

RING_IDS = parse_ring_list(EW_RINGS)

# Map trace datatype to numpy dtype
DTYPE_MAP = {"i2": np.int16, "s2": np.int16, "i4": np.int32, "s4": np.int32,
             "f4": np.float32, "f8": np.float64, "t4": np.float32, "t8": np.float64}

async def redis_writer(queue: asyncio.Queue):
    r = aioredis.from_url(REDIS_URL)
    batch = []
    last_flush = time.time()
    while True:
        try:
            item = None
            try:
                item = await asyncio.wait_for(queue.get(), timeout=BATCH_TIMEOUT)
            except asyncio.TimeoutError:
                pass

            if item:
                batch.append(item)

            # flush if batch too big or timeout
            if batch and (len(batch) >= BATCH_MAX or (time.time() - last_flush) >= BATCH_TIMEOUT):
                # Use pipeline to send multiple xadd in one round-trip
                async with r.pipeline() as pipe:
                    for meta, payload in batch:
                        # fields: meta (json bytes), payload (raw bytes)
                        pipe.xadd(STREAM_KEY, {"meta": json.dumps(meta).encode("utf-8"), "payload": payload})
                    await pipe.execute()
                logger.debug("Flushed %d messages to Redis", len(batch))
                batch.clear()
                last_flush = time.time()
        except Exception as e:
            logger.exception("redis_writer error: %s", e)
            # backoff on redis errors
            await asyncio.sleep(0.5)

async def main():
    ew = PyEW.EWModule(EW_DEF_RING, EW_MOD, EW_INST, hb_time=30, db=False)
    # add rings listed in EW_RINGS
    for rid in RING_IDS:
        ew.add_ring(rid)

    # build asyncio queue
    queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
    # start redis writer
    writer_task = asyncio.create_task(redis_writer(queue))

    # choose method: prefer copymsg_type if available (gives status, rlen, realmsg)
    # fallback to get_wave wrapper if your PyEW exposes it.
    ring_idx = 0
    num_rings = len(ew.ringcom) if hasattr(ew, "ringcom") else 0
    logger.info("Starting read loop, rings=%d", num_rings)

    try:
        while True:
            try:
                if num_rings > 0:
                    # use copymsg_type if PyEW exposes ringcom objects and copymsg_type
                    try:
                        msg = ew.ringcom[ring_idx].copymsg_type(19)  # 19 = trace
                    except Exception:
                        # fallback to ew.get_wave(buf_ring)
                        msg = ew.get_wave(ring_idx)
                    ring_idx = (ring_idx + 1) % max(1, num_rings)
                else:
                    msg = ew.get_wave(0)

                if not msg or msg == (0, 0):
                    await asyncio.sleep(0.001)
                    continue

                # normalize msg types from different PyEW wrappers:
                # case A: (status, rlen, realmsg)
                # case B: (rlen, realmsg)
                # case C: dict from get_wave
                meta = {}
                payload_bytes = b""
                status = None

                if isinstance(msg, tuple):
                    if len(msg) == 3:
                        status, rlen, realmsg = msg
                        payload_bytes = bytes(realmsg[:rlen])
                    elif len(msg) == 2:
                        rlen, realmsg = msg
                        payload_bytes = bytes(realmsg[:rlen])
                elif isinstance(msg, dict):
                    # expected keys: 'data', 'datatype', 'nsamp', 'startt', 'endt', 'station', ...
                    dtype = msg.get("datatype", "i2")
                    npdtype = DTYPE_MAP.get(dtype, np.int16)
                    data = msg.get("data")
                    # ensure numpy array
                    if isinstance(data, np.ndarray):
                        arr = data.astype(npdtype, copy=False)
                    else:
                        arr = np.array(data, dtype=npdtype, copy=True)
                    payload_bytes = arr.tobytes()
                    meta = {
                        "network": msg.get("network", ""),
                        "station": msg.get("station", ""),
                        "location": msg.get("location", ""),
                        "channel": msg.get("channel", ""),
                        "datatype": dtype,
                        "nsamp": int(msg.get("nsamp", arr.size)),
                        "samprate": float(msg.get("samprate", 100.0)),
                        "startt": float(msg.get("startt", 0.0)),
                        "endt": float(msg.get("endt", 0.0)),
                        "pub_time": time.time()
                    }
                else:
                    # unknown format — try to be robust
                    logger.debug("Unknown msg type from PyEW: %s", type(msg))
                    continue

                # If metadata empty, try to fill minimal meta
                if not meta:
                    meta = {"datatype": "i2", "nsamp": len(payload_bytes) // 2, "pub_time": time.time()}

                # push into queue (non-blocking with drop policy to avoid blocking reader)
                try:
                    queue.put_nowait((meta, payload_bytes))
                except asyncio.QueueFull:
                    # drop policy: drop this message (or you could pop oldest and push)
                    logger.warning("Queue full, dropping message for station %s", meta.get("station"))
                    # increment a metric or alert as needed

            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.exception("reader loop error: %s", e)
                await asyncio.sleep(0.01)
    finally:
        writer_task.cancel()
        await asyncio.sleep(0.1)

if __name__ == "__main__":
    asyncio.run(main())