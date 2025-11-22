import { useState, useEffect, useRef } from 'react';
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
  const [containerHeight, setContainerHeight] = useState(window.innerHeight);
  const containerRef = useRef(null);

  // 監聽容器大小變化
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const { height } = containerRef.current.getBoundingClientRect();
        setContainerHeight(height);
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);

    const resizeObserver = new ResizeObserver(updateSize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateSize);
      resizeObserver.disconnect();
    };
  }, []);

  // 當容器高度或視圖狀態改變時，重新計算邊界
  useEffect(() => {
    const { latitude, zoom } = viewState;
    const { minLat, maxLat } = calculateLatitudeRange(latitude, zoom, containerHeight);

    if (onBoundsChange) {
      onBoundsChange({ minLat, maxLat, zoom });
    }
  }, [viewState, containerHeight, onBoundsChange]);

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
    // 邊界計算已移至 useEffect
  };

  return (
    <div ref={containerRef} className="taiwan-map-deck-container" style={{ width: '100%', height: '100%', position: 'relative' }}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        controller={true}
        layers={allLayers}
        onHover={handleHover}
        width="100%"
        height="100%"
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
