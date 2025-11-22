import { useEffect } from 'react';
import { parseEarthwormTime } from '../utils';

const DATA_RETENTION_WINDOW = 120; // 資料暫存時間窗口（秒）

/**
 * Hook for processing pick packets
 * Handles P-wave arrival time markers and deduplication
 * 
 * Earthworm 會將同一個 pick 維持 9 秒，每秒傳一次
 * 差別只有 update_sec 不一樣，我們只保留最新的
 * 
 * @param {Object} options
 * @param {Array} options.pickPackets - Array of pick packets from WebSocket
 * @param {Function} options.setWaveDataMap - setState function to update waveDataMap
 */
export function usePickPackets({ pickPackets, setWaveDataMap }) {
    useEffect(() => {
        if (pickPackets.length === 0) return;

        setWaveDataMap(prev => {
            const updated = { ...prev };
            const now = Date.now() / 1000;

            pickPackets.forEach(latestPacket => {
                const pickData = latestPacket.content;

                // Validate pick data
                if (!pickData || !pickData.station || !pickData.pick_time) return;

                const stationCode = pickData.station;

                // Ensure station data exists
                const prevStationData = updated[stationCode] || {
                    dataPoints: [],
                    pgaHistory: [],
                    lastPga: 0,
                    lastEndTime: null,
                    recentStats: {
                        points: [],
                        totalSumSquares: 0,
                        totalMaxAbs: 0,
                        totalCount: 0
                    },
                    picks: []
                };

                // Clone station data if needed
                let stationData = updated[stationCode];
                if (stationData === prev[stationCode]) {
                    stationData = { ...prevStationData };
                    updated[stationCode] = stationData;
                }

                // Ensure picks array exists and is copied
                if (!stationData.picks) {
                    stationData.picks = [];
                } else if (stationData.picks === prevStationData.picks) {
                    stationData.picks = [...stationData.picks];
                }

                // Parse and add/update pick
                const pickTime = parseEarthwormTime(pickData.pick_time);
                if (pickTime) {
                    // 使用 (station, channel, pick_time) 作為唯一鍵
                    // Earthworm 會重複發送同一個 pick，差別只有 update_sec
                    const channel = pickData.channel || '';
                    const updateSec = parseInt(pickData.update_sec) || 0;

                    // 查找是否已存在相同的 pick (station + channel + time)
                    const existingIndex = stationData.picks.findIndex(
                        p => p.channel === channel && Math.abs(p.time - pickTime) < 0.1 // 0.1 秒容差
                    );

                    if (existingIndex !== -1) {
                        // 存在相同的 pick，比較 update_sec
                        const existingPick = stationData.picks[existingIndex];
                        if (updateSec > (existingPick.updateSec || 0)) {
                            // 新的 update_sec 更大，更新這個 pick
                            stationData.picks[existingIndex] = {
                                time: pickTime,
                                type: 'P',
                                id: pickData.pickid,
                                channel: channel,
                                updateSec: updateSec,
                                latitude: parseFloat(pickData.lat),
                                longitude: parseFloat(pickData.lon)
                            };
                        }
                        // else: 舊的 update_sec，忽略
                    } else {
                        // 新的 pick，直接添加
                        stationData.picks.push({
                            time: pickTime,
                            type: 'P',
                            id: pickData.pickid,
                            channel: channel,
                            updateSec: updateSec,
                            latitude: parseFloat(pickData.lat),
                            longitude: parseFloat(pickData.lon)
                        });

                        // Sort picks by time to ensure cleanup logic works correctly
                        stationData.picks.sort((a, b) => a.time - b.time);
                    }
                }
            });

            // 清理超過 120 秒的舊 picks
            Object.keys(updated).forEach(stationCode => {
                const stationData = updated[stationCode];
                if (stationData?.picks && stationData.picks.length > 0) {
                    const oldLength = stationData.picks.length;
                    stationData.picks = stationData.picks.filter(
                        pick => (now - pick.time) <= DATA_RETENTION_WINDOW
                    );

                    // 如果有清理，需要確保我們已經 clone 了陣列
                    if (stationData.picks.length !== oldLength && stationData === prev[stationCode]) {
                        updated[stationCode] = { ...stationData, picks: stationData.picks };
                    }
                }
            });

            return updated;
        });
    }, [pickPackets, setWaveDataMap]);
}
