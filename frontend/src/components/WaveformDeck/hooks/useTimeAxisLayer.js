import { useMemo } from 'react';
import { PathLayer } from '@deck.gl/layers';
import { COLORS } from '../constants';
import { calculateLongitude } from '../utils';

/**
 * 時間軸圖層 Hook
 * 繪製時間軸線和刻度
 */
export function useTimeAxisLayer({ timeWindow, panelHeight, minLat, maxLat, lonRange }) {
    return useMemo(() => {
        // 使用真實緯度範圍，加入預設值防止 NaN
        const safeMinLat = Number.isFinite(minLat) ? minLat : 21.3;
        const safeMaxLat = Number.isFinite(maxLat) ? maxLat : 26.3;
        const latRange = safeMaxLat - safeMinLat;

        // 放在最低緯度上方約 5% 的範圍處 (確保在視圖內)
        // 因為 BOTTOM_MARGIN 為 0，我們必須畫在地圖範圍內
        const timeAxisLat = safeMinLat + (latRange * 0.05);

        // 靜態視圖範圍
        const rightEdgeLon = lonRange / 2;
        const leftEdgeLon = -lonRange / 2;
        
        const lines = [
            // 主軸線 (全寬)
            {
                path: [[leftEdgeLon, timeAxisLat], [rightEdgeLon, timeAxisLat]],
                color: COLORS.TIME_AXIS
            }
        ];

        // 產生刻度 (-120s 到 0s，每 10s 一格)
        const tickInterval = 10; // 秒
        const numTicks = Math.floor(timeWindow / tickInterval);

        for (let i = 0; i <= numTicks; i++) {
            const timeOffset = -i * tickInterval; // 0, -10, -20...
            
            // 計算經度位置
            // 0s -> rightEdgeLon
            // -120s -> leftEdgeLon
            const tickLon = rightEdgeLon + (timeOffset / timeWindow) * lonRange;

            // 刻度線長度
            const tickHeight = latRange * 0.015;

            lines.push({
                path: [[tickLon, timeAxisLat - tickHeight], [tickLon, timeAxisLat + tickHeight]],
                color: COLORS.TIME_AXIS
            });
        }

        // 添加文字標籤 (使用 TextLayer 會更好，但這裡先用 PathLayer 畫線，文字由 useLabelLayers 處理或這裡添加 TextLayer)
        // 為了簡單，我們這裡只返回 PathLayer，文字標籤建議在 useLabelLayers 中處理，或者這裡返回多個圖層
        // 讓我們這裡只負責線條，文字在 useLabelLayers 中已經有了 (雖然需要調整位置)

        // 為了方便，我們這裡直接返回 PathLayer。
        // 文字標籤 "10s" 可以在 useLabelLayers 中添加，或者這裡改成返回 [PathLayer, TextLayer]
        // 考慮到架構，我們讓 useLabelLayers 處理文字比較一致。

        return new PathLayer({
            id: 'time-axis',
            data: lines,
            getPath: d => d.path,
            getColor: d => d.color,
            widthMinPixels: 2,
            wrapLongitude: false // 靜態視圖不需要 wrapping
        });
    }, [timeWindow, panelHeight, minLat, maxLat, lonRange]);
}
