import { useState, useEffect, useMemo } from 'react';
import './App.css';
import { TaiwanMapDeck } from './components/MapDeck';
import { RealtimeWaveformDeck } from './components/WaveformDeck';
import StationSelection from './components/StationSelection.jsx';

// Import custom hooks
import { useStationMetadata } from './hooks/useStationMetadata';
import { useWebSocket } from './hooks/useWebSocket';
import { useWaveformData } from './hooks/useWaveformData';
import { useStationDisplay } from './hooks/useStationDisplay';

const DEFAULT_DISPLAY_WINDOW = 120;   // 預設顯示時間窗口（秒）

function App() {
  // View and selection state
  const [view, setView] = useState('waveform'); // 'waveform' or 'stationSelection'
  const [selectionMode, setSelectionMode] = useState('active'); // 'target', 'active', 'all_site', 'custom'
  const [customStations, setCustomStations] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null); // For both reports and events

  // Data state (to be passed to hooks)
  const [wavePackets, setWavePackets] = useState([]);
  const [pickPackets, setPickPackets] = useState([]);
  const [latestWaveTime, setLatestWaveTime] = useState(null);

  // Map state
  const [mapBounds, setMapBounds] = useState(null);
  const [displayTimeWindow, setDisplayTimeWindow] = useState(DEFAULT_DISPLAY_WINDOW);

  // ===== Custom Hooks =====

  // 1. Load station metadata from CSV files
  const { allTargetStations, stationMap } = useStationMetadata();

  // 2. Manage WebSocket connection
  const { isConnected, socket } = useWebSocket({
    onWavePacket: (packets) => {
      setLatestWaveTime(new Date().toLocaleString('zh-TW'));
      setWavePackets(packets);
    },
    onPickPacket: (packets) => {
      console.log(`[App] Received ${packets.length} pick packets`);
      setPickPackets(packets);
    },
    onHistoricalData: (data) => {
      console.log('[App] Received historical_data:', data);
      // Add historical data to wavePackets (it has the same format)
      if (data && data.data && Object.keys(data.data).length > 0) {
        setWavePackets([data]);
        setLatestWaveTime(new Date().toLocaleString('zh-TW'));
      }
    }
  });

  // 3. Process waveform and pick data
  const { waveDataMap, stationIntensities, mapStationIntensities } = useWaveformData({
    wavePackets,
    pickPackets
  });

  // 4. Calculate station display lists
  const { displayStations, mapDisplayStations, stationsToSubscribe } = useStationDisplay({
    selectionMode,
    customStations,
    waveDataMap,
    stationMap,
    allTargetStations
  });

  // ===== WebSocket Subscription =====

  // Subscribe to WebSocket station data
  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (stationsToSubscribe.length > 0) {
      // Send subscription
      socket.send(JSON.stringify({
        event: 'subscribe_stations',
        data: { stations: stationsToSubscribe }
      }));

      // Request historical data for these stations (120 seconds window)
      console.log(`[App] Requesting historical data for ${stationsToSubscribe.length} stations:`, stationsToSubscribe.slice(0, 10));
      socket.send(JSON.stringify({
        event: 'request_historical_data',
        data: {
          stations: stationsToSubscribe,
          window_seconds: 120
        }
      }));
    }
    return () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          event: 'subscribe_stations',
          data: { stations: [] }
        }));
      }
    };
  }, [socket, stationsToSubscribe]);

  // ===== Event Handlers =====

  const handleSelectionChange = (mode, selectedStations) => {
    setSelectionMode(mode);
    if (mode === 'custom') {
      setCustomStations(selectedStations);
    }
    setWavePackets([]);
  };

  const handleMapBoundsChange = (bounds) => {
    setMapBounds(bounds);
  };

  const handleDisplayTimeWindowChange = (newTimeWindow) => {
    setDisplayTimeWindow(newTimeWindow);
  };

  // ===== Derived State =====

  const waveformTitle = useMemo(() => {
    const count = displayStations.length;
    switch (selectionMode) {
      case 'active':
        return `即時訊號測站 (${count} 站)`;
      case 'all_site':
        return `所有測站清單 (${count} 站)`;
      case 'custom':
        return `自訂測站列表 (${count} 站)`;
      case 'target':
      default:
        return `全台 PWS 參考點 - ${count} 站`;
    }
  }, [selectionMode, displayStations.length]);

  // Dummy data for reports and events
  const reports = [
    { id: 'rep-1', title: '預警報告 #1', content: '這是預警報告 #1 的詳細內容。' },
    { id: 'rep-2', title: '預警報告 #2', content: '這是預警報告 #2 的詳細內容。' },
  ];
  const events = [
    { id: 'evt-1', title: '地震事件 A', content: '這是地震事件 A 的詳細內容。' },
    { id: 'evt-2', title: '地震事件 B', content: '這是地震事件 B 的詳細內容。' },
  ];

  // ===== Render =====

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">AI 地震預警即時監控面板</h1>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 已連接' : '🔴 未連接'}
          </div>
        </div>
        <div className="header-right">
          {latestWaveTime ? (
            <div className="wave-status-compact active">
              <span className="wave-icon">🌊</span>
              <span className="wave-text">{latestWaveTime}</span>
            </div>
          ) : (
            <div className="wave-status-compact waiting">
              <span className="wave-icon">⏳</span>
              <span className="wave-text">等待波形</span>
            </div>
          )}
        </div>
      </header>

      {/* Dashboard */}
      <div className="dashboard">
        {/* Left Panel: Report and Event Lists */}
        <div className="left-panel">
          <section className="section report-list-section">
            <div className="section-header">
              <h2>預警報告列表</h2>
            </div>
            <ul className="report-list">
              {reports.map(report => (
                <li
                  key={report.id}
                  className={`report-list-item ${selectedItem?.id === report.id ? 'selected' : ''}`}
                  onClick={() => setSelectedItem(report)}
                >
                  {report.title}
                </li>
              ))}
            </ul>
          </section>
          <section className="section event-list-section">
            <div className="section-header">
              <h2>地震事件</h2>
            </div>
            <ul className="report-list">
              {events.map(event => (
                <li
                  key={event.id}
                  className={`report-list-item ${selectedItem?.id === event.id ? 'selected' : ''}`}
                  onClick={() => setSelectedItem(event)}
                >
                  {event.title}
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Middle Panel: Map and Waveforms */}
        <div className="main-content">
          <div className="mid-panel">
            <section className="section map-section">
              <div className="section-header">
                <h2>測站分布</h2>
                <button
                  className="select-station-button"
                  onClick={() => setView(prev => prev === 'waveform' ? 'stationSelection' : 'waveform')}
                >
                  {view === 'waveform' ? '選擇顯示測站' : '返回波形圖'}
                </button>
              </div>
              <TaiwanMapDeck
                stations={mapDisplayStations}
                stationIntensities={mapStationIntensities}
                waveDataMap={waveDataMap}
                onBoundsChange={handleMapBoundsChange}
              />
            </section>
          </div>
          <div className="right-panel">
            {view === 'waveform' ? (
              <RealtimeWaveformDeck
                waveDataMap={waveDataMap}
                displayStations={displayStations}
                stationMap={stationMap}
                title={waveformTitle}
                timeWindow={DEFAULT_DISPLAY_WINDOW}
                onTimeWindowChange={handleDisplayTimeWindowChange}
                latMin={mapBounds?.minLat}
                latMax={mapBounds?.maxLat}
              />
            ) : (
              <StationSelection
                allStations={stationMap}
                activeStations={displayStations}
                selectionMode={selectionMode}
                onSelectionChange={handleSelectionChange}
                onViewChange={setView}
              />
            )}
          </div>
        </div>

        {/* Right Panel: Shared Detail View */}
        <div className="report-detail-panel">
          <section className="section report-detail-section">
            <div className="section-header">
              <h2>詳細資料</h2>
            </div>
            <div className="report-detail-content">
              {selectedItem ? (
                <div>
                  <h3>{selectedItem.title}</h3>
                  <p>{selectedItem.content}</p>
                </div>
              ) : (
                <div className="empty-state">
                  <p>請從左側列表選擇一個項目以查看詳細資料。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default App;
