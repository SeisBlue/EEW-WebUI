import { useMemo } from 'react';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { COLORS } from '../constants';

/**
 * 網格線圖層 Hook
 * 繪製緯度網格線和標籤
 */
export function useGridLayers({ minLat, maxLat, panelWidth, panelHeight }) {
    return useMemo(() => {
        const layers = [];
        const gridLines = [];
        const gridLabels = [];

        for (let lat = Math.ceil(minLat); lat <= maxLat; lat += 0.5) {
            const y = ((maxLat - lat) / (maxLat - minLat)) * panelHeight;

            gridLines.push({
                path: [[0, y], [panelWidth, y]],
                color: lat % 1 === 0 ? COLORS.GRID_MAJOR : COLORS.GRID_MINOR
            });

            if (lat % 1 === 0) {
                gridLabels.push({
                    position: [8, y - 5],
                    text: `${lat}°N`,
                    color: COLORS.GRID_LABEL,
                    size: 11
                });
            }
        }

        layers.push(new PathLayer({
            id: 'grid-lines',
            data: gridLines,
            getPath: d => d.path,
            getColor: d => d.color,
            widthMinPixels: 1
        }));

        layers.push(new TextLayer({
            id: 'grid-labels',
            data: gridLabels,
            getPosition: d => d.position,
            getText: d => d.text,
            getColor: d => d.color,
            getSize: d => d.size,
            getTextAnchor: 'start', // 靠左對齊，避免被切掉
            fontFamily: 'monospace'
        }));

        return layers;
    }, [minLat, maxLat, panelWidth, panelHeight]);
}
