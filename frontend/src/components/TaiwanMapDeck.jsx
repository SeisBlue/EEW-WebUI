import { useMemo } from 'react';
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

function TaiwanMap({ stations, stationIntensities }) {
  const layers = useMemo(() => {
    if (!stations || stations.length === 0) {
      return [];
    }

    // 測站點位層
    const stationPoints = new ScatterplotLayer({
      id: 'station-points',
      data: stations,
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
      getLineColor: [255, 255, 255, 150],
      getLineWidth: 1,
      lineWidthMinPixels: 1,
      updateTriggers: {
        getFillColor: [stationIntensities],
        getRadius: [stationIntensities]
      }
    });

    // 測站名稱標籤層
    const stationLabels = new TextLayer({
      id: 'station-labels',
      data: stations,
      getPosition: d => [d.longitude, d.latitude],
      getText: d => d.station,
      getSize: 12,
      getColor: [255, 255, 255, 200],
      getPixelOffset: [0, 15],
      fontFamily: 'monospace',
    });

    return [stationPoints, stationLabels];
  }, [stations, stationIntensities]);

  return (
    <DeckGL
      initialViewState={INITIAL_VIEW_STATE}
      controller={true}
      layers={layers}
    >
      <Map 
        reuseMaps 
        mapStyle={MAP_STYLE}
      />
    </DeckGL>
  );
}

TaiwanMap.propTypes = {
  stations: PropTypes.array.isRequired,
  stationIntensities: PropTypes.object.isRequired,
};

export default TaiwanMap;
