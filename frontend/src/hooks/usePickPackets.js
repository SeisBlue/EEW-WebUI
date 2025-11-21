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

        const latestPacket = pickPackets[0];
        const pickData = latestPacket.content;

        // Validate pick data
        if (!pickData || !pickData.station || !pickData.pick_time) return;

        setWaveDataMap(prev => {
            const updated = { ...prev };
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

            const stationData = { ...prevStationData };

            // Ensure picks array exists and is copied
            if (!stationData.picks) {
                stationData.picks = [];
            } else {
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

                // Clean up old picks
                const now = Date.now();
                const cutoff = now - DATA_RETENTION_WINDOW * 1000;
                stationData.picks = stationData.picks.filter(
                    p => p.time >= cutoff
                );
            }

            updated[stationCode] = stationData;
            return updated;
        });
    }, [pickPackets, setWaveDataMap]);
}
