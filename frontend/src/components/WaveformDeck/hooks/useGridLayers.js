import { useMemo } from 'react';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { COLORS } from '../constants';

/**
 * 網格線圖層 Hook
 * 繪製緯度網格線和標籤
 */
export function useGridLayers({ mapLat, currentLon, waveWidth, panelWidth, panelHeight, minLat, maxLat, lonRange }) {
    return useMemo(() => {
        const layers = [];
        const gridLines = [];
        const gridLabels = [];

        // 假設 minLat/maxLat 是通過 mapLat 隱含的
        // 我們需要知道原始緯度範圍來繪製網格
        // 這裡反向推算或假設範圍?
        // 為了簡單起見，我們假設台灣附近的範圍 21-26
        // const minLat = 21;
        // const maxLat = 26;

        // 靜態視圖，經度固定為 0
        // 左邊緣大約是 -lonRange / 2
        const leftEdgeLon = -lonRange / 2;
        // 粗略估計每像素對應的經度
        const degreesPerPixelX = lonRange / 1000;

        // 加入預設值防止 NaN
        const safeMinLat = Number.isFinite(minLat) ? minLat : 21.3;
        const safeMaxLat = Number.isFinite(maxLat) ? maxLat : 26.3;

        for (let lat = Math.ceil(safeMinLat); lat <= safeMaxLat; lat += 0.5) {
            const centerLat = mapLat(lat);

            // 網格線 (環繞地球)
            gridLines.push({
                path: [[-180, centerLat], [180, centerLat]],
                color: lat % 1 === 0 ? COLORS.GRID_MAJOR : COLORS.GRID_MINOR
            });

            if (lat % 1 === 0) {
                // 標籤位置：左側邊緣 + 偏移 (靜態)
                const labelLon = leftEdgeLon + (8 * degreesPerPixelX);

                // 調整垂直對齊以避免切邊
                let alignmentBaseline = 'center';
                let pixelOffset = [0, 0];

                if (Math.abs(lat - safeMinLat) < 0.1) {
                    // 最底部的標籤：向上偏移
                    alignmentBaseline = 'bottom';
                    pixelOffset = [0, -2];
                } else if (Math.abs(lat - safeMaxLat) < 0.1) {
                    // 最頂部的標籤：向下偏移
                    alignmentBaseline = 'top';
                    pixelOffset = [0, 2];
                }

                gridLabels.push({
                    position: [labelLon, centerLat],
                    text: `${lat}°N`,
                    color: COLORS.GRID_LABEL,
                    size: 11,
                    alignmentBaseline,
                    pixelOffset
                });
            }
        }

        layers.push(new PathLayer({
            id: 'grid-lines',
            data: gridLines,
            getPath: d => d.path,
            getColor: d => d.color,
            widthMinPixels: 1,
            wrapLongitude: true
        }));

        layers.push(new TextLayer({
            id: 'grid-labels',
            data: gridLabels,
            getPosition: d => d.position,
            getText: d => d.text,
            getColor: d => d.color,
            getSize: d => d.size,
            getTextAnchor: 'start',
            fontFamily: 'monospace'
        }));

        return layers;
    }, [mapLat, currentLon, waveWidth, panelWidth, panelHeight, minLat, maxLat, lonRange]);
}
