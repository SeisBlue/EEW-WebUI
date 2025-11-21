import { useMemo } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { COLORS, STATION_RADIUS, PICK_BORDER_WIDTH } from '../constants';
import { hasRecentWaveData, hasPickData } from '../utils';

/**
 * 測站點圖層 Hook
 * 繪製地圖上的測站點，根據震度和 Pick 狀態顯示不同樣式
 */
export function useStationLayers({ stations, stationIntensities, waveDataMap }) {
    return useMemo(() => {
        if (!stations || stations.length === 0) {
            return null;
        }

        return new ScatterplotLayer({
            id: 'station-points',
            data: stations,
            pickable: true,
            getPosition: d => [d.longitude, d.latitude],

            // 填充顏色：只有有波形數據時才填充震度顏色
            getFillColor: d => {
                const hasData = hasRecentWaveData(waveDataMap, d.station);

                // 只有有波形數據時才填充顏色
                // 如果只有 Pick 沒有波形，保持透明（但黃色邊框仍會顯示）
                if (!hasData) return [0, 0, 0, 0];

                const intensityData = stationIntensities[d.station];
                return intensityData ? intensityData.color : [0, 0, 0, 0];
            },

            // 半徑：有數據的測站較大
            getRadius: d => {
                const intensityData = stationIntensities[d.station];
                return intensityData && intensityData.pga > 0
                    ? STATION_RADIUS.ACTIVE
                    : STATION_RADIUS.DEFAULT;
            },

            radiusMinPixels: STATION_RADIUS.MIN_PIXELS,
            radiusMaxPixels: STATION_RADIUS.MAX_PIXELS,
            stroked: true,

            // 邊框顏色：有 Pick 時顯示黃色
            getLineColor: d => {
                const hasPick = hasPickData(waveDataMap, d.station);
                return hasPick
                    ? COLORS.STATION_BORDER_PICK
                    : COLORS.STATION_BORDER_DEFAULT;
            },

            // 邊框寬度：有 Pick 時較粗
            getLineWidth: d => {
                const hasPick = hasPickData(waveDataMap, d.station);
                return hasPick
                    ? PICK_BORDER_WIDTH.ACTIVE
                    : PICK_BORDER_WIDTH.DEFAULT;
            },

            lineWidthMinPixels: 1,

            // 更新觸發器：確保數據變化時重新渲染
            updateTriggers: {
                getFillColor: [stationIntensities, waveDataMap],
                getRadius: [stationIntensities],
                getLineColor: [waveDataMap],
                getLineWidth: [waveDataMap]
            }
        });
    }, [stations, stationIntensities, waveDataMap]);
}
