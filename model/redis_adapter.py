import time
import redis
import numpy as np
import json
from loguru import logger

class RedisAdapter:
    def __init__(self, host='redis', port=6379, db=0):
        try:
            self.redis_client = redis.Redis(host=host, port=port, db=db, decode_responses=False)
            self.redis_client.ping()
            logger.info("Successfully connected to Redis.")
        except Exception as e:
            logger.error(f"Could not connect to Redis: {e}")
            self.redis_client = None

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
        """
        if not self.redis_client:
            logger.error("Redis client not available.")
            return []

        stream_key = "pick"
        start_id = f"{int(start_time * 1000)}-0"
        end_id = f"{int(end_time * 1000)}-0"

        try:
            messages = self.redis_client.xrange(stream_key, min=start_id, max=end_id, count=max_picks)
            picks = []
            for _, message in messages:
                if b'data' in message:
                    try:
                        pick_data = json.loads(message[b'data'])
                        picks.append(pick_data)
                    except Exception as e:
                        logger.warning(f"Failed to parse pick data: {e}. Raw message: {message}")
            return picks

        except Exception as e:
            logger.error(f"Error fetching picks from Redis: {e}")
            return []
            
    def get_waveforms_bulk(self, stream_keys, start_time, end_time):
        """
        Fetch waveform data for multiple streams in parallel using Redis Pipeline.
        Returns a dictionary {stream_key: numpy_array or None}
        """
        if not self.redis_client or not stream_keys:
            return {}

        start_id = f"{int(start_time * 1000)}-0"
        end_id = f"{int(end_time * 1000)}-0"
        
        pipeline = self.redis_client.pipeline()
        for key in stream_keys:
            pipeline.xrange(key, min=start_id, max=end_id)
        
        # Execute all commands in one go
        results = pipeline.execute()
        
        parsed_results = {}
        for key, messages in zip(stream_keys, results):
            if not messages:
                parsed_results[key] = None
                continue
                
            waveform_chunks = []
            for _, message in messages:
                if b'data' in message:
                    waveform_chunks.append(np.frombuffer(message[b'data'], dtype=np.int32))
            
            if waveform_chunks:
                parsed_results[key] = np.concatenate(waveform_chunks)
            else:
                parsed_results[key] = None
                
        return parsed_results

    def fetch_station_waves_optimized(self, stations, start_time, end_time, channels=['HLZ', 'HLN', 'HLE']):
        """
        Optimized fetch:
        1. Predicts keys (wave:{station}:{channel}) to avoid 'scan_iter'.
        2. Pipelines all requests.
        3. Returns (headers, data_matrix) where data_matrix is a 2D numpy array padded to max length.
        """
        if not self.redis_client or not stations:
            return [], np.array([])

        # 1. Generate all potential keys
        stream_keys = []
        key_map = [] # (station, channel, key)
        for station in stations:
            for channel in channels:
                key = f"wave:{station}:{channel}"
                stream_keys.append(key)
                key_map.append({'station': station, 'channel': channel, 'key': key})

        # 2. Bulk fetch
        raw_data = self.get_waveforms_bulk(stream_keys, start_time, end_time)
        
        # 3. Process and Pad
        valid_headers = []
        valid_waveforms = []
        
        for item in key_map:
            key = item['key']
            waveform = raw_data.get(key)
            if waveform is not None and len(waveform) > 0:
                valid_headers.append(item)
                valid_waveforms.append(waveform)
        
        if not valid_waveforms:
            return [], np.array([])
            
        # Pad to max length
        max_len = max(len(w) for w in valid_waveforms)
        # Ensure at least some length if all are empty (though check above handles it)
        
        padded_waveforms = []
        for w in valid_waveforms:
            if len(w) < max_len:
                padded = np.pad(w, (0, max_len - len(w)), mode='constant', constant_values=0)
                padded_waveforms.append(padded)
            else:
                padded_waveforms.append(w)
                
        data_matrix = np.array(padded_waveforms)
        
        return valid_headers, data_matrix

if __name__ == '__main__':
    # Example usage:
    adapter = RedisAdapter()
    if adapter.redis_client:
        logger.info("Starting continuous monitoring loop (Ctrl+C to stop)...")
        try:
            while True:
                end_timestamp = time.time()
                
                # 1. Fetch picks from the last 10 seconds
                start_timestamp_picks = end_timestamp - 10
                # logger.info(f"Fetching picks from {start_timestamp_picks} to {end_timestamp}")
                picks = adapter.get_picks(start_timestamp_picks, end_timestamp)
                
                if picks:
                    # 2. Extract unique stations from picks
                    target_stations = set()
                    for p in picks:
                        # Try common keys for station name (adjust based on actual pick format)
                        # Assuming 'station' or 'sta' key exists in the pick dictionary
                        sta = p.get('station') or p.get('sta')
                        if sta:
                            target_stations.add(sta)
                        else:
                            # Fallback: check if it's nested or has different structure
                            logger.warning(f"Could not extract station from pick: {p}")

                    logger.info(f"Successfully fetched {len(picks)} picks from {len(target_stations)} unique stations.")

                    if target_stations:
                        logger.info(f"Found stations in picks: {target_stations}")
                        
                        # 3. Fetch 30 seconds of wave data for these stations (Optimized)
                        start_timestamp_wave = end_timestamp - 30
                        
                        fetch_start = time.time()
                        # Assume standard channels for optimization. 
                        # If you need more, add them to the list e.g. ['HLZ', 'HLN', 'HLE', 'EHZ']
                        headers, data_matrix = adapter.fetch_station_waves_optimized(
                            list(target_stations), 
                            start_timestamp_wave, 
                            end_timestamp,
                            channels=['HLZ', 'HLN', 'HLE']
                        )
                        fetch_time = time.time() - fetch_start
                        
                        if len(headers) > 0:
                            logger.info(f"Fetched {len(headers)} streams in {fetch_time:.4f}s. Data shape: {data_matrix.shape}")
                            
                            # Optional: Log summary per station to verify
                            # Group by station for logging
                            station_stats = {}
                            for i, header in enumerate(headers):
                                sta = header['station']
                                ch = header['channel']
                                count = len(data_matrix[i])
                                # Note: data_matrix is padded, so count is max_len. 
                                # If we want actual length, we'd need to return it or trim zeros (if zeros are padding)
                                # But user asked for "padded to 30s", so showing shape is good.
                                if sta not in station_stats:
                                    station_stats[sta] = []
                                station_stats[sta].append(f"{ch}={count}")
                            
                            for sta, stats in station_stats.items():
                                logger.info(f"Station {sta}: {', '.join(stats)}")
                        else:
                            logger.warning("No wave data found for target stations.")
                    else:
                        logger.warning("No valid stations extracted from picks.")
                else:
                    # Optional: log a heartbeat or silence
                    # logger.debug("No picks found in the last 10 seconds.")
                    pass
                
                time.sleep(1)
                
        except KeyboardInterrupt:
            logger.info("Stopping monitoring loop.")
