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
    setCurrentMode('custom'); // Manual selection implies custom mode
  };

  const handleClearAll = () => {
    setSelected(new Set());
    setCurrentMode('custom');
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

  const handlePresetClick = (mode) => {
    // For presets, apply immediately and switch view
    onSelectionChange(mode, []); // Pass empty array, App.jsx will calculate the stations
    onViewChange('waveform');
  };

  const handleApplyCustom = () => {
    // The apply button is now only for custom selections
    onSelectionChange('custom', Array.from(selected));
    onViewChange('waveform');
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
        <h4>預設選項 (點擊直接套用)</h4>
        <div className="preset-buttons">
          <button
            className={`preset-button ${selectionMode === 'default' ? 'active' : ''}`}
            onClick={() => handlePresetClick('default')}
          >
            預設 PWS 參考點
          </button>
          <button
            className={`preset-button ${selectionMode === 'all' ? 'active' : ''}`}
            onClick={() => handlePresetClick('all')}
          >
            全部 Z 軸 (壓力測試)
          </button>
        </div>
        <p className="preset-info">
          目前模式: {
            {
              'default': '預設的 CWASN 測站列表。',
              'all': '顯示所有接收到 Z 軸訊號的測站 (壓力測試模式)。',
              'custom': '手動選擇要顯示的測站。'
            }[selectionMode]
          }
        </p>
      </div>

      <div className="selection-list-container">
        <div className="list-controls">
          <span>{`手動選擇 (${selected.size} / ${stationDetails.length})`}</span>
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
        <button onClick={handleApplyCustom} className="apply-button">
          套用手動選擇
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
