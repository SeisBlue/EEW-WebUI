import { useState, useMemo, useRef, useEffect } from 'react';
import { pgaToIntensity } from '../utils';
import { useWavePackets } from './useWavePackets';
import { usePickPackets } from './usePickPackets';

const DATA_RETENTION_WINDOW = 120; // 資料暫存時間窗口（秒）

/**
 * Custom hook for processing waveform and pick data
 * Integrates wave packet and pick packet processing
 * 
 * @param {Object} options - Configuration options
 * @param {Array} options.wavePackets - Array of wave packets
 * @param {Array} options.pickPackets - Array of pick packets
 * @returns {Object} { waveDataMap, stationIntensities, mapStationIntensities }
 *   - stationIntensities: { [stationCode]: { pga, intensity } }
 *   - 各組件可根據 intensity 自行決定顯示顏色
 */
export function useWaveformData({ wavePackets, pickPackets }) {
  const [waveDataMap, setWaveDataMap] = useState({});

  // Use sub-hooks for processing different packet types
  useWavePackets({ wavePackets, setWaveDataMap });
  usePickPackets({ pickPackets, setWaveDataMap });

  // Derive station intensities from waveDataMap
  // 只提供 PGA 和震度，不計算顏色
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

      intensities[stationCode] = {
        pga: maxPga,
        intensity: intensity
        // 移除 color，讓各組件自行決定如何根據 intensity 顯示顏色
      };
    });
    return intensities;
  }, [waveDataMap]);

  // Throttled station intensities for the map (1 second update interval)
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
