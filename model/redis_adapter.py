import time
import redis
import numpy as np
import json
from loguru import logger

class RedisAdapter:
    def __init__(self, host='redis', port=6379, db=0):
        self.host = host
        self.port = port
        self.db = db
        self.redis_client = None
        self.connect()

    def connect(self):
        try:
            # Create a new client instance
            self.redis_client = redis.Redis(host=self.host, port=self.port, db=self.db, decode_responses=False)
            self.redis_client.ping()
            logger.info("Successfully connected to Redis.")
            return True
        except Exception as e:
            logger.error(f"Could not connect to Redis: {e}")
            self.redis_client = None
            return False

    def get_waveform_data(self, station, channel, start_time, end_time):
        """
        Fetch waveform data from a Redis Stream for a given station and channel
        within a specified time range.
        """
        if not self.redis_client:
            logger.error("Redis client not available.")
            return None
        
        stream_key = f"wave:{station}:{channel}"
        
        # The stream IDs in Redis are timestamp-based, so we can use them for time-range queries.
        # The format is <milliseconds_timestamp>-<sequence_number>.
        start_id = f"{int(start_time * 1000)}-0"
        end_id = f"{int(end_time * 1000)}-0"

        try:
            messages = self.redis_client.xrange(stream_key, min=start_id, max=end_id)
            if not messages:
                # logger.warning(f"No data found for {stream_key} in the given time range.")
                return None

            # Process the messages to reconstruct the waveform
            # This part will need to be adjusted based on the exact data format in Redis.
            # Assuming 'data' field contains the raw waveform bytes.
            waveform_chunks = []
            for _, message in messages:
                if b'data' in message:
                    waveform_chunks.append(np.frombuffer(message[b'data'], dtype=np.int32))

            if not waveform_chunks:
                return None

            return np.concatenate(waveform_chunks)

        except Exception as e:
            logger.error(f"Error fetching waveform data from Redis: {e}")
            return None

    def get_picks(self, start_time, end_time, max_picks=100):
        """
        Fetch pick data from the 'pick' Redis Stream within a specified time range.
        Returns a list of unique picks (one per station), sorted by pick_time ascending.
        Deduplication logic: Keep the pick with the highest 'update_sec'.
        """
        if not self.redis_client:
            logger.error("Redis client not available.")
            return []

        stream_key = "pick"
        start_id = f"{int(start_time * 1000)}-0"
        end_id = f"{int(end_time * 1000)}-0"

        try:
            messages = self.redis_client.xrange(stream_key, min=start_id, max=end_id, count=max_picks * 5) # Fetch more to account for updates
            
            best_picks = {} # {station: pick_data}

            for _, message in messages:
                if b'data' in message:
                    try:
                        pick_data = json.loads(message[b'data'])
                        
                        # Ensure pick_time_float exists
                        if 'pick_time' in pick_data:
                            pick_data['pick_time_float'] = float(pick_data['pick_time'])
                        else:
                            pick_data['pick_time_float'] = 0.0
                            
                        # Ensure update_sec exists
                        if 'update_sec' in pick_data:
                            pick_data['update_sec'] = int(pick_data['update_sec'])
                        else:
                            pick_data['update_sec'] = 0
                            
                        sta = pick_data.get('station')
                        if sta:
                            if sta not in best_picks:
                                best_picks[sta] = pick_data
                            else:
                                # Keep the one with larger update_sec
                                if pick_data['update_sec'] > best_picks[sta]['update_sec']:
                                    best_picks[sta] = pick_data
                                    
                    except Exception as e:
                        logger.warning(f"Failed to parse pick data: {e}. Raw message: {message}")
            
            # Convert to list and sort by pick_time
            unique_picks = list(best_picks.values())
            unique_picks.sort(key=lambda x: x['pick_time_float'])
            
            # Limit to max_picks (though usually we want all valid stations in the window)
            # If max_picks is strictly for the number of stations to return:
            if len(unique_picks) > max_picks:
                unique_picks = unique_picks[:max_picks]
                        
            return unique_picks

        except Exception as e:
            logger.error(f"Error fetching picks from Redis: {e}")
            return []
            
    def get_waveforms_bulk(self, stations, start_time, end_time, channels=['*Z', '*N', '*E'], sampling_rate=100):
        """
        Fetch waveform data for multiple stations and channels in parallel using Redis Pipeline.
        Returns (station_headers, data_matrix)
        - station_headers: list of dicts [{'station': 'A001'}, ...]
        - data_matrix: 3D numpy array of shape (N_stations, N_samples, N_channels)
        All arrays are padded/trimmed to exactly int((end_time - start_time) * sampling_rate).
        """
        if not self.redis_client or not stations:
            return [], np.array([])

        start_id = f"{int(start_time * 1000)}-0"
        end_id = f"{int(end_time * 1000)}-0"
        
        target_length = int((end_time - start_time) * sampling_rate)
        
        # Generate all keys
        stream_keys = []
        for station in stations:
            for channel in channels:
                stream_keys.append(f"wave:{station}:{channel}")
        
        pipeline = self.redis_client.pipeline()
        for key in stream_keys:
            pipeline.xrange(key, min=start_id, max=end_id)
        
        # Execute all commands in one go
        results = pipeline.execute()
        
        # Build Matrix
        n_stations = len(stations)
        n_channels = len(channels)
        data_matrix = np.zeros((n_stations, target_length, n_channels), dtype=np.int32)
        
        # Iterate through results and fill matrix
        # results is flat list corresponding to stream_keys
        # stream_keys order: station 0 chan 0, station 0 chan 1, ...
        
        result_idx = 0
        for i in range(n_stations):
            for j in range(n_channels):
                messages = results[result_idx]
                result_idx += 1
                
                if not messages:
                    continue
                    
                waveform_chunks = []
                for _, message in messages:
                    if b'data' in message:
                        waveform_chunks.append(np.frombuffer(message[b'data'], dtype=np.int32))
                
                if not waveform_chunks:
                    continue

                full_wave = np.concatenate(waveform_chunks)
                current_len = len(full_wave)
                
                if current_len == target_length:
                    data_matrix[i, :, j] = full_wave
                elif current_len > target_length:
                    data_matrix[i, :, j] = full_wave[:target_length]
                else:
                    # Pad with zeros at the end
                    data_matrix[i, :current_len, j] = full_wave
        
        station_headers = [{'station': s} for s in stations]
        return station_headers, data_matrix

    def scan_active_stations(self, match_pattern="wave:*:*"):
        """
        Scan Redis for active stations and channels.
        Returns a dictionary {station: [channel1, channel2, ...]}
        """
        if not self.redis_client:
            return {}
            
        active_stations = {}
        try:
            # Use scan_iter for memory efficiency
            for key in self.redis_client.scan_iter(match=match_pattern):
                # key is bytes in some redis clients, but we set decode_responses=False
                # Wait, in __init__ decode_responses=False. So keys are bytes.
                if isinstance(key, bytes):
                    key_str = key.decode('utf-8')
                else:
                    key_str = key
                    
                parts = key_str.split(':')
                if len(parts) == 3:
                    _, station, channel = parts
                    if station not in active_stations:
                        active_stations[station] = []
                    active_stations[station].append(channel)
                    
        except Exception as e:
            logger.error(f"Error scanning active stations: {e}")
            
        return active_stations

    def publish_inference_results(self, model_tag, results):
        """
        Publish inference results to Redis Stream 'inference:{model_tag}:results'.
        results: list of dicts, e.g. [{'station': 'A', 'pga': 0.1, 'intensity': 1, 'timestamp': 1234567890}]
        """
        if not self.redis_client or not results:
            return

        stream_key = f"inference:{model_tag}:results"
        pipeline = self.redis_client.pipeline()
        
        for res in results:
            # Ensure all values are strings or numbers suitable for Redis
            # Redis streams store field-value pairs.
            # We can store the whole dict as fields.
            try:
                # Convert dict to flat key-value pairs for xadd
                # Note: xadd expects a dictionary mapping field names to values.
                # Values must be strings or bytes.
                entry = {}
                for k, v in res.items():
                    entry[str(k)] = str(v)
                
                pipeline.xadd(stream_key, entry)
            except Exception as e:
                logger.error(f"Error preparing result for Redis: {e}")
        
        try:
            pipeline.execute()
            # logger.info(f"Published {len(results)} inference results to {stream_key}")
        except Exception as e:
            logger.error(f"Error publishing inference results to Redis: {e}")


if __name__ == '__main__':
    # Example usage:
    adapter = RedisAdapter()
    
    logger.info("Starting continuous monitoring loop (Ctrl+C to stop)...")
    try:
        while True:
            # Auto-reconnect logic
            if not adapter.redis_client:
                logger.info("Attempting to connect to Redis...")
                if not adapter.connect():
                    logger.warning("Connection failed. Retrying in 5 seconds...")
                    time.sleep(5)
                    continue
            
            try:
                time.sleep(2)
                end_timestamp = time.time()
                
                # 1. Fetch picks from the last 30 seconds
                start_timestamp_picks = end_timestamp - 30
                picks = adapter.get_picks(start_timestamp_picks, end_timestamp)
                
                if not picks:
                    logger.info("No picks found.")
                    continue

                # 2. Extract unique stations from picks (already unique from adapter)
                target_stations = [p.get('station') for p in picks if p.get('station')]

                logger.info(f"Fetched {len(picks)} picks from {len(target_stations)} stations.")
                
                # 3. Fetch 30 seconds of wave data for these stations
                start_timestamp_wave = end_timestamp - 30
                
                fetch_start = time.time()
                headers, data_matrix = adapter.get_waveforms_bulk(
                    target_stations, 
                    start_timestamp_wave, 
                    end_timestamp,
                    channels=['HLZ', 'HLN', 'HLE']
                )
                fetch_time = time.time() - fetch_start
                
                if len(headers) == 0:
                    logger.warning("No wave data found for target stations.")
                    continue

                logger.info(f"Fetched {len(headers)} stations in {fetch_time:.4f}s. Data shape: {data_matrix.shape}")
                
                # Optional: Log summary per station to verify
                for i, header in enumerate(headers):
                    sta = header['station']
                    station_data = data_matrix[i]
                    
                    # Count non-zeros per channel to verify data presence
                    channel_counts = []
                    channels = ['HLZ', 'HLN', 'HLE']
                    for j, ch in enumerate(channels):
                        count = np.count_nonzero(station_data[:, j])
                        channel_counts.append(f"{ch}={count}")
                    
                    logger.info(f"Station {sta}: {', '.join(channel_counts)}")
                
            except (redis.ConnectionError, redis.TimeoutError) as e:
                logger.error(f"Redis connection error: {e}")
                adapter.redis_client = None # Force reconnect
                time.sleep(1)
            except Exception as e:
                logger.error(f"Unexpected error in main loop: {e}")
                time.sleep(1)
                
    except KeyboardInterrupt:
        logger.info("Stopping monitoring loop.")
