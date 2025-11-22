import { useState, useEffect, useRef, useMemo } from 'react';
import PropTypes from 'prop-types';
import WaveformPanel from './WaveformPanel';
import { LAT_MIN, LAT_MAX } from './constants';
import './RealtimeWaveformDeck.css';

const DEFAULT_DISPLAY_WINDOW = 120;  // 固定時間窗口：120 秒

function RealtimeWaveformDeck({
  waveDataMap,
  displayStations,
  stationMap,
  title,
  latMin,
  latMax,
  mapZoom
}) {
  const [renderTrigger, setRenderTrigger] = useState(Date.now());
  const panelRef = useRef(null);
  const [dimensions, setDimensions] = useState(null);

  // baseTime 固定為組件初始化時往前推 120 秒
  // 這樣歷史資料會畫在時間軸的前面，實時資料自然接續
  const baseTime = useMemo(() => {
    // 固定在組件掛載時的時間，往前推 120 秒
    const now = Date.now();
    return now - (DEFAULT_DISPLAY_WINDOW * 1000);
  }, []); // 空依賴陣列，只在初始化時計算一次

  // 使用固定更新頻率實現平滑滾動（降低 GPU 負擔）
  // 20 FPS 足夠流暢，同時大幅減少渲染壓力
  useEffect(() => {
    const UPDATE_INTERVAL = 500; // 50ms = 20 FPS

    const intervalId = setInterval(() => {
      setRenderTrigger(Date.now());
    }, UPDATE_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, []);

  // 響應式尺寸計算
  useEffect(() => {
    const updateSize = () => {
      if (panelRef.current) {
        const rect = panelRef.current.getBoundingClientRect();
        setDimensions(prev => {
          if (prev && prev.width === rect.width && prev.height === rect.height) {
            return prev;
          }
          return {
            width: rect.width,
            height: rect.height
          };
        });
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);

    const resizeObserver = new ResizeObserver(updateSize);
    if (panelRef.current) {
      resizeObserver.observe(panelRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateSize);
      resizeObserver.disconnect();
    };
  }, []);


  return (
    <div className="realtime-waveform geographic">
      <div ref={panelRef} className="waveform-panel-container" style={{ flex: 1, overflow: 'hidden' }}>
        {dimensions && dimensions.width > 0 && dimensions.height > 0 && (
          <WaveformPanel
            title={title}
            stations={displayStations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={latMin ?? LAT_MIN}
            latMax={latMax ?? LAT_MAX}
            mapZoom={mapZoom}
            panelWidth={dimensions.width}
            panelHeight={dimensions.height}
            renderTrigger={renderTrigger}
            timeWindow={DEFAULT_DISPLAY_WINDOW}
            baseTime={baseTime}
          />
        )}
      </div>
    </div>
  );
}

RealtimeWaveformDeck.propTypes = {
  waveDataMap: PropTypes.object.isRequired,
  displayStations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  title: PropTypes.string.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  mapZoom: PropTypes.number
};

export default RealtimeWaveformDeck;
