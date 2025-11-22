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
  // Process incoming wave packets
  useEffect(() => {
    if (wavePackets.length === 0) return;

    setWaveDataMap(prev => {
      const updated = { ...prev };
      const now = Date.now();

      // Process all packets in the batch
      wavePackets.forEach(latestPacket => {
        if (!latestPacket.data) return;

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
          // Note: We modify the 'updated' object in place for the batch
          let stationData = updated[stationCode];

          if (!stationData) {
            stationData = {
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
            updated[stationCode] = stationData;
          } else {
            // Shallow copy for immutability of the map structure, 
            // but we can mutate the arrays if we are careful or just copy them once per batch.
            // To be safe and follow React patterns, we clone the station object.
            // However, for performance with large batches, we might want to clone once.
            // Since we are inside setWaveDataMap updater, 'updated' is a new object.
            // We need to clone the stationData if it comes from 'prev'.
            if (stationData === prev[stationCode]) {
              stationData = {
                ...stationData,
                dataPoints: [...stationData.dataPoints],
                pgaHistory: [...stationData.pgaHistory],
                recentStats: {
                  ...stationData.recentStats,
                  points: [...stationData.recentStats.points]
                }
              };
              updated[stationCode] = stationData;
            }
          }

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
            effective_samprate: wavePacketData.effective_samprate,  // 保存後端計算的有效採樣率
            isGap: false
          });

          // Sort dataPoints by timestamp to ensure cleanup logic works correctly
          // (Oldest data must be at the beginning of the array)
          stationData.dataPoints.sort((a, b) => a.timestamp - b.timestamp);

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

            // Sort recentStats points by timestamp
            stationData.recentStats.points.sort((a, b) => a.timestamp - b.timestamp);

            stationData.recentStats.totalSumSquares += sumSquares;
            stationData.recentStats.totalCount += waveform.length;

            // Update display scale immediately
            // Use RMS * 5 for robust scaling that ignores single spikes
            if (stationData.recentStats.totalCount > 0) {
              const rms = Math.sqrt(stationData.recentStats.totalSumSquares / stationData.recentStats.totalCount);
              stationData.displayScale = Math.max(rms * 5, 0.05);
            }
          }
        });
      });

      return updated;
    });
  }, [wavePackets, setWaveDataMap]);

  // Periodic cleanup of old data (every 1 second)
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      setWaveDataMap(prev => {
        const now = Date.now();
        const cutoffTime = now - DATA_RETENTION_WINDOW * 1000;
        let hasChanges = false;
        const updated = { ...prev };

        Object.keys(updated).forEach(stationCode => {
          const stationData = updated[stationCode];

          // Check if cleanup is needed to avoid unnecessary copying
          const needsCleanup = (
            (stationData.dataPoints.length > 0 && stationData.dataPoints[0].endTimestamp < cutoffTime) ||
            (stationData.pgaHistory.length > 0 && stationData.pgaHistory[0].timestamp < cutoffTime) ||
            (stationData.recentStats.points.length > 0 && stationData.recentStats.points[0].timestamp < cutoffTime) ||
            (stationData.picks && stationData.picks.length > 0 && stationData.picks[0].time < cutoffTime)
          );

          if (!needsCleanup) return;

          hasChanges = true;
          const newStationData = { ...stationData };

          // Remove old data points
          newStationData.dataPoints = stationData.dataPoints.filter(
            point => point.endTimestamp >= cutoffTime
          );

          // Remove old PGA history
          newStationData.pgaHistory = stationData.pgaHistory.filter(
            item => item.timestamp >= cutoffTime
          );

          // Update statistics by removing old points
          const stats = { ...stationData.recentStats, points: [...stationData.recentStats.points] };
          let statsChanged = false;
          while (stats.points.length > 0 && stats.points[0].timestamp < cutoffTime) {
            const removedPoint = stats.points.shift();
            stats.totalSumSquares -= removedPoint.sumSquares;
            stats.totalCount -= removedPoint.count;
            statsChanged = true;
          }

          if (statsChanged) {
            stats.totalMaxAbs = stats.points.reduce(
              (max, p) => Math.max(max, p.maxAbs),
              0
            );
          }
          newStationData.recentStats = stats;

          // Calculate display scale based on recent statistics
          if (stats.totalCount > 0) {
            const rms = Math.sqrt(stats.totalSumSquares / stats.totalCount);
            // Use RMS * 5 for robust scaling that ignores single spikes
            newStationData.displayScale = Math.max(rms * 5, 0.05);
          } else if (newStationData.dataPoints.length === 0) {
            newStationData.displayScale = 1.0;
          }

          // Clean up old picks
          if (stationData.picks) {
            newStationData.picks = stationData.picks.filter(
              p => p.time >= cutoffTime
            );
          }

          updated[stationCode] = newStationData;
        });

        return hasChanges ? updated : prev;
      });
    }, 1000);

    return () => clearInterval(cleanupInterval);
  }, [setWaveDataMap]);
}
