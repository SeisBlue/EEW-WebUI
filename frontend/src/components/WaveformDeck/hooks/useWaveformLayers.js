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
 * 繪製基線、波形路徑和 Pick 標記
 */


/**
 * 波形圖層 Hook
 * 繪製基線、波形路徑和 Pick 標記
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
  maxLat
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

    // 合併所有基線到單個數據集
    const baselineData = [];
    const waveformData = [];
    const pickLines = [];
    const pickLabels = [];

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
        const hasPicks = waveData.picks && waveData.picks.length > 0;

        // 確定波形樣式
        let waveColor;
        let lineWidth;

        if (hasPicks) {
          waveColor = COLORS.WAVEFORM_ACTIVE;
          lineWidth = 0.5;
        } else {
          waveColor = COLORS.WAVEFORM_DIM;
          lineWidth = 0.5;
        }

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
              width: lineWidth
            });
          }
        });
      }

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
        wrapLongitude: true, // 啟用經度環繞
        updateTriggers: {
          getPath: [waveDataMap, baseTime]
        }
      }));
    }

    if (pickLines.length > 0) {
      layers.push(new PathLayer({
        id: 'pick-lines',
        data: pickLines,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1,
        wrapLongitude: true, // 啟用經度環繞
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
  }, [stations, stationMap, waveDataMap, mapLat, baseTime, timeWindow, bottomMargin, degreesPerSecond, minLat, maxLat]);
}
