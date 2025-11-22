import { useMemo } from 'react';
import { PolygonLayer } from '@deck.gl/layers';
import { COLORS, PICK_SQUARE_SIZE } from '../constants';

/**
 * Pick 標記圖層 Hook
 * 繪製黃色正方形邊框來標示有 P 波偵測的位置
 * 完全獨立於測站圖層，可在地圖和波形圖中重複使用
 */
export function usePickLayers({ waveDataMap }) {
    return useMemo(() => {
        // 從 waveDataMap 中收集所有有 Pick 的測站及其經緯度
        // Pick 資料本身就包含經緯度（來自 Redis）
        const allPickStations = [];
        
        if (waveDataMap) {
            Object.keys(waveDataMap).forEach(stationCode => {
                const stationData = waveDataMap[stationCode];
                if (stationData?.picks && stationData.picks.length > 0) {
                    // 使用最新 pick 的經緯度（picks 已按時間排序）
                    const latestPick = stationData.picks[stationData.picks.length - 1];
                    if (latestPick.latitude && latestPick.longitude) {
                        allPickStations.push({
                            station: stationCode,
                            latitude: latestPick.latitude,
                            longitude: latestPick.longitude
                        });
                    }
                }
            });
        }

        // 如果沒有 pick 資料，返回 null
        if (allPickStations.length === 0) {
            return null;
        }

        // 黃色正方形邊框層
        return new PolygonLayer({
            id: 'pick-square-borders',
            data: allPickStations,
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
    }, [waveDataMap]);
}
