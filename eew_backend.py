import argparse
import bisect
import json
import multiprocessing
import sys
import threading
import time
from datetime import datetime

import numpy as np
import pandas as pd
import PyEW
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi_socketio import SocketManager
from scipy.signal import detrend, iirfilter, sosfilt, zpk2sos
from loguru import logger

# 初始化 multiprocessing 共享物件
manager = multiprocessing.Manager()
wave_buffer = manager.dict()
wave_queue = manager.Queue()
pick_buffer = manager.dict()
report_queue = manager.Queue()
wave_endt = manager.Value("d", 0)
wave_speed_count = manager.Value("i", 0)

app = FastAPI()
# HTTP API 的 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# SocketIO 的 CORS（獨立處理 WebSocket）
socket_manager = SocketManager(app=app, cors_allowed_origins="*")

# 訂閱管理：追蹤每個客戶端訂閱的測站
subscribed_stations = {}  # {session_id: set(station_codes)}

"""
Web Server
"""


@socket_manager.on("connect")
def connect_earthworm(sid, environ):
    socket_manager.emit("connect_init", to=sid)


@socket_manager.on("subscribe_stations")
def handle_subscribe_stations(sid,data):
    """處理前端訂閱測站請求"""
    session_id = sid
    stations = data.get("stations", [])

    if stations:
        subscribed_stations[session_id] = set(stations)
        logger.info(
            f"📡 Client {session_id[:8]} subscribed to {len(stations)} stations"
        )
    else:
        # 清空訂閱
        if session_id in subscribed_stations:
            del subscribed_stations[session_id]
        logger.info(f"📡 Client {session_id[:8]} unsubscribed from all stations")


@socket_manager.on("disconnect")
def handle_disconnect(sid):
    """客戶端斷線時清理訂閱"""
    session_id = sid
    if session_id in subscribed_stations:
        del subscribed_stations[session_id]
        logger.info(f"🔌 Client {session_id[:8]} disconnected, subscription removed")


def _process_wave_data(wave, is_realtime=False):
    """處理單個波形數據，提取並格式化"""
    waveform_data = wave["data"]

    # 進行訊號處理
    processed_data = signal_processing(waveform_data)
    if processed_data is not None:
        waveform_data = processed_data

    if isinstance(waveform_data, np.ndarray):
        waveform_list = waveform_data.tolist()
        pga = float(np.max(np.abs(waveform_data)))
    elif isinstance(waveform_data, list):
        waveform_list = waveform_data
        pga = float(max(abs(x) for x in waveform_data)) if waveform_data else 0.0
    else:
        return None

    return {
        "waveform": waveform_list,
        "pga": pga,
        "status": "active",
        "startt": wave.get("startt", 0),
        "endt": wave.get("endt", 0),
        "samprate": wave.get("samprate", 100),
        "is_realtime": is_realtime,
    }



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

def wave_emitter():
    """按需推送波形數據 - 只發送被訂閱的測站"""
    batch_interval = 0.1
    last_send_time = time.time()

    while True:
        try:
            wave_batch = {}
            current_time = time.time()

            # 收集一定時間內的所有波形數據
            while current_time - last_send_time < batch_interval:
                try:
                    wave = wave_queue.get(timeout=0.05)
                    wave_id = join_id_from_dict(wave, order="NSLC")

                    if "Z" not in wave_id:
                        continue

                    # 處理波形數據
                    processed = _process_wave_data(wave, is_realtime=False)
                    if processed:
                        wave_batch[wave_id] = processed

                except:
                    pass

                current_time = time.time()

            # 發送數據
            if wave_batch and subscribed_stations:
                all_subscribed = set()
                for stations_set in subscribed_stations.values():
                    all_subscribed.update(stations_set)

                filtered_batch = {}
                for wave_id, wave_data in wave_batch.items():
                    station_code = wave_id.split(".")[1] if "." in wave_id else wave_id
                    if station_code in all_subscribed:
                        filtered_batch[wave_id] = wave_data

                if filtered_batch:
                    timestamp = int(time.time() * 1000)
                    wave_packet = {
                        "waveid": f"batch_{timestamp}",
                        "timestamp": timestamp,
                        "data": filtered_batch,
                    }
                    socket_manager.emit("wave_packet", wave_packet)
                    logger.debug(
                        f"📦 Batch sent: {len(filtered_batch)}/{len(wave_batch)} stations"
                    )

            last_send_time = current_time

        except Exception as e:
            logger.error(f"Error in wave_emitter: {e}")
            time.sleep(0.1)
            continue


def report_emitter():
    while True:
        report_data = report_queue.get()
        if not report_data:
            continue

        socket_manager.emit("report_data", report_data)


def web_server():
    """啟動 Web Server 與 socket_manager"""
    logger.info("Starting web server...")

    # 啟動背景資料發送執行緒
    threading.Thread(target=wave_emitter, daemon=True).start()
    threading.Thread(target=report_emitter, daemon=True).start()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port)


"""
Earthworm Wave Listener
"""

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


def wave_array_init(sample_rate, buffer_time, fill_value):
    return np.full(sample_rate * buffer_time, fill_value=fill_value)


def time_array_init(sample_rate, buffer_time, start_time, end_time, data_length):
    """
    生成一個時間序列，包含前後兩段
    後段從 start_time 內插至 end_time (確定的時間序列)
    前段從 start_time 外插至 buffer 開始點 (往前預估的時間序列)
    """
    return np.append(
        np.linspace(
            start_time - (buffer_time - 1),
            start_time,
            sample_rate * (buffer_time - 1),
        ),
        np.linspace(start_time, end_time, data_length),
    )


def slide_array(array, data):
    array = np.append(array, data)
    return array[data.size :]


def earthworm_wave_listener(buf_ring):
    buffer_time = 30  # 設定緩衝區保留時間
    sample_rate = 100  # 設定取樣率

    # 預先計算常數，避免重複查詢
    wave_constant_cache = {}
    wave_buffer_local = {}  # 本地緩存，減少 Manager.dict 訪問

    while True:
        if not earthworm.mod_sta():
            continue

        wave = earthworm.get_wave(buf_ring)
        if not wave:
            continue

        # 快速時間檢查（最早過濾）
        wave_endt_val = wave["endt"]
        current_time = time.time()
        if wave_endt_val < current_time - 3 or wave_endt_val > current_time + 1:
            continue

        # 得到最新的 wave 結束時間
        wave_endt.value = wave_endt_val

        try:
            # 內聯 convert_to_tsmip_legacy_naming，避免函數調用
            network = wave["network"]
            if network == "TW":
                network = "SM"
                location = "01"
            else:
                location = wave["location"]

            station = wave["station"]
            channel = wave["channel"]

            # 內聯 join_id_from_dict，避免字串操作開銷
            wave_id = f"{network}.{station}.{location}.{channel}"

            # 快速檢查是否為 Z 通道（提前判斷）
            is_z_channel = "Z" in wave_id

            # 使用緩存獲取 wave_constant
            cache_key = (station, channel)
            if cache_key not in wave_constant_cache:
                try:
                    wave_constant_cache[cache_key] = constant_dict[cache_key]
                except:
                    wave_constant_cache[cache_key] = 3.2e-6

            # 直接在原數據上乘以常數，避免複製
            wave_data = wave["data"] * wave_constant_cache[cache_key]
            wave["data"] = wave_data

            # 將 wave_id 加入 wave_queue 給 wave_emitter 發送至前端
            if is_z_channel:
                wave_queue.put(wave)

            # add new trace to buffer - 使用本地緩存
            if wave_id not in wave_buffer_local:
                # 檢查是否在共享 buffer 中
                if wave_id not in wave_buffer.keys():
                    # wave_buffer 初始化時全部填入 wave 的平均值
                    init_array = wave_array_init(
                        sample_rate, buffer_time, fill_value=wave_data.mean()
                    )
                    wave_buffer[wave_id] = init_array
                    wave_buffer_local[wave_id] = init_array
                else:
                    wave_buffer_local[wave_id] = wave_buffer[wave_id]

            # 更新 buffer
            updated_array = slide_array(wave_buffer_local[wave_id], wave_data)
            wave_buffer_local[wave_id] = updated_array
            wave_buffer[wave_id] = updated_array

            wave_speed_count.value += 1

        except Exception as e:
            logger.error(f"earthworm_wave_process error {e}")


"""
Earthworm Pick Listener
"""


def parse_pick_msg(pick_msg):
    pick_msg_column = pick_msg.split()
    try:
        pick = {
            "station": pick_msg_column[0],
            "channel": pick_msg_column[1],
            "network": pick_msg_column[2],
            "location": pick_msg_column[3],
            "lon": pick_msg_column[4],
            "lat": pick_msg_column[5],
            "pga": pick_msg_column[6],
            "pgv": pick_msg_column[7],
            "pd": pick_msg_column[8],
            "tc": pick_msg_column[9],  # Average period
            "pick_time": pick_msg_column[10],
            "weight": pick_msg_column[11],  # 0:best 5:worst
            "instrument": pick_msg_column[12],  # 1:Acc 2:Vel
            "update_sec": pick_msg_column[13],  # sec after pick
        }

        pick["pickid"] = join_id_from_dict(pick, order="NSLC")

        return pick

    except IndexError as e:
        logger.error(f"pick_msg parsing error: {pick_msg_column}, {e}")


def earthworm_pick_listener(buf_ring):
    """
    監看 pick ring 的訊息，並將 pick 加入 pick_buffer
    pick msg 的時間窗為 p 波後 2-10 秒
    ref: pick_ew_new/pick_ra_0709.c line 283
    """
    event_window = 10
    while True:
        try:
            # 超時移除 pick
            for pick_id, buffer_pick in pick_buffer.items():
                if float(buffer_pick["sys_time"]) + event_window < time.time():
                    pick_buffer.__delitem__(pick_id)
                    logger.debug(f"delete pick: {pick_id}")
        except BrokenPipeError:
            break

        except Exception as e:
            logger.error(f"delete pick error: {pick_id}, {e}")

        # 取得 pick msg
        pick_msg = earthworm.get_msg(buf_ring=buf_ring, msg_type=0)
        if not pick_msg:
            time.sleep(0.00001)
            continue
        logger.debug(f"{pick_msg}")

        # PickRing trace gap 太大會有 Restarting 的訊息
        if "Restarting" in pick_msg:
            continue

        # PickRing 的未知短訊息，如：1732070774 124547
        if len(pick_msg.split()) < 13:
            continue

        try:
            pick_data = parse_pick_msg(pick_msg)
            pick_id = join_id_from_dict(pick_data, order="NSLC")

            # 跳過程式啟動前殘留在 shared memory 的 Pick
            if time.time() > float(pick_data["pick_time"]) + 10:
                continue

            # upsec 為 2 秒時加入 pick
            if pick_data["update_sec"] == "2":
                print(pick_msg)
                sys.stdout.flush()

                # 以系統時間作為時間戳記
                pick_data["sys_time"] = time.time()
                pick_buffer[pick_id] = pick_data
                logger.debug(f"add pick: {pick_id}")

        except Exception as e:
            logger.error(f"earthworm_pick_listener error: {pick_msg}, {e}")
            continue
        time.sleep(0.00001)


"""
Earthworm EEW Listener
"""


def earthworm_eew_listener(buf_ring):
    while True:
        try:
            # 取得 pick msg
            eew_msg = earthworm.get_msg(buf_ring=buf_ring, msg_type=0)
            if not eew_msg:
                time.sleep(0.00001)
                continue
            print(eew_msg)
            sys.stdout.flush()
            logger.debug(f"{eew_msg}")

        except Exception as e:
            logger.error(f"earthworm_eew_listener error: {eew_msg}, {e}")
            continue
        time.sleep(0.00001)


# Load target station
target_file = "/workspace/station/eew_target.csv"
try:
    logger.info(f"Loading {target_file}...")
    target_df = pd.read_csv(target_file)
    target_dict = target_df.to_dict(orient="records")
    logger.info(f"{target_file} loaded")

except FileNotFoundError:
    logger.error(f"{target_file} not found")

# Load all stations from site_info.csv (for secondary stations display)
all_stations_dict = []
site_info_file = "/workspace/station/site_info.csv"
try:
    logger.info(f"Loading {site_info_file}...")
    site_info_df = pd.read_csv(site_info_file)

    # 只取 HLZ 通道且仍在運作的測站（End_time = 2599-12-31）
    active_stations = site_info_df[
        (site_info_df["Channel"] == "HLZ") & (site_info_df["End_time"] == "2599-12-31")
    ].copy()

    # 去重（同一測站可能有多條記錄）
    active_stations = active_stations.drop_duplicates(subset=["Station"])

    # 轉換為字典格式
    all_stations_dict = (
        active_stations[["Station", "Latitude", "Longitude"]]
        .rename(
            columns={
                "Station": "station",
                "Latitude": "latitude",
                "Longitude": "longitude",
            }
        )
        .to_dict(orient="records")
    )

    logger.info(
        f"Loaded {len(all_stations_dict)} active stations from {site_info_file}"
    )

except FileNotFoundError:
    logger.warning(
        f"{site_info_file} not found, secondary stations will not be available"
    )
except Exception as e:
    logger.error(f"Error loading {site_info_file}: {e}")



def calculate_intensity(pga, pgv=None, label=False):
    try:
        intensity_label = ["0", "1", "2", "3", "4", "5-", "5+", "6-", "6+", "7"]
        pga_level = np.log10(
            [1e-5, 0.008, 0.025, 0.080, 0.250, 0.80, 1.4, 2.5, 4.4, 8.0]
        )  # log10(m/s^2)

        pgv_level = np.log10(
            [1e-5, 0.002, 0.007, 0.019, 0.057, 0.15, 0.3, 0.5, 0.8, 1.4]
        )  # log10(m/s)

        pga_intensity = bisect.bisect(pga_level, pga) - 1
        intensity = pga_intensity

        if pga > pga_level[5] and pgv is not None:
            pgv_intensity = bisect.bisect(pgv_level, pgv) - 1
            if pgv_intensity > pga_intensity:
                intensity = pgv_intensity

        if label:
            return intensity_label[intensity]

        else:
            return intensity

    except Exception as e:
        logger.error(f"calculate_intensity error: {e}")



def loading_animation(pick_threshold):
    pick_counts = len(pick_buffer)
    loading_chars = ["-", "\\", "|", "/"]

    # 無限循環顯示 loading 動畫
    wave_speed_count.value = 0
    start_time = time.time()
    for char in loading_chars:
        # 清除上一個字符
        sys.stdout.write("\r" + " " * 30 + "\r")
        sys.stdout.flush()

        wave_count = len(wave_buffer)

        wave_timestring = datetime.fromtimestamp(float(wave_endt.value)).strftime(
            "%Y-%m-%d %H:%M:%S.%f"
        )

        delay = time.time() - wave_endt.value

        delta = time.time() - start_time
        wave_process_rate = wave_speed_count.value / delta if delta > 0 else 0

        # 顯示目前的 loading 字符
        sys.stdout.write(
            f"{wave_count} waves: {wave_timestring[:-3]} rate: {wave_process_rate:.3f} lag:{delay:.3f}s picks:{pick_counts}/{pick_threshold} {char} "
        )
        sys.stdout.flush()
        time.sleep(0.1)

def convert_intensity(value):
    if value.endswith("+"):
        return float(value[:-1]) + 0.25
    elif value.endswith("-"):
        return float(value[:-1]) - 0.25
    else:
        return float(value)


def reporter():
    """
    累積發送預警之測站，辨識其行政區，每隔一秒檢查是否有新增行政區，避免在短時間內重複發送警報，如果 pick < 5 則重置
    """
    station_list = []
    station_info = {}
    for target in target_dict:
        station_list.append(target["station"])
        station_info[target["station"]] = {
            "station_zh": target["station_zh"],
            "county": target["county"],
        }

    alarm_county = {}
    past_alarm_county = {}
    new_alarm_county = {}
    start_time = time.time()
    while True:
        report = report_queue.get()

        for station in station_list:
            intensity = report.get(station, "N/A")
            if intensity in ["4", "5-", "5+", "6-", "6+", "7"]:
                county = station_info[station]["county"]
                if county not in alarm_county:
                    alarm_county[county] = intensity
                else:
                    alarm_county[county] = max(
                        alarm_county[county], intensity, key=convert_intensity
                    )

        if time.time() - start_time < 1:
            time.sleep(0.1)
            continue

        for county, intensity in alarm_county.items():
            if county not in past_alarm_county:
                new_alarm_county[county] = intensity

            elif convert_intensity(intensity) > convert_intensity(
                past_alarm_county[county]
            ):
                new_alarm_county[county] = intensity

        if new_alarm_county:
            report["alarm_county"] = alarm_county
            report["new_alarm_county"] = new_alarm_county
            format_report = format_earthquake_report(report)
            print(format_report)
            sys.stdout.flush()

            with open(
                f"/workspace/logs/format_report/text_report_{report['format_time']}.log",
                "a",
            ) as f:
                f.write(format_report + "\n")


            past_alarm_county.update(new_alarm_county)
            new_alarm_county = {}

        start_time = time.time()

        if len(pick_buffer) < 5:
            alarm_county = {}
            new_alarm_county = {}
            past_alarm_county = {}


def format_earthquake_report(raw_report):
    report_lines = []
    report_lines.append("--------------------------------------------------")
    report_lines.append("【地震預警報告】")
    report_lines.append("")

    # 摘要部分
    report_lines.append(f"警報時間：{raw_report['report_time']}")
    report_lines.append("")
    if "new_alarm_county" in raw_report:
        report_lines.append("【新增警報】")
        county_list = []
        for county, intensity in raw_report["new_alarm_county"].items():
            county_list.append([intensity, county])
        county_list = sorted(
            county_list, key=lambda x: convert_intensity(x[0]), reverse=True
        )
        for intensity, county in county_list:
            report_lines.append(f"{county}：{intensity} 級以上")

        report_lines.append("")

    # 詳細技術資訊部分
    report_lines.append("【系統資訊】")
    report_lines.append(f"波形延遲：{raw_report['wave_lag']:.2f} 秒")
    report_lines.append(f"累積波型：{raw_report['wave_time']:.2f} 秒")
    report_lines.append(f"計算時間：{raw_report['run_time']:.4f} 秒")
    report_lines.append("")
    report_lines.append("--------------------------------------------------")

    return "\n".join(report_lines)


if __name__ == "__main__":
    logger.info("TTSAM Realtime Start")
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", type=str, default="0.0.0.0", help="web server ip")
    parser.add_argument("--port", type=int, default=5001, help="web server port")
    parser.add_argument(
        "--env",
        type=str,
        default="test",
        choices=["cwa", "test", "jimmy"],
        help="set environment",
    )
    parser.add_argument(
        "--verbose-level",
        type=str,
        default="INFO",
        help="change verbose level: ERROR, WARNING, INFO, DEBUG",
    )
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        help="change log level: ERROR, WARNING, INFO, DEBUG",
    )
    args = parser.parse_args()
    processes = []

    # get config
    config_file = "ttsam_config.json"
    try:
        config = json.load(open(config_file, "r"))
        logger.info(f"{config_file} loaded")
    except FileNotFoundError:
        config = {
            "mqtt": {
                "username": "ttsam",
                "password": "ttsam",
                "host": "0.0.0.0",
                "port": 1883,
                "topic": "ttsam",
            },
            "discord": {
                "webhook_url": "webhook",
                "proxies": {"http": "proxy", "https": "proxy"},
            },
        }
        logger.warning(f"{config_file} not found, using default config")

    # 配置日誌設置
    logger.remove()
    logger.add(sys.stderr, level=args.verbose_level, backtrace=True, diagnose=True)
    logger.add(
        "/workspace/logs/ttsam_error.log",
        rotation="1 week",
        level=args.log_level,
        enqueue=True,
        backtrace=True,
    )

    earthworm_param = {
        "test": {
            "inst_id": 255,
            "wave": {"WAVE_RING_CWASN": 1000, "WAVE_RING_TSMIP": 1030},
            "pick": {"PICK_RING": 1005},
            "eew": {"EEW_RING": 1035},
        },
        "jimmy": {
            "inst_id": 255,
            "wave": {"WAVE_RING_TSMIP": 1034},
            "pick": {"PICK_RING": 1005},
            "eew": {},
        },
        "cwa": {
            "inst_id": 52,
            "wave": {"WAVE_RING_TSMIP": 1034},
            "pick": {"PICK_RING": 1005},
            "eew": {},
        },
    }
    ring_order = []  # 新增：追蹤 ring 添加順序
    earthworm = PyEW.EWModule(
        def_ring=1000,
        mod_id=2,
        inst_id=earthworm_param[args.env]["inst_id"],
        hb_time=30,
        db=False,
    )

    # 添加 wave rings（根據 env 動態添加）
    for ring_name, ring_id in earthworm_param[args.env]["wave"].items():
        earthworm.add_ring(ring_id)
        ring_order.append(ring_name)
        buf_ring = len(ring_order) - 1
        processes.append(
            multiprocessing.Process(target=earthworm_wave_listener, kwargs={"buf_ring": buf_ring})
        )
        logger.info(f"Added ring{len(ring_order) - 1}: {ring_name} with ID {ring_id}")

    # 添加 pick rings（根據 env 動態添加）
    for ring_name, ring_id in earthworm_param[args.env]["pick"].items():
        earthworm.add_ring(ring_id)
        ring_order.append(ring_name)
        buf_ring = len(ring_order) - 1
        processes.append(
            multiprocessing.Process(target=earthworm_pick_listener, kwargs={"buf_ring": buf_ring})
        )
        logger.info(f"Added ring{len(ring_order) - 1}: {ring_name} with ID {ring_id}")

    # 添加 eew rings（根據 env 動態添加）
    for ring_name, ring_id in earthworm_param[args.env]["eew"].items():
        earthworm.add_ring(ring_id)
        ring_order.append(ring_name)
        buf_ring = len(ring_order) - 1
        processes.append(
            multiprocessing.Process(target=earthworm_eew_listener,
                                    kwargs={"buf_ring": buf_ring})
        )
        logger.info(
            f"Added ring{len(ring_order) - 1}: {ring_name} with ID {ring_id}")

    logger.info(f"{args.env} env, inst_id = {earthworm_param[args.env]['inst_id']}")


    processes.append(multiprocessing.Process(target=reporter))

    for p in processes:
        p.start()
