import asyncio
import time
import argparse
from typing import List, Set, Dict
import redis.asyncio as redis
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from loguru import logger
import uvicorn
import pandas as pd
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos

# --- Redis 和 FastAPI 配置 ---
REDIS_CONFIG = {
    "host": "localhost",
    "port": 6379,
    "db": 0,
}

app = FastAPI()

# --- WebSocket 連線管理器 ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.subscribed_stations: Dict[WebSocket, Set[str]] = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        self.subscribed_stations[websocket] = set()
        logger.info(f"📡 Client {websocket.client.host} connected")
        # 通知前端連線已建立，可以開始訂閱
        await websocket.send_json({"event": "connect_init"})

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        if websocket in self.subscribed_stations:
            del self.subscribed_stations[websocket]
        logger.info(f"🔌 Client {websocket.client.host} disconnected")

    def subscribe(self, websocket: WebSocket, stations: List[str]):
        """處理來自客戶端的測站訂閱請求"""
        if stations:
            # 前端傳來的可能是 'TWQ1' 或 'A024' 這種簡碼
            self.subscribed_stations[websocket] = set(stations)
            logger.info(
                f"📡 Client {websocket.client.host} subscribed to {len(stations)} stations: {list(stations)[:5]}..."
            )
        else:
            self.subscribed_stations[websocket] = set()
            logger.info(f"📡 Client {websocket.client.host} unsubscribed from all stations")

    async def send_wave_packet(self, wave_packet: dict):
        """將波形資料包傳送給已訂閱的客戶端"""
        wave_batch = wave_packet.get("data", {})
        if not wave_batch:
            return

        # 遍歷所有連線
        for websocket, subscribed_codes in self.subscribed_stations.items():
            if not subscribed_codes:
                continue

            # 過濾出此客戶端訂閱的測站資料
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


socket_manager = ConnectionManager()

# --- WebSocket 端點 ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await socket_manager.connect(websocket)
    try:
        while True:
            # 等待客戶端訊息 (例如訂閱請求)
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
    
    # 獲取所有 wave stream 的鍵
    stream_keys_bytes = [key async for key in redis_client.scan_iter("wave:*:*")]
    stream_keys = [key.decode('utf-8') for key in stream_keys_bytes]
    if not stream_keys:
        logger.warning("No 'wave:*' streams found in Redis. Waiting for streams to be created...")
        # 如果啟動時沒有 stream，每 5 秒檢查一次
        while not stream_keys:
            await asyncio.sleep(5)
            stream_keys = [key.decode('utf-8') for key in await redis_client.keys("wave:*:*")]

    logger.info(f"Found {len(stream_keys)} wave streams to listen to.")
    
    # 為每個 stream 設置起始讀取位置為最新訊息
    stream_ids = {key: '$' for key in stream_keys}
    batch_interval = 0.1  # 每 0.1 秒處理一次批次

    while True:
        try:
            # 使用 XREADGROUP 或 XREAD 來讀取多個 stream
            # block=100 表示最多等待 100ms
            response = await redis_client.xread(stream_ids, count=10, block=100)
            
            if not response:
                continue

            wave_batch = {}
            
            for stream_key, messages in response:
                # 更新下一次讀取的 ID
                last_id = messages[-1][0].decode('utf-8')
                stream_key_str = stream_key.decode('utf-8')
                stream_ids[stream_key] = last_id

                # stream_key 格式: b'wave:EGFH:HLZ'
                # reader_pyew_to_redis.py 寫入的 key 是 wave:{station}:{channel}
                # 但前端需要完整的 SCNL，我們在這裡組合
                # 注意：這是一個簡化，假設 network 和 location 是固定的
                _, station, channel = stream_key_str.split(":")

                for msg_id, msg_data in messages:
                    # reader_pyew_to_redis.py 將 numpy array 存為 bytes
                    # 我們需要讀取並轉換回來
                    waveform_bytes = msg_data.get(b'data')
                    if not waveform_bytes:
                        continue
                    
                    # 1. 從 bytes 轉回 numpy array
                    # reader_pyew_to_redis.py 寫入的是原始 int32 資料
                    waveform_raw = np.frombuffer(waveform_bytes, dtype=np.int32)
                    
                    # 2. 取得儀器校正值並轉換單位
                    wave_meta = {'station': station, 'channel': channel, 'network': msg_data.get(b'network', b'TW').decode('utf-8')}
                    wave_meta = convert_to_tsmip_legacy_naming(wave_meta) # 處理命名轉換
                    constant = get_wave_constant(wave_meta)
                    waveform_processed = waveform_raw * constant

                    # 3. 進行訊號處理
                    waveform_processed = signal_processing(waveform_processed)
                    if waveform_processed is None:
                        continue

                    # 4. 組合前端需要的 SCNL 格式 ID
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
            # 發生錯誤時等待一下，避免快速循環
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
    asyncio.create_task(redis_wave_reader())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FastAPI WebSocket server for EEW.")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Web server IP")
    parser.add_argument("--port", type=int, default=5001, help="Web server port")
    args = parser.parse_args()

    logger.info(f"Starting server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)