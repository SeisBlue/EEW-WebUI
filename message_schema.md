# Message schemas (recommended)

## 1) Broker message: waves.raw (multipart)
- Part 0: JSON metadata (utf-8)
  {
    "network": "TW",
    "station": "ABCD",
    "location": "01",
    "channel": "HLZ",
    "datatype": "i2",         # TraceBuf2 datatype string
    "nsamp": 100,
    "samprate": 100.0,
    "startt": 1699999999.123, # epoch seconds (double)
    "endt": 1699999999.123,
    "msg_type": 19
  }
- Part 1: binary payload (raw sample bytes) — exactly nsamp * bytes_per_sample (endianness as per datatype)
- Broker supports multipart (NATS publish accepts bytes; you can pack meta + newline + payload or use JetStream single bytes).

## 2) WebSocket frames (from dispatcher -> browser)
- Strategy A (two frames per sample set):
  1) JSON text frame: {"type":"meta","id":"TW.ABCD.01.HLZ","nsamp":100,"datatype":"i2","startt":1699...}
  2) Binary frame: payload bytes
- Strategy B (single binary with small JSON header prefix):
  - 4-byte big-endian header length N, then N bytes JSON metadata, then binary payload.
  - Allows single recv per sample.

## 3) Model trigger topic (model.trigger) — JSON+binary or packed JSON
- Example JSON (single message containing dataset for 25 stations):
  {
    "event_id": "evt_2025....",
    "trigger_time": 1699...,
    "stations": ["STA1","STA2",...],  # 25 stations
    "meta": [{station: "STA1", "nsamp":3000, "samprate":100, "datatype":"i2"}, ...],
    "payloads": [base64(payload1), base64(payload2), ...]  # or multipart binary
  }
- If using JetStream, prefer multipart or pack into binary protobuf to avoid base64.

Notes:
- Prefer binary multipart to avoid base64 overhead.
- Ensure metadata includes datatype & byte ordering for correct decode.