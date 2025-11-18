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
 * 檢查測站是否為 TSMIP 格式 (Axxx, Bxxx, Cxxx)
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
  if (pga < 0.2) return "0"; // 氣象署未定義0級，但實務上需要一個基準
  if (pga < 0.8) return "0"; // 0.2-0.8 仍為 0 級
  if (pga < 2.5) return "1";
  if (pga < 8.0) return "2";
  if (pga < 25) return "3";
  if (pga < 80) return "4";
  if (pga < 140) return "5-";
  if (pga < 250) return "5+";
  if (pga < 440) return "6-";
  if (pga < 800) return "6+";
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
