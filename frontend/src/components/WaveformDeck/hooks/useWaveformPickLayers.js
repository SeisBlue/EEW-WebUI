import { useMemo } from 'react';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { COLORS } from '../constants';
import {
  calculateLongitude,
} from '../utils';

/**
 * 波形 Pick 標記圖層 Hook
 * 繪製 Pick 標記線和標籤，完全獨立於波形圖層
 */
export function useWaveformPickLayers({
  stations,
  stationMap,
  waveDataMap,
  mapLat,
  baseTime,
  degreesPerSecond,
  waveHeightLat  // 從外部傳入波形高度，確保一致性
}) {
  return useMemo(() => {
    const pickLines = [];
    const pickLabels = [];

    stations.forEach((stationCode) => {
      const station = stationMap[stationCode];
      if (!station || !station.latitude) return;

      const centerLat = mapLat(station.latitude);
      const waveData = waveDataMap[stationCode];

      // 處理 Pick 標記
      if (waveData?.picks?.length > 0) {
        waveData.picks.forEach(pick => {
          const pickTime = pick.time;

          // 計算經度
          const lon = calculateLongitude(pickTime, baseTime, degreesPerSecond);

          // Pick 線
          pickLines.push({
            path: [[lon, centerLat - waveHeightLat / 2], [lon, centerLat + waveHeightLat / 2]],
            color: COLORS.PICK_MARKER,
            width: 2
          });

          // Pick 文字
          pickLabels.push({
            position: [lon, centerLat - waveHeightLat / 2 - (waveHeightLat * 0.1)], // 稍微往下偏移
            text: pick.type || 'P',
            color: COLORS.PICK_LABEL,
            size: 12,
            anchor: 'middle'
          });
        });
      }
    });

    const layers = [];

    if (pickLines.length > 0) {
      layers.push(new PathLayer({
        id: 'pick-lines',
        data: pickLines,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1,
        wrapLongitude: true,
        updateTriggers: {
          getPath: [waveDataMap, baseTime]
        }
      }));
    }

    if (pickLabels.length > 0) {
      layers.push(new TextLayer({
        id: 'pick-labels',
        data: pickLabels,
        getPosition: d => d.position,
        getText: d => d.text,
        getColor: d => d.color,
        getSize: d => d.size,
        getTextAnchor: d => d.anchor,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        updateTriggers: {
          getPosition: [waveDataMap, baseTime]
        }
      }));
    }

    return layers;
  }, [stations, stationMap, waveDataMap, mapLat, baseTime, degreesPerSecond, waveHeightLat]);
}
