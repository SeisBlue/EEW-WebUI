import { useState, useEffect, useMemo } from 'react';
import './App.css';
import Papa from 'papaparse';
import TaiwanMap from './components/TaiwanMapDeck';
import RealtimeWaveformDeck from './components/RealtimeWaveformDeck';
import StationSelection from './components/StationSelection.jsx';

// 所有測站列表 - 按緯度排列顯示
const EEW_TARGETS = [
  'NOU', 'TIPB', 'ILA', 'TWC', 'ENT',
  'HWA', 'EGFH', 'EYUL', 'TTN', 'ECS', 'TAWH', 'HEN',
  'TAP', 'A024', 'NTS', 'NTY', 'NCU', 'B011',
  'HSN1', 'HSN', 'NJD', 'B131', 'TWQ1', 'B045',
  'TCU', 'WDJ', 'WHP', 'WNT1', 'WPL', 'WHY',
  'WCHH', 'WYL', 'WDL', 'WSL', 'CHY1', 'C095', 'WCKO',
  'TAI', 'C015', 'CHN1', 'KAU', 'SCS', 'SPT', 'SSD',
  'PNG', 'KNM', 'MSU'
];

function App() {
  // View and selection state
  const [view, setView] = useState('waveform'); // 'waveform' or 'stationSelection'
  const [selectionMode, setSelectionMode] = useState('default'); // 'default', 'all', 'custom'
  const [customStations, setCustomStations] = useState([]);

  // WebSocket and data state
  const [isConnected, setIsConnected] = useState(false);
  const [socket, setSocket] = useState(null);
  const [wavePackets, setWavePackets] = useState([]);
  const [latestWaveTime, setLatestWaveTime] = useState(null);

  // Station and map state
  const [allTargetStations, setAllTargetStations] = useState([]); // All stations from eew_target.csv
  const [stationIntensities, setStationIntensities] = useState({});
  const [stationMap, setStationMap] = useState({});
  const [waveDataMapForStressTest, setWaveDataMapForStressTest] = useState({});

  // Load initial station metadata
  useEffect(() => {
    Papa.parse('/eew_target.csv', {
      download: true, header: true, skipEmptyLines: true,
      complete: (results) => {
        const stations = results.data.map(s => ({
          network: s.network, county: s.county, station: s.station, station_zh: s.station_zh,
          longitude: parseFloat(s.longitude), latitude: parseFloat(s.latitude), elevation: parseFloat(s.elevation),
          status: 'unknown', lastSeen: null, pga: null,
        }));
        setAllTargetStations(stations);
        console.log('📍 [App] Loaded', stations.length, 'target stations from eew_target.csv');
      },
      error: (err) => console.error('❌ [App] Failed to load eew_target.csv:', err)
    });

    Papa.parse('/site_info.csv', {
      download: true, header: true, skipEmptyLines: true,
      complete: (results) => {
        const newStationMap = {};
        results.data.forEach(s => {
          if (s.Station) {
            newStationMap[s.Station] = {
              station: s.Station,
              latitude: parseFloat(s.Latitude),
              longitude: parseFloat(s.Longitude),
            };
          }
        });
        setStationMap(newStationMap);
        console.log('📍 [App] stationMap updated:', Object.keys(newStationMap).length, 'stations from site_info.csv');
      },
      error: (err) => console.error('❌ [App] Failed to load site_info.csv:', err)
    });
  }, []);

  // WebSocket connection management
  useEffect(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => { console.log('✅ [App] Connected'); setIsConnected(true); setSocket(ws); };
    ws.onclose = () => { console.log('❌ [App] Disconnected'); setIsConnected(false); setSocket(null); };
    ws.onerror = (error) => console.error('❌ [App] WebSocket Error:', error);

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.event === 'wave_packet') {
        setLatestWaveTime(new Date().toLocaleString('zh-TW'));
        setWavePackets(prev => [message.data, ...prev].slice(0, 10));
        if (selectionMode === 'all') {
          setWaveDataMapForStressTest(prev => ({ ...prev, ...message.data.data }));
        }
      }
    };

    return () => { if (ws.readyState === WebSocket.OPEN) ws.close(); };
  }, [selectionMode]);

  // Calculate the list of stations to display in the waveform panel
  const displayStations = useMemo(() => {
    switch (selectionMode) {
      case 'all':
        const received = Object.keys(waveDataMapForStressTest).map(s => s.split('.')[1]).filter(Boolean);
        return [...new Set(received)].sort((a, b) => (stationMap[b]?.latitude ?? 0) - (stationMap[a]?.latitude ?? 0));
      case 'custom':
        return customStations;
      case 'default':
      default:
        return EEW_TARGETS;
    }
  }, [selectionMode, waveDataMapForStressTest, customStations, stationMap]);

  // Calculate the list of stations to display on the map
  const mapDisplayStations = useMemo(() => {
    const stationSet = new Set(displayStations);
    if (selectionMode === 'default') {
        const targetSet = new Set(EEW_TARGETS);
        return allTargetStations.filter(s => targetSet.has(s.station));
    }
    return allTargetStations.filter(s => stationSet.has(s.station));
  }, [displayStations, selectionMode, allTargetStations]);


  // Subscribe to WebSocket station data
  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const stationsToSubscribe = selectionMode === 'all' ? ['__ALL_Z__'] : displayStations;
    if (stationsToSubscribe.length > 0) {
      socket.send(JSON.stringify({ event: 'subscribe_stations', data: { stations: stationsToSubscribe } }));
    }
    return () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: 'subscribe_stations', data: { stations: [] } }));
      }
    };
  }, [socket, displayStations, selectionMode]);

  const handleSelectionChange = (mode, selectedStations) => {
    setSelectionMode(mode);
    if (mode === 'custom') {
      setCustomStations(selectedStations);
    }
    // Reset data when selection changes to avoid showing stale waveforms
    setWavePackets([]);
    setStationIntensities({});
    if (mode !== 'all') {
      setWaveDataMapForStressTest({});
    }
  };

  const waveformTitle = useMemo(() => {
    const count = displayStations.length;
    switch (selectionMode) {
      case 'all': return `壓力測試：所有 Z 軸波形 (${count} 站)`;
      case 'custom': return `自訂測站列表 (${count} 站)`;
      default: return `全台 PWS 參考點 - ${count} 站`;
    }
  }, [selectionMode, displayStations.length]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">AI 地震預警即時監控面板</h1>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 已連接' : '🔴 未連接'}
          </div>
        </div>
        <div className="header-right">
          {latestWaveTime ? (
            <div className="wave-status-compact active"><span className="wave-icon">🌊</span><span className="wave-text">{latestWaveTime}</span></div>
          ) : (
            <div className="wave-status-compact waiting"><span className="wave-icon">⏳</span><span className="wave-text">等待波形</span></div>
          )}
        </div>
      </header>

      <div className="dashboard">
        <div className="left-panel">
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
            <TaiwanMap
              stations={mapDisplayStations}
              stationIntensities={stationIntensities}
            />
          </section>
        </div>

        <div className="right-panel">
          {view === 'waveform' ? (
            <RealtimeWaveformDeck
              wavePackets={wavePackets}
              onStationIntensityUpdate={setStationIntensities}
              displayStations={displayStations}
              stationMap={stationMap}
              title={waveformTitle}
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
    </div>
  );
}

export default App;
