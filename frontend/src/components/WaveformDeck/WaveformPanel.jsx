import { useMemo, memo } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { useGridLayers } from './hooks/useGridLayers';
import { useTimeAxisLayer } from './hooks/useTimeAxisLayer';
import { useLabelLayers } from './hooks/useLabelLayers';
import { useWaveformLayers } from './hooks/useWaveformLayers';
import { useWaveformPickLayers } from './hooks/useWaveformPickLayers';
import { calculateLongitude } from './utils';
import { LAT_MAX, LAT_MIN, LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_MARGIN, WAVE_AMPLITUDE_SCALE } from './constants';



const WaveformPanel = memo(function WaveformPanel({
  title,
  stations,
  stationMap,
  waveDataMap,
  latMin,
  latMax,
  mapZoom,
  panelWidth,
  panelHeight,
  renderTrigger,
  timeWindow,
  baseTime
}) {
  const minLat = latMin ?? LAT_MIN;
  const maxLat = latMax ?? LAT_MAX;

  // 計算佈局尺寸
  const waveWidth = Math.max(100, panelWidth - LEFT_MARGIN - RIGHT_MARGIN);
  // 有效高度：扣除底部邊距，這是波形實際佔用的高度
  const effectiveHeight = Math.max(100, panelHeight - BOTTOM_MARGIN);

  // 1. 計算緯度範圍
  const latRange = maxLat - minLat;

  // 2. 使用 Map 的 Zoom Level 計算經度範圍
  // Deck.gl Zoom 0: 360度 = 512px
  // 360 / lonRange * (512 / 360) * 2^zoom = waveWidth
  // lonRange = (waveWidth * 360) / (512 * 2^zoom)
  const zoom = mapZoom ?? 7; // Default zoom if not provided
  const lonRange = (waveWidth * 360) / (512 * Math.pow(2, zoom));

  // 3. 計算每秒對應的經度
  const degreesPerSecond = lonRange / timeWindow;


  // 5. 計算中心緯度 (用於 ViewState)
  // 我們希望 minLat 顯示在 panelHeight 的底部
  // 也就是說，視圖的底部邊緣 (panelHeight) 對應 minLat
  // 視圖頂部邊緣 (0) 對應 maxLat
  // 中心 = (minLat + maxLat) / 2
  const centerLat = (minLat + maxLat) / 2;

  // 計算每像素的緯度數 (用於其他計算)
  const degreesPerPixelLat = latRange / panelHeight;

  // 計算當前時間對應的經度
  const currentLon = calculateLongitude(renderTrigger, baseTime, degreesPerSecond);

  // 緯度映射函數：直接返回真實緯度
  const mapLat = (lat) => lat;

  // 計算波形高度 (緯度度數) - 與 useWaveformLayers 保持一致
  const waveHeightLat = useMemo(() => {
    return (latRange / (stations.length || 1)) * WAVE_AMPLITUDE_SCALE;
  }, [latRange, stations.length]);

  // 使用各個 Hook 獲取圖層
  const gridLayers = useGridLayers({
    mapLat,
    currentLon,
    waveWidth,
    panelWidth,
    panelHeight,
    minLat,
    maxLat,
    lonRange
  });

  const timeAxisLayer = useTimeAxisLayer({
    timeWindow,
    panelHeight,
    minLat,
    maxLat,
    lonRange
  });

  const labelLayers = useLabelLayers({
    stations,
    stationMap,
    waveDataMap,
    mapLat,
    panelHeight,
    renderTrigger,
    timeWindow,
    bottomMargin: BOTTOM_MARGIN,
    minLat,
    maxLat,
    lonRange
  });

  // 計算需要高亮的測站集合（目前是有 pick 的測站，未來可擴展為 hover 等）
  const highlightedStations = useMemo(() => {
    const highlighted = new Set();
    stations.forEach(stationCode => {
      const waveData = waveDataMap[stationCode];
      // 有 pick 的測站應該被高亮
      if (waveData?.picks && waveData.picks.length > 0) {
        highlighted.add(stationCode);
      }
      // 未來可以在這裡添加其他高亮條件，例如：
      // if (hoveredStation === stationCode) highlighted.add(stationCode);
    });
    return highlighted;
  }, [stations, waveDataMap]);

  const waveformLayers = useWaveformLayers({
    stations,
    stationMap,
    waveDataMap,
    mapLat,
    baseTime,
    timeWindow,
    bottomMargin: BOTTOM_MARGIN,
    degreesPerSecond,
    minLat,
    maxLat,
    highlightedStations  // 傳遞高亮測站集合
  });

  const pickLayers = useWaveformPickLayers({
    stations,
    stationMap,
    waveDataMap,
    mapLat,
    baseTime,
    degreesPerSecond,
    waveHeightLat
  });

  // 整合所有圖層
  const allLayers = [
    ...gridLayers,
    timeAxisLayer,
    ...waveformLayers,
    ...pickLayers,  // Pick 圖層：獨立於波形圖層
    ...labelLayers
  ];

  // 確保尺寸有效
  const validWidth = Math.max(panelWidth, 1);
  const validHeight = Math.max(panelHeight, 1);

  // 定義兩個 View
  const views = [
    new MapView({
      id: 'wave-view',
      controller: false,
      x: LEFT_MARGIN, // 波形視圖從左邊距開始
      y: 0,
      width: waveWidth,
      height: '100%',
      repeat: true
    }),
    new MapView({
      id: 'label-view',
      controller: false,
      x: 0, // 標籤視圖覆蓋整個寬度 (或僅左側)
      y: 0,
      width: '100%', // 為了方便，讓它覆蓋整個寬度，但我們只在左側繪製標籤
      height: '100%',
      repeat: false // 標籤不需要重複
    })
  ];

  // ViewState
  const viewState = {
    'wave-view': {
      longitude: currentLon - (lonRange / 2), // 將當前時間置於視圖右側? 不，currentLon 是 "現在"。
      // 我們希望現在在最右邊。
      // 如果視圖寬度是 lonRange。
      // 中心點應該是 currentLon - (lonRange / 2)
      latitude: centerLat,
      zoom: zoom,
      pitch: 0,
      bearing: 0,
      transitionDuration: 0
    },
    'label-view': {
      longitude: 0, // 固定
      latitude: centerLat,
      zoom: zoom, // 保持縮放一致，確保垂直對齊
      pitch: 0,
      bearing: 0,
      transitionDuration: 0
    }
  };

  // Layer Filter
  const layerFilter = ({ layer, viewport }) => {
    if (viewport.id === 'wave-view') {
      // 波形視圖顯示：波形、Pick線/標籤、網格線、基線
      return ['waveforms', 'pick-lines', 'pick-labels', 'grid-lines', 'baselines'].includes(layer.id);
    } else if (viewport.id === 'label-view') {
      // 標籤視圖顯示：測站標籤、網格標籤、時間軸(靜態)
      return ['labels', 'grid-labels', 'time-axis'].includes(layer.id);
    }
    return false;
  };

  // 計算有資料的測站數量
  const activeStationCount = useMemo(() => {
    return stations.filter(stationCode => {
      return waveDataMap?.[stationCode]?.pgaHistory?.length > 0;
    }).length;
  }, [stations, waveDataMap]);

  return (
    <div className="waveform-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{activeStationCount} / {stations.length} 站</span>
        <span className="time-window-display" style={{ marginLeft: '10px', color: '#64B5F6', fontSize: '12px' }}>
          時間窗口: {timeWindow.toFixed(1)}s
        </span>
      </div>
      <div className="deckgl-container" style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0e27' }}>
        <DeckGL
          views={views}
          viewState={viewState}
          layers={allLayers}
          layerFilter={layerFilter}
          width={validWidth}
          height={validHeight}
          controller={false}
          getCursor={() => 'default'}
        />
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.title === nextProps.title &&
    prevProps.stations === nextProps.stations &&
    prevProps.stationMap === nextProps.stationMap &&
    prevProps.waveDataMap === nextProps.waveDataMap &&
    prevProps.latMin === nextProps.latMin &&
    prevProps.latMax === nextProps.latMax &&
    prevProps.panelWidth === nextProps.panelWidth &&
    prevProps.panelHeight === nextProps.panelHeight &&
    prevProps.renderTrigger === nextProps.renderTrigger &&
    prevProps.timeWindow === nextProps.timeWindow &&
    prevProps.baseTime === nextProps.baseTime
  );
});

WaveformPanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  panelWidth: PropTypes.number.isRequired,
  panelHeight: PropTypes.number.isRequired,
  renderTrigger: PropTypes.number.isRequired,
  timeWindow: PropTypes.number.isRequired,
  baseTime: PropTypes.number.isRequired,
  mapZoom: PropTypes.number
};

export default WaveformPanel;
