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

# --- 波形降採樣配置 ---
# 控制傳送資料點數的倍數：資料點數 = resolution_width * POINTS_PER_PIXEL
# 預設 2.0 表示傳送解析度兩倍的資料點，可調整以平衡畫質與傳輸量
POINTS_PER_PIXEL = 1.0
FIXED_TIME_WINDOW = 120  # 固定時間窗口（秒）

app = FastAPI()
background_tasks = set()

# --- WebSocket 連線管理器 ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.subscribed_stations: Dict[WebSocket, Set[str]] = {}
        self.client_resolutions: Dict[WebSocket, int] = {}  # 儲存每個客戶端的螢幕解析度

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
        if websocket in self.client_resolutions:
            del self.client_resolutions[websocket]
        logger.info(f"Client {websocket.client.host} disconnected")

    def subscribe(self, websocket: WebSocket, stations: List[str]):
        """處理來自客戶端的測站訂閱請求"""
        if stations:
            # 前端傳來的可能是 'TWQ1' 或 'A024' 這種簡碼
            self.subscribed_stations[websocket] = set(stations)
            logger.info(
                f"Client {websocket.client.host} subscribed to {len(stations)} stations: {list(stations)[:10]}..."
            )
        else:
            self.subscribed_stations[websocket] = set()
            logger.info(f"Client {websocket.client.host} unsubscribed from all stations")
    
    def set_resolution(self, websocket: WebSocket, width: int):
        """設定客戶端的顯示解析度"""
        self.client_resolutions[websocket] = width
        logger.info(f"Client {websocket.client.host} set resolution to {width}px")

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
                    if len(wave_id.split(".")) >= 4 and wave_id.split(".")[3].endswith("Z")
                }
            else:
                # 原本的過濾邏輯
                # wave_id 格式為 'SM.A024.01.HLZ'，subscribed_codes 可能是 'A024'
                filtered_batch = {
                    wave_id: wave_data
                    for wave_id, wave_data in wave_batch.items()
                    if len(wave_id.split(".")) >= 2 and wave_id.split(".")[1] in subscribed_codes
                }

            if filtered_batch:
                # 根據客戶端解析度進行降採樣
                resolution_width = self.client_resolutions.get(websocket, 1000)  # 預設 1000
                
                downsampled_batch = {}
                for wave_id, wave_data in filtered_batch.items():
                    waveform = wave_data.get("waveform", [])
                    samprate = wave_data.get("samprate", 100)
                    
                    if waveform and len(waveform) > 0:
                        # 計算降採樣因子
                        downsample_factor = calculate_downsample_factor(samprate, resolution_width)
                        
                        # 執行降採樣
                        downsampled_waveform = downsample_waveform(np.array(waveform), downsample_factor)
                        
                        # 建立降採樣後的資料
                        downsampled_batch[wave_id] = {
                            **wave_data,
                            "waveform": downsampled_waveform.tolist(),
                            "samprate": samprate,  # 保留原始採樣率
                            "effective_samprate": samprate / downsample_factor,  # 降採樣後的有效採樣率
                            "original_length": len(waveform),
                            "downsampled_length": len(downsampled_waveform),
                            "downsample_factor": downsample_factor
                        }
                    else:
                        downsampled_batch[wave_id] = wave_data
                
                # 建立針對此客戶端的資料包
                client_packet = {
                    "waveid": wave_packet["waveid"],
                    "timestamp": wave_packet["timestamp"],
                    "data": downsampled_batch,
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
            
            elif event == "set_display_resolution":
                # 處理客戶端解析度設定
                width = payload.get("width", 1000)  # 預設 1000 像素
                socket_manager.set_resolution(websocket, width)
            
            elif event == "request_historical_data":
                # Handle request for historical data (last 120 seconds)
                stations = payload.get("stations", [])
                window_seconds = payload.get("window_seconds", 121)
                
                if not stations:
                    continue

                logger.info(f"Client {websocket.client.host} requested {window_seconds}s of historical data for {len(stations)} stations")
                
                # Create Redis client for this request
                redis_client = redis.Redis(**REDIS_CONFIG, decode_responses=False)
                
                try:
                    # Calculate time range
                    end_time = time.time()
                    start_time = end_time - window_seconds
                    
                    # Build stream keys for only Z channels (like real-time reader)
                    stream_keys = []
                    
                    # Handle special __ALL_Z__ marker for stress testing
                    if stations == ['__ALL_Z__']:
                        logger.info(f"Client requested __ALL_Z__ - scanning all Z channel streams in Redis")
                        # Scan all wave:*:*Z streams (matches HLZ, ENZ, BHZ, etc.)
                        all_z_keys = [key async for key in redis_client.scan_iter("wave:*:*Z")]
                        stream_keys = all_z_keys
                        logger.info(f"Found {len(stream_keys)} Z-channel streams")
                    else:
                        # Normal station list - find Z channels for each station
                        for station in stations:
                            # Scan for all Z channels for this station (wave:STATION:*Z)
                            station_z_keys = [key async for key in redis_client.scan_iter(f"wave:{station}:*Z")]
                            stream_keys.extend(station_z_keys)
                        logger.info(f"Found {len(stream_keys)} Z-channel streams for {len(stations)} stations")
                    
                    logger.info(f"Querying historical data: start_time={start_time}, end_time={end_time}, stations={stations[:5]}...")
                    logger.info(f"Stream keys (first 5): {[k.decode('utf-8') for k in stream_keys[:5]]}")
                    
                    # 獲取客戶端解析度
                    resolution_width = socket_manager.client_resolutions.get(websocket, 1000)
                    
                    # Fetch historical data using pipeline
                    fetch_start = time.time()
                    wave_packets = await get_historical_waves_bulk(
                        redis_client, 
                        stream_keys, 
                        start_time, 
                        end_time,
                        resolution_width  # 傳遞解析度用於降採樣
                    )
                    fetch_time = time.time() - fetch_start
                    
                    if wave_packets:
                        # Send multiple packets to client (one per time group)
                        logger.info(f"Fetched {len(wave_packets)} historical time-grouped packets in {fetch_time:.3f}s")
                        
                        for i, wave_batch in enumerate(wave_packets):
                            timestamp = int(time.time() * 1000)
                            wave_packet = {
                                "waveid": f"historical_{timestamp}_{i}",
                                "timestamp": timestamp,
                                "data": wave_batch,
                            }
                            await websocket.send_json({"event": "historical_data", "data": wave_packet})
                            # Small delay to avoid overwhelming client
                            await asyncio.sleep(0.1)
                        
                        logger.info(f"Sent {len(wave_packets)} historical wave packets to client")
                        
                        # Also fetch and send historical picks
                        try:
                            pick_packets = await get_historical_picks(redis_client, start_time, end_time)
                            if pick_packets:
                                logger.info(f"Sending {len(pick_packets)} historical picks in one batch to client")
                                # 一次發送所有 picks
                                await websocket.send_json({
                                    "event": "historical_picks_batch", 
                                    "data": {
                                        "picks": pick_packets,
                                        "count": len(pick_packets)
                                    }
                                })
                        except Exception as e:
                            logger.error(f"Error fetching historical picks: {e}")
                    else:
                        logger.warning(f"No historical data found for requested stations: {stations[:10]}")
                        logger.warning(f"Checked stream keys: {[k.decode('utf-8') for k in stream_keys[:10]]}")
                        await websocket.send_json({"event": "historical_data", "data": {"waveid": "empty", "timestamp": int(time.time() * 1000), "data": {}}})
                
                except Exception as e:
                    logger.error(f"Error fetching historical data: {e}")
                    await websocket.send_json({"event": "error", "data": {"message": f"Failed to fetch historical data: {str(e)}"}})
                finally:
                    await redis_client.close()

    except WebSocketDisconnect:
        socket_manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error with {websocket.client.host}: {e}")
        socket_manager.disconnect(websocket)



# --- 從 Redis 讀取並推送資料的背景任務 ---
async def get_historical_waves_bulk(redis_client, stream_keys, start_time, end_time, resolution_width=1000):
    """
    Fetch historical waveform data for multiple streams using Redis Pipeline.
    Uses xrange to query time-based data efficiently.
    
    Args:
        redis_client: Async Redis client
        stream_keys: List of stream keys (e.g., [b'wave:A001:HLZ', ...])
        start_time: Start timestamp (seconds)
        end_time: End timestamp (seconds)
        resolution_width: Client display width in pixels (for downsampling)
    
    Returns:
        list: List of wave_batch dicts (one per 5-second window)
    """
    if not stream_keys:
        return {}
    
    start_id = f"{int(start_time * 1000)}-0"
    end_id = f"{int(end_time * 1000)}-0"
    
    logger.info(f"get_historical_waves_bulk: Querying {len(stream_keys)} streams from {start_id} to {end_id}")
    
    # Use pipeline to batch all xrange queries
    pipeline = redis_client.pipeline()
    for key in stream_keys:
        pipeline.xrange(key, min=start_id, max=end_id)
    
    # Execute all commands in one go
    results = await pipeline.execute()
    
    logger.info(f"get_historical_waves_bulk: Pipeline returned {len(results)} results")
    
    # Count how many streams have data
    streams_with_data = sum(1 for r in results if r)
    logger.info(f"get_historical_waves_bulk: {streams_with_data}/{len(results)} streams have data")
    
    # Group all chunks by station first (to process full duration at once)
    station_data_map = {}  # {wave_id: {'chunks': [], 'meta': ...}}
    
    for key, messages in zip(stream_keys, results):
        if not messages:
            continue
        
        key_str = key.decode('utf-8') if isinstance(key, bytes) else key
        _, station, channel = key_str.split(":")
        
        # Process each message chunk
        for msg_id, msg_data in messages:
            waveform_bytes = msg_data.get(b'data')
            if not waveform_bytes:
                continue
            
            waveform_raw = np.frombuffer(waveform_bytes, dtype=np.int32)
            
            # Apply scaling
            wave_meta = {
                'station': station, 
                'channel': channel, 
                'network': msg_data.get(b'network', b'TW').decode('utf-8')
            }
            wave_meta = convert_to_tsmip_legacy_naming(wave_meta)
            constant = get_wave_constant(wave_meta)
            waveform_scaled = waveform_raw * constant
            
            network = msg_data.get(b'network', b'SM').decode('utf-8')
            location = msg_data.get(b'location', b'01').decode('utf-8')
            wave_id = f"{network}.{station}.{location}.{channel}"
            
            startt = float(msg_data.get(b'startt', b'0'))
            endt = float(msg_data.get(b'endt', b'0'))
            samprate = int(float(msg_data.get(b'samprate', b'100')))
            
            if wave_id not in station_data_map:
                station_data_map[wave_id] = {
                    'chunks': [],
                    'samprate': samprate
                }
            
            station_data_map[wave_id]['chunks'].append({
                'waveform': waveform_scaled,
                'startt': startt,
                'endt': endt
            })
    
    if not station_data_map:
        return []
    
    # Concatenate and prepare for batch processing
    wave_ids = []
    full_waveforms = []
    wave_start_times = []
    wave_samprates = []
    
    for wave_id, data in station_data_map.items():
        chunks = data['chunks']
        # Sort by time
        chunks.sort(key=lambda c: c['startt'])
        
        # Concatenate
        full_waveform = np.concatenate([c['waveform'] for c in chunks])
        
        wave_ids.append(wave_id)
        full_waveforms.append(full_waveform)
        wave_start_times.append(chunks[0]['startt'])
        wave_samprates.append(data['samprate'])
        
    # Batch process the FULL waveforms
    try:
        processed_waveforms = batch_signal_processing(full_waveforms)
        
        # Apply Taper to the start of each waveform to remove filter spike
        # Taper first 2 seconds (200 samples at 100Hz)
        for i, waveform in enumerate(processed_waveforms):
            if waveform is None or len(waveform) == 0:
                continue
                
            taper_len = min(len(waveform), 200)  # 2 seconds
            if taper_len > 0:
                # Simple linear taper (0 to 1)
                taper = np.linspace(0, 1, taper_len)
                waveform[:taper_len] = waveform[:taper_len] * taper
                
    except Exception as e:
        logger.error(f"Batch processing error in historical data: {e}")
        return []

    # Slice back into 5-second packets for transmission
    TIME_WINDOW = 5  # seconds
    packet_map = {}  # {time_key: {wave_id: data}}
    
    for i, wave_id in enumerate(wave_ids):
        waveform = processed_waveforms[i]
        if waveform is None or len(waveform) == 0:
            continue
            
        start_time = wave_start_times[i]
        samprate = wave_samprates[i]
        
        # Calculate downsample factor once
        downsample_factor = calculate_downsample_factor(samprate, resolution_width)
        
        # Slice into windows
        total_samples = len(waveform)
        samples_per_window = int(TIME_WINDOW * samprate)
        
        for j in range(0, total_samples, samples_per_window):
            chunk_start_idx = j
            chunk_end_idx = min(j + samples_per_window, total_samples)
            
            chunk_waveform = waveform[chunk_start_idx:chunk_end_idx]
            
            chunk_start_time = start_time + (chunk_start_idx / samprate)
            chunk_end_time = start_time + (chunk_end_idx / samprate)
            
            # Downsample this chunk
            downsampled_chunk = downsample_waveform(chunk_waveform, downsample_factor)
            
            pga = float(np.max(np.abs(downsampled_chunk))) if len(downsampled_chunk) > 0 else 0
            
            # Group by time window key
            time_key = int(chunk_start_time / TIME_WINDOW)
            if time_key not in packet_map:
                packet_map[time_key] = {}
                
            packet_map[time_key][wave_id] = {
                "waveform": downsampled_chunk.tolist(),
                "pga": pga,
                "startt": chunk_start_time,
                "endt": chunk_end_time,
                "samprate": samprate,
                "effective_samprate": samprate / downsample_factor,
                "original_length": len(chunk_waveform),
                "downsampled_length": len(downsampled_chunk),
                "downsample_factor": downsample_factor
            }
            
    # Convert map to list of packets
    all_packets = []
    for time_key in sorted(packet_map.keys()):
        all_packets.append(packet_map[time_key])
        
    logger.info(f"get_historical_waves_bulk: Processed {len(wave_ids)} stations, sliced into {len(all_packets)} packets")
    return all_packets


async def get_historical_picks(redis_client, start_time, end_time):
    """
    Fetch historical pick data from Redis 'pick' stream.
    Filters out duplicate picks (Earthworm sends same pick 9 times),
    keeping only the latest update based on update_sec.
    
    Args:
        redis_client: Async Redis client
        start_time: Start timestamp (seconds)
        end_time: End timestamp (seconds)
    
    Returns:
        list: List of deduplicated pick packets
    """
    start_id = f"{int(start_time * 1000)}-0"
    end_id = f"{int(end_time * 1000)}-0"
    
    logger.info(f"get_historical_picks: Querying pick stream from {start_id} to {end_id}")
    
    # Query pick stream
    messages = await redis_client.xrange("pick", min=start_id, max=end_id)
    
    logger.info(f"get_historical_picks: Found {len(messages)} pick messages")
    
    # Deduplicate picks: key = (station, channel, pick_time), value = latest pick
    pick_map = {}
    
    for msg_id, msg_data in messages:
        raw_data = msg_data.get(b'data')
        if raw_data:
            try:
                # Decode and parse pick data
                text_data = raw_data.decode('utf-8')
                json_data = json.loads(text_data)
                if isinstance(json_data, dict):
                    # Create unique key from station, channel, and pick time
                    station = json_data.get('station', '')
                    channel = json_data.get('channel', '')
                    pick_time = json_data.get('time', 0)  # Pick arrival time
                    update_sec = json_data.get('update_sec', 0)  # Update sequence number
                    
                    # Use (station, channel, pick_time) as key
                    pick_key = (station, channel, pick_time)
                    
                    # Keep only the latest update (highest update_sec)
                    if pick_key not in pick_map or update_sec > pick_map[pick_key]['update_sec']:
                        pick_map[pick_key] = {
                            'data': json_data,
                            'update_sec': update_sec
                        }
            except Exception as e:
                logger.debug(f"Error parsing pick message: {e}")
                continue
    
    # Convert deduplicated picks to packets
    pick_packets = []
    for pick_info in pick_map.values():
        packet = {
            "type": "pick",
            "content": pick_info['data'],
            "timestamp": time.time()
        }
        pick_packets.append(packet)
    
    logger.info(f"get_historical_picks: Deduplicated {len(messages)} messages to {len(pick_packets)} unique picks")
    return pick_packets


async def redis_wave_reader():
    """
    持續從 Redis 讀取所有 'wave:*' stream，批次處理後推送給 WebSocket 管理器。
    動態掃描新的 streams。
    """
    logger.info("Starting Redis wave reader...")
    redis_client = redis.Redis(**REDIS_CONFIG, decode_responses=False)
    
    stream_ids = {}
    last_scan_time = 0
    scan_interval = 5  # Rescan every 5 seconds for new streams

    while True:
        try:
            # Periodically scan for new streams
            current_time = time.time()
            if current_time - last_scan_time > scan_interval:
                # Scan only Z-channel streams using wildcard pattern (HLZ, ENZ, BHZ, etc.)
                stream_keys_bytes = [key async for key in redis_client.scan_iter("wave:*:*Z")]
                
                # Add new streams
                new_streams = 0
                for key in stream_keys_bytes:
                    if key not in stream_ids:
                        # Use '0-0' to read from beginning, or '$' to read only new messages
                        # Using '0-0' to ensure we don't miss any recent data that arrived before reader started
                        stream_ids[key] = '0-0'
                        new_streams += 1
                
                if new_streams > 0:
                    logger.info(f"Found {len(stream_keys_bytes)} Z-channel wave streams to listen to.")
                elif len(stream_ids) == 0:
                    logger.warning("No Z-channel 'wave:*:*Z' streams found yet. Will retry...")
                
                last_scan_time = current_time
            
            # If no streams yet, wait and continue
            if not stream_ids:
                await asyncio.sleep(1)
                continue
            
            # Read fewer streams per iteration to reduce latency
            response = await redis_client.xread(stream_ids, count=100, block=100)
            
            if not response:
                continue

            start_time = time.time()
            processed_count = 0
            
            # Collect waveforms for batch processing
            batch_waveforms = []  # List of (wave_id, waveform_array, pga_compute_needed)
            wave_metadata = []  # List of metadata dicts
            
            for stream_key, messages in response:
                last_id = messages[-1][0]
                stream_ids[stream_key] = last_id

                stream_key_str = stream_key.decode('utf-8')
                _, station, channel = stream_key_str.split(":")
                
                # No need to filter Z channels here - already filtered at scan time with wave:*:*Z pattern

                for msg_id, msg_data in messages:
                    waveform_bytes = msg_data.get(b'data')
                    if not waveform_bytes:
                        continue
                    
                    waveform_raw = np.frombuffer(waveform_bytes, dtype=np.int32)
                    
                    wave_meta = {'station': station, 'channel': channel, 'network': msg_data.get(b'network', b'TW').decode('utf-8')}
                    wave_meta = convert_to_tsmip_legacy_naming(wave_meta)
                    constant = get_wave_constant(wave_meta)
                    waveform_scaled = waveform_raw * constant
                    
                    network = msg_data.get(b'network', b'SM').decode('utf-8')
                    location = msg_data.get(b'location', b'01').decode('utf-8')
                    wave_id = f"{network}.{station}.{location}.{channel}"
                    
                    # Collect for batch processing
                    batch_waveforms.append(waveform_scaled)
                    wave_metadata.append({
                        'wave_id': wave_id,
                        'startt': float(msg_data.get(b'startt', b'0')),
                        'endt': float(msg_data.get(b'endt', b'0')),
                        'samprate': int(float(msg_data.get(b'samprate', b'100'))),
                    })
                    processed_count += 1

            # Batch process all waveforms at once
            if not batch_waveforms:
                continue

            wave_batch = {}
            try:
                # Process all waveforms in batch
                processed_waveforms = batch_signal_processing(batch_waveforms)
                
                # Build wave_batch
                for i, waveform_processed in enumerate(processed_waveforms):
                    if waveform_processed is None or len(waveform_processed) == 0:
                        continue
                    
                    meta = wave_metadata[i]
                    pga = float(np.max(np.abs(waveform_processed)))
                    
                    wave_batch[meta['wave_id']] = {
                        "waveform": waveform_processed.tolist(),
                        "pga": pga,
                        "startt": meta['startt'],
                        "endt": meta['endt'],
                        "samprate": meta['samprate'],
                    }
            except Exception as e:
                logger.error(f"Batch processing error: {e}")
                # Fallback to individual processing if batch fails
                for i, waveform_scaled in enumerate(batch_waveforms):
                    try:
                        waveform_processed = signal_processing(waveform_scaled)
                        if waveform_processed is None:
                            continue
                        
                        meta = wave_metadata[i]
                        pga = float(np.max(np.abs(waveform_processed)))
                        
                        wave_batch[meta['wave_id']] = {
                            "waveform": waveform_processed.tolist(),
                            "pga": pga,
                            "startt": meta['startt'],
                            "endt": meta['endt'],
                            "samprate": meta['samprate'],
                        }
                    except Exception as e2:
                        logger.error(f"Individual processing error for {meta['wave_id']}: {e2}")

            processing_time = time.time() - start_time
            
            if wave_batch:
                timestamp = int(time.time() * 1000)
                wave_packet = {
                    "waveid": f"batch_{timestamp}",
                    "timestamp": timestamp,
                    "data": wave_batch,
                }
                
                logger.info(f"Processed {processed_count} Z-channel waves in {processing_time:.3f}s, sending {len(wave_batch)} to clients")
                
                await socket_manager.send_wave_packet(wave_packet)
                await asyncio.sleep(0.33)

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
    last_id = '0-0'

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
                    if not raw_data:
                        continue

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
                    if not raw_data:
                        continue

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
constant_dict = {}
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


# Cache for missing stations to avoid log flooding
missing_stations_cache = set()

def downsample_waveform(waveform, factor):
    """
    簡單降採樣：每 factor 個點取一個
    
    Args:
        waveform: numpy array 或 list
        factor: 降採樣因子
    
    Returns:
        降採樣後的 numpy array
    """
    if factor <= 1:
        return waveform
    return waveform[::factor]

def calculate_downsample_factor(samprate, resolution_width):
    """
    計算降採樣因子
    
    Args:
        samprate: 採樣率 (Hz)
        resolution_width: 客戶端解析度寬度 (pixels)
    
    Returns:
        降採樣因子 (整數)
    """
    # 120 秒的總資料點數
    total_points = FIXED_TIME_WINDOW * samprate
    # 目標點數 = 解析度 * POINTS_PER_PIXEL
    target_points = resolution_width * POINTS_PER_PIXEL
    # 計算降採樣因子
    factor = int(total_points / target_points)
    return max(1, factor)  # 至少為 1（不降採樣）

def get_wave_constant(wave):
    # count to cm/s^2
    station = wave["station"]
    channel = wave["channel"]
    key = (station, channel)
    
    # Fast path: direct lookup
    if key in constant_dict:
        return constant_dict[key]
    
    # Slow path: handle missing key
    if key not in missing_stations_cache:
        logger.debug(
            f"{station} {channel} not found in site_info.txt, use default 3.2e-6"
        )
        missing_stations_cache.add(key)
        
    return 3.2e-6

def batch_signal_processing(waveforms):
    """
    Batch process multiple waveforms at once for 10x+ speedup.
    Uses numpy padding and vectorized operations.
    """
    if not waveforms:
        return []
    
    try:
        # Find max length
        max_len = max(len(w) for w in waveforms)
        
        # Pad all waveforms to same length and stack into 2D array
        padded_waveforms = []
        original_lengths = []
        
        for waveform in waveforms:
            original_lengths.append(len(waveform))
            if len(waveform) < max_len:
                # Pad with zeros
                padded = np.pad(waveform, (0, max_len - len(waveform)), mode='constant')
                padded_waveforms.append(padded)
            else:
                padded_waveforms.append(waveform)
        
        # Stack into 2D array (n_waveforms, max_len)
        stacked = np.array(padded_waveforms)
        
        # Batch detrend (subtract mean for each row)
        detrended = stacked - np.mean(stacked, axis=1, keepdims=True)
        
        # Batch lowpass filter
        sos = lowpass_sos(freq=10, df=100, corners=4)
        filtered = sosfilt(sos, detrended, axis=1)
        
        # Unpad and return individual waveforms
        result = []
        for i, orig_len in enumerate(original_lengths):
            result.append(filtered[i, :orig_len])
        
        return result
        
    except Exception as e:
        logger.error(f"batch_signal_processing error: {e}")
        # Fallback to individual processing
        return [signal_processing(w) for w in waveforms]


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


def lowpass_sos(freq=10, df=100, corners=4):
    """
    Return SOS (second-order sections) for lowpass filter.
    Used for batch processing.
    """
    fe = 0.5 * df
    f = freq / fe

    if f > 1:
        f = 1.0
    
    sos = iirfilter(corners, f, btype="lowpass", ftype="butter", output="sos")
    return sos

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