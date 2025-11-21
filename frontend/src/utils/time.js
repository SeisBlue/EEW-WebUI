/**
 * 時間解析工具函數
 */

/**
 * 解析 Earthworm pick 時間格式為 timestamp (ms)
 * 
 * 支援兩種格式:
 * 1. Unix timestamp (秒): 例如 1763573045.23
 * 2. Earthworm 格式: YYYYMMDDHHmmSS.ss
 * 
 * @param {string} timeStr - 時間字串
 * @returns {number|null} - timestamp (毫秒)，失敗返回 null
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
