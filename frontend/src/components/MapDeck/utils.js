/**
 * MapDeck 工具函數
 */

/**
 * 計算基於 zoom 的緯度可視範圍
 * @param {number} latitude - 當前緯度
 * @param {number} zoom - 當前縮放級別
 * @param {number} windowHeight - 視窗高度
 * @returns {{minLat: number, maxLat: number}} 緯度範圍
 */
export function calculateLatitudeRange(latitude, zoom, windowHeight) {
    // 根據 zoom 計算大約的緯度範圍
    // 使用 Mercator 投影的比例尺：scale ~ 1 / cos(latitude)
    // 經度每像素度數 = 360 / (512 * 2^zoom)
    // 緯度每像素度數 ~= 經度每像素度數 * cos(latitude)
    const degreesPerPixelLon = 360 / (512 * Math.pow(2, zoom));
    const degreesPerPixelLat = degreesPerPixelLon * Math.cos(latitude * Math.PI / 180);

    const latRange = windowHeight * degreesPerPixelLat;
    const minLat = Math.max(-90, latitude - latRange / 2);
    const maxLat = Math.min(90, latitude + latRange / 2);

    return { minLat, maxLat };
}

/**
 * 檢查測站是否有近期波形數據
 * @param {Object} waveDataMap - 波形數據映射
 * @param {string} stationCode - 測站代碼
 * @returns {boolean} 是否有數據
 */
export function hasRecentWaveData(waveDataMap, stationCode) {
    return waveDataMap?.[stationCode]?.pgaHistory?.length > 0;
}

/**
 * 檢查測站是否有 Pick 標記
 * @param {Object} waveDataMap - 波形數據映射
 * @param {string} stationCode - 測站代碼
 * @returns {boolean} 是否有 Pick
 */
export function hasPickData(waveDataMap, stationCode) {
    return waveDataMap?.[stationCode]?.picks?.length > 0;
}
