import { useMemo, memo } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { useGridLayers } from './hooks/useGridLayers';
import { useTimeAxisLayer } from './hooks/useTimeAxisLayer';
import { useLabelLayers } from './hooks/useLabelLayers';
import { useWaveformLayers } from './hooks/useWaveformLayers';
import { calculateLongitude } from './utils';
import { LAT_MAX, LAT_MIN, LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_MARGIN } from './constants';



const WaveformPanel = memo(function WaveformPanel({
  title,
  stations,
  stationMap,
  waveDataMap,
  latMin,
  latMax,
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

  // 2. 計算經度範圍 (基於螢幕寬高比)
  // 我們希望 latRange 對應 effectiveHeight
  // lonRange 對應 waveWidth
  // 保持 1:1 比例
  const lonRange = latRange * (waveWidth / effectiveHeight);

  // 3. 計算每秒對應的經度
  const degreesPerSecond = lonRange / timeWindow;

  // 4. 計算 Zoom Level
  // Deck.gl Zoom 0: 360度 = 512px
  const zoom = Math.log2(waveWidth / (lonRange * (512 / 360)));


  // 5. 計算中心緯度 (用於 ViewState)
  // 我們希望 minLat 顯示在 effectiveHeight 的底部 (即 panelHeight - BOTTOM_MARGIN 的位置)
  // 也就是說，視圖的底部邊緣 (panelHeight) 對應的緯度應該比 minLat 更低
  // 計算每像素的緯度數
  const degreesPerPixelLat = latRange / effectiveHeight;
  // 底部邊距對應的緯度差
  const bottomMarginDegrees = BOTTOM_MARGIN * degreesPerPixelLat;
  
  // 視圖的總緯度範圍 (包含底部邊距)
  const totalLatRange = latRange + bottomMarginDegrees;
  
  // 視圖的中心緯度
  // 視圖底部緯度 = minLat - bottomMarginDegrees
  // 視圖頂部緯度 = maxLat
  // 中心 = (視圖底部 + 視圖頂部) / 2
  const centerLat = ((minLat - bottomMarginDegrees) + maxLat) / 2;

  // 計算當前時間對應的經度
  const currentLon = calculateLongitude(renderTrigger, baseTime, degreesPerSecond);

  // 緯度映射函數：直接返回真實緯度
  const mapLat = (lat) => lat;

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
    maxLat
  });

  // 整合所有圖層
  const allLayers = [
    ...gridLayers,
    timeAxisLayer,
    ...waveformLayers,
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
  baseTime: PropTypes.number.isRequired
};

export default WaveformPanel;
