import { useMemo } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { COLORS, STATION_RADIUS } from '../constants';
import { hasRecentWaveData } from '../utils';
import { getIntensityColor } from '../../../utils/intensity';

/**
 * 測站點圖層 Hook
 * 繪製地圖上的測站點，根據震度顯示不同樣式
 * 地圖組件自行根據震度決定顏色
 */
export function useStationLayers({ stations, stationIntensities, waveDataMap }) {
    return useMemo(() => {
        if (!stations || stations.length === 0) {
            return null;
        }

        // 測站點層
        return new ScatterplotLayer({
            id: 'station-points',
            data: stations,
            pickable: true,
            getPosition: d => [d.longitude, d.latitude],

            // 填充顏色：根據震度自行計算顏色
            getFillColor: d => {
                const hasData = hasRecentWaveData(waveDataMap, d.station);

                // 只有有波形數據時才填充顏色
                if (!hasData) return [0, 0, 0, 0];

                const intensityData = stationIntensities[d.station];
                if (!intensityData) return [0, 0, 0, 0];

                // 地圖自行根據震度計算顏色
                const color = getIntensityColor(intensityData.intensity);
                return color;
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
    }, [stations, stationIntensities, waveDataMap]);
}
