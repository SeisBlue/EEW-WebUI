import { useState, useEffect, useMemo, useRef } from 'react';
import { extractStationCode, parseEarthwormTime, pgaToIntensity, getIntensityColor } from '../utils';

const DATA_RETENTION_WINDOW = 120; // 資料暫存時間窗口（秒）

/**
 * Custom hook for processing waveform and pick data
 * @param {Object} options - Configuration options
 * @param {Array} options.wavePackets - Array of wave packets
 * @param {Array} options.pickPackets - Array of pick packets
 * @returns {Object} { waveDataMap, stationIntensities, mapStationIntensities }
 */
export function useWaveformData({ wavePackets, pickPackets }) {
    const [waveDataMap, setWaveDataMap] = useState({});

    // Process new wave packets
    useEffect(() => {
        if (wavePackets.length === 0) return;

        const latestPacket = wavePackets[0];

        setWaveDataMap(prev => {
            const updated = { ...prev };
            const now = Date.now();

            if (latestPacket.data) {
                Object.keys(latestPacket.data).forEach(seedStation => {
                    const stationCode = extractStationCode(seedStation);
                    const wavePacketData = latestPacket.data[seedStation];
                    const {
                        pga = 0,
                        startt,
                        endt,
                        samprate = 100,
                        waveform = []
                    } = wavePacketData;

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
                        }
                    };
                    const stationData = {
                        ...prevStationData,
                        dataPoints: [...prevStationData.dataPoints],
                        pgaHistory: [...prevStationData.pgaHistory],
                        recentStats: {
                            ...prevStationData.recentStats,
                            points: [...prevStationData.recentStats.points]
                        }
                    };
                    updated[stationCode] = stationData;

                    const packetStartTime = startt ? startt * 1000 : now;
                    const packetEndTime = endt ? endt * 1000 : now;

                    let hasGap = false;
                    if (stationData.lastEndTime !== null && startt) {
                        const timeDiff = Math.abs(startt - stationData.lastEndTime);
                        const expectedInterval = 1.0 / samprate;
                        if (timeDiff > expectedInterval * 2) {
                            hasGap = true;
                        }
                    }

                    if (hasGap && stationData.dataPoints.length > 0) {
                        stationData.dataPoints.push({
                            timestamp: stationData.lastEndTime * 1000,
                            endTimestamp: packetStartTime,
                            values: [],
                            isGap: true
                        });
                    }

                    stationData.dataPoints.push({
                        timestamp: packetStartTime,
                        endTimestamp: packetEndTime,
                        values: waveform,
                        samprate: samprate,
                        isGap: false
                    });

                    if (endt) {
                        stationData.lastEndTime = endt;
                    }

                    stationData.pgaHistory.push({ timestamp: now, pga: pga });
                    stationData.lastPga = pga;

                    if (waveform.length > 0) {
                        let sumSquares = 0;
                        let maxAbs = 0;
                        for (const value of waveform) {
                            sumSquares += value * value;
                            maxAbs = Math.max(maxAbs, Math.abs(value));
                        }
                        stationData.recentStats.points.push({
                            timestamp: packetEndTime,
                            sumSquares,
                            maxAbs,
                            count: waveform.length
                        });
                        stationData.recentStats.totalSumSquares += sumSquares;
                        stationData.recentStats.totalMaxAbs = Math.max(stationData.recentStats.totalMaxAbs, maxAbs);
                        stationData.recentStats.totalCount += waveform.length;
                    }
                });
            }

            const cutoffTime = now - DATA_RETENTION_WINDOW * 1000;
            const recentCutoff = now - 10 * 1000;

            Object.keys(updated).forEach(stationCode => {
                const stationData = updated[stationCode];

                stationData.dataPoints = stationData.dataPoints.filter(
                    point => point.endTimestamp >= cutoffTime
                );
                stationData.pgaHistory = stationData.pgaHistory.filter(
                    item => item.timestamp >= cutoffTime
                );

                const stats = stationData.recentStats;
                let statsChanged = false;
                while (stats.points.length > 0 && stats.points[0].timestamp < recentCutoff) {
                    const removedPoint = stats.points.shift();
                    stats.totalSumSquares -= removedPoint.sumSquares;
                    stats.totalCount -= removedPoint.count;
                    statsChanged = true;
                }

                if (statsChanged) {
                    stats.totalMaxAbs = stats.points.reduce((max, p) => Math.max(max, p.maxAbs), 0);
                }

                if (stats.totalCount > 0) {
                    const rms = Math.sqrt(stats.totalSumSquares / stats.totalCount);
                    stationData.displayScale = Math.max(rms * 4, stats.totalMaxAbs * 0.3, 0.05);
                } else if (stationData.dataPoints.length === 0) {
                    stationData.displayScale = 1.0;
                }

                // Clean up old picks
                if (stationData.picks) {
                    stationData.picks = stationData.picks.filter(p => p.time >= cutoffTime);
                }

                updated[stationCode] = stationData;
            });

            return updated;
        });
    }, [wavePackets]);

    // Process new pick packets
    useEffect(() => {
        if (pickPackets.length === 0) return;
        const latestPacket = pickPackets[0];
        const pickData = latestPacket.content;

        if (!pickData || !pickData.station || !pickData.pick_time) return;

        setWaveDataMap(prev => {
            const updated = { ...prev };
            const stationCode = pickData.station;

            // Ensure station data exists
            const prevStationData = updated[stationCode] || {
                dataPoints: [], pgaHistory: [], lastPga: 0, lastEndTime: null,
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

            const pickTime = parseEarthwormTime(pickData.pick_time);
            if (pickTime) {
                // Check for duplicates
                const isDuplicate = stationData.picks.some(p => p.id === pickData.pickid);
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
                stationData.picks = stationData.picks.filter(p => p.time >= cutoff);
            }

            updated[stationCode] = stationData;
            return updated;
        });
    }, [pickPackets]);

    // Derive station intensities from waveDataMap
    const stationIntensities = useMemo(() => {
        const intensities = {};
        Object.keys(waveDataMap).forEach(stationCode => {
            const stationData = waveDataMap[stationCode];
            if (!stationData || !stationData.pgaHistory) return;

            const now = Date.now();
            const dataCutoff = now - DATA_RETENTION_WINDOW * 1000;
            const maxPga = stationData.pgaHistory
                .filter(item => item.timestamp >= dataCutoff)
                .reduce((max, item) => Math.max(max, item.pga), 0);

            const intensity = pgaToIntensity(maxPga);
            const color = getIntensityColor(intensity);

            intensities[stationCode] = {
                pga: maxPga,
                intensity: intensity,
                color: color
            };
        });
        return intensities;
    }, [waveDataMap]);

    // Throttled station intensities for the map
    const [mapStationIntensities, setMapStationIntensities] = useState({});
    const latestStationIntensities = useRef(stationIntensities);
    latestStationIntensities.current = stationIntensities;

    useEffect(() => {
        const interval = setInterval(() => {
            setMapStationIntensities(latestStationIntensities.current);
        }, 1000); // Update map intensities every 1 second

        return () => clearInterval(interval);
    }, []);

    return {
        waveDataMap,
        stationIntensities,
        mapStationIntensities
    };
}
