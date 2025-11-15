#!/usr/bin/env python3
"""
Reader stub: simulates multiple stations and publishes raw waveform to Redis Stream 'waves'.
Each stream entry has fields:
  - meta: JSON metadata (utf-8)
  - payload: binary bytes (raw int16 samples)
"""
import asyncio
import json
import os
import random
import time
from math import sin, pi

import numpy as np
import redis.asyncio as redis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
STREAM_KEY = os.getenv("STREAM_KEY", "waves")
NUM_STATIONS = int(os.getenv("NUM_STATIONS", "100"))  # PoC default; scale as needed
SR = int(os.getenv("SAMPLE_RATE", "100"))  # samples per second
WINDOW_SEC = int(os.getenv("WINDOW_SEC", "30"))
NSAMP_PER_PKT = int(os.getenv("NSAMP_PER_PKT", "100"))  # samples per packet
DTYPE = np.int16  # i2
BYTES_PER_SAMPLE = 2

async def produce():
    r = redis.from_url(REDIS_URL)
    station_ids = [f"STA{str(i).zfill(4)}" for i in range(NUM_STATIONS)]
    phases = {s: random.random() * 2 * pi for s in station_ids}
    t = 0.0
    while True:
        start_time = time.time()
        for sta in station_ids:
            # generate a short packet of NSAMP_PER_PKT samples
            f = 1.0 + (hash(sta) % 5)  # different freq per station
            phase = phases[sta]
            samples = np.array(
                [int(1000 * sin(2 * pi * f * (t + i / SR) + phase) + random.gauss(0, 50))
                 for i in range(NSAMP_PER_PKT)],
                dtype=DTYPE
            )
            meta = {
                "network": "XX",
                "station": sta,
                "location": "01",
                "channel": "HLZ",
                "datatype": "i2",
                "nsamp": int(NSAMP_PER_PKT),
                "samprate": SR,
                "startt": t,
                "endt": t + (NSAMP_PER_PKT - 1) / SR,
                "msg_type": 19
            }
            # add to redis stream: fields meta (json bytes) and payload (binary)
            await r.xadd(STREAM_KEY, {"meta": json.dumps(meta).encode("utf-8"), "payload": samples.tobytes()})
            t += NSAMP_PER_PKT / SR
        # throttle: produce roughly NUM_STATIONS * NSAMP_PER_PKT / SR packets per second
        elapsed = time.time() - start_time
        await asyncio.sleep(max(0.0, max(0.01, (NSAMP_PER_PKT / SR) - elapsed)))

if __name__ == "__main__":
    asyncio.run(produce())