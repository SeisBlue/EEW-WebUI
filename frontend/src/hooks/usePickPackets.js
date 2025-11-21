import { useEffect } from 'react';
import { parseEarthwormTime } from '../utils';

const DATA_RETENTION_WINDOW = 120; // 資料暫存時間窗口（秒）

/**
 * Hook for processing pick packets
 * Handles P-wave arrival time markers and deduplication
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

                // We need to clone if we haven't already for this batch
                // But since we might process multiple picks for the same station, checking against 'prev' is tricky.
                // Simpler approach: always clone if we are modifying.
                // Optimization: check if updated[stationCode] is already a new object (different from prev[stationCode])
                let stationData = updated[stationCode];
                if (stationData === prev[stationCode]) {
                    stationData = { ...prevStationData };
                    updated[stationCode] = stationData;
                }

                // Ensure picks array exists and is copied
                if (!stationData.picks) {
                    stationData.picks = [];
                } else if (stationData.picks === prevStationData.picks) {
                     // If picks array is same as prev, clone it
                    stationData.picks = [...stationData.picks];
                }

                // Parse and add pick time
                const pickTime = parseEarthwormTime(pickData.pick_time);
                if (pickTime) {
                    // Check for duplicates
                    const isDuplicate = stationData.picks.some(
                        p => p.id === pickData.pickid
                    );

                    if (!isDuplicate) {
                        stationData.picks.push({
                            time: pickTime,
                            type: 'P',
                            id: pickData.pickid
                        });
                    }
                }
            });

            return updated;
        });
    }, [pickPackets, setWaveDataMap]);
}
