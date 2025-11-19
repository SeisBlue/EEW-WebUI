import { useState, useMemo } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
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

function TaiwanMap({ stations, stationIntensities, waveDataMap }) {
  const [hoverInfo, setHoverInfo] = useState(null);

  const layers = useMemo(() => {
    if (!stations || stations.length === 0) {
      return [];
    }

    const stationPoints = new ScatterplotLayer({
      id: 'station-points',
      data: stations,
      pickable: true,
      getPosition: d => [d.longitude, d.latitude],
      getFillColor: d => {
        const intensityData = stationIntensities[d.station];
        return intensityData ? intensityData.color : [100, 100, 100, 100];
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
        return hasPick ? 2 : 1;
      },
      lineWidthMinPixels: 1,
      updateTriggers: {
        getFillColor: [stationIntensities],
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

    return [stationPoints, stationLabels];
  }, [stations, stationIntensities, hoverInfo, waveDataMap]);

  const handleHover = ({ object, x, y }) => {
    setHoverInfo({ object, x, y });
  };

  return (
    <div className="map-container">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
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
};

export default TaiwanMap;
