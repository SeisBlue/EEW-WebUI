/**
 * 波形計算相關的工具函數
 */

/**
 * 計算測站的 Y 座標位置
 * @param {number} latitude - 測站緯度
 * @param {number} minLat - 最小緯度
 * @param {number} maxLat - 最大緯度
 * @param {number} availableHeight - 可用高度
 * @returns {number} Y 座標
 */
export function calculateStationYPosition(latitude, minLat, maxLat, availableHeight) {
    return ((maxLat - latitude) / (maxLat - minLat)) * availableHeight;
}

/**
 * 計算 Pick 標記的 X 座標
 * @param {number} pickTime - Pick 時間（毫秒）
 * @param {number} baseTime - 基準時間（毫秒）
 * @param {number} speed - 速度（像素/毫秒）
 * @param {number} xOffset - X 偏移量
 * @param {number} waveWidth - 波形寬度
 * @returns {number} X 座標
 */
export function calculatePickXPosition(pickTime, baseTime, speed, xOffset, waveWidth) {
    return (xOffset + waveWidth) + (pickTime - baseTime) * speed;
}

/**
 * 計算波形樣本點的 X 座標
 * @param {number} sampleTime - 樣本時間（毫秒）
 * @param {number} baseTime - 基準時間（毫秒）
 * @param {number} speed - 速度（像素/毫秒）
 * @param {number} xOffset - X 偏移量
 * @param {number} waveWidth - 波形寬度
 * @returns {number} X 座標
 */
export function calculateWaveformX(sampleTime, baseTime, speed, xOffset, waveWidth) {
    return (xOffset + waveWidth) + (sampleTime - baseTime) * speed;
}

/**
 * 計算波形樣本點的 Y 座標
 * @param {number} value - 樣本值
 * @param {number} displayScale - 顯示縮放
 * @param {number} centerY - 中心 Y 座標
 * @param {number} waveHeight - 波形高度
 * @returns {number} Y 座標
 */
export function calculateWaveformY(value, displayScale, centerY, waveHeight) {
    const normalizedValue = value / displayScale;
    const clampedValue = Math.max(-1, Math.min(1, normalizedValue));
    return centerY - clampedValue * (waveHeight / 2);
}
