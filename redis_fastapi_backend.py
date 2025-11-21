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
            logger.info(
                f"Client {websocket.client.host} subscribed to {len(stations)} stations: {list(stations)[:10]}..."
            )
        else:
            self.subscribed_stations[websocket] = set()
            logger.info(f"Client {websocket.client.host} unsubscribed from all stations")

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
            
            elif event == "request_historical_data":
                # Handle request for historical data (last 120 seconds)
                stations = payload.get("stations", [])
                window_seconds = payload.get("window_seconds", 120)
                
                if stations:
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
                        
                        # Fetch historical data using pipeline
                        fetch_start = time.time()
                        wave_packets = await get_historical_waves_bulk(
                            redis_client, 
                            stream_keys, 
                            start_time, 
                            end_time
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
                                await asyncio.sleep(0.01)
                            
                            logger.info(f"Sent {len(wave_packets)} historical wave packets to client")
                            
                            # Also fetch and send historical picks
                            try:
                                pick_packets = await get_historical_picks(redis_client, start_time, end_time)
                                if pick_packets:
                                    logger.info(f"Sending {len(pick_packets)} historical picks to client")
                                    for pick_packet in pick_packets:
                                        await websocket.send_json({"event": "pick_packet", "data": pick_packet})
                                        await asyncio.sleep(0.01)
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
async def get_historical_waves_bulk(redis_client, stream_keys, start_time, end_time):
    """
    Fetch historical waveform data for multiple streams using Redis Pipeline.
    Uses xrange to query time-based data efficiently.
    
    Args:
        redis_client: Async Redis client
        stream_keys: List of stream keys (e.g., [b'wave:A001:HLZ', ...])
        start_time: Start timestamp (seconds)
        end_time: End timestamp (seconds)
    
    Returns:
        dict: {wave_id: {waveform, pga, startt, endt, samprate}, ...}
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
    
    # Group chunks by 5-second windows to reduce packet count
    # This balances between data granularity and transmission efficiency
    TIME_WINDOW = 5  # seconds
    time_grouped_data = {}  # {time_window_key: [chunk, ...]}
    
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
            
            # Group by 5-second windows
            time_window_key = int(startt / TIME_WINDOW)
            if time_window_key not in time_grouped_data:
                time_grouped_data[time_window_key] = []
            
            time_grouped_data[time_window_key].append({
                'wave_id': wave_id,
                'waveform': waveform_scaled,
                'startt': startt,
                'endt': endt,
                'samprate': samprate
            })
    
    if not time_grouped_data:
        return []
    
    # Process each 5-second window
    all_packets = []
    for time_key in sorted(time_grouped_data.keys()):
        chunk_list = time_grouped_data[time_key]
        
        # Group chunks by station and concatenate waveforms
        station_chunks = {}  # {wave_id: [chunks...]}
        for chunk in chunk_list:
            wave_id = chunk['wave_id']
            if wave_id not in station_chunks:
                station_chunks[wave_id] = []
            station_chunks[wave_id].append(chunk)
        
        # Concatenate chunks for each station
        chunks_to_process = []
        for wave_id, chunks in station_chunks.items():
            # Sort by startt to maintain chronological order
            chunks.sort(key=lambda c: c['startt'])
            
            # Concatenate waveforms
            concatenated_waveform = np.concatenate([c['waveform'] for c in chunks])
            
            # Use first chunk's startt and last chunk's endt
            chunks_to_process.append({
                'wave_id': wave_id,
                'waveform': concatenated_waveform,
                'startt': chunks[0]['startt'],
                'endt': chunks[-1]['endt'],
                'samprate': chunks[0]['samprate']
            })
        
        # Batch process concatenated waveforms
        batch_waveforms = [chunk['waveform'] for chunk in chunks_to_process]
        
        try:
            processed_waveforms = batch_signal_processing(batch_waveforms)
            
            # Build packet for this 5-second window
            wave_batch = {}
            for i, waveform_processed in enumerate(processed_waveforms):
                if waveform_processed is None or len(waveform_processed) == 0:
                    continue
                
                chunk = chunks_to_process[i]
                pga = float(np.max(np.abs(waveform_processed)))
                
                wave_batch[chunk['wave_id']] = {
                    "waveform": waveform_processed.tolist(),
                    "pga": pga,
                    "startt": chunk['startt'],
                    "endt": chunk['endt'],
                    "samprate": chunk['samprate'],
                }
            
            if wave_batch:
                all_packets.append(wave_batch)
                
        except Exception as e:
            logger.error(f"Batch processing error for time window {time_key}: {e}")
    
    logger.info(f"get_historical_waves_bulk: Grouped into {len(all_packets)} 5-second window packets")
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
            wave_batch = {}
            if batch_waveforms:
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
                await asyncio.sleep(1)

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