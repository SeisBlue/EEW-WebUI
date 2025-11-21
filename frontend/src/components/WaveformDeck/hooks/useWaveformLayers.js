import { useMemo } from 'react';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { pgaToIntensity, getIntensityValue } from '../../../utils/intensity';
import { SAMPLE_RATE, WAVE_HEIGHT, COLORS } from '../constants';
import {
  calculateStationYPosition,
  calculateDownsampleFactor,
  calculateWaveformX,
  calculateWaveformY,
  calculatePickXPosition
} from '../utils';

/**
 * 波形圖層 Hook
 * 繪製基線、波形路徑和 Pick 標記
 */
export function useWaveformLayers({
  stations,
  stationMap,
  waveDataMap,
  waveWidth,
  xOffset,
  panelHeight,
  minLat,
  maxLat,
  baseTime,
  timeWindow,
  bottomMargin
}) {
  return useMemo(() => {
    // 預計算所有測站的 Y 位置
    const stationPositions = new Map();
    const availableHeight = panelHeight - bottomMargin;
    
    stations.forEach((stationCode) => {
      const station = stationMap[stationCode];
      if (!station || !station.latitude) return;

      const centerY = calculateStationYPosition(
        station.latitude,
        minLat,
        maxLat,
        availableHeight
      );
      stationPositions.set(stationCode, centerY);
    });

    // 合併所有基線到單個數據集
    const baselineData = [];
    const waveformData = [];
    const pickLines = [];
    const pickLabels = [];

    stations.forEach((stationCode) => {
      const centerY = stationPositions.get(stationCode);
      if (centerY === undefined) return;

      const waveData = waveDataMap[stationCode];

      // 添加基線
      baselineData.push({
        path: [[xOffset, centerY], [xOffset + waveWidth, centerY]],
        color: COLORS.BASELINE,
        width: 0.5
      });

      // 處理波形數據
      if (waveData?.dataPoints?.length > 0) {
        const displayScale = waveData.displayScale || 1.0;

        // 計算速度：像素/毫秒
        const speed = waveWidth / (timeWindow * 1000);

        // 根據 PGA 計算震度等級
        const pga = waveData.lastPga || 0;
        const intensityStr = pgaToIntensity(pga);
        const intensityValue = getIntensityValue(intensityStr);
        const hasPicks = waveData.picks && waveData.picks.length > 0;

        // 確定波形樣式
        let waveColor;
        let lineWidth;

        if (hasPicks || intensityValue >= 4) {
          // 有 pick 或震度 4+ 使用正常顏色和粗線
          waveColor = COLORS.WAVEFORM_ACTIVE;
          lineWidth = 1.0;
        } else {
          // 否則使用淡色和細線
          waveColor = COLORS.WAVEFORM_DIM;
          lineWidth = 0.5;
        }

        waveData.dataPoints.forEach(point => {
          const { timestamp, values, samprate, isGap } = point;

          // 跳過斷點標記
          if (isGap) return;

          const pathPoints = [];

          // 使用實際的採樣率和時間戳
          const effectiveSamprate = samprate || SAMPLE_RATE;
          const len = values.length;

          // 動態降採樣
          const downsampleFactor = calculateDownsampleFactor(
            timeWindow,
            effectiveSamprate,
            waveWidth
          );

          // 優化：使用 for 循環代替 forEach，減少函數調用開銷
          for (let idx = 0; idx < len; idx += downsampleFactor) {
            // 計算這個樣本點的實際時間
            const sampleTime = timestamp + (idx / effectiveSamprate) * 1000;

            // 計算 X 座標
            const x = calculateWaveformX(
              sampleTime,
              baseTime,
              speed,
              xOffset,
              waveWidth
            );

            // 計算 Y 座標
            const y = calculateWaveformY(
              values[idx],
              displayScale,
              centerY,
              WAVE_HEIGHT
            );

            pathPoints.push([x, y]);
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
        const speed = waveWidth / (timeWindow * 1000);

        waveData.picks.forEach(pick => {
          const pickTime = pick.time;

          // 計算 X 座標
          const x = calculatePickXPosition(
            pickTime,
            baseTime,
            speed,
            xOffset,
            waveWidth
          );

          // Pick 線
          pickLines.push({
            path: [[x, centerY - WAVE_HEIGHT / 2], [x, centerY + WAVE_HEIGHT / 2]],
            color: COLORS.PICK_MARKER,
            width: 2
          });

          // Pick 文字
          pickLabels.push({
            position: [x, centerY - WAVE_HEIGHT / 2 - 8],
            text: pick.type || 'P',
            color: COLORS.PICK_LABEL,
            size: 12,
            anchor: 'middle'
          });
        });
      }
    });

    // 使用單個 PathLayer 繪製所有基線
    const layers = [];

    if (baselineData.length > 0) {
      layers.push(new PathLayer({
        id: 'baselines',
        data: baselineData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 0.5,
        getDashArray: [3, 3]
      }));
    }

    // 使用單個 PathLayer 繪製所有波形
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
        updateTriggers: {
          getPath: [waveDataMap, baseTime]
        }
      }));
    }

    // 繪製 Pick 線
    if (pickLines.length > 0) {
      layers.push(new PathLayer({
        id: 'pick-lines',
        data: pickLines,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1,
        updateTriggers: {
          getPath: [waveDataMap, baseTime]
        }
      }));
    }

    // 繪製 Pick 標籤
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
  }, [stations, stationMap, waveDataMap, waveWidth, xOffset, panelHeight, minLat, maxLat, baseTime, timeWindow, bottomMargin]);
}
