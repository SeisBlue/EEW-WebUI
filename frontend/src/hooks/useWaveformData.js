import { useState, useMemo, useRef, useEffect } from 'react';
import { pgaToIntensity, getIntensityColor } from '../utils';
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
 */
export function useWaveformData({ wavePackets, pickPackets }) {
  const [waveDataMap, setWaveDataMap] = useState({});

  // Use sub-hooks for processing different packet types
  useWavePackets({ wavePackets, setWaveDataMap });
  usePickPackets({ pickPackets, setWaveDataMap });

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
