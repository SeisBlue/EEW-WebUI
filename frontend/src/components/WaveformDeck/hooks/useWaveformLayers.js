import { useMemo } from 'react';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { pgaToIntensity, getIntensityValue } from '../../../utils/intensity';
import { SAMPLE_RATE, COLORS, WAVE_AMPLITUDE_SCALE } from '../constants';
import {
  calculateLongitude,
  calculateWaveformLat
} from '../utils';

/**
 * 波形圖層 Hook
 * 繪製基線、波形路徑
 * @param {Set<string>} highlightedStations - 需要高亮顯示的測站集合（例如有 pick 的測站、hover 的測站等）
 */
export function useWaveformLayers({
  stations,
  stationMap,
  waveDataMap,
  mapLat, // 緯度映射函數 (現在是恆等函數)
  baseTime,
  timeWindow,
  bottomMargin,
  degreesPerSecond,
  minLat,
  maxLat,
  highlightedStations = new Set()  // 默認為空集合
}) {
  return useMemo(() => {
    // 預計算所有測站的 Y 位置 (緯度)
    const stationPositions = new Map();

    stations.forEach((stationCode) => {
      const station = stationMap[stationCode];
      if (!station || !station.latitude) return;

      const centerLat = mapLat(station.latitude);
      stationPositions.set(stationCode, centerLat);
    });

    // 計算波形高度 (緯度度數)
    // 使用真實緯度範圍
    const latRange = maxLat - minLat;
    const waveHeightLat = (latRange / (stations.length || 1)) * WAVE_AMPLITUDE_SCALE;

    const baselineData = [];
    const waveformData = [];

    stations.forEach((stationCode) => {
      const centerLat = stationPositions.get(stationCode);
      if (centerLat === undefined) return;

      const waveData = waveDataMap[stationCode];

      // 添加基線 (環繞地球一圈)
      baselineData.push({
        path: [[-180, centerLat], [180, centerLat]],
        color: COLORS.BASELINE,
        width: 0.5
      });

      // 處理波形數據
      if (waveData?.dataPoints?.length > 0) {
        const displayScale = waveData.displayScale || 1.0;
        
        // 根據是否高亮選擇顏色
        const isHighlighted = highlightedStations.has(stationCode);
        const waveColor = isHighlighted ? COLORS.WAVEFORM_ACTIVE : COLORS.WAVEFORM_DIM;

        waveData.dataPoints.forEach(point => {
          const { timestamp, values, samprate, isGap } = point;

          if (isGap) return;

          const pathPoints = [];
          const effectiveSamprate = point.effective_samprate || samprate || SAMPLE_RATE;
          const len = values.length;

          for (let idx = 0; idx < len; idx++) {
            const sampleTime = timestamp + (idx / effectiveSamprate) * 1000;

            // 計算經度
            const lon = calculateLongitude(sampleTime, baseTime, degreesPerSecond);

            // 計算緯度
            const lat = calculateWaveformLat(
              values[idx],
              displayScale,
              centerLat,
              waveHeightLat
            );

            pathPoints.push([lon, lat]);
          }

          if (pathPoints.length > 1) {
            waveformData.push({
              path: pathPoints,
              color: waveColor,
              width: 0.5
            });
          }
        });
      }
    });

    const layers = [];

    if (baselineData.length > 0) {
      layers.push(new PathLayer({
        id: 'baselines',
        data: baselineData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 0.5,
        getDashArray: [3, 3],
        wrapLongitude: true // 啟用經度環繞
      }));
    }

    if (waveformData.length > 0) {
      layers.push(new PathLayer({
        id: 'waveforms',
        data: waveformData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1.2,
        jointRounded: false,
        capRounded: false,
        wrapLongitude: true,
        updateTriggers: {
          getPath: [waveDataMap, baseTime]
        }
      }));
    }

    return layers;
  }, [stations, stationMap, waveDataMap, mapLat, baseTime, timeWindow, bottomMargin, degreesPerSecond, minLat, maxLat, highlightedStations]);
}
