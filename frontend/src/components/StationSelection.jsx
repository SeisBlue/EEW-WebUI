import { useState, useMemo } from 'react';
import PropTypes from 'prop-types';
import './StationSelection.css';

function StationSelection({
  allStations,
  activeStations,
  onSelectionChange,
  onViewChange,
  selectionMode,
}) {
  const [selected, setSelected] = useState(new Set(activeStations));
  const [currentMode, setCurrentMode] = useState(selectionMode);

  const stationDetails = useMemo(() => {
    return Object.values(allStations).sort((a, b) => (b.latitude ?? 0) - (a.latitude ?? 0));
  }, [allStations]);

  const handleSelectAll = () => {
    const allStationCodes = stationDetails.map(s => s.station);
    setSelected(new Set(allStationCodes));
  };

  const handleClearAll = () => {
    setSelected(new Set());
  };

  const handleStationToggle = (stationCode) => {
    setSelected(prev => {
      const newSelection = new Set(prev);
      if (newSelection.has(stationCode)) {
        newSelection.delete(stationCode);
      } else {
        newSelection.add(stationCode);
      }
      return newSelection;
    });
    // When user manually toggles, switch to custom mode
    setCurrentMode('custom');
  };

  const handleApply = () => {
    onSelectionChange(currentMode, Array.from(selected));
    onViewChange('waveform');
  };

  const handleModeChange = (mode) => {
    setCurrentMode(mode);
    // We don't change the actual selection until "Apply" is clicked
  };

  return (
    <div className="station-selection-panel">
      <div className="panel-header">
        <h2>選擇顯示測站</h2>
        <button onClick={() => onViewChange('waveform')} className="back-button">
          &times; 返回波形圖
        </button>
      </div>

      <div className="selection-presets">
        <h4>預設選項</h4>
        <div className="preset-buttons">
          <button
            className={`preset-button ${currentMode === 'default' ? 'active' : ''}`}
            onClick={() => handleModeChange('default')}
          >
            預設 PWS 參考點
          </button>
          <button
            className={`preset-button ${currentMode === 'tsmip' ? 'active' : ''}`}
            onClick={() => handleModeChange('tsmip')}
          >
            替換為 TSMIP
          </button>
          <button
            className={`preset-button ${currentMode === 'all' ? 'active' : ''}`}
            onClick={() => handleModeChange('all')}
          >
            全部 Z 軸 (壓力測試)
          </button>
        </div>
        <p className="preset-info">
          {
            {
              'default': '顯示預設的 CWASN 測站列表。',
              'tsmip': '將預設列表自動替換為 5km 內最近的 TSMIP 測站。',
              'all': '顯示所有接收到 Z 軸訊號的測站 (壓力測試模式)。',
              'custom': '手動選擇要顯示的測站。'
            }[currentMode]
          }
        </p>
      </div>

      <div className="selection-list-container">
        <div className="list-controls">
          <span>{`已選擇 ${selected.size} / ${stationDetails.length} 個測站`}</span>
          <div>
            <button onClick={handleSelectAll} className="list-control-button">全選</button>
            <button onClick={handleClearAll} className="list-control-button">全部清除</button>
          </div>
        </div>
        <div className="station-list">
          <table>
            <thead>
              <tr>
                <th>選擇</th>
                <th>測站代碼</th>
                <th>緯度</th>
                <th>經度</th>
              </tr>
            </thead>
            <tbody>
              {stationDetails.map(station => (
                <tr
                  key={station.station}
                  className={selected.has(station.station) ? 'selected' : ''}
                  onClick={() => handleStationToggle(station.station)}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(station.station)}
                      readOnly
                    />
                  </td>
                  <td>{station.station}</td>
                  <td>{station.latitude?.toFixed(4)}</td>
                  <td>{station.longitude?.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel-footer">
        <button onClick={handleApply} className="apply-button">
          套用並返回
        </button>
      </div>
    </div>
  );
}

StationSelection.propTypes = {
  allStations: PropTypes.object.isRequired,
  activeStations: PropTypes.array.isRequired,
  onSelectionChange: PropTypes.func.isRequired,
  onViewChange: PropTypes.func.isRequired,
  selectionMode: PropTypes.string.isRequired,
};

export default StationSelection;
