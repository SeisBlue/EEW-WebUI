import { useState, useEffect, useMemo } from 'react';
import './App.css';
import Papa from 'papaparse';
import TaiwanMap from './components/TaiwanMapDeck';
import RealtimeWaveformDeck from './components/RealtimeWaveformDeck';
import StationSelection from './components/StationSelection.jsx';
import { getIntensityColor, pgaToIntensity, extractStationCode } from './utils';

const TIME_WINDOW = 30;
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
  const [selectionMode, setSelectionMode] = useState('default'); // 'default', 'active', 'all_site', 'custom'
  const [customStations, setCustomStations] = useState([]);

  // WebSocket and data state
  const [isConnected, setIsConnected] = useState(false);
  const [socket, setSocket] = useState(null);
  const [wavePackets, setWavePackets] = useState([]);
  const [latestWaveTime, setLatestWaveTime] = useState(null);
  const [waveDataMap, setWaveDataMap] = useState({});

  // Station and map state
  const [allTargetStations, setAllTargetStations] = useState([]); // All stations from eew_target.csv
  const [stationIntensities, setStationIntensities] = useState({});
  const [stationMap, setStationMap] = useState({});

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
      }
    };

    return () => { if (ws.readyState === WebSocket.OPEN) ws.close(); };
  }, []);

  // Process new wave packets
  useEffect(() => {
    if (wavePackets.length === 0) return;

    const latestPacket = wavePackets[0];

    setWaveDataMap(prev => {
      const updated = { ...prev };
      const now = Date.now();

      if (latestPacket.data) {
        Object.keys(latestPacket.data).forEach(seedStation => {
          const stationCode = extractStationCode(seedStation);
          const wavePacketData = latestPacket.data[seedStation];
          const { pga = 0, startt, endt, samprate = 100, waveform = [] } = wavePacketData;

          const prevStationData = updated[stationCode] || {
            dataPoints: [], pgaHistory: [], lastPga: 0, lastEndTime: null,
            recentStats: {
              points: [], totalSumSquares: 0, totalMaxAbs: 0, totalCount: 0
            }
          };
          const stationData = {
            ...prevStationData,
            dataPoints: [...prevStationData.dataPoints],
            pgaHistory: [...prevStationData.pgaHistory],
            recentStats: {
              ...prevStationData.recentStats,
              points: [...prevStationData.recentStats.points]
            }
          };
          updated[stationCode] = stationData;

          const packetStartTime = startt ? startt * 1000 : now;
          const packetEndTime = endt ? endt * 1000 : now;

          let hasGap = false;
          if (stationData.lastEndTime !== null && startt) {
            const timeDiff = Math.abs(startt - stationData.lastEndTime);
            const expectedInterval = 1.0 / samprate;
            if (timeDiff > expectedInterval * 2) {
              hasGap = true;
            }
          }

          if (hasGap && stationData.dataPoints.length > 0) {
            stationData.dataPoints.push({
              timestamp: stationData.lastEndTime * 1000,
              endTimestamp: packetStartTime,
              values: [],
              isGap: true
            });
          }

          stationData.dataPoints.push({
            timestamp: packetStartTime,
            endTimestamp: packetEndTime,
            values: waveform,
            samprate: samprate,
            isGap: false
          });

          if (endt) {
            stationData.lastEndTime = endt;
          }

          stationData.pgaHistory.push({ timestamp: now, pga: pga });
          stationData.lastPga = pga;

          if (waveform.length > 0) {
            let sumSquares = 0;
            let maxAbs = 0;
            for (const value of waveform) {
              sumSquares += value * value;
              maxAbs = Math.max(maxAbs, Math.abs(value));
            }
            stationData.recentStats.points.push({
              timestamp: packetEndTime,
              sumSquares,
              maxAbs,
              count: waveform.length
            });
            stationData.recentStats.totalSumSquares += sumSquares;
            stationData.recentStats.totalMaxAbs = Math.max(stationData.recentStats.totalMaxAbs, maxAbs);
            stationData.recentStats.totalCount += waveform.length;
          }
        });
      }

      const newStationIntensities = { ...stationIntensities };
      const cutoffTime = now - TIME_WINDOW * 1000;
      const recentCutoff = now - 10 * 1000;

      Object.keys(updated).forEach(stationCode => {
        const stationData = updated[stationCode];

        stationData.dataPoints = stationData.dataPoints.filter(
          point => point.endTimestamp >= cutoffTime
        );
        stationData.pgaHistory = stationData.pgaHistory.filter(
          item => item.timestamp >= cutoffTime
        );

        const stats = stationData.recentStats;
        let statsChanged = false;
        while (stats.points.length > 0 && stats.points[0].timestamp < recentCutoff) {
          const removedPoint = stats.points.shift();
          stats.totalSumSquares -= removedPoint.sumSquares;
          stats.totalCount -= removedPoint.count;
          statsChanged = true;
        }

        if (statsChanged) {
          stats.totalMaxAbs = stats.points.reduce((max, p) => Math.max(max, p.maxAbs), 0);
        }

        if (stats.totalCount > 0) {
          const rms = Math.sqrt(stats.totalSumSquares / stats.totalCount);
          stationData.displayScale = Math.max(rms * 4, stats.totalMaxAbs * 0.3, 0.05);
        } else if (stationData.dataPoints.length === 0) {
          stationData.displayScale = 1.0;
        }

        const maxPga30s = stationData.pgaHistory.reduce((max, item) => Math.max(max, item.pga), 0);
        const intensity = pgaToIntensity(maxPga30s);
        const color = getIntensityColor(intensity);

        newStationIntensities[stationCode] = {
          pga: maxPga30s,
          intensity: intensity,
          color: color
        };
      });

      setStationIntensities(newStationIntensities);
      return updated;
    });
  }, [wavePackets]);

  // Calculate the list of stations to display in the waveform panel
  const displayStations = useMemo(() => {
    switch (selectionMode) {
      case 'active':
        const received = Object.keys(waveDataMap);
        return [...new Set(received)].sort((a, b) => (stationMap[b]?.latitude ?? 0) - (stationMap[a]?.latitude ?? 0));
      case 'all_site':
        return Object.keys(stationMap).sort((a, b) => (stationMap[b]?.latitude ?? 0) - (stationMap[a]?.latitude ?? 0));
      case 'custom':
        return customStations;
      case 'default':
      default:
        return EEW_TARGETS;
    }
  }, [selectionMode, waveDataMap, customStations, stationMap]);

  // Calculate the list of stations to display on the map
  const mapDisplayStations = useMemo(() => {
    const targetStationsMap = new Map(allTargetStations.map(s => [s.station, s]));

    return displayStations
      .map(stationCode => {
        if (targetStationsMap.has(stationCode)) {
          return targetStationsMap.get(stationCode);
        }
        if (stationMap[stationCode]) {
          return {
            station: stationCode,
            longitude: stationMap[stationCode].longitude,
            latitude: stationMap[stationCode].latitude,
            network: '',
            county: '',
            station_zh: stationCode,
            elevation: 0,
            status: 'unknown',
            lastSeen: null,
            pga: null,
          };
        }
        return null;
      })
      .filter(Boolean);
  }, [displayStations, allTargetStations, stationMap]);


  // Subscribe to WebSocket station data
  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const stationsToSubscribe = selectionMode === 'active' ? ['__ALL_Z__'] : displayStations;
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
    setWavePackets([]);
    setStationIntensities({});
    setWaveDataMap({});
  };

  const waveformTitle = useMemo(() => {
    const count = displayStations.length;
    switch (selectionMode) {
      case 'active': return `即時訊號測站 (${count} 站)`;
      case 'all_site': return `所有測站清單 (${count} 站)`;
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
              waveDataMap={waveDataMap}
              displayStations={displayStations}
              stationMap={stationMap}
              title={waveformTitle}
              timeWindow={TIME_WINDOW}
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
