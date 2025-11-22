import { useMemo } from 'react';
import { TextLayer } from '@deck.gl/layers';
import { COLORS } from '../constants';

/**
 * 文字標籤圖層 Hook
 * 繪製測站代碼、中文名稱、PGA 數值和時間軸標籤
 */
export function useLabelLayers({
    stations,
    stationMap,
    waveDataMap,
    mapLat, // 緯度映射函數 (恆等)
    panelHeight,
    renderTrigger,
    timeWindow,
    bottomMargin,
    minLat,
    maxLat,
    lonRange
}) {
    return useMemo(() => {
        const labels = [];

        // 靜態視圖，經度固定為 0
        // 我們將標籤放在經度 0 附近
        // 假設視圖寬度對應 lonRange 度
        // 左邊緣大約是 -lonRange / 2
        const leftEdgeLon = -lonRange / 2;

        // 計算每像素對應的經度 (假設 waveWidth 512px 對應 360度 -> 0.7度/px)
        // 這裡我們需要知道 waveWidth 對應 lonRange
        // 但是我們沒有傳入 waveWidth，不過我們可以反推
        // 或者直接使用一個相對值，因為這是在靜態視圖中
        // 為了簡單，我們假設 lonRange 對應螢幕寬度
        // 所以每像素經度 = lonRange / panelHeight * (panelHeight/panelWidth) ... 有點複雜
        // 讓我們傳入一個估計值，或者直接用 lonRange 的比例
        const degreesPerPixelX = lonRange / 1000; // 粗略估計，假設寬度 1000px

        stations.forEach((stationCode) => {
            const station = stationMap[stationCode];
            if (!station || !station.latitude) return;

            // 計算緯度位置
            const centerLat = mapLat(station.latitude);

            const waveData = waveDataMap[stationCode];
            const hasPicks = waveData?.picks?.length > 0;

            // 默認樣式
            let textAlpha = 255;
            let stationLabelOffset = -30; // 像素偏移 (相對於左邊緣)
            let labelColor = waveData ? COLORS.LABEL_DEFAULT : COLORS.LABEL_INACTIVE;
            let labelBackgroundColor = [0, 0, 0, 0];
            let labelPadding = [0, 0, 0, 0];
            let labelBorderRadius = 0;
            let labelFontWeight = 'normal';

            // 2. 確定文字透明度
            if (!hasPicks) {
                textAlpha = 10;
            } else {
                textAlpha = 255;
            }

            // 3. Pick 測站的特殊樣式
            if (hasPicks) {
                labelColor = COLORS.PICK_LABEL;
                labelBackgroundColor = COLORS.PICK_BG;
                labelPadding = [2, 5, 2, 5];
                labelBorderRadius = 4;
                labelFontWeight = 'bold';
            }

            // 4. 應用最終透明度
            labelColor = [...labelColor];
            labelColor[3] = textAlpha;

            // 計算測站標籤的經度 (靜態)
            const stationLabelLon = leftEdgeLon + (stationLabelOffset * degreesPerPixelX);

            // 測站代碼標籤
            labels.push({
                position: [stationLabelLon, centerLat],
                text: stationCode,
                color: labelColor,
                backgroundColor: labelBackgroundColor,
                padding: labelPadding,
                borderRadius: labelBorderRadius,
                fontWeight: labelFontWeight,
                size: 10,
                anchor: 'start', // 靠左對齊
                alignmentBaseline: 'center',
            });


        });

        // 時間軸標籤 (全寬懸浮)
        const safeMinLat = Number.isFinite(minLat) ? minLat : 21.3;
        const safeMaxLat = Number.isFinite(maxLat) ? maxLat : 26.3;
        const latRange = safeMaxLat - safeMinLat;

        // 與 useTimeAxisLayer 保持一致
        const timeAxisY = safeMinLat + (latRange * 0.05);
        const rightEdgeLon = lonRange / 2;
        
        const tickInterval = 10; // 秒
        const numTicks = Math.floor(timeWindow / tickInterval);

        for (let i = 0; i <= numTicks; i++) {
            const timeOffset = -i * tickInterval; // 0, -10, -20...
            const tickLon = rightEdgeLon + (timeOffset / timeWindow) * lonRange;

            let labelText = `${timeOffset}s`;
            let labelColor = COLORS.TIME_RELATIVE;
            let labelSize = 11;
            let labelOffset = [0, 12]; // 標籤在軸線下方

            // 0秒處顯示當前時間
            if (timeOffset === 0) {
                const now = new Date(renderTrigger);
                const timeString = now.toLocaleTimeString('zh-TW', { hour12: false });
                labelText = timeString; // 只顯示時間，不顯示 "0s"
                labelColor = COLORS.TIME_CURRENT;
                labelSize = 12;
                labelOffset = [0, 12];
            }

            labels.push({
                position: [tickLon, timeAxisY],
                text: labelText,
                color: labelColor,
                size: labelSize,
                anchor: 'middle',
                alignmentBaseline: 'top',
                pixelOffset: labelOffset
            });
        }


        return [new TextLayer({
            id: 'labels',
            data: labels,
            getPosition: d => d.position,
            getText: d => d.text,
            getColor: d => d.color,
            getSize: d => d.size,
            getTextAnchor: d => d.anchor,
            getAlignmentBaseline: d => d.alignmentBaseline,
            getBackgroundColor: d => d.backgroundColor,
            getBorderRadius: d => d.borderRadius,
            getPadding: d => d.padding,
            getFontWeight: d => d.fontWeight,
            getPixelOffset: d => d.pixelOffset,
            fontFamily: 'monospace',
            updateTriggers: {
                getColor: waveDataMap,
                getBackgroundColor: waveDataMap,
                getText: [waveDataMap]
            }
        })];
    }, [stations, stationMap, waveDataMap, mapLat, panelHeight, bottomMargin, minLat, maxLat, lonRange, timeWindow]);
}
