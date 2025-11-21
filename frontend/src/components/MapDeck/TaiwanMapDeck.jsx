import { useState, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { Map } from 'react-map-gl/maplibre';
import PropTypes from 'prop-types';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_STYLE, INITIAL_VIEW_STATE } from './constants';
import { calculateLatitudeRange } from './utils';
import { useMapGridLayers } from './hooks/useMapGridLayers';
import { useStationLayers } from './hooks/useStationLayers';
import { useHoverLabel } from './hooks/useHoverLabel';
import './TaiwanMapDeck.css';

function TaiwanMapDeck({
  stations,
  stationIntensities,
  waveDataMap,
  onBoundsChange
}) {
  // 狀態管理
  const [hoverInfo, setHoverInfo] = useState(null);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [windowHeight, setWindowHeight] = useState(window.innerHeight);

  // 監聽視窗大小變化
  useEffect(() => {
    const handleResize = () => {
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // 使用 Hooks 獲取各個圖層
  const gridLayers = useMapGridLayers();
  const stationLayer = useStationLayers({ 
    stations, 
    stationIntensities, 
    waveDataMap 
  });
  const hoverLabel = useHoverLabel({ hoverInfo });

  // 整合所有圖層
  const allLayers = [
    ...gridLayers,
    stationLayer,
    hoverLabel
  ].filter(Boolean);

  // 懸停事件處理
  const handleHover = ({ object, x, y }) => {
    setHoverInfo({ object, x, y });
  };

  // 視圖狀態變化處理
  const handleViewStateChange = ({ viewState: newViewState }) => {
    setViewState(newViewState);

    // 計算可視範圍的緯度邊界
    const { latitude, zoom } = newViewState;
    const { minLat, maxLat } = calculateLatitudeRange(latitude, zoom, windowHeight);

    // 回傳邊界給父組件
    if (onBoundsChange) {
      onBoundsChange({ minLat, maxLat });
    }
  };

  return (
    <div className="taiwan-map-deck-container">
      <DeckGL
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        controller={true}
        layers={allLayers}
        onHover={handleHover}
      >
        <Map
          reuseMaps
          mapStyle={MAP_STYLE}
        />
      </DeckGL>
    </div>
  );
}

TaiwanMapDeck.propTypes = {
  stations: PropTypes.array.isRequired,
  stationIntensities: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  onBoundsChange: PropTypes.func,  // 可選：地圖邊界變化回調
};

export default TaiwanMapDeck;
