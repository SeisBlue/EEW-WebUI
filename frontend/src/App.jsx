import { useState, useEffect } from 'react';
import './App.css';
import Papa from 'papaparse';
import TaiwanMap from './components/TaiwanMapDeck';
import RealtimeWaveform from './components/RealtimeWaveformDeck';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [wavePackets, setWavePackets] = useState([]);
  const [latestWaveTime, setLatestWaveTime] = useState(null);
  const [targetStations, setTargetStations] = useState([]);
  const [socket, setSocket] = useState(null);
  const [stationReplacements, setStationReplacements] = useState({});
  const [stationIntensities, setStationIntensities] = useState({});

  useEffect(() => {
    Papa.parse('/eew_target.csv', {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const stations = results.data.map(s => ({
          network: s.network,
          county: s.county,
          station: s.station,
          station_zh: s.station_zh,
          longitude: parseFloat(s.longitude),
          latitude: parseFloat(s.latitude),
          elevation: parseFloat(s.elevation),
          status: 'unknown',
          lastSeen: null,
          pga: null,
        }));
        setTargetStations(stations);
        console.log('📍 Loaded', stations.length, 'target stations from eew_target.csv');
      },
      error: (err) => {
        console.error('載入 eew_target.csv 失敗:', err);
      }
    });

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    console.log(`🔌 Attempting to connect to WebSocket at ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('✅ Connected to Server');
      setIsConnected(true);
      setSocket(ws);
    };

    ws.onclose = () => {
      console.log('❌ Disconnected from Server');
      setIsConnected(false);
      setSocket(null);
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket Error:', error);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const { event: eventType, data } = message;

      switch (eventType) {
        case 'connect_init':
          console.log('🔌 Connection initialized by server');
          break;
        case 'wave_packet':
          console.log('🌊 Wave packet received:', data.waveid);
          setLatestWaveTime(new Date().toLocaleString('zh-TW'));
          setWavePackets(prev => [data, ...prev].slice(0, 10));
          break;
        default:
          console.warn('Unknown event type received:', eventType);
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">
            AI 地震預警即時監控面板
          </h1>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 已連接' : '🔴 未連接'}
          </div>
        </div>
        <div className="header-right">
          {!latestWaveTime ? (
            <div className="wave-status-compact waiting">
              <span className="wave-icon">⏳</span>
              <span className="wave-text">等待波形</span>
            </div>
          ) : (
            <div className="wave-status-compact active">
              <span className="wave-icon">🌊</span>
              <span className="wave-text">{latestWaveTime}</span>
            </div>
          )}
        </div>
      </header>

      <div className="dashboard">
        <div className="left-panel">
          <section className="section map-section">
            <h2>測站分布</h2>
            <TaiwanMap
              stations={targetStations}
              stationReplacements={stationReplacements}
              stationIntensities={stationIntensities}
            />
          </section>
        </div>

        <div className="right-panel">
          <RealtimeWaveform
            wavePackets={wavePackets}
            socket={socket}
            onReplacementUpdate={setStationReplacements}
            onStationIntensityUpdate={setStationIntensities}
          />
        </div>
      </div>
    </div>
  );
}

export default App;
