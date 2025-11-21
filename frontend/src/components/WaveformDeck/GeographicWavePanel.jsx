import { useMemo, memo } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { useGridLayers } from './hooks/useGridLayers';
import { useTimeAxisLayer } from './hooks/useTimeAxisLayer';
import { useLabelLayers } from './hooks/useLabelLayers';
import { useWaveformLayers } from './hooks/useWaveformLayers';
import { LAT_MAX, LAT_MIN, LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_MARGIN } from './constants';

const GeographicWavePanel = memo(function GeographicWavePanel({
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
  const xOffset = LEFT_MARGIN;
  const waveWidth = Math.max(100, panelWidth - LEFT_MARGIN - RIGHT_MARGIN);

  // 使用各個 Hook 獲取圖層
  const gridLayers = useGridLayers({
    minLat,
    maxLat,
    panelWidth,
    panelHeight
  });

  const timeAxisLayer = useTimeAxisLayer({
    xOffset,
    waveWidth,
    panelHeight
  });

  const labelLayers = useLabelLayers({
    stations,
    stationMap,
    waveDataMap,
    xOffset,
    waveWidth,
    panelHeight,
    minLat,
    maxLat,
    renderTrigger,
    timeWindow,
    bottomMargin: BOTTOM_MARGIN
  });

  const waveformLayers = useWaveformLayers({
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
    bottomMargin: BOTTOM_MARGIN
  });

  // 整合所有圖層
  const allLayers = [
    ...gridLayers,
    timeAxisLayer,
    ...waveformLayers,
    ...labelLayers
  ];

  // 定義兩個 View
  const views = [
    new OrthographicView({
      id: 'static-view',
      controller: false,
      x: 0,
      y: 0,
      width: '100%',
      height: '100%'
    }),
    new OrthographicView({
      id: 'wave-view',
      controller: false,
      x: xOffset,
      y: 0,
      width: waveWidth,
      height: '100%'
    })
  ];

  // 確保尺寸有效
  const validWidth = Math.max(panelWidth, 1);
  const validHeight = Math.max(panelHeight, 1);

  // 計算 wave-view 的相機位置
  const waveSpeed = waveWidth / (timeWindow * 1000);
  const cameraXOffset = (renderTrigger - baseTime) * waveSpeed;

  // static-view 保持固定
  const staticViewState = {
    target: [validWidth / 2, validHeight / 2, 0],
    zoom: 0
  };

  // wave-view 隨時間移動
  const waveViewState = {
    target: [xOffset + waveWidth / 2 + cameraXOffset, validHeight / 2, 0],
    zoom: 0
  };

  const viewState = {
    'static-view': staticViewState,
    'wave-view': waveViewState
  };

  // Layer Filter: 分配圖層到對應的 View
  const layerFilter = ({ layer, viewport }) => {
    if (viewport.id === 'static-view') {
      return ['grid-lines', 'grid-labels', 'time-axis', 'labels', 'baselines'].includes(layer.id);
    } else if (viewport.id === 'wave-view') {
      return ['waveforms', 'pick-lines', 'pick-labels'].includes(layer.id);
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
    <div className="geographic-wave-panel">
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
  // 自定義比較函數：只在關鍵屬性變化時重新渲染
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

GeographicWavePanel.propTypes = {
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

export default GeographicWavePanel;
