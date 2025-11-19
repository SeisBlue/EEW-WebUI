/**
 * 根據震度字串取得對應的數值，以便排序
 * @param {string} intensityStr - 例如 "4", "5-", "5+"
 * @returns {number}
 */
export function getIntensityValue(intensityStr) {
  if (!intensityStr || typeof intensityStr !== 'string') return 0;
  const mapping = {
    '5-': 5.0,
    '5+': 5.5,
    '6-': 6.0,
    '6+': 6.5,
  };
  return mapping[intensityStr] || parseFloat(intensityStr) || 0;
}

/**
 * 取得震度對應的顏色
 * @param {string} intensity - 例如 "4", "5-", "5+"
 * @returns {Array<number>} - [R, G, B] 顏色陣列
 */
export function getIntensityColor(intensity) {
  switch (intensity) {
    case "0": return [255, 255, 255];     // #ffffff 白色
    case "1": return [51, 255, 221];      // #33FFDD 青色
    case "2": return [52, 255, 50];       // #34ff32 綠色
    case "3": return [254, 253, 50];      // #fefd32 黃色
    case "4": return [254, 133, 50];      // #fe8532 橙色
    case "5-": return [253, 82, 51];      // #fd5233 紅色
    case "5+": return [196, 63, 59];      // #c43f3b 深紅
    case "6-": return [157, 70, 70];      // #9d4646 暗紅
    case "6+": return [154, 76, 134];     // #9a4c86 紫紅
    case "7": return [181, 31, 234];      // #b51fea 紫色
    default: return [148, 163, 184];      // #94a3b8 灰色（未知）
  }
}

/**
 * 檢查測站是否為 TSMIP 格式
 * @param {string} stationCode
 */
export function isTSMIPStation(stationCode) {
  return /^[ABCDEFGH]\d{3}$/.test(stationCode);
}

/**
 * 將 PGA (gal, cm/s^2) 轉換為台灣震度級數。
 * 根據台灣中央氣象署的震度分級標準。
 * @param {number} pga - 地動加速度峰值，單位為 gal (cm/s^2)。
 */
export function pgaToIntensity(pga) {
  if (pga < 0.002) return "0";
  if (pga < 0.008) return "0";
  if (pga < 0.025) return "1";
  if (pga < 0.08) return "2";
  if (pga < 0.25) return "3";
  if (pga < 0.8) return "4";
  if (pga < 1.4) return "5-";
  if (pga < 2.5) return "5+";
  if (pga < 4.4) return "6-";
  if (pga < 8.0) return "6+";
  return "7";
}


/**
 * 從 SEED 格式提取測站代碼
 * @param {string} seedName - e.g., "TW.HSN1..BHZ"
 * @returns {string} - e.g., "HSN1"
 */
export function extractStationCode(seedName) {
  if (!seedName) return seedName;
  const parts = seedName.split('.');
  if (parts.length >= 2) {
    return parts[1];
  }
  return seedName;
}

/**
 * 解析 Earthworm pick 時間格式 (YYYYMMDDHHmmSS.ss) 為 timestamp (ms)
 * @param {string} timeStr
 * @returns {number} timestamp in ms
 */
export function parseEarthwormTime(timeStr) {
  if (!timeStr) return null;
  
  // 嘗試解析為 Unix timestamp (秒)
  // Earthworm 的 pick_time 有時是 epoch seconds (e.g. 1763573045.23)
  // 正常的 YYYYMMDD... 格式數值會非常大 (> 10^13)
  // 目前時間 (2025年) 約為 1.7 * 10^9
  const val = parseFloat(timeStr);
  if (!isNaN(val)) {
    // 如果數值小於 10000000000 (約西元 2286 年)，假設是秒
    if (val > 0 && val < 10000000000) {
      return val * 1000;
    }
  }

  if (timeStr.length < 14) return null;
  
  const year = parseInt(timeStr.substring(0, 4));
  const month = parseInt(timeStr.substring(4, 6)) - 1; // 0-indexed
  const day = parseInt(timeStr.substring(6, 8));
  const hour = parseInt(timeStr.substring(8, 10));
  const minute = parseInt(timeStr.substring(10, 12));
  const second = parseInt(timeStr.substring(12, 14));
  
  // 處理小數秒
  let ms = 0;
  if (timeStr.includes('.')) {
    ms = parseFloat("0." + timeStr.split('.')[1]) * 1000;
  }

  // 假設 Earthworm 時間為 UTC
  return new Date(Date.UTC(year, month, day, hour, minute, second, ms)).getTime();
}
