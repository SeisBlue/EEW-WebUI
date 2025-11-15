# Minimal fast, raw-bytes pipeline from PyEW -> WebSocket
import asyncio
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

# 如果你使用的是 PyEW 套件名稱不同，請改為正確匯入
try:
    from PyEW import EWModule
    HAVE_PYEW = True
except Exception as e:
    HAVE_PYEW = False
    print("PyEW import failed:", e)

logger = logging.getLogger("pyew-proxy")
logger.setLevel(logging.INFO)
handler = logging.StreamHandler()
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logger.addHandler(handler)

app = FastAPI()

# Configuration - 調整成你的環境
EW_RING = int(os.getenv("EW_RING", "1234"))
EW_MOD = int(os.getenv("EW_MOD", "100"))
EW_INST = int(os.getenv("EW_INST", "1"))
HB = int(os.getenv("EW_HB", "5"))
TRACE_MSG_TYPE = int(os.getenv("TRACE_MSG_TYPE", "19"))  # 通常 wave = 19
QUEUE_MAXSIZE = int(os.getenv("QUEUE_MAXSIZE", "2000"))  # 控制 backpressure
BROADCAST_BATCH_DELAY = float(os.getenv("BROADCAST_BATCH_DELAY", "0.0"))  # optional small sleep

# Globals
ew: Optional[EWModule] = None
executor = ThreadPoolExecutor(max_workers=1)  # 1 thread for blocking reader
loop = asyncio.get_event_loop()

class ConnectionManager:
    def __init__(self):
        self._conns: set[WebSocket] = set()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self._conns.add(ws)
        logger.info("Client connected, total=%d", len(self._conns))

    def disconnect(self, ws: WebSocket):
        self._conns.discard(ws)
        logger.info("Client disconnected, total=%d", len(self._conns))

    async def broadcast_bytes(self, payload: bytes):
        if not self._conns:
            return
        dead = []
        for ws in list(self._conns):
            try:
                # send_bytes 傳送 binary frame；這裡不做任何編碼或轉換
                await ws.send_bytes(payload)
            except Exception:
                dead.append(ws)
        for d in dead:
            self._conns.discard(d)

manager = ConnectionManager()

# Stats
stats = {
    "reads": 0,
    "drops_queue_full": 0,
    "msgs_sent": 0,
    "get_miss": 0,
}

# Bounded queue between blocking reader and asyncio broadcaster
message_queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)

# Blocking reader running in its own native thread
def blocking_reader(loop, queue: asyncio.Queue, stop_event: "threading.Event"):
    """
    Runs in background thread. Calls PyEW blocking read (copymsg_type / get_bytes).
    Puts raw bytes slices into asyncio queue via loop.call_soon_threadsafe(queue.put_nowait, payload).
    """
    global ew, stats
    logger.info("Blocking reader started")
    # slight safety sleep
    import time
    while not stop_event.is_set():
        try:
            # Use EWModule API. Depending on your PyEW version, adjust the call:
            # The original PyEW.copymsg_type returns (status, rlen, realmsg) or (0,0)
            # If you used a wrapper port, adapt accordingly.
            if ew is None:
                time.sleep(0.1)
                continue

            msg = None
            try:
                # Prefer a lower-level call that returns raw bytes with length
                # Try common wrappers:
                msg = ew.ringcom[0].copymsg_type(TRACE_MSG_TYPE)
            except Exception:
                # fallback to EWModule.get_bytes wrapper if exists
                try:
                    msg = ew.get_bytes(0, TRACE_MSG_TYPE)
                except Exception:
                    msg = (0, 0)

            # Normalize result
            raw_bytes = None
            rlen = 0
            status = None
            if isinstance(msg, tuple) and len(msg) >= 3:
                status = msg[0]
                rlen = msg[1]
                raw = msg[2]
                # raw may be bytes-like; slice to rlen
                try:
                    raw_bytes = raw[:rlen]
                except Exception:
                    # if raw is bytes and rlen > len(raw) guard
                    raw_bytes = bytes(raw)
                # track GET_MISS-like statuses (non-zero statuses)
                if status != 0:
                    stats["get_miss"] += 1
            elif isinstance(msg, tuple) and len(msg) == 2:
                # maybe (rlen, realmsg)
                rlen = msg[0]
                raw = msg[1]
                raw_bytes = raw[:rlen]
            elif isinstance(msg, bytes) and len(msg) > 0:
                raw_bytes = msg
            else:
                # no message
                raw_bytes = None

            if raw_bytes:
                stats["reads"] += 1
                try:
                    # put into asyncio queue without blocking; if full, drop and count
                    loop.call_soon_threadsafe(_queue_put_nowait_safe, queue, raw_bytes)
                except Exception:
                    # ensure we don't crash the thread
                    logger.exception("Failed to schedule queue put")
            else:
                # no data - small sleep to avoid busy loop
                time.sleep(0.001)
        except Exception:
            logger.exception("Exception in blocking reader loop")
            time.sleep(0.01)
    logger.info("Blocking reader stopping")

def _queue_put_nowait_safe(q: asyncio.Queue, payload: bytes):
    """Called in loop thread via call_soon_threadsafe to do a non-blocking put."""
    global stats
    try:
        q.put_nowait(payload)
    except asyncio.QueueFull:
        # drop policy: drop the incoming (new) message; increment counter
        stats["drops_queue_full"] += 1

async def broadcaster_task():
    """Async consumer that broadcasts messages from queue to all connected websockets."""
    global stats
    logger.info("Broadcaster started")
    while True:
        payload = await message_queue.get()
        try:
            # Optionally small await to batch multiple sends or yield
            if BROADCAST_BATCH_DELAY:
                await asyncio.sleep(BROADCAST_BATCH_DELAY)
            # broadcast to all ws clients
            await manager.broadcast_bytes(payload)
            stats["msgs_sent"] += 1
        except Exception:
            logger.exception("broadcast failed")
        finally:
            message_queue.task_done()

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            # keep connection alive and optionally handle control messages
            data = await ws.receive_text()
            # simple protocol: client can ask for stats
            if data == "stats":
                await ws.send_json({"stats": stats})
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)
        logger.exception("websocket error")

@app.on_event("startup")
async def startup_event():
    global ew, loop, executor
    # create EWModule
    if HAVE_PYEW:
        try:
            ew = EWModule(EW_RING, EW_MOD, EW_INST, HB, db=False)
        except Exception:
            logger.exception("Failed to instantiate EWModule")
            ew = None
    else:
        logger.warning("PyEW not available; proxy cannot read ring")

    # start broadcaster
    asyncio.create_task(broadcaster_task())

    # start blocking reader in executor as long-running thread
    import threading
    stop_event = threading.Event()
    # store stop_event so we can later set it if needed
    app.state._reader_stop = stop_event
    executor.submit(blocking_reader, loop, message_queue, stop_event)
    logger.info("Startup complete")

@app.on_event("shutdown")
async def shutdown_event():
    # stop blocking reader
    stop_event = getattr(app.state, "_reader_stop", None)
    if stop_event is not None:
        stop_event.set()
    executor.shutdown(wait=False)
    logger.info("Shutdown complete")

if __name__ == "__main__":
    # uvicorn with one worker recommended for shared memory attachments
    uvicorn.run("proxy:app", host="0.0.0.0", port=8000, workers=1)