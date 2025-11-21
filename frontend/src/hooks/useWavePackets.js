import { useEffect } from 'react';
import { extractStationCode } from '../utils';

const DATA_RETENTION_WINDOW = 120; // 資料暫存時間窗口（秒）

/**
 * Hook for processing wave packets
 * Handles waveform data, gap detection, statistics calculation, and data retention
 * 
 * @param {Object} options
 * @param {Array} options.wavePackets - Array of wave packets from WebSocket
 * @param {Function} options.setWaveDataMap - setState function to update waveDataMap
 */
export function useWavePackets({ wavePackets, setWaveDataMap }) {
  useEffect(() => {
    if (wavePackets.length === 0) return;

    const latestPacket = wavePackets[0];

    setWaveDataMap(prev => {
      const updated = { ...prev };
      const now = Date.now();

      // Process each station's waveform data
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

          // Initialize or copy existing station data
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

          // Detect time gaps in data
          let hasGap = false;
          if (stationData.lastEndTime !== null && startt) {
            const timeDiff = Math.abs(startt - stationData.lastEndTime);
            const expectedInterval = 1.0 / samprate;
            if (timeDiff > expectedInterval * 2) {
              hasGap = true;
            }
          }

          // Insert gap marker if needed
          if (hasGap && stationData.dataPoints.length > 0) {
            stationData.dataPoints.push({
              timestamp: stationData.lastEndTime * 1000,
              endTimestamp: packetStartTime,
              values: [],
              isGap: true
            });
          }

          // Add new data point
          stationData.dataPoints.push({
            timestamp: packetStartTime,
            endTimestamp: packetEndTime,
            values: waveform,
            samprate: samprate,
            isGap: false
          });

          // Update last end time
          if (endt) {
            stationData.lastEndTime = endt;
          }

          // Update PGA history
          stationData.pgaHistory.push({ timestamp: now, pga: pga });
          stationData.lastPga = pga;

          // Calculate statistics for display scaling
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
            stationData.recentStats.totalMaxAbs = Math.max(
              stationData.recentStats.totalMaxAbs, 
              maxAbs
            );
            stationData.recentStats.totalCount += waveform.length;
          }
        });
      }

      // Clean up old data based on retention window
      const cutoffTime = now - DATA_RETENTION_WINDOW * 1000;
      const recentCutoff = now - 10 * 1000;

      Object.keys(updated).forEach(stationCode => {
        const stationData = updated[stationCode];

        // Remove old data points
        stationData.dataPoints = stationData.dataPoints.filter(
          point => point.endTimestamp >= cutoffTime
        );

        // Remove old PGA history
        stationData.pgaHistory = stationData.pgaHistory.filter(
          item => item.timestamp >= cutoffTime
        );

        // Update statistics by removing old points
        const stats = stationData.recentStats;
        let statsChanged = false;
        while (stats.points.length > 0 && stats.points[0].timestamp < recentCutoff) {
          const removedPoint = stats.points.shift();
          stats.totalSumSquares -= removedPoint.sumSquares;
          stats.totalCount -= removedPoint.count;
          statsChanged = true;
        }

        // Recalculate max if stats changed
        if (statsChanged) {
          stats.totalMaxAbs = stats.points.reduce(
            (max, p) => Math.max(max, p.maxAbs), 
            0
          );
        }

        // Calculate display scale based on recent statistics
        if (stats.totalCount > 0) {
          const rms = Math.sqrt(stats.totalSumSquares / stats.totalCount);
          stationData.displayScale = Math.max(rms * 4, stats.totalMaxAbs * 0.3, 0.05);
        } else if (stationData.dataPoints.length === 0) {
          stationData.displayScale = 1.0;
        }

        // Clean up old picks
        if (stationData.picks) {
          stationData.picks = stationData.picks.filter(
            p => p.time >= cutoffTime
          );
        }

        updated[stationCode] = stationData;
      });

      return updated;
    });
  }, [wavePackets, setWaveDataMap]);
}
