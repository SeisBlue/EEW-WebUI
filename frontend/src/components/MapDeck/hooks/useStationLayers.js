import { useMemo } from 'react';
import { ScatterplotLayer, PolygonLayer } from '@deck.gl/layers';
import { COLORS, STATION_RADIUS, PICK_SQUARE_SIZE } from '../constants';
import { hasRecentWaveData, hasPickData } from '../utils';

/**
 * 測站點圖層 Hook
 * 繪製地圖上的測站點，根據震度和 Pick 狀態顯示不同樣式
 * 返回兩個圖層：黃色正方形邊框層 + 測站點層
 */
export function useStationLayers({ stations, stationIntensities, waveDataMap }) {
    return useMemo(() => {
        if (!stations || stations.length === 0) {
            return [];
        }

        // 過濾出有 Pick 的測站
        const stationsWithPick = stations.filter(station => 
            hasPickData(waveDataMap, station.station)
        );

        // 黃色正方形邊框層（只顯示有 Pick 的測站）
        const pickSquareLayer = new PolygonLayer({
            id: 'pick-square-borders',
            data: stationsWithPick,
            pickable: false,
            stroked: true,
            filled: false,
            getPolygon: d => {
                const lon = d.longitude;
                const lat = d.latitude;
                const size = PICK_SQUARE_SIZE;
                // 創建正方形的四個角
                return [
                    [lon - size, lat - size],
                    [lon + size, lat - size],
                    [lon + size, lat + size],
                    [lon - size, lat + size],
                    [lon - size, lat - size]  // 閉合多邊形
                ];
            },
            getLineColor: COLORS.PICK_SQUARE_BORDER,
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            updateTriggers: {
                data: [waveDataMap]
            }
        });

        // 測站點層
        const stationPointsLayer = new ScatterplotLayer({
            id: 'station-points',
            data: stations,
            pickable: true,
            getPosition: d => [d.longitude, d.latitude],

            // 填充顏色：只有有波形數據時才填充震度顏色
            getFillColor: d => {
                const hasData = hasRecentWaveData(waveDataMap, d.station);

                // 只有有波形數據時才填充顏色
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

            // 邊框顏色：統一使用預設顏色
            getLineColor: COLORS.STATION_BORDER_DEFAULT,

            // 邊框寬度：統一寬度
            getLineWidth: 1,

            lineWidthMinPixels: 1,

            // 更新觸發器：確保數據變化時重新渲染
            updateTriggers: {
                getFillColor: [stationIntensities, waveDataMap],
                getRadius: [stationIntensities]
            }
        });

        // 返回兩個圖層：先繪製正方形邊框，再繪製測站點（這樣測站點會在上層）
        return [pickSquareLayer, stationPointsLayer];
    }, [stations, stationIntensities, waveDataMap]);
}
