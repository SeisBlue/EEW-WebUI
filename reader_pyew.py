#!/usr/bin/env python3
"""
reader_pyew.py

A Redis-stream publisher using PyEW to read Earthworm rings and publish
waveform packets to Redis Stream (same format as reader_stub).

Environment variables:
  REDIS_URL  - redis connection string (default redis://localhost:6379/0)
  STREAM_KEY - redis stream key to xadd to (default 'waves')
  EW_DEF_RING - default ring for EWModule constructor (default 1000)
  EW_MOD - module id for messages (default 2)
  EW_INST - instance id for EWModule (default 1)
  EW_RINGS - comma separated list of ring ids to add and read from (e.g. "1034,1000")
  POLL_SLEEP - fallback sleep when no message (seconds, default 0.005)
"""
import os
import time
import json
import logging
from typing import List

import numpy as np
import redis.asyncio as redis

# Try import PyEW (must be installed in the environment)
try:
    import PyEW
except Exception as e:
    raise RuntimeError("Cannot import PyEW. Make sure PyEW is installed and importable.") from e

# Logging
logging.basicConfig(level=os.getenv("LOGLEVEL", "INFO"))
logger = logging.getLogger("reader_pyew")

# Config from env
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
STREAM_KEY = os.getenv("STREAM_KEY", "waves")
EW_DEF_RING = int(os.getenv("EW_DEF_RING", "1000"))
EW_MOD = int(os.getenv("EW_MOD", "2"))
EW_INST = int(os.getenv("EW_INST", "1"))
EW_RINGS = os.getenv("EW_RINGS", "")  # e.g. "1034,1000"
POLL_SLEEP = float(os.getenv("POLL_SLEEP", "0.005"))

# Parse ring ids
def parse_ring_list(s: str) -> List[int]:
    if not s:
        return []
    parts = [p.strip() for p in s.split(",") if p.strip()]
    ids = []
    for p in parts:
        try:
            ids.append(int(p))
        except ValueError:
            logger.warning("Invalid ring id in EW_RINGS: %s", p)
    return ids

RING_IDS = parse_ring_list(EW_RINGS)

# Redis client
r = redis.from_url(REDIS_URL)

def _dtype_and_bytes_for_datatype(dt: str):
    """
    Map PyEW/Trace datatype string to numpy dtype and bytes-per-sample.
    Typical TraceBuf2 datatypes: 'i2','i4','i8','f4','f8','s4','t4','t8'
    We will support common ones.
    """
    if dt in ("i2", "s2"):
        return np.int16, 2
    if dt in ("i4", "s4"):
        return np.int32, 4
    if dt == "f4" or dt == "t4":
        return np.float32, 4
    if dt == "f8" or dt == "t8":
        return np.float64, 8
    # default fallback
    return np.int16, 2

async def publish_wave_to_redis(meta: dict, payload: bytes):
    """
    Add to Redis Stream with fields 'meta' (json bytes) and 'payload' (raw bytes).
    """
    try:
        await r.xadd(STREAM_KEY, {"meta": json.dumps(meta).encode("utf-8"), "payload": payload})
    except Exception as e:
        logger.exception("Failed to xadd to redis: %s", e)

def build_meta_from_wave(wave: dict):
    """
    Construct a small metadata dict describing the trace payload.
    wave is expected to be the dict returned by EWModule.get_wave(...)
    """
    meta = {
        "network": wave.get("network", ""),
        "station": wave.get("station", ""),
        "location": wave.get("location", ""),
        "channel": wave.get("channel", ""),
        "nsamp": int(wave.get("nsamp", 0)),
        "samprate": float(wave.get("samprate", 100.0)),
        "startt": float(wave.get("startt", 0.0)),
        "endt": float(wave.get("endt", 0.0)),
        "datatype": wave.get("datatype", "i2"),
        "msg_type": 19,
    }
    return meta

async def main():
    # instantiate EWModule
    logger.info("Creating EWModule def_ring=%s mod=%s inst=%s", EW_DEF_RING, EW_MOD, EW_INST)
    ew = PyEW.EWModule(EW_DEF_RING, EW_MOD, EW_INST, hb_time=30, db=False)

    # add rings if specified
    if RING_IDS:
        for rid in RING_IDS:
            logger.info("Adding ring id %s", rid)
            ew.add_ring(rid)
    else:
        logger.warning("No EW_RINGS specified. EWModule will still be attached to def_ring but no additional rings added.")

    # Determine number of ring buffers available
    num_rings = len(ew.ringcom)
    if num_rings == 0:
        logger.warning("No rings in ew.ringcom. If you expect rings, check EW_RINGS env.")
    else:
        logger.info("reader_pyew will poll %d ring buffer(s) (indices 0..%d)", num_rings, num_rings - 1)

    # round-robin over configured ring buffers; call ew.get_wave(buf_ring) (blocking style loop)
    # Note: EWModule.get_wave returns parsed dict (or {} if nothing)
    import asyncio
    ring_idx = 0
    while True:
        try:
            if num_rings == 0:
                # attempt to fallback to default ringcom[0] if present
                try:
                    wave = ew.get_wave(0)
                except Exception:
                    wave = {}
            else:
                wave = ew.get_wave(ring_idx)
                ring_idx = (ring_idx + 1) % num_rings

            if not wave:
                # no message
                await asyncio.sleep(POLL_SLEEP)
                continue

            # wave is a dict with keys including 'data' (numpy array), 'datatype', etc.
            dtype_name = wave.get("datatype", "i2")
            npdtype, bps = _dtype_and_bytes_for_datatype(dtype_name)

            data = wave.get("data", None)
            if data is None:
                logger.debug("Got wave with no data, skipping")
                continue

            # Ensure numpy array dtype matches expected type for consistent bytes
            try:
                # If data is numpy array but dtype differs, convert without changing semantics if possible
                if isinstance(data, np.ndarray) and data.dtype != npdtype:
                    payload_arr = data.astype(npdtype, copy=False)
                else:
                    payload_arr = np.array(data, dtype=npdtype, copy=False)
            except Exception:
                # fallback: create copy coerced to dtype
                payload_arr = np.array(data, dtype=npdtype, copy=True)

            payload_bytes = payload_arr.tobytes()
            meta = build_meta_from_wave(wave)
            # add a local timestamp for when published
            meta["pub_time"] = time.time()

            # Publish to Redis
            await publish_wave_to_redis(meta, payload_bytes)
            logger.debug("Published wave %s %s samples", meta.get("station"), meta.get("nsamp"))

        except KeyboardInterrupt:
            logger.info("Interrupted, exiting")
            break
        except Exception as e:
            logger.exception("Unhandled exception in reader loop: %s", e)
            await asyncio.sleep(0.1)

if __name__ == "__main__":
    import asyncio
    try:
        asyncio.run(main())
    except Exception as e:
        logger.exception("reader_pyew failed: %s", e)