import { useState, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, TextLayer, PathLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import PropTypes from 'prop-types';
import 'maplibre-gl/dist/maplibre-gl.css';

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

const INITIAL_VIEW_STATE = {
  longitude: 120.9,
  latitude: 23.6,
  zoom: 6.8,
  pitch: 0,
  bearing: 0
};

function TaiwanMap({ stations, stationIntensities, waveDataMap, onBoundsChange }) {
  const [hoverInfo, setHoverInfo] = useState(null);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

  const layers = useMemo(() => {
    const allLayers = [];

    // 緯度網格線
    const latGridLines = [];
    const latGridLabels = [];
    const minLat = 20;
    const maxLat = 30;
    const lonMin = 115;
    const lonMax = 125;

    for (let lat = minLat; lat <= maxLat; lat += 0.5) {
      const isMajor = lat % 1 === 0; // 每 1 度是主要線

      latGridLines.push({
        path: [[lonMin, lat], [lonMax, lat]],
        color: isMajor ? [100, 181, 246, 100] : [100, 181, 246, 50], // 主要線更明顯
        width: isMajor ? 2 : 1
      });

      // 在主要線上添加標籤
      if (isMajor) {
        latGridLabels.push({
          position: [lonMin + 0.1, lat],
          text: `${lat}°N`,
          color: [100, 181, 246, 200],
          size: 12
        });
      }
    }

    // 添加緯度網格線圖層
    if (latGridLines.length > 0) {
      allLayers.push(new PathLayer({
        id: 'lat-grid-lines',
        data: latGridLines,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1
      }));
    }

    // 添加緯度標籤圖層
    if (latGridLabels.length > 0) {
      allLayers.push(new TextLayer({
        id: 'lat-grid-labels',
        data: latGridLabels,
        getPosition: d => d.position,
        getText: d => d.text,
        getColor: d => d.color,
        getSize: d => d.size,
        getTextAnchor: 'start',
        fontFamily: 'monospace',
        fontWeight: 'bold',
        outlineWidth: 2,
        outlineColor: [0, 0, 0, 150]
      }));
    }

    if (!stations || stations.length === 0) {
      return allLayers;
    }

    const stationPoints = new ScatterplotLayer({
      id: 'station-points',
      data: stations,
      pickable: true,
      getPosition: d => [d.longitude, d.latitude],
      getFillColor: d => {
        const hasRecentData = waveDataMap?.[d.station]?.pgaHistory?.length > 0;
        // const hasPick = waveDataMap?.[d.station]?.picks?.length > 0;

        // Only fill if there is waveform data. 
        // If there is only a pick but no waveform, it should remain hollow (transparent)
        // but the yellow outline (handled in getLineColor) will still show.
        if (!hasRecentData) return [0, 0, 0, 0];

        const intensityData = stationIntensities[d.station];
        return intensityData ? intensityData.color : [0, 0, 0, 0];
      },
      getRadius: d => {
        const intensityData = stationIntensities[d.station];
        return intensityData && intensityData.pga > 0 ? 800 : 400;
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 15,
      stroked: true,
      getLineColor: d => {
        const hasPick = waveDataMap?.[d.station]?.picks?.length > 0;
        return hasPick ? [255, 235, 59, 255] : [255, 255, 255, 150]; // Yellow if pick, else white transparent
      },
      getLineWidth: d => {
        const hasPick = waveDataMap?.[d.station]?.picks?.length > 0;
        return hasPick ? 20 : 1;
      },
      lineWidthMinPixels: 1,
      updateTriggers: {
        getFillColor: [stationIntensities, waveDataMap],
        getRadius: [stationIntensities],
        getLineColor: [waveDataMap],
        getLineWidth: [waveDataMap]
      }
    });

    const stationLabels = hoverInfo?.object ? new TextLayer({
      id: 'station-labels',
      data: [hoverInfo.object],
      getPosition: d => [d.longitude, d.latitude],
      getText: d => d.station,
      getSize: 14,
      getColor: [255, 255, 255, 255],
      getPixelOffset: [0, 18],
      fontFamily: 'monospace',
      fontWeight: 'bold',
      outlineWidth: 4,
      outlineColor: [0, 0, 0, 150]
    }) : null;

    allLayers.push(stationPoints);
    if (stationLabels) allLayers.push(stationLabels);

    return allLayers;
  }, [stations, stationIntensities, hoverInfo, waveDataMap]);

  const handleHover = ({ object, x, y }) => {
    setHoverInfo({ object, x, y });
  };

  const handleViewStateChange = ({ viewState: newViewState }) => {
    setViewState(newViewState);

    // 計算可視範圍的緯度邊界
    const { latitude, zoom } = newViewState;

    // 根據 zoom 計算大約的緯度範圍
    // zoom 每增加1，範圍縮小約一半
    // 調整係數以更好地匹配地圖實際可視範圍
    const latRange = 180 / Math.pow(2, zoom) * 3.35; 
    const minLat = Math.max(-90, latitude - latRange / 2);
    const maxLat = Math.min(90, latitude + latRange / 2);

    // 回傳邊界給父組件
    if (onBoundsChange) {
      onBoundsChange({ minLat, maxLat });
    }
  };

  return (
    <div className="map-container">
      <DeckGL
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        controller={true}
        layers={layers}
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

TaiwanMap.propTypes = {
  stations: PropTypes.array.isRequired,
  stationIntensities: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  onBoundsChange: PropTypes.func,  // 可選：地圖邊界變化回調
};

export default TaiwanMap;
