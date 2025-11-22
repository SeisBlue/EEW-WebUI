/**
 * 波形計算相關的工具函數
 */

/**
 * 將時間轉換為經度 (Ring Buffer)
 * 映射規則：時間 * degreesPerSecond
 * @param {number} time - 時間戳 (毫秒)
 * @param {number} baseTime - 基準時間 (毫秒)
 * @param {number} degreesPerSecond - 每秒對應的經度
 * @returns {number} 經度 [-180, 180]
 */
export function calculateLongitude(time, baseTime, degreesPerSecond) {
    const elapsedSeconds = (time - baseTime) / 1000;
    const totalDegrees = elapsedSeconds * degreesPerSecond;

    // 取餘數得到在 360 度內的位置
    let degrees = totalDegrees % 360;

    // 轉換到 [-180, 180) for Deck.gl
    if (degrees > 180) degrees -= 360;
    if (degrees <= -180) degrees += 360;

    return degrees;
}

/**
 * 計算 Mercator 投影的縮放修正因子
 * @param {number} latitude - 緯度
 * @returns {number} 縮放因子 (1/cos(lat))
 */
export function getMercatorScale(latitude) {
    // 限制緯度以避免無限大 (雖然台灣地區不會遇到)
    const safeLat = Math.max(-85, Math.min(85, latitude));
    const rad = (safeLat * Math.PI) / 180;
    return 1 / Math.cos(rad);
}

/**
 * 計算波形樣本點的緯度
 * @param {number} value - 樣本值
 * @param {number} displayScale - 顯示縮放
 * @param {number} centerLat - 中心緯度 (測站緯度)
 * @param {number} waveHeightLat - 波形最大高度 (緯度度數，於赤道處)
 * @returns {number} 緯度
 */
export function calculateWaveformLat(value, displayScale, centerLat, waveHeightLat) {
    const normalizedValue = value / displayScale;
    const clampedValue = Math.max(-1, Math.min(1, normalizedValue));

    // Mercator 修正：在高緯度地區，同樣的緯度差在螢幕上看起來更長
    // 所以為了讓波形在螢幕上看起來高度一致，我們需要除以 Mercator 縮放因子
    const scale = getMercatorScale(centerLat);
    const adjustedHeight = waveHeightLat / scale;

    // 注意：Y 軸向上是緯度增加，所以正值應該加，負值減
    // 但原本的波形繪製可能是反的 (螢幕座標 Y 向下增加)
    // 在地圖座標系中，緯度向上增加。
    // 如果 value 是正的，我們希望波形向上凸起 -> lat 增加
    return centerLat + clampedValue * (adjustedHeight / 2);
}
