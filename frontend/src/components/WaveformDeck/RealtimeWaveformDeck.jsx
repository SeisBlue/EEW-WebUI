import { useState, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import WaveformPanel from './WaveformPanel';
import { LAT_MIN, LAT_MAX } from './constants';
import './RealtimeWaveformDeck.css';

const DEFAULT_DISPLAY_WINDOW = 120;
const MIN_TIME_WINDOW = 1;   // 最小時間窗口：1 秒
const MAX_TIME_WINDOW = 120; // 最大時間窗口：120 秒

function RealtimeWaveformDeck({
  waveDataMap,
  displayStations,
  stationMap,
  title,
  timeWindow: initialTimeWindow,
  onTimeWindowChange,
  latMin,
  latMax
}) {
  const [renderTrigger, setRenderTrigger] = useState(Date.now());
  const [baseTime] = useState(Date.now());
  const panelRef = useRef(null);
  const animationFrameRef = useRef(null);
  const [dimensions, setDimensions] = useState(null);

  // 時間軸縮放狀態
  const [timeWindow, setTimeWindow] = useState(initialTimeWindow || DEFAULT_DISPLAY_WINDOW);

  // 使用 requestAnimationFrame 實現平滑滾動
  useEffect(() => {
    const animate = () => {
      setRenderTrigger(Date.now());
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
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

  // 滾輪縮放時間軸
  useEffect(() => {
    const handleWheel = (e) => {
      if (!panelRef.current?.contains(e.target)) return;

      e.preventDefault();

      // 計算縮放因子
      const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;

      setTimeWindow(prev => {
        const newWindow = prev * zoomFactor;
        const clamped = Math.max(MIN_TIME_WINDOW, Math.min(MAX_TIME_WINDOW, newWindow));

        if (onTimeWindowChange) {
          onTimeWindowChange(clamped);
        }

        return clamped;
      });
    };

    const panel = panelRef.current;
    if (panel) {
      panel.addEventListener('wheel', handleWheel, { passive: false });
    }

    return () => {
      if (panel) {
        panel.removeEventListener('wheel', handleWheel);
      }
    };
  }, [onTimeWindowChange]);

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
            panelWidth={dimensions.width}
            panelHeight={dimensions.height}
            renderTrigger={renderTrigger}
            timeWindow={timeWindow}
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
  timeWindow: PropTypes.number.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  onTimeWindowChange: PropTypes.func
};

export default RealtimeWaveformDeck;
