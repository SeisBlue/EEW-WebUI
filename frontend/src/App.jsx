import {useState, useEffect, useMemo} from 'react';
import './App.css';
import Papa from 'papaparse';
import TaiwanMap from './components/TaiwanMapDeck';
import RealtimeWaveformDeck from './components/RealtimeWaveformDeck';
import StationSelection from './components/StationSelection.jsx';
import {
  getIntensityColor,
  pgaToIntensity,
  extractStationCode,
  parseEarthwormTime
} from './utils';

const DATA_RETENTION_WINDOW = 120;  // 資料暫存時間窗口（秒）- 用於保留歷史資料
const DEFAULT_DISPLAY_WINDOW = 120;   // 預設顯示時間窗口（秒）
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
  const [selectionMode, setSelectionMode] = useState('active'); // 'target', 'active', 'all_site', 'custom'
  const [customStations, setCustomStations] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null); // For both reports and events

  // WebSocket and data state
  const [isConnected, setIsConnected] = useState(false);
  const [socket, setSocket] = useState(null);
  const [wavePackets, setWavePackets] = useState([]);
  const [pickPackets, setPickPackets] = useState([]);
  const [latestWaveTime, setLatestWaveTime] = useState(null);
  const [waveDataMap, setWaveDataMap] = useState({});

  // Station and map state
  const [allTargetStations, setAllTargetStations] = useState([]); // All stations from eew_target.csv
  const [stationMap, setStationMap] = useState({});
  const [mapBounds, setMapBounds] = useState(null); // 地圖的緯度邊界

  // Display time window state - 與波形縮放聯動
  const [displayTimeWindow, setDisplayTimeWindow] = useState(DEFAULT_DISPLAY_WINDOW);

  // Load initial station metadata
  useEffect(() => {
    Papa.parse('/eew_target.csv', {
      download: true, header: true, skipEmptyLines: true,
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
    ws.onopen = () => {
      console.log('✅ [App] Connected');
      setIsConnected(true);
      setSocket(ws);
    };
    ws.onclose = () => {
      console.log('❌ [App] Disconnected');
      setIsConnected(false);
      setSocket(null);
    };
    ws.onerror = (error) => console.error('❌ [App] WebSocket Error:', error);

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.event === 'wave_packet') {
        const waveIds = Object.keys(message.data.data || {});
        if (waveIds.length > 0) {
          console.log(`📊 Received ${waveIds.length} waves:`, waveIds.slice(0, 5));
        }
        setLatestWaveTime(new Date().toLocaleString('zh-TW'));
        setWavePackets(prev => [message.data, ...prev].slice(0, 10));
      } else if (message.event === 'pick_packet') {
        console.log("Received pick_packet:", message.data);
        setPickPackets(prev => [message.data, ...prev].slice(0, 20));
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, []);

  // Process new wave packets
  useEffect(() => {
    if (wavePackets.length === 0) return;

    const latestPacket = wavePackets[0];

    setWaveDataMap(prev => {
      const updated = {...prev};
      const now = Date.now();

      if (latestPacket.data) {
        Object.keys(latestPacket.data).forEach(seedStation => {
          const stationCode = extractStationCode(seedStation);
          const wavePacketData = latestPacket.data[seedStation];
          const {
            pga = 0,
            startt,
            endt,
            samprate = 100,
            waveform = []
          } = wavePacketData;

          const prevStationData = updated[stationCode] || {
            dataPoints: [],
            pgaHistory: [],
            lastPga: 0,
            lastEndTime: null,
            recentStats: {
              points: [],
              totalSumSquares: 0,
              totalMaxAbs: 0,
              totalCount: 0
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

          stationData.pgaHistory.push({timestamp: now, pga: pga});
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

      const cutoffTime = now - DATA_RETENTION_WINDOW * 1000;  // 使用資料暫存窗口
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

        // Clean up old picks
        if (stationData.picks) {
          stationData.picks = stationData.picks.filter(p => p.time >= cutoffTime);
        }

        updated[stationCode] = stationData;
      });

      console.log(`📈 Total stations in waveDataMap: ${Object.keys(updated).length}`);
      return updated;
    });
  }, [wavePackets]);

  // Derive station intensities from waveDataMap
  const stationIntensities = useMemo(() => {
    const intensities = {};
    Object.keys(waveDataMap).forEach(stationCode => {
      const stationData = waveDataMap[stationCode];
      if (!stationData || !stationData.pgaHistory) return;

      // 計算顯示窗口內的最大 PGA（使用當前 displayTimeWindow）
      const now = Date.now();
      const displayCutoff = now - displayTimeWindow * 1000;
      const maxPga = stationData.pgaHistory
        .filter(item => item.timestamp >= displayCutoff)
        .reduce((max, item) => Math.max(max, item.pga), 0);
      const intensity = pgaToIntensity(maxPga);
      const color = getIntensityColor(intensity);

      intensities[stationCode] = {
        pga: maxPga,
        intensity: intensity,
        color: color
      };
    });
    return intensities;
  }, [waveDataMap, displayTimeWindow]);  // 加入 displayTimeWindow 依賴

  // Process new pick packets
  useEffect(() => {
    if (pickPackets.length === 0) return;
    const latestPacket = pickPackets[0];
    const pickData = latestPacket.content;

    if (!pickData || !pickData.station || !pickData.pick_time) return;

    setWaveDataMap(prev => {
      const updated = {...prev};
      const stationCode = pickData.station;

      // Ensure station data exists
      const prevStationData = updated[stationCode] || {
        dataPoints: [], pgaHistory: [], lastPga: 0, lastEndTime: null,
        recentStats: {
          points: [],
          totalSumSquares: 0,
          totalMaxAbs: 0,
          totalCount: 0
        },
        picks: []
      };

      const stationData = {...prevStationData};

      // Ensure picks array exists and is copied
      if (!stationData.picks) {
        stationData.picks = [];
      } else {
        stationData.picks = [...stationData.picks];
      }

      const pickTime = parseEarthwormTime(pickData.pick_time);
      if (pickTime) {
        // Check for duplicates
        const isDuplicate = stationData.picks.some(p => p.id === pickData.pickid);
        if (!isDuplicate) {
          stationData.picks.push({
            time: pickTime,
            type: 'P',
            id: pickData.pickid
          });
        }

        // Clean up old picks
        const now = Date.now();
        const cutoff = now - DATA_RETENTION_WINDOW * 1000;  // 使用資料暫存窗口
        stationData.picks = stationData.picks.filter(p => p.time >= cutoff);
      }

      updated[stationCode] = stationData;
      return updated;
    });
  }, [pickPackets]);

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
      case 'target':
      default:
        return EEW_TARGETS;
    }
  }, [selectionMode, waveDataMap, customStations, stationMap]);

  // Calculate the list of stations to display on the map
  const mapDisplayStations = useMemo(() => {
    const targetStationsMap = new Map(allTargetStations.map(s => [s.station, s]));
    const stationsToShow = new Set(displayStations);

    // Add stations with active picks to the map, even if not in displayStations
    Object.keys(waveDataMap).forEach(stationCode => {
      if (waveDataMap[stationCode]?.picks?.length > 0) {
        stationsToShow.add(stationCode);
      }
    });

    return Array.from(stationsToShow)
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
  }, [displayStations, allTargetStations, stationMap, waveDataMap]);


  // Calculate stations to subscribe - memoized to prevent unnecessary re-subscriptions
  const stationsToSubscribe = useMemo(() => {
    switch (selectionMode) {
      case 'active':
        return ['__ALL_Z__'];
      case 'custom':
        return customStations;
      case 'all_site':
        return Object.keys(stationMap);
      case 'target':
      default:
        return EEW_TARGETS;
    }
  }, [selectionMode, customStations, stationMap]);

  // Subscribe to WebSocket station data
  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (stationsToSubscribe.length > 0) {
      socket.send(JSON.stringify({
        event: 'subscribe_stations',
        data: {stations: stationsToSubscribe}
      }));
    }
    return () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          event: 'subscribe_stations',
          data: {stations: []}
        }));
      }
    };
  }, [socket, stationsToSubscribe]);

  const handleSelectionChange = (mode, selectedStations) => {
    setSelectionMode(mode);
    if (mode === 'custom') {
      setCustomStations(selectedStations);
    }
    setWavePackets([]);
    setWaveDataMap({});
  };

  const handleMapBoundsChange = (bounds) => {
    setMapBounds(bounds);
  };

  const handleDisplayTimeWindowChange = (newTimeWindow) => {
    setDisplayTimeWindow(newTimeWindow);
  };

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

  // Dummy data
  const reports = [
    { id: 'rep-1', title: '預警報告 #1', content: '這是預警報告 #1 的詳細內容。' },
    { id: 'rep-2', title: '預警報告 #2', content: '這是預警報告 #2 的詳細內容。' },
  ];
  const events = [
    { id: 'evt-1', title: '地震事件 A', content: '這是地震事件 A 的詳細內容。' },
    { id: 'evt-2', title: '地震事件 B', content: '這是地震事件 B 的詳細內容。' },
  ];


  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-title">AI 地震預警即時監控面板</h1>
          <div
            className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 已連接' : '🔴 未連接'}
          </div>
        </div>
        <div className="header-right">
          {latestWaveTime ? (
            <div className="wave-status-compact active"><span
              className="wave-icon">🌊</span><span
              className="wave-text">{latestWaveTime}</span></div>
          ) : (
            <div className="wave-status-compact waiting"><span
              className="wave-icon">⏳</span><span
              className="wave-text">等待波形</span></div>
          )}
        </div>
      </header>

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
              <TaiwanMap
                stations={mapDisplayStations}
                stationIntensities={stationIntensities}
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
  )
    ;
}

export default App;
