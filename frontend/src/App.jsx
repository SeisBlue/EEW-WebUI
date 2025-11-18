import { useState, useEffect, useMemo, useRef } from 'react'
// import io from 'socket.io-client' // 移除 socket.io-client
import './App.css'
import ReportDetail from './components/ReportDetail'
import Papa from 'papaparse'
import TaiwanMap from './components/TaiwanMapDeck'
import RealtimeWaveform from './components/RealtimeWaveformDeck'
import { getIntensityValue } from './utils'

// 輔助函式：計算並回傳各警報縣市的最大震度
const getMaxIntensityByCounty = (reportData, stationToCountyMap) => {
  if (!reportData || !reportData.alarm || !stationToCountyMap) {
    return [];
  }
  const alertedCounties = new Set(
    reportData.alarm
      .map(stationCode => stationToCountyMap.get(stationCode))
      .filter(Boolean)
  );
  if (alertedCounties.size === 0) return [];

  const allReportStations = Object.keys(reportData).filter(key => !['picks', 'log_time', 'alarm', 'report_time', 'format_time', 'wave_time', 'wave_endt', 'wave_lag', 'run_time', 'alarm_county', 'new_alarm_county'].includes(key));

  const countyIntensities = Array.from(alertedCounties).map(county => {
    let maxIntensity = '0';
    let maxIntensityValue = 0;
    allReportStations.forEach(stationCode => {
      if (stationToCountyMap.get(stationCode) === county) {
        const currentIntensity = reportData[stationCode];
        const currentValue = getIntensityValue(currentIntensity);
        if (currentValue > maxIntensityValue) {
          maxIntensityValue = currentValue;
          maxIntensity = currentIntensity;
        }
      }
    });
    return { county, maxIntensity };
  });

  return countyIntensities.sort((a, b) => getIntensityValue(b.maxIntensity) - getIntensityValue(a.maxIntensity));
};

// 輔助函式：根據震度取得標籤樣式
const getIntensityTagClass = (intensityStr) => {
  const value = parseInt(intensityStr, 10);
  if (isNaN(value)) return 'info';
  if (value >= 5) return 'danger';
  if (value >= 4) return 'warning';
  return 'info';
};


function App() {
  const [isConnected, setIsConnected] = useState(false)
  const [wavePackets, setWavePackets] = useState([])
  const [latestWaveTime, setLatestWaveTime] = useState(null)
  const [targetStations, setTargetStations] = useState([])
  const [socket, setSocket] = useState(null)
  const [stationReplacements, setStationReplacements] = useState({})
  const [stationIntensities, setStationIntensities] = useState({})
  const [reports, setReports] = useState([])
  const [stationToCountyMap, setStationToCountyMap] = useState(new Map());

  // 新增 state 來管理累加的縣市警報
  const [countyAlerts, setCountyAlerts] = useState({});
  // 使用 ref 來保存計時器 ID，以便可以清除它
  const resetTimerRef = useRef(null);

  // 載入歷史報告
  const loadHistoricalReports = async (limit = 20) => {
    try {
      const reportsResponse = await fetch('/api/reports')
      const reportFiles = await reportsResponse.json()
      const historicalReports = []
      for (let i = 0; i < Math.min(limit, reportFiles.length); i++) {
        const file = reportFiles[i]
        try {
          const contentResponse = await fetch(`/get_file_content?file=${file.filename}`)
          const text = await contentResponse.text()
          const jsonData = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
          const latestData = jsonData[jsonData.length - 1]
          historicalReports.push({
            id: `historical_${file.filename}_${Date.now()}`,
            timestamp: file.datetime,
            data: latestData,
            isHistorical: true,
            filename: file.filename
          })
        } catch (err) {
          console.error(`載入歷史報告 ${file.filename} 失敗:`, err)
        }
      }
      setReports(prev => [...historicalReports, ...prev])
      console.log(`📚 Loaded ${historicalReports.length} historical reports`)
    } catch (err) {
      console.error('載入歷史報告失敗:', err)
    }
  }

  const [selectedType, setSelectedType] = useState(null)
  const [selectedItem, setSelectedItem] = useState(null)

  useEffect(() => {
    // 改為讀取本地的 eew_target.csv
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
          // 添加前端需要的額外狀態
          status: 'unknown',
          lastSeen: null,
          pga: null,
        }));
        setTargetStations(stations);
        setStationToCountyMap(new Map(stations.map(s => [s.station, s.county])));
        console.log('📍 Loaded', stations.length, 'target stations from eew_target.csv');
      },
      error: (err) => {
        console.error('載入 eew_target.csv 失敗:', err);
      }});

    // --- WebSocket 連線邏輯 ---
    // 根據環境決定 WebSocket URL
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    console.log(`🔌 Attempting to connect to WebSocket at ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('✅ Connected to Server')
      setIsConnected(true)
      setSocket(ws); // 將 WebSocket 實例存入 state
    };

    ws.onclose = () => {
      console.log('❌ Disconnected from Server')
      setIsConnected(false)
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
          loadHistoricalReports(20);
          break;
        case 'wave_packet':
          console.log('🌊 Wave packet received:', data.waveid);
          setLatestWaveTime(new Date().toLocaleString('zh-TW'));
          setWavePackets(prev => [data, ...prev].slice(0, 10));
          break;
        case 'report_data': // 雖然新後端沒有，但保留以備不時之需
          console.log('📊 Report data received:', data);
          setReports(prev => [{
            id: Date.now(),
            timestamp: new Date().toLocaleString('zh-TW'),
            data,
            isRealtime: true
          }, ...prev].slice(0, 20));
          break;
        default:
          console.warn('Unknown event type received:', eventType);
      }
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  }, [])

  // 新增 useEffect 來處理警報累加和自動重設邏輯
  useEffect(() => {
    // 如果沒有報告，則不執行任何操作
    if (reports.length === 0) {
      return;
    }

    // 取得最新的報告
    const latestReport = reports[0];
    if (!latestReport || !latestReport.data) {
      return;
    }

    // 計算最新報告中的警報縣市
    const newCountyIntensities = getMaxIntensityByCounty(latestReport.data, stationToCountyMap);
    const newAlerts = {};
    for (const item of newCountyIntensities) {
      newAlerts[item.county] = true;
    }

    // 如果有新的警報縣市，則進行累加
    if (Object.keys(newAlerts).length > 0) {
      // 使用 callback 形式更新 state，合併舊的警報和新的警報
      setCountyAlerts(prevAlerts => ({
        ...prevAlerts,
        ...newAlerts
      }));
    }

    // 清除上一個計時器（如果存在）
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }

    // 設定一個新的 30 秒計時器
    // 30 秒後，如果沒有新的報告進來重設計時器，就會執行清空操作
    resetTimerRef.current = setTimeout(() => {
      console.log('⏰ 30秒無新報告，重設地圖顏色');
      setCountyAlerts({});
    }, 30000); // 30 秒

    // 元件卸載時，清除計時器以防止記憶體洩漏
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, [reports, stationToCountyMap]); // 當報告列表更新時觸發

  const handleBackToWaveform = () => {
    setSelectedType(null)
    setSelectedItem(null)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1
            className="app-title clickable"
            onClick={handleBackToWaveform}
            title="點擊回到首頁"
          >
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
            <div
              className="wave-status-compact active clickable"
              onClick={handleBackToWaveform}
              title="點擊回到波形顯示"
            >
              <span className="wave-icon">🌊</span>
              <span className="wave-text">{latestWaveTime}</span>
            </div>
          )}
        </div>
      </header>

      <div className="dashboard">
        <div className="left-panel">
          <section className="section events-section">
            <h2>歷史報告 ({reports.length})</h2>
            <div className="event-list">
              {reports.length === 0 ? (
                <p className="empty-message">等待預測報告資料...</p>
              ) : (
                reports.map(report => {
                  const countyIntensities = getMaxIntensityByCounty(report.data, stationToCountyMap);
                  return (
                    <div
                      key={report.id}
                      className={`event-card ${selectedType === 'report' && selectedItem?.id === report.id ? 'selected' : ''} ${report.isHistorical ? 'historical' : ''}`}
                      onClick={() => {
                        setSelectedType('report')
                        setSelectedItem(report)
                      }}
                    >
                      <div className="event-header">
                        <span className="event-time">
                          {report.timestamp}
                          {report.isHistorical && <span className="report-type-indicator">📚</span>}
                        </span>
                      </div>
                      <div className="event-stations-list">
                        {countyIntensities.length > 0 ? (
                          <>
                            {countyIntensities.slice(0, 3).map(({ county, maxIntensity }) => (
                              <span key={county} className={`station-tag ${getIntensityTagClass(maxIntensity)}`}>
                                {county} {maxIntensity}
                              </span>
                            ))}
                            {countyIntensities.length > 3 && (
                              <span className="station-tag more">+{countyIntensities.length - 3}</span>
                            )}
                          </>
                        ) : (
                          <span className="station-tag neutral">無警報縣市</span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className="section map-section">
            <h2>測站分布</h2>
            <TaiwanMap
              stations={targetStations}
              stationReplacements={stationReplacements}
              stationIntensities={stationIntensities}
              countyAlerts={countyAlerts}
            />
          </section>
        </div>

        <div className="right-panel">
          <div style={{ display: !selectedType ? 'block' : 'none', height: '100%' }}>
            <RealtimeWaveform
              wavePackets={wavePackets}
              socket={socket}
              onReplacementUpdate={setStationReplacements}
              onStationIntensityUpdate={setStationIntensities}
            />
          </div>
          {selectedType === 'report' && (
            <ReportDetail
              report={selectedItem}
              onBack={handleBackToWaveform}
              targetStations={targetStations}
              onSelectReport={(report) => setSelectedItem(report)}
              reports={reports}
            />
          )}
        </div>
      </div>
    </div>
  )
}

export default App