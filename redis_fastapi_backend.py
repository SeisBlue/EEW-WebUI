import asyncio
import time
import argparse
import os
from typing import List, Set, Dict
import redis.asyncio as redis
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from loguru import logger
import uvicorn
import pandas as pd
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
import json

# --- Redis 和 FastAPI 配置 ---
REDIS_CONFIG = {
    "host": os.getenv("REDIS_HOST", "localhost"),
    "port": 6379,
    "db": 0,
}

app = FastAPI()
background_tasks = set()

# --- WebSocket 連線管理器 ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.subscribed_stations: Dict[WebSocket, Set[str]] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.subscribed_stations[websocket] = set()
        logger.info(f"Client {websocket.client.host} connected")
        # 通知前端連線已建立，可以開始訂閱
        await websocket.send_json({"event": "connect_init"})

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        if websocket in self.subscribed_stations:
            del self.subscribed_stations[websocket]
        logger.info(f"Client {websocket.client.host} disconnected")

    def subscribe(self, websocket: WebSocket, stations: List[str]):
        """處理來自客戶端的測站訂閱請求"""
        if stations:
            # 前端傳來的可能是 'TWQ1' 或 'A024' 這種簡碼
            self.subscribed_stations[websocket] = set(stations)
            # logger.info(
            #     f"Client {websocket.client.host} subscribed to {len(stations)} stations: {list(stations)[:5]}..."
            # )
        else:
            self.subscribed_stations[websocket] = set()
            # logger.info(f"Client {websocket.client.host} unsubscribed from all stations")

    async def send_wave_packet(self, wave_packet: dict):
        """將波形資料包傳送給已訂閱的客戶端"""
        wave_batch = wave_packet.get("data", {})
        if not wave_batch:
            return

        # 遍歷所有連線
        for websocket, subscribed_codes in self.subscribed_stations.items():
            if not subscribed_codes:
                continue

            filtered_batch = {}
            # 檢查是否有壓力測試的特殊訂閱
            if "__ALL_Z__" in subscribed_codes:
                # 過濾出所有 Z 軸的資料
                filtered_batch = {
                    wave_id: wave_data
                    for wave_id, wave_data in wave_batch.items()
                    if wave_id.endswith("Z")
                }
            else:
                # 原本的過濾邏輯
                # wave_id 格式為 'SM.A024.01.HLZ'，subscribed_codes 可能是 'A024'
                filtered_batch = {
                    wave_id: wave_data
                    for wave_id, wave_data in wave_batch.items()
                    if wave_id.split(".")[1] in subscribed_codes
                }

            if filtered_batch:
                # 建立針對此客戶端的資料包
                client_packet = {
                    "waveid": wave_packet["waveid"],
                    "timestamp": wave_packet["timestamp"],
                    "data": filtered_batch,
                }
                try:
                    # 發送資料
                    await websocket.send_json({"event": "wave_packet", "data": client_packet})
                except Exception as e:
                    logger.error(f"Failed to send to {websocket.client.host}: {e}")

    async def send_pick_packet(self, pick_data: dict):
        """將 PICK 資料包傳送給所有連線的客戶端 (廣播)"""
        for websocket in self.active_connections:
            try:
                await websocket.send_json({"event": "pick_packet", "data": pick_data})
            except Exception as e:
                logger.error(f"Failed to send pick to {websocket.client.host}: {e}")

    async def send_eew_packet(self, eew_data: dict):
        """將 EEW 資料包傳送給所有連線的客戶端 (廣播)"""
        for websocket in self.active_connections:
            try:
                await websocket.send_json({"event": "eew_packet", "data": eew_data})
            except Exception as e:
                logger.error(f"Failed to send eew to {websocket.client.host}: {e}")

socket_manager = ConnectionManager()

# --- WebSocket 端點 ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await socket_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event")
            payload = data.get("data")

            if event == "subscribe_stations":
                stations = payload.get("stations", [])
                socket_manager.subscribe(websocket, stations)

    except WebSocketDisconnect:
        socket_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error with {websocket.client.host}: {e}")
        socket_manager.disconnect(websocket)


# --- 從 Redis 讀取並推送資料的背景任務 ---
async def redis_wave_reader():
    """
    持續從 Redis 讀取所有 'wave:*' stream，批次處理後推送給 WebSocket 管理器。
    """
    logger.info("Starting Redis wave reader...")
    redis_client = redis.Redis(**REDIS_CONFIG, decode_responses=False)
    
    stream_keys_bytes = [key async for key in redis_client.scan_iter("wave:*:*")]
    if not stream_keys_bytes:
        logger.warning("No 'wave:*' streams found in Redis. Waiting for streams to be created...")
        await asyncio.sleep(5)
        # Retry once
        stream_keys_bytes = [key async for key in redis_client.scan_iter("wave:*:*")]

    if not stream_keys_bytes:
        logger.error("Still no 'wave:*' streams found. Exiting reader task.")
        return

    logger.info(f"Found {len(stream_keys_bytes)} wave streams to listen to.")
    
    stream_ids = {key: '$' for key in stream_keys_bytes}

    while True:
        try:
            response = await redis_client.xread(stream_ids, count=10, block=100)
            
            if not response:
                continue

            wave_batch = {}
            
            for stream_key, messages in response:
                last_id = messages[-1][0]
                stream_ids[stream_key] = last_id

                stream_key_str = stream_key.decode('utf-8')
                _, station, channel = stream_key_str.split(":")

                for msg_id, msg_data in messages:
                    waveform_bytes = msg_data.get(b'data')
                    if not waveform_bytes:
                        continue
                    
                    waveform_raw = np.frombuffer(waveform_bytes, dtype=np.int32)
                    
                    wave_meta = {'station': station, 'channel': channel, 'network': msg_data.get(b'network', b'TW').decode('utf-8')}
                    wave_meta = convert_to_tsmip_legacy_naming(wave_meta)
                    constant = get_wave_constant(wave_meta)
                    waveform_processed = waveform_raw * constant
                    waveform_processed = signal_processing(waveform_processed)
                    if waveform_processed is None:
                        continue

                    network = msg_data.get(b'network', b'SM').decode('utf-8')
                    location = msg_data.get(b'location', b'01').decode('utf-8')
                    wave_id = f"{network}.{station}.{location}.{channel}"

                    pga = float(np.max(np.abs(waveform_processed))) if waveform_processed.size > 0 else 0.0

                    wave_batch[wave_id] = {
                        "waveform": waveform_processed.tolist(),
                        "pga": pga,
                        "startt": float(msg_data.get(b'startt', b'0')),
                        "endt": float(msg_data.get(b'endt', b'0')),
                        "samprate": int(float(msg_data.get(b'samprate', b'100'))),
                    }

            if wave_batch:
                timestamp = int(time.time() * 1000)
                wave_packet = {
                    "waveid": f"batch_{timestamp}",
                    "timestamp": timestamp,
                    "data": wave_batch,
                }
                await socket_manager.send_wave_packet(wave_packet)

        except Exception as e:
            logger.error(f"Error in redis_wave_reader: {e}")
            await asyncio.sleep(0.1)


async def redis_pick_reader():
    """
    持續從 Redis 讀取 'pick' stream，推送給 WebSocket 管理器。
    """
    logger.info("Starting Redis pick reader...")
    redis_client = redis.Redis(**REDIS_CONFIG, decode_responses=False)
    stream_key = "pick"
    last_id = '$'

    while True:
        try:
            # Block 100ms waiting for new messages
            response = await redis_client.xread({stream_key: last_id}, count=10, block=100)
            if not response:
                continue

            for _, messages in response:
                for msg_id, msg_data in messages:
                    last_id = msg_id
                    # msg_data has b'data' and b'recv_time'
                    raw_data = msg_data.get(b'data')
                    if raw_data:
                        try:
                            # Try to decode as utf-8 text
                            text_data = raw_data.decode('utf-8')
                        except:
                            text_data = str(raw_data)
                        
                        # Try to parse as JSON (if reader sent a JSON string)
                        try:
                            json_data = json.loads(text_data)
                            if isinstance(json_data, dict):
                                # It's a parsed pick object
                                packet = {
                                    "type": "pick",
                                    "content": json_data,
                                    "timestamp": time.time()
                                }
                            else:
                                # It's just a string (or other JSON type)
                                packet = {
                                    "type": "pick",
                                    "content": text_data,
                                    "timestamp": time.time()
                                }
                        except json.JSONDecodeError:
                            # Not JSON, treat as raw text
                            packet = {
                                "type": "pick",
                                "content": text_data,
                                "timestamp": time.time()
                            }
                            
                        await socket_manager.send_pick_packet(packet)

        except Exception as e:
            # If stream doesn't exist yet, xread might fail or just return empty.
            # If it fails because key doesn't exist, we wait.
            # logger.error(f"Error in redis_pick_reader: {e}")
            await asyncio.sleep(1)


async def redis_eew_reader():
    """
    持續從 Redis 讀取 'eew' stream，推送給 WebSocket 管理器。
    """
    logger.info("Starting Redis eew reader...")
    redis_client = redis.Redis(**REDIS_CONFIG, decode_responses=False)
    stream_key = "eew"
    last_id = '$'

    while True:
        try:
            response = await redis_client.xread({stream_key: last_id}, count=10, block=100)
            if not response:
                continue

            for _, messages in response:
                for msg_id, msg_data in messages:
                    last_id = msg_id
                    raw_data = msg_data.get(b'data')
                    if raw_data:
                        try:
                            text_data = raw_data.decode('utf-8')
                        except:
                            text_data = str(raw_data)
                        
                        packet = {
                            "type": "eew",
                            "content": text_data,
                            "timestamp": time.time()
                        }
                        await socket_manager.send_eew_packet(packet)

        except Exception as e:
            # logger.error(f"Error in redis_eew_reader: {e}")
            await asyncio.sleep(1)


# Load site info
site_info_file = "/workspace/station/site_info.csv"
try:
    logger.info(f"Loading {site_info_file}...")
    site_info = pd.read_csv(site_info_file)
    constant_dict = site_info.set_index(["Station", "Channel"])["Constant"].to_dict()
    logger.info(f"{site_info_file} loaded")

except FileNotFoundError:
    logger.warning(f"{site_info_file} not found")


def join_id_from_dict(data, order="NSLC"):
    code = {"N": "network", "S": "station", "L": "location", "C": "channel"}
    data_id = ".".join(data[code[letter]] for letter in order)
    return data_id


def convert_to_tsmip_legacy_naming(wave):
    if wave["network"] == "TW":
        wave["network"] = "SM"
        wave["location"] = "01"
    return wave


def get_wave_constant(wave):
    # count to cm/s^2
    try:
        wave_constant = constant_dict[wave["station"], wave["channel"]]

    except Exception as e:
        logger.debug(
            f"{wave['station']} not found in site_info.txt, use default 3.2e-6"
        )
        wave_constant = 3.2e-6

    return wave_constant

def signal_processing(waveform):
    try:
        # demean and lowpass filter
        data = detrend(waveform, type="constant")
        data = lowpass(data, freq=10)

        return data

    except Exception as e:
        logger.error(f"signal_processing error: {e}")


def lowpass(data, freq=10, df=100, corners=4):
    """
    Modified form ObsPy Signal Processing
    https://docs.obspy.org/_modules/obspy/signal/filter.html#lowpass
    """
    fe = 0.5 * df
    f = freq / fe

    if f > 1:
        f = 1.0
    z, p, k = iirfilter(corners, f, btype="lowpass", ftype="butter", output="zpk")
    sos = zpk2sos(z, p, k)

    return sosfilt(sos, data)

@app.on_event("startup")
async def startup_event():
    # 在 FastAPI 啟動時，建立背景任務
    for coro in [redis_wave_reader(), redis_pick_reader(), redis_eew_reader()]:
        task = asyncio.create_task(coro)
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down background tasks...")
    for task in background_tasks:
        task.cancel()
    await asyncio.gather(*background_tasks, return_exceptions=True)
    logger.info("Background tasks shut down.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FastAPI WebSocket server for EEW.")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Web server IP")
    parser.add_argument("--port", type=int, default=5001, help="Web server port")
    args = parser.parse_args()

    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)