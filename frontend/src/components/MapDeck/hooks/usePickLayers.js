import { useMemo } from 'react';
import { PolygonLayer } from '@deck.gl/layers';
import { PICK_SQUARE_SIZE } from '../constants';

/**
 * Pick 標記圖層 Hook
 * 繪製黃色正方形邊框來標示有 P 波偵測的位置
 * Alpha 值會根據時間遞減（從 240 開始，每秒減 2，持續 120 秒）
 * 完全獨立於測站圖層，可在地圖和波形圖中重複使用
 */
export function usePickLayers({ waveDataMap, currentTime }) {
    return useMemo(() => {
        // 從 waveDataMap 中收集所有有 Pick 的測站及其經緯度和時間
        const allPickStations = [];
        const now = currentTime || Date.now() / 1000; // 使用傳入的 currentTime 或當前時間（秒）

        if (waveDataMap) {
            Object.keys(waveDataMap).forEach(stationCode => {
                const stationData = waveDataMap[stationCode];
                if (stationData?.picks && stationData.picks.length > 0) {
                    // 使用最新 pick 的經緯度和時間（picks 已按時間排序）
                    const latestPick = stationData.picks[stationData.picks.length - 1];
                    if (latestPick.latitude && latestPick.longitude && latestPick.time) {
                        allPickStations.push({
                            station: stationCode,
                            latitude: latestPick.latitude,
                            longitude: latestPick.longitude,
                            pickTime: latestPick.time / 1000 // 轉換毫秒為秒
                        });
                    }
                }
            });
        }

        // 如果沒有 pick 資料，返回 null
        if (allPickStations.length === 0) {
            return null;
        }

        // 黃色正方形邊框層（帶時間衰減的 alpha）
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
            getLineColor: d => {
                // 計算 pick 的年齡（秒）
                const age = now - d.pickTime;

                // Alpha 從 255 開始，每秒減 5，最小為 100
                const alpha = Math.max(100, 255 - age * 5);

                // Debug: 輸出時間信息
                if (Math.random() < 0.1) { // 只隨機輸出 10% 避免太多日誌
                    console.log(`[Pick Alpha] Station: ${d.station}, Age: ${age.toFixed(1)}s, Alpha: ${alpha}, Now: ${now.toFixed(1)}, PickTime: ${d.pickTime.toFixed(1)}`);
                }

                // 返回黃色 RGBA：[255, 235, 59, alpha]
                return [255, 235, 59, alpha];
            },
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            updateTriggers: {
                getLineColor: [currentTime, waveDataMap]
            }
        });
    }, [waveDataMap, currentTime]);
}
