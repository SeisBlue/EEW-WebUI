#!/usr/bin/env python3
"""
Example: read wave / pick / eew messages from Earthworm rings using PyEW,
print metadata / message contents (no Redis). Does NOT modify PyEW.

Behavior:
- Uses EWModule.get_wave(...) for wave messages (message type 19).
- Uses transport.copymsg_type(msg_type) for other message categories (pick, eew).
- Runs one subprocess per (ring, category) to avoid GIL limits and allow parallel reads.
- Prints parsed metadata or decoded text for each received message.

Usage:
  - Edit `earthworm_param` and `MSG_TYPE_MAP` below to match your environment.
  - Run: python3 example_multi_reader.py
  - Ctrl-C to stop.

Notes:
- You MUST supply correct Earthworm message type integers for non-wave categories
  in MSG_TYPE_MAP (pick/eew). Wave messages are typically type 19 and are handled
  by EWModule.get_wave to reuse PyEW's parsing.
- If you don't know the message type for a category, put None in MSG_TYPE_MAP;
  the worker will still fetch raw bytes but will attempt to decode as text.
"""
import time
import argparse
import multiprocessing as mp
import sys
from pprint import pprint
from datetime import datetime
import redis

# ---- Configuration: edit for your environment ----
earthworm_param = {
    "test": {
        "inst_id": 255,
        "wave": {
            "WAVE_RING_CWASN": 1000,
            "WAVE_RING_TSMIP": 1030
        },
        "pick": {"PICK_RING": 1005},
        "eew": {
            "EEW_RING": 1035,
        },
    },
    "jimmy": {
        "inst_id": 255,
        "wave": {"WAVE_RING_TSMIP": 1034},
        "pick": {"PICK_RING": 1005},
        "eew": {},
    },
    "cwa": {
        "inst_id": 52,
        "wave": {"WAVE_RING_TSMIP": 1034},
        "pick": {"PICK_RING": 1005},
        "eew": {},
    },
}

# Map logical category -> Earthworm message type integer.
# Replace values for 'pick' and 'eew' with the correct message type numbers used in your
# Earthworm config. If unknown, set to None to try text decoding.
# <-- put the actual integer type for pick messages, or leave None for text attempt
MSG_TYPE_MAP = {
    "wave": 19,  # standard TRACEBUF/TRACE2
    "pick": 0,
    "eew": 0,

}

redis_config = {
    "host": "localhost",
    "port": 6379,
    "db": 0,
}
# -------------------------------------------------

# Import PyEW classes (must be installed/importable)
from PyEW import EWModule, transport


def pretty_print_wave(result):
    """Print metadata + short data summary from EWModule.get_wave() result dict."""
    meta_keys = ['station', 'network', 'channel', 'location',
                 'nsamp', 'samprate', 'startt', 'endt', 'datatype']
    meta = {k: result.get(k) for k in meta_keys}
    print("=" * 78)
    print("WAVE message received:")
    pprint(meta)
    data = result.get('data', None)
    if data is not None:
        try:
            print("data dtype:", data.dtype, "length:", data.size)
            nprint = min(10, data.size)
            print("first {} samples: {}".format(nprint, data[:nprint].tolist()))
        except Exception as e:
            print("data: could not inspect numpy array:", e)
    print("=" * 78)


def parse_text_message(b):
    """Try to decode a text message, fallback to hex summary."""
    try:
        text = b.decode('utf-8')
        # Trim to reasonable length for printing
        if len(text) > 1000:
            text = text[:1000] + '... (truncated)'
        return ("text", text)
    except Exception:
        # Not valid UTF-8; show length and hex snippet
        return ("binary", f"len={len(b)} hex-prefix={b[:64].hex()}...")


def worker_wave(rname, ringid, modid, instid, poll_delay, redis_cfg):
    """
    Worker that uses EWModule to add a ring and call get_wave (which does the Trace parsing).
    We create a short-lived EWModule for each worker and call add_ring + get_wave.
    This worker also writes the received wave data to a Redis Stream.
    """
    print(f"[wave worker] {rname}={ringid} starting")
    try:
        redis_client = redis.Redis(**redis_cfg)
        redis_client.ping()
        print(f"[wave worker] {rname}={ringid} connected to Redis.")
    except Exception as e:
        print(f"[wave worker] {rname}={ringid} could not connect to Redis: {e}", file=sys.stderr)
        return

    # hb_time arbitrary (heartbeat thread will run); debug False
    module = EWModule(def_ring=1000, mod_id=modid, inst_id=instid, hb_time=15, db=False)
    module.add_ring(ringid)
    buf_index = len(module.ringcom) - 1
    try:
        while True:
            res = module.get_wave(buf_index)
            if res:
                station = res.get('station')
                channel = res.get('channel')

                if station and channel:
                    stream_key = f"wave:{station}:{channel}"
                    
                    # Prepare data for Redis Stream. NumPy array must be converted to bytes.
                    message_payload = {k: v for k, v in res.items() if k != 'data'}
                    if 'data' in res and res['data'] is not None:
                        message_payload['data'] = res['data'].tobytes()

                    # Add to Redis Stream
                    msg_id = redis_client.xadd(stream_key, message_payload)

                    stream_trim_seconds = 120
                    min_id_timestamp = int((time.time() - stream_trim_seconds) * 1000)
                    try:
                        # 使用原生命令確保傳入正確參數：XTRIM <key> MINID ~ <ms>-0
                        redis_client.execute_command('XTRIM', stream_key, 'MINID', '~',
                                                     f'{min_id_timestamp}-0')
                    except Exception as e:
                        print(f"[wave worker] {rname}={ringid} xtrim failed: {e}",
                              file=sys.stderr)
            else:
                time.sleep(poll_delay)
    except KeyboardInterrupt:
        pass
    finally:
        # Attempt safe detach
        try:
            module.OK = False
            module.default_ring.detach()
        except Exception:
            pass
        for r in getattr(module, "ringcom", []):
            try:
                r.detach()
            except Exception:
                pass
        print(f"[wave worker] {rname}={ringid} stopped")


def worker_text_or_binary(rname, ringid, modid, instid, msg_type, poll_delay,
                          category):
    """
    Worker for message categories other than wave. Uses transport.copymsg_type(msg_type)
    if msg_type is provided. If msg_type is None, will attempt to call copymsg_type with
    0..255 to try catching text messages, but normally you should provide the correct msg_type.
    """
    print(
        f"[{category} worker] {rname}={ringid} msg_type={msg_type} starting")
    t = transport(ringid, modid, instid)
    t.flush()
    try:
        while True:
            if msg_type is not None:
                msg = t.copymsg_type(msg_type)
            else:
                # If no msg_type known, try a generic approach: try copying any msg (type=0 in req),
                # then filter by instid if needed. Here we just call copymsg_type(0) to get something
                # that the ring returns (this may not return the desired messages in some configs).
                msg = t.copymsg_type(0)
            if msg != (0, 0):
                # msg is (status, rlen, realmsg) per PyEW.copymsg_type
                status, rlen, realmsg = msg
                if rlen <= 0:
                    continue
                payload = realmsg[:rlen]
                kind, body = parse_text_message(payload)
                print(
                    f"{category.upper()} message from {rname} {ringid} (status={status}, rlen={rlen}, kind={kind}):")
                print(body)
            else:
                time.sleep(poll_delay)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            t.detach()
        except Exception:
            pass
        print(f"[{category} worker] {rname}={ringid} stopped")


def start_workers_for_profile(profile_name, profile_cfg, msg_type_map,
                              poll_delay=0.001):
    """
    Start processes for all rings defined in a profile. Returns list of Process objects.
    profile_cfg is expected to have:
      - inst_id
      - wave: dict of {name: ringid}
      - pick: dict of {name: ringid}
      - eew: dict of {name: ringid}
    """
    procs = []
    inst_id = profile_cfg.get("inst_id", 255)
    mod_id = 2  # configurable fallback; adjust if you need a different mod id

    # waves: for each ring defined, spawn worker_wave
    for rname, ringid in profile_cfg.get("wave", {}).items():
        p = mp.Process(target=worker_wave,
                       args=(profile_name, ringid, mod_id, inst_id, poll_delay, redis_config))
        p.daemon = True
        p.start()
        procs.append(p)

    # picks
    for rname, ringid in profile_cfg.get("pick", {}).items():
        p = mp.Process(target=worker_text_or_binary,
                       args=(profile_name, ringid, mod_id, inst_id,
                             msg_type_map.get("pick"), poll_delay, "pick"))
        p.daemon = True
        p.start()
        procs.append(p)

    # eew
    for rname, ringid in profile_cfg.get("eew", {}).items():
        p = mp.Process(target=worker_text_or_binary,
                       args=(rname, ringid, mod_id, inst_id,
                             msg_type_map.get("eew"), poll_delay, "eew"))
        p.daemon = True
        p.start()
        procs.append(p)

    return procs


def main(profiles_to_run=None, poll_delay=0.001):
    """
    Launch workers for requested profiles (keys in earthworm_param).
    If profiles_to_run is None, launch for all profiles in earthworm_param.
    """
    if profiles_to_run is None:
        profiles_to_run = list(earthworm_param.keys())

    all_procs = []
    for prof in profiles_to_run:
        cfg = earthworm_param.get(prof)
        if not cfg:
            print(f"No configuration for profile '{prof}', skipping.")
            continue
        procs = start_workers_for_profile(prof, cfg, MSG_TYPE_MAP,
                                          poll_delay=poll_delay)
        all_procs.extend(procs)

    print("All workers started. Press Ctrl-C to stop.")
    try:
        while True:
            alive = any(p.is_alive() for p in all_procs)
            if not alive:
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print("Shutdown requested, terminating workers...")
    finally:
        for p in all_procs:
            try:
                p.terminate()
            except Exception:
                pass
        for p in all_procs:
            p.join(timeout=1)
        print("All workers stopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Multi-category PyEW ring reader (print-only).")
    parser.add_argument("--env", "-e", nargs="+",
                        help="Which profiles to run (from earthworm_param).")
    parser.add_argument("--delay", "-d", type=float, default=0.001,
                        help="Poll delay when no message (s).")
    args = parser.parse_args()

    # If you want to only run certain profiles: python example_multi_reader.py -p test jimmy
    main(profiles_to_run=args.env, poll_delay=args.delay)
