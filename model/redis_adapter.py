import redis
import numpy as np
import json
from loguru import logger

class RedisAdapter:
    def __init__(self, host='localhost', port=6379, db=0):
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
                    waveform_chunks.append(np.frombuffer(message[b'data'], dtype=np.float64)) # Assuming float64, adjust if needed

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
                        logger.warning(f"Failed to parse pick data: {e}")
            return picks

        except Exception as e:
            logger.error(f"Error fetching picks from Redis: {e}")
            return []

if __name__ == '__main__':
    # Example usage:
    adapter = RedisAdapter()
    if adapter.redis_client:
        # These are placeholder values. Replace with actual station, channel, and time range.
        station_code = "TEST"
        channel_code = "EHZ"
        start_timestamp = 0 # Replace with a real start timestamp
        end_timestamp = 30 # Replace with a real end timestamp

        waveform = adapter.get_waveform_data(station_code, channel_code, start_timestamp, end_timestamp)
        if waveform is not None:
            logger.info(f"Successfully fetched waveform data with {len(waveform)} samples.")
        else:
            logger.warning("Failed to fetch waveform data.")
            
        picks = adapter.get_picks(start_timestamp, end_timestamp)
        if picks:
            logger.info(f"Successfully fetched {len(picks)} picks.")
        else:
            logger.warning("Failed to fetch picks.")
