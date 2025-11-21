/**
 * 測站相關工具函數
 */

/**
 * 檢查測站是否為 TSMIP 格式
 * TSMIP 格式: 一個英文字母 + 三個數字，例如 A024, B131
 * @param {string} stationCode - 測站代碼
 * @returns {boolean}
 */
export function isTSMIPStation(stationCode) {
    return /^[ABCDEFGH]\d{3}$/.test(stationCode);
}

/**
 * 從 SEED 格式提取測站代碼
 * @param {string} seedName - SEED 格式，例如 "TW.HSN1..BHZ"
 * @returns {string} - 測站代碼，例如 "HSN1"
 */
export function extractStationCode(seedName) {
    if (!seedName) return seedName;
    const parts = seedName.split('.');
    if (parts.length >= 2) {
        return parts[1];
    }
    return seedName;
}
