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
REDIS_HOST = 'redis'
REDIS_PORT = 6379
REDIS_DB = 0

# Model and Data Paths
VS30_REPO_ID = "SeisBlue/TaiwanVs30"
VS30_FILENAME = "Vs30ofTaiwan.nc"
MODEL_REPO_ID = "SeisBlue/TTSAM"
MODEL_FILENAME = "ttsam_trained_model_11.pt"
MODEL_DIR = "./weights"

SITE_INFO_FILE = "./station/site_info.csv"
TARGET_FILE = "./station/eew_target.csv"

# Signal Processing Constants
SAMPLING_RATE = 100
TARGET_LENGTH = 3000  # 30 seconds @ 100 Hz
MIN_DURATION = 30.0

# ============ Global Variables ============
tree = None
vs30_table = None
site_info = None
constant_dict = {}
target_dict = None
model = None

# ============ Helper Functions ============

def load_vs30():
    global tree, vs30_table
    try:
        logger.info("Loading Vs30 data from Hugging Face...")
        vs30_file = hf_hub_download(repo_id=VS30_REPO_ID, filename=VS30_FILENAME, repo_type="dataset", local_dir=MODEL_DIR)
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
    global site_info, constant_dict
    try:
        logger.info(f"Loading {SITE_INFO_FILE}...")
        df = pd.read_csv(SITE_INFO_FILE)
        
        # Populate constant_dict: (Station, Channel) -> Constant
        # Assuming columns "Station", "Channel", "Constant" exist
        if "Constant" in df.columns and "Channel" in df.columns:
            constant_dict = df.set_index(["Station", "Channel"])["Constant"].to_dict()
        else:
            logger.warning("Column 'Constant' or 'Channel' not found in site_info.csv. Using default constant.")
            constant_dict = {}
            
        site_info = df.drop_duplicates(subset=["Station"]).reset_index(drop=True)
        logger.info(f"Loaded {len(site_info)} stations and {len(constant_dict)} constants.")
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
        model_path = hf_hub_download(repo_id=MODEL_REPO_ID, filename=MODEL_FILENAME, local_dir=MODEL_DIR)
        model = get_full_model(model_path)
        model.eval() # Set to evaluation mode
        logger.info("Model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")

def lowpass(data, freq=10, df=100, corners=4, axis=0):
    fe = 0.5 * df
    f = freq / fe
    if f > 1:
        f = 1.0
    z, p, k = iirfilter(corners, f, btype="lowpass", ftype="butter", output="zpk")
    sos = zpk2sos(z, p, k)
    return sosfilt(sos, data, axis=axis)

def signal_processing(waveform, axis=0):
    data = detrend(waveform, axis=axis, type="constant")
    data = lowpass(data, freq=10, axis=axis)
    return data

# ============ Main Logic ============

def get_recent_picks(redis_adapter, lookback_seconds=60, max_picks=100):
    """
    Fetch recent picks from Redis using the adapter.
    Returns a list of pick dictionaries, sorted by pick_time.
    """
    now = time.time()
    start_time = now - lookback_seconds
    
    # Adapter now handles sorting and deduplication
    picks = redis_adapter.get_picks(start_time, now, max_picks=max_picks)
    
    return picks

# Constants
CHANNEL_MAP = {
    'Z': ['HLZ', 'EHZ', 'Z'],
    'N': ['HLN', 'EHN', 'N', '1'],
    'E': ['HLE', 'EHE', 'E', '2']
}
ALL_CHANNELS = list(set([ch for sublist in CHANNEL_MAP.values() for ch in sublist]))

def fetch_and_process_waveforms_from_picks(redis_adapter, picks, duration=30):
    """
    Fetch waveforms based on provided picks using bulk fetch.
    Selects top 25 unique stations from the sorted picks.
    """
    # Picks are already unique and sorted from adapter
    selected_picks = picks[:25]
    
    if not selected_picks:
        return [], [], []
        
    logger.info(f"Selected {len(selected_picks)} stations from picks.")

    # 2. Prepare for bulk fetch
    triggered_stations = [p.get('station') for p in selected_picks]
    
    # Determine time range
    min_pick_time = min(p.get('pick_time_float') for p in selected_picks)
    max_pick_time = max(p.get('pick_time_float') for p in selected_picks)
    
    fetch_start_time = min_pick_time
    fetch_end_time = max_pick_time + duration + 1 # +1 buffer

    # 3. Bulk Fetch
    headers, data_matrix = redis_adapter.get_waveforms_bulk(
        triggered_stations, 
        fetch_start_time, 
        fetch_end_time,
        channels=ALL_CHANNELS,
        sampling_rate=SAMPLING_RATE
    )
    
    # Mappings
    channel_to_idx = {ch: i for i, ch in enumerate(ALL_CHANNELS)}
    station_to_idx = {h['station']: i for i, h in enumerate(headers)}

    waveforms = []
    station_info_list = []
    valid_stations = []

    # 4. Process each station
    for p in selected_picks:
        station_code = p.get('station')
        pick_time = p.get('pick_time_float')
        
        if station_code not in station_to_idx:
            continue
            
        idx = station_to_idx[station_code]
        station_data = data_matrix[idx] # (Time, N_channels)
        
        # Calculate offset
        time_offset_seconds = pick_time - fetch_start_time
        start_sample = int(time_offset_seconds * SAMPLING_RATE)
        end_sample = start_sample + TARGET_LENGTH
        
        # Slice window
        s_start = max(0, start_sample)
        s_end = min(len(station_data), end_sample)
        
        if s_end <= s_start:
            continue
            
        window_data = station_data[s_start:s_end, :]
        
        # Pad locally if needed
        current_len = window_data.shape[0]
        if current_len < TARGET_LENGTH:
            padded = np.zeros((TARGET_LENGTH, len(ALL_CHANNELS)), dtype=np.int32)
            dest_start = max(0, -start_sample)
            dest_end = dest_start + current_len
            if dest_end <= TARGET_LENGTH:
                padded[dest_start:dest_end, :] = window_data
                window_data = padded
            else:
                continue
        elif current_len > TARGET_LENGTH:
             window_data = window_data[:TARGET_LENGTH, :]

        # Select best channels
        def get_channel_data(priority_list):
            for ch in priority_list:
                if ch in channel_to_idx:
                    ch_idx = channel_to_idx[ch]
                    trace = window_data[:, ch_idx]
                    if np.any(trace != 0):
                        return trace, ch
            return None, None

        z_data, z_ch = get_channel_data(CHANNEL_MAP['Z'])
        n_data, n_ch = get_channel_data(CHANNEL_MAP['N'])
        e_data, e_ch = get_channel_data(CHANNEL_MAP['E'])

        if z_data is None:
            continue
            
        # Fallback for missing components
        if n_data is None: 
            n_data = z_data.copy()
            n_ch = z_ch # Use Z constant if N is missing/copied? Or default? 
                        # If we copy Z data, we probably should use Z constant or just treat it as is.
                        # But strictly speaking, if we use Z data for N, it's already scaled by Z constant if we scale before copy.
                        # Let's scale AFTER copy to be safe, but wait, if we copy raw counts, we need N constant.
                        # If N is missing, we don't have N constant. 
                        # Let's assume if missing, we use default constant for the "virtual" channel or just Z's constant?
                        # Using Z's constant seems safer if we are copying Z's data.
        
        if e_data is None: 
            e_data = z_data.copy()
            e_ch = z_ch

        # Apply constants
        def apply_constant(data, station, channel):
            if channel is None:
                return data * 3.2e-6
            const = constant_dict.get((station, channel), 3.2e-6)
            return data * const

        z_data = apply_constant(z_data, station_code, z_ch)
        n_data = apply_constant(n_data, station_code, n_ch)
        e_data = apply_constant(e_data, station_code, e_ch)

        # Stack and Process
        waveform_3c = np.stack([z_data, n_data, e_data], axis=1) # (3000, 3)
        
        try:
            waveform_3c = signal_processing(waveform_3c, axis=0)
        except Exception as e:
            logger.warning(f"Signal processing failed for {station_code}: {e}")
            continue

        waveforms.append(waveform_3c)
        
        # Metadata
        station_row = site_info[site_info['Station'] == station_code]
        if not station_row.empty:
            lat = station_row.iloc[0]['Latitude']
            lon = station_row.iloc[0]['Longitude']
            elev = station_row.iloc[0]['Elevation']
        else:
            lat, lon, elev = 0, 0, 0

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

def calculate_intensity(pga):
    """
    Calculate CWA Seismic Intensity based on PGA (m/s^2).
    PGA input is in m/s^2.
    CWA Scale (2020):
    0: < 0.008 m/s^2 (0.8 gal)
    1: 0.008 - 0.025 m/s^2 (0.8 - 2.5 gal)
    2: 0.025 - 0.080 m/s^2 (2.5 - 8.0 gal)
    3: 0.080 - 0.250 m/s^2 (8.0 - 25.0 gal)
    4: 0.250 - 0.800 m/s^2 (25.0 - 80.0 gal)
    5-: 0.80 - 1.40 m/s^2 (80 - 140 gal)
    5+: 1.40 - 2.50 m/s^2 (140 - 250 gal)
    6-: 2.50 - 4.40 m/s^2 (250 - 440 gal)
    6+: 4.40 - 8.00 m/s^2 (440 - 800 gal)
    7: > 8.00 m/s^2 (> 800 gal)
    """
    # Convert to gal (cm/s^2) for easier comparison with standard tables if needed, 
    # but here we use m/s^2 directly as per thresholds.
    # Thresholds in m/s^2:
    if pga < 0.008: return "0"
    if pga < 0.025: return "1"
    if pga < 0.080: return "2"
    if pga < 0.250: return "3"
    if pga < 0.800: return "4"
    if pga < 1.400: return "5-"
    if pga < 2.500: return "5+"
    if pga < 4.400: return "6-"
    if pga < 8.000: return "6+"
    return "7"

def intensity_to_rank(intensity):
    """Convert intensity string to numeric rank for sorting."""
    intensity_map = {
        "0": 0, "1": 1, "2": 2, "3": 3, "4": 4,
        "5-": 5, "5+": 6, "6-": 7, "6+": 8, "7": 9
    }
    return intensity_map.get(intensity, 0)

def run_inference(waveforms, station_info_list, redis_adapter=None):
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

    # Output results sorted by intensity (highest to lowest)
    results = list(zip(all_target_names, all_pga_list))
    # Add intensity to each result for sorting
    results_with_intensity = [(name, pga, calculate_intensity(pga)) for name, pga in results]
    # Sort by intensity rank (highest first), then by PGA within same intensity
    results_with_intensity.sort(key=lambda x: (intensity_to_rank(x[2]), x[1]), reverse=True)
    
    max_pga = results_with_intensity[0][1] if results_with_intensity else 0.0
    max_intensity = results_with_intensity[0][2] if results_with_intensity else "0"
    logger.info(f"Inference Complete. Max PGA: {max_pga:.4f} m/s² (Intensity: {max_intensity}). Top 5 Predicted Intensity:")
    for name, pga, intensity in results_with_intensity[:5]:
        logger.info(f"{name}: {intensity}")
        
    # Publish to Redis
    if redis_adapter:
        publish_data = []
        timestamp = time.time()
        for name, pga, intensity in results_with_intensity:
            publish_data.append({
                'station': name,
                'pga': f"{pga:.6f}",
                'intensity': intensity,
                'timestamp': f"{timestamp:.6f}"
            })
        
        redis_adapter.publish_inference_results("ttsam", publish_data)
        logger.info(f"Published {len(publish_data)} results to Redis.")

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
    
    try:
        while True:
            # Loop to simulate real-time
            lookback = 10 # seconds
            # logger.info(f"Fetching picks from last {lookback} seconds...")
            
            picks = get_recent_picks(redis_adapter, lookback_seconds=lookback)
            
            if len(picks) >= 5:
                logger.info(f"Found {len(picks)} picks.")
                waveforms, station_info_list, _ = fetch_and_process_waveforms_from_picks(
                    redis_adapter, picks, duration=30
                )
                
                if waveforms:
                    run_inference(waveforms, station_info_list, redis_adapter=redis_adapter)
                else:
                    logger.warning("No waveforms could be extracted from the picks.")
            else:
                logger.info(f"{len(picks)} picks found in the last 10 seconds.")

            time.sleep(1)

    except KeyboardInterrupt:
        logger.info("Stopping inference demo.")

if __name__ == "__main__":
    main()
