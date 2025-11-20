import time
import numpy as np
import pandas as pd
import torch
import redis
import json
from huggingface_hub import hf_hub_download
from loguru import logger
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
from scipy.spatial import cKDTree
import xarray as xr

# Import from local modules
from ttsam import get_full_model
from redis_adapter import RedisAdapter

# ============ Configuration ============
REDIS_HOST = 'localhost'
REDIS_PORT = 6379
REDIS_DB = 0

# Model and Data Paths
VS30_REPO_ID = "SeisBlue/TaiwanVs30"
VS30_FILENAME = "Vs30ofTaiwan.nc"
MODEL_REPO_ID = "SeisBlue/TTSAM"
MODEL_FILENAME = "ttsam_trained_model_11.pt"

SITE_INFO_FILE = "../station/site_info.csv"
TARGET_FILE = "../station/eew_target.csv"

# Signal Processing Constants
SAMPLING_RATE = 100
TARGET_LENGTH = 3000  # 30 seconds @ 100 Hz
MIN_DURATION = 30.0

# ============ Global Variables ============
tree = None
vs30_table = None
site_info = None
target_dict = None
model = None

# ============ Helper Functions ============

def load_vs30():
    global tree, vs30_table
    try:
        logger.info("Loading Vs30 data from Hugging Face...")
        vs30_file = hf_hub_download(repo_id=VS30_REPO_ID, filename=VS30_FILENAME, repo_type="dataset")
        ds = xr.open_dataset(vs30_file)
        lat_flat = ds["lat"].values.flatten()
        lon_flat = ds["lon"].values.flatten()
        vs30_flat = ds["vs30"].values.flatten()

        vs30_table = pd.DataFrame({"lat": lat_flat, "lon": lon_flat, "Vs30": vs30_flat})
        vs30_table = vs30_table.replace([np.inf, -np.inf], np.nan).dropna()
        tree = cKDTree(vs30_table[["lat", "lon"]])
        logger.info("Vs30 data loaded successfully.")
    except Exception as e:
        logger.warning(f"Failed to load Vs30 data: {e}")
        logger.warning("Using default Vs30 value (600 m/s)")

def get_vs30(lat, lon, user_vs30=600):
    if tree is None or vs30_table is None:
        return float(user_vs30)
    distance, i = tree.query([float(lat), float(lon)])
    vs30 = vs30_table.iloc[i]["Vs30"]
    return float(vs30)

def load_station_info():
    global site_info
    try:
        logger.info(f"Loading {SITE_INFO_FILE}...")
        site_info = pd.read_csv(SITE_INFO_FILE)
        site_info = site_info.drop_duplicates(subset=["Station"]).reset_index(drop=True)
        logger.info(f"Loaded {len(site_info)} stations.")
    except Exception as e:
        logger.error(f"Failed to load site info: {e}")

def load_target_info():
    global target_dict
    try:
        logger.info(f"Loading {TARGET_FILE}...")
        target_df = pd.read_csv(TARGET_FILE)
        target_dict = target_df.to_dict(orient="records")
        logger.info(f"Loaded {len(target_dict)} targets.")
    except Exception as e:
        logger.error(f"Failed to load target info: {e}")

def load_model():
    global model
    try:
        logger.info("Loading TTSAM model...")
        model_path = hf_hub_download(repo_id=MODEL_REPO_ID, filename=MODEL_FILENAME)
        model = get_full_model(model_path)
        model.eval() # Set to evaluation mode
        logger.info("Model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")

def lowpass(data, freq=10, df=100, corners=4):
    fe = 0.5 * df
    f = freq / fe
    if f > 1:
        f = 1.0
    z, p, k = iirfilter(corners, f, btype="lowpass", ftype="butter", output="zpk")
    sos = zpk2sos(z, p, k)
    return sosfilt(sos, data)

def signal_processing(waveform):
    data = detrend(waveform, type="constant")
    data = lowpass(data, freq=10)
    return data

# ============ Main Logic ============

def get_recent_picks(redis_client, lookback_seconds=60, max_picks=100):
    """
    Fetch recent picks from Redis 'pick' stream.
    Returns a list of pick dictionaries, sorted by pick_time.
    """
    stream_key = "pick"
    # Calculate min ID for lookback (approximate)
    # Redis stream IDs are timestamp-based (ms)
    min_id = int((time.time() - lookback_seconds) * 1000)
    
    try:
        # Fetch from stream
        # We use xrange to get picks in the time window
        messages = redis_client.xrange(stream_key, min=min_id, max="+", count=max_picks)
        
        picks = []
        for msg_id, msg_data in messages:
            if b'data' in msg_data:
                try:
                    # Data is JSON string
                    pick_data = json.loads(msg_data[b'data'])
                    picks.append(pick_data)
                except Exception as e:
                    logger.warning(f"Failed to parse pick data: {e}")
        
        # Sort by pick_time (ascending)
        for p in picks:
            try:
                p['pick_time_float'] = float(p['pick_time'])
            except:
                p['pick_time_float'] = 0.0
                
        picks.sort(key=lambda x: x['pick_time_float'])
        
        return picks
    except Exception as e:
        logger.error(f"Error fetching picks from Redis: {e}")
        return []

def fetch_and_process_waveforms_from_picks(redis_adapter, picks, duration=30):
    """
    Fetch waveforms based on provided picks.
    Selects top 25 unique stations from the sorted picks.
    """
    waveforms = []
    station_info_list = []
    valid_stations = []
    
    unique_stations = set()
    selected_picks = []
    
    # Filter for unique stations, up to 25
    for p in picks:
        sta = p.get('station')
        if sta not in unique_stations:
            unique_stations.add(sta)
            selected_picks.append(p)
            if len(selected_picks) >= 25:
                break
    
    logger.info(f"Selected {len(selected_picks)} stations from picks.")

    channel_map = {
        'Z': ['HLZ', 'EHZ', 'Z'],
        'N': ['HLN', 'EHN', 'N', '1'],
        'E': ['HLE', 'EHE', 'E', '2']
    }

    for p in selected_picks:
        station_code = p.get('station')
        pick_time = p.get('pick_time_float')
        
        start_time = pick_time
        end_time = start_time + duration
        
        # Find station in site_info
        station_row = site_info[site_info['Station'] == station_code]
        if station_row.empty:
            logger.warning(f"Station {station_code} not found in site_info.")
            continue
            
        lat = station_row.iloc[0]['Latitude']
        lon = station_row.iloc[0]['Longitude']
        elev = station_row.iloc[0]['Elevation']

        # Fetch Z component
        z_data = None
        for ch in channel_map['Z']:
            z_data = redis_adapter.get_waveform_data(station_code, ch, start_time, end_time)
            if z_data is not None and len(z_data) > 0:
                break
        
        if z_data is None:
            # logger.debug(f"Station {station_code}: No Z component found.")
            continue

        # Fetch N component
        n_data = None
        for ch in channel_map['N']:
            n_data = redis_adapter.get_waveform_data(station_code, ch, start_time, end_time)
            if n_data is not None and len(n_data) > 0:
                break
        
        # Fetch E component
        e_data = None
        for ch in channel_map['E']:
            e_data = redis_adapter.get_waveform_data(station_code, ch, start_time, end_time)
            if e_data is not None and len(e_data) > 0:
                break

        # Handle missing components
        if n_data is None:
            n_data = z_data.copy()
        if e_data is None:
            e_data = z_data.copy()

        # Signal Processing
        try:
            z_data = signal_processing(z_data)
            n_data = signal_processing(n_data)
            e_data = signal_processing(e_data)
        except Exception as e:
            logger.warning(f"Signal processing failed for {station_code}: {e}")
            continue

        # Pad/Truncate to TARGET_LENGTH
        waveform_3c = np.zeros((TARGET_LENGTH, 3))
        z_len = min(len(z_data), TARGET_LENGTH)
        n_len = min(len(n_data), TARGET_LENGTH)
        e_len = min(len(e_data), TARGET_LENGTH)

        waveform_3c[:z_len, 0] = z_data[:z_len]
        waveform_3c[:n_len, 1] = n_data[:n_len]
        waveform_3c[:e_len, 2] = e_data[:e_len]

        waveforms.append(waveform_3c)
        
        vs30 = get_vs30(lat, lon)
        station_info_list.append([lat, lon, elev, vs30])
        valid_stations.append({
            "Station": station_code,
            "Latitude": lat,
            "Longitude": lon,
            "Elevation": elev,
            "PickTime": pick_time
        })

    return waveforms, station_info_list, valid_stations

def run_inference(waveforms, station_info_list):
    if not waveforms:
        logger.warning("No waveforms to process.")
        return

    # Padding to 25 stations
    max_stations = 25
    waveform_padded = np.zeros((max_stations, 3000, 3))
    station_info_padded = np.zeros((max_stations, 4))

    num_stations = min(len(waveforms), max_stations)
    for i in range(num_stations):
        waveform_padded[i] = waveforms[i]
        station_info_padded[i] = station_info_list[i]

    # Prepare targets (batch processing)
    batch_size = 25
    total_targets = len(target_dict)
    num_batches = (total_targets + batch_size - 1) // batch_size
    
    all_pga_list = []
    all_target_names = []

    logger.info(f"Running inference for {num_stations} stations...")

    for batch_idx in range(num_batches):
        start_idx = batch_idx * batch_size
        end_idx = min((batch_idx + 1) * batch_size, total_targets)
        batch_targets = target_dict[start_idx:end_idx]

        target_list = []
        target_names = []
        for target in batch_targets:
            target_list.append([
                target["latitude"],
                target["longitude"],
                target["elevation"],
                get_vs30(target["latitude"], target["longitude"])
            ])
            target_names.append(target["station"])

        target_padded = np.zeros((batch_size, 4))
        for i in range(len(target_list)):
            target_padded[i] = target_list[i]

        tensor_data = {
            "waveform": torch.tensor(waveform_padded).unsqueeze(0).double().to(next(model.parameters()).device),
            "station": torch.tensor(station_info_padded).unsqueeze(0).double().to(next(model.parameters()).device),
            "target": torch.tensor(target_padded).unsqueeze(0).double().to(next(model.parameters()).device),
        }

        with torch.no_grad():
            weight, sigma, mu = model(tensor_data)
            batch_pga = torch.sum(weight * mu, dim=2).cpu().detach().numpy().flatten().tolist()

        all_pga_list.extend(batch_pga[:len(target_names)])
        all_target_names.extend(target_names)

    # Output results (Top 5 PGA)
    results = list(zip(all_target_names, all_pga_list))
    results.sort(key=lambda x: x[1], reverse=True)
    
    logger.info("Inference Complete. Top 5 Predicted PGA:")
    for name, pga in results[:5]:
        logger.info(f"{name}: {pga:.4f} m/s²")

def main():
    # Initialize
    load_vs30()
    load_station_info()
    load_target_info()
    load_model()
    
    redis_adapter = RedisAdapter(host=REDIS_HOST, port=REDIS_PORT, db=REDIS_DB)
    if not redis_adapter.redis_client:
        logger.error("Could not connect to Redis. Exiting.")
        return

    logger.info("Starting Redis Inference Demo (Pick-Triggered)...")
    
    # Loop to simulate real-time or just run once
    # For demo, let's try to fetch picks from the last minute
    
    lookback = 60 # seconds
    logger.info(f"Fetching picks from last {lookback} seconds...")
    
    picks = get_recent_picks(redis_adapter.redis_client, lookback_seconds=lookback)
    
    if picks:
        logger.info(f"Found {len(picks)} picks.")
        waveforms, station_info_list, _ = fetch_and_process_waveforms_from_picks(
            redis_adapter, picks, duration=30
        )
        
        if waveforms:
            run_inference(waveforms, station_info_list)
        else:
            logger.warning("No waveforms could be extracted from the picks.")
    else:
        logger.warning("No picks found in the last 60 seconds. Waiting for picks...")

if __name__ == "__main__":
    main()
