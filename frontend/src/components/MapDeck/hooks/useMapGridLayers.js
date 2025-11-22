import { useMemo } from 'react';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { GRID_BOUNDS, COLORS } from '../constants';

/**
 * 地圖網格線圖層 Hook
 * 繪製緯度網格線和標籤
 */
export function useMapGridLayers() {
    return useMemo(() => {
        const allLayers = [];
        const latGridLines = [];
        const latGridLabels = [];

        const { minLat, maxLat, lonMin, lonMax } = GRID_BOUNDS;

        // 生成網格線數據
        for (let lat = minLat; lat <= maxLat; lat += 0.5) {
            const isMajor = lat % 1 === 0; // 每 1 度是主要線

            latGridLines.push({
                path: [[lonMin, lat], [lonMax, lat]],
                color: isMajor ? COLORS.GRID_MAJOR : COLORS.GRID_MINOR,
                width: isMajor ? 2 : 1
            });

            // 在主要線上添加標籤
            if (isMajor) {
                latGridLabels.push({
                    position: [119.8, lat],
                    text: `${lat}°N`,
                    color: COLORS.GRID_LABEL,
                    size: 12
                });
            }
        }

        // 添加緯度網格線圖層
        if (latGridLines.length > 0) {
            allLayers.push(new PathLayer({
                id: 'lat-grid-lines',
                data: latGridLines,
                getPath: d => d.path,
                getColor: d => d.color,
                getWidth: d => d.width,
                widthMinPixels: 1
            }));
        }

        // 添加緯度標籤圖層
        if (latGridLabels.length > 0) {
            allLayers.push(new TextLayer({
                id: 'lat-grid-labels',
                data: latGridLabels,
                getPosition: d => d.position,
                getText: d => d.text,
                getColor: d => d.color,
                getSize: d => d.size,
                getTextAnchor: 'start',
                fontFamily: 'monospace',
                fontWeight: 'bold',
                outlineWidth: 2,
                outlineColor: COLORS.LABEL_OUTLINE
            }));
        }

        return allLayers;
    }, []); // 網格線是靜態的，不需要依賴
}
