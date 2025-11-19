import { useState, useEffect, useRef, useMemo, memo } from 'react'
import PropTypes from 'prop-types'
import DeckGL from '@deck.gl/react'
import { OrthographicView } from '@deck.gl/core'
import { PathLayer, TextLayer } from '@deck.gl/layers'
import './RealtimeWaveformDeck.css'

const LAT_MAX = 26.0
const LAT_MIN = 21.8 // 涵蓋整個台灣（包括離島）

// 時間軸設定
const SAMPLE_RATE = 100 // 100 Hz

/**
 * DeckGL 波形面板組件 - 使用 memo 優化
 */
const GeographicWavePanel = memo(function GeographicWavePanel({ title, stations, stationMap, waveDataMap, latMin, latMax, simpleLayout, panelWidth, panelHeight, renderTrigger, timeWindow }) {
  const [hoveredStation] = useState(null)

  const minLat = latMin ?? LAT_MIN
  const maxLat = latMax ?? LAT_MAX

  // 計算波形路徑數據（使用 PathLayer）- 優化版本
  const waveformLayers = useMemo(() => {
    const waveWidth = panelWidth * 0.75
    const waveHeight = simpleLayout ? 60 : 45 // 增加波形高度：從 40/30 增加到 60/45
    const xOffset = panelWidth * 0.15
    const now = renderTrigger // 使用傳入的 renderTrigger 作為當前時間
    const bottomMargin = 60  // 為時間軸留出底部空間

    // 預計算所有測站的 Y 位置
    const stationPositions = new Map()
    stations.forEach((stationCode, index) => {
      const station = stationMap[stationCode]
      if (!station) return

      let centerY
      if (simpleLayout) {
        const stationSpacing = waveHeight * 1.0
        const topMargin = waveHeight * 1.0
        const totalStationsHeight = stationSpacing * (stations.length - 1)
        const availableBottomMargin = panelHeight - bottomMargin - topMargin - totalStationsHeight
        const adjustedTopMargin = availableBottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
        centerY = adjustedTopMargin + stationSpacing * index
      } else {
        if (!station.latitude) return
        // 調整為可用高度（扣除底部時間軸空間）
        const availableHeight = panelHeight - bottomMargin
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * availableHeight
      }
      stationPositions.set(stationCode, centerY)
    })

    // 合併所有基線到單個數據集
    const baselineData = []
    const waveformData = []

    stations.forEach((stationCode) => {
      const centerY = stationPositions.get(stationCode)
      if (centerY === undefined) return

      const isHovered = hoveredStation === stationCode
      const waveData = waveDataMap[stationCode]

      // 添加基線
      baselineData.push({
        path: [[xOffset, centerY], [xOffset + waveWidth, centerY]],
        color: isHovered ? [255, 193, 7, 76] : [255, 255, 255, 26],
        width: isHovered ? 1 : 0.5
      })

      // 處理波形數據
      if (waveData?.dataPoints?.length > 0) {
        const displayScale = waveData.displayScale || 1.0

        waveData.dataPoints.forEach(point => {
          const { timestamp, endTimestamp, values, samprate, isGap } = point

          // 跳過斷點標記
          if (isGap) {
            return
          }

          const timeDiff = now - timestamp
          const endTimeDiff = endTimestamp ? now - endTimestamp : timeDiff

          // 如果整個數據段都在時間窗口之外，跳過
          if (endTimeDiff > timeWindow * 1000 || timeDiff < 0) return

          const pathPoints = []

          // 使用實際的採樣率和時間戳
          const effectiveSamprate = samprate || SAMPLE_RATE
          const len = values.length

          // 優化：使用 for 循環代替 forEach，減少函數調用開銷
          for (let idx = 0; idx < len; idx++) {
            // 計算這個樣本點的實際時間
            const sampleTime = timestamp + (idx / effectiveSamprate) * 1000  // 毫秒
            const sampleTimeDiff = now - sampleTime
            const sampleTimeOffset = sampleTimeDiff / 1000  // 轉換為秒

            if (sampleTimeOffset < 0 || sampleTimeOffset > timeWindow) continue

            const x = xOffset + waveWidth * (1 - sampleTimeOffset / timeWindow)
            const normalizedValue = values[idx] / displayScale
            const clampedValue = Math.max(-1, Math.min(1, normalizedValue))
            const y = centerY - clampedValue * (waveHeight / 2)

            pathPoints.push([x, y])
          }

          if (pathPoints.length > 1) {
            waveformData.push({
              path: pathPoints,
              color: isHovered ? [255, 193, 7, 255] : [76, 175, 80, 230],
              width: isHovered ? 2.0 : 1.2
            })
          }
        })
      }
    })

    // 使用單個 PathLayer 繪製所有基線
    const layers = []

    if (baselineData.length > 0) {
      layers.push(new PathLayer({
        id: 'baselines',
        data: baselineData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 0.5,
        getDashArray: [3, 3],
        updateTriggers: {
          getColor: hoveredStation,
          getWidth: hoveredStation
        }
      }))
    }

    // 使用單個 PathLayer 繪製所有波形
    if (waveformData.length > 0) {
      layers.push(new PathLayer({
        id: 'waveforms',
        data: waveformData,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1.2,
        jointRounded: false, // 關閉圓角以提升性能
        capRounded: false,
        updateTriggers: {
          getColor: hoveredStation,
          getWidth: hoveredStation,
          getPath: [waveDataMap, renderTrigger] // 當波形數據或時間變化時更新
        }
      }))
    }

    return layers
  }, [stations, stationMap, waveDataMap, hoveredStation, minLat, maxLat, simpleLayout, panelWidth, panelHeight, title, renderTrigger, timeWindow])

  // 文字標籤圖層 - 優化版本
  const labelLayers = useMemo(() => {
    const waveWidth = panelWidth * 0.75
    const waveHeight = simpleLayout ? 60 : 45 // 增加波形高度：從 40/30 增加到 60/45
    const xOffset = panelWidth * 0.15
    const bottomMargin = 60  // 為時間軸留出底部空間

    const labels = []

    stations.forEach((stationCode, index) => {
      const station = stationMap[stationCode]
      if (!station) return

      // 計算 Y 位置
      let centerY
      if (simpleLayout) {
        const stationSpacing = waveHeight * 1.0
        const topMargin = waveHeight * 1.0
        const totalStationsHeight = stationSpacing * (stations.length - 1)
        const availableBottomMargin = panelHeight - bottomMargin - topMargin - totalStationsHeight
        const adjustedTopMargin = availableBottomMargin < waveHeight * 0.8 ? topMargin * 0.8 : topMargin
        centerY = adjustedTopMargin + stationSpacing * index
      } else {
        if (!station.latitude) return
        // 調整為可用高度（扣除底部時間軸空間）
        const availableHeight = panelHeight - bottomMargin
        centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * availableHeight
      }

      const waveData = waveDataMap[stationCode]
      const isHovered = hoveredStation === stationCode

      // 測站代碼標籤
      labels.push({
        position: [xOffset - 8, centerY],
        text: stationCode,
        color: isHovered ? [255, 193, 7] : (waveData ? [224, 224, 224] : [102, 102, 102]),
        size: isHovered ? 11 : 10,
        anchor: 'end',
        alignmentBaseline: 'center'
      })

      // 測站中文名稱
      if (station.station_zh) {
        labels.push({
          position: [xOffset + waveWidth + 5, centerY - 8],
          text: station.station_zh,
          color: isHovered ? [255, 193, 7] : [224, 224, 224],
          size: isHovered ? 10 : 9,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }

      // PGA 數值
      if (waveData?.lastPga) {
        labels.push({
          position: [xOffset + waveWidth + 5, centerY + 2],
          text: `PGA: ${waveData.lastPga.toFixed(2)}`,
          color: isHovered ? [255, 193, 7] : [76, 175, 80],
          size: isHovered ? 10 : 9,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }

      // 縮放範圍
      if (waveData?.displayScale) {
        labels.push({
          position: [xOffset + waveWidth + 5, centerY + 11],
          text: `±${waveData.displayScale.toFixed(2)}`,
          color: isHovered ? [255, 193, 7] : [144, 202, 249],
          size: isHovered ? 9 : 8,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }
    })

    // 時間軸標籤 - 顯示實際時間和相對時間差
    const timeAxisY = panelHeight - 50  // 增加底部空間，從 25 改為 50
    const timeWaveWidth = panelWidth * 0.75
    const timeXOffset = panelWidth * 0.15
    const numTicks = 7
    const now = new Date(renderTrigger) // 使用 renderTrigger 的時間

    for (let i = 0; i < numTicks; i++) {
      const timeValue = -i * (timeWindow / (numTicks - 1))
      const x = timeXOffset + timeWaveWidth - (i / (numTicks - 1)) * timeWaveWidth

      let label
      let color
      if (timeValue === 0) {
        // 最右側：顯示當前實際時間（時:分:秒）
        label = now.toLocaleTimeString('zh-TW', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        })
        color = [76, 175, 80, 255]  // 綠色，完全不透明
      } else {
        // 其他位置：顯示相對時間差
        label = `${timeValue.toFixed(0)}s`
        color = [144, 202, 249, 255]  // 藍色，完全不透明
      }

      labels.push({
        position: [x, timeAxisY + 8],  // 調整文字位置，更靠近軸線
        text: label,
        color: color,
        size: 12,  // 增大字體從 10 到 12
        anchor: 'middle',
        alignmentBaseline: 'center'
      })
    }

    return [new TextLayer({
      id: 'labels',
      data: labels,
      getPosition: d => d.position,
      getText: d => d.text,
      getColor: d => d.color,
      getSize: d => d.size,
      getTextAnchor: d => d.anchor,
      getAlignmentBaseline: d => d.alignmentBaseline,
      fontFamily: 'monospace',
      fontWeight: 'normal',
      updateTriggers: {
        getColor: [hoveredStation, waveDataMap],
        getSize: hoveredStation,
        getText: [waveDataMap, renderTrigger] // 添加 renderTrigger 以更新時間顯示
      }
    })]
  }, [stations, stationMap, waveDataMap, hoveredStation, minLat, maxLat, simpleLayout, panelWidth, panelHeight, renderTrigger, timeWindow])

  // 緯度網格線
  const gridLayers = useMemo(() => {
    if (simpleLayout) return []

    const layers = []
    const gridLines = []
    const gridLabels = []

    for (let lat = Math.ceil(minLat); lat <= maxLat; lat += 0.5) {
      const y = ((maxLat - lat) / (maxLat - minLat)) * panelHeight

      gridLines.push({
        path: [[0, y], [panelWidth, y]],
        color: lat % 1 === 0 ? [100, 181, 246, 76] : [100, 181, 246, 38]
      })

      if (lat % 1 === 0) {
        gridLabels.push({
          position: [8, y - 5],
          text: `${lat} N`,
          color: [100, 181, 246],
          size: 11
        })
      }
    }

    layers.push(new PathLayer({
      id: 'grid-lines',
      data: gridLines,
      getPath: d => d.path,
      getColor: d => d.color,
      widthMinPixels: 1
    }))

    layers.push(new TextLayer({
      id: 'grid-labels',
      data: gridLabels,
      getPosition: d => d.position,
      getText: d => d.text,
      getColor: d => d.color,
      getSize: d => d.size,
      getTextAnchor: 'start', // 改為靠左對齊，避免被切掉
      fontFamily: 'monospace'
    }))

    return layers
  }, [minLat, maxLat, simpleLayout, panelWidth, panelHeight])

  // 時間軸線
  const timeAxisLayer = useMemo(() => {
    const timeAxisY = panelHeight - 50  // 與標籤位置一致，從 25 改為 50
    const axisWaveWidth = panelWidth * 0.75
    const axisXOffset = panelWidth * 0.15

    const lines = [{
      path: [[axisXOffset, timeAxisY], [axisXOffset + axisWaveWidth, timeAxisY]],
      color: [255, 255, 255, 128]  // 增加不透明度，更清晰
    }]

    const numTicks = 7
    for (let i = 0; i < numTicks; i++) {
      const x = axisXOffset + axisWaveWidth - (i / (numTicks - 1)) * axisWaveWidth
      lines.push({
        path: [[x, timeAxisY - 5], [x, timeAxisY + 5]],  // 刻度線更長，從 5 改為 ±5
        color: [255, 255, 255, 128]
      })
    }

    return new PathLayer({
      id: 'time-axis',
      data: lines,
      getPath: d => d.path,
      getColor: d => d.color,
      widthMinPixels: 1.5  // 增加線條寬度
    })
  }, [panelWidth, panelHeight])

  const allLayers = [...gridLayers, timeAxisLayer, ...waveformLayers, ...labelLayers]

  const views = new OrthographicView({
    id: 'ortho',
    controller: false
  })

  // 確保尺寸有效
  const validWidth = Math.max(panelWidth, 1)
  const validHeight = Math.max(panelHeight, 1)

  // 使用左上角为原点的坐标系统
  const viewState = {
    target: [validWidth / 2, validHeight / 2, 0],
    zoom: 0
  }

  return (
    <div className="geographic-wave-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{stations.length} 站</span>
      </div>
      <div className="deckgl-container" style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0e27' }}>
        <DeckGL
          views={views}
          viewState={viewState}
          layers={allLayers}
          width={validWidth}
          height={validHeight}
          controller={false}
          getCursor={() => 'default'}
        />
      </div>
    </div>
  )
}, (prevProps, nextProps) => {
  // 自定義比較函數：只在關鍵屬性變化時重新渲染
  return (
    prevProps.title === nextProps.title &&
    prevProps.stations === nextProps.stations &&
    prevProps.stationMap === nextProps.stationMap &&
    prevProps.waveDataMap === nextProps.waveDataMap &&
    prevProps.latMin === nextProps.latMin &&
    prevProps.latMax === nextProps.latMax &&
    prevProps.simpleLayout === nextProps.simpleLayout &&
    prevProps.panelWidth === nextProps.panelWidth &&
    prevProps.panelHeight === nextProps.panelHeight &&
    prevProps.renderTrigger === nextProps.renderTrigger && // 比較 renderTrigger
    prevProps.timeWindow === nextProps.timeWindow
  )
})

GeographicWavePanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  simpleLayout: PropTypes.bool,
  panelWidth: PropTypes.number.isRequired,
  panelHeight: PropTypes.number.isRequired,
  renderTrigger: PropTypes.number.isRequired,
  timeWindow: PropTypes.number.isRequired
}

function RealtimeWaveformDeck({ waveDataMap, displayStations, stationMap, title, timeWindow }) {
  const [renderTrigger, setRenderTrigger] = useState(Date.now()) // 使用時間戳作為觸發器
  const panelRef = useRef(null)
  const animationFrameRef = useRef() // 用於保存 requestAnimationFrame 的 ID
  const [dimensions, setDimensions] = useState(null)

  // --- 優化：使用 requestAnimationFrame 實現平滑滾動 ---
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
        const rect = panelRef.current.getBoundingClientRect()
        setDimensions(prev => {
          if (prev && prev.width === rect.width && prev.height === rect.height) {
            return prev
          }
          return {
            width: rect.width,
            height: rect.height
          }
        })
      }
    }

    updateSize()
    window.addEventListener('resize', updateSize)

    const resizeObserver = new ResizeObserver(updateSize)
    if (panelRef.current) {
      resizeObserver.observe(panelRef.current)
    }

    return () => {
      window.removeEventListener('resize', updateSize)
      resizeObserver.disconnect()
    }
  }, [])

  return (
    <div className="realtime-waveform geographic">
      <div ref={panelRef} className="waveform-panel-container" style={{ flex: 1, overflow: 'hidden' }}>
        {dimensions && dimensions.width > 0 && dimensions.height > 0 && (
          <GeographicWavePanel
            title={title}
            stations={displayStations}
            stationMap={stationMap}
            waveDataMap={waveDataMap}
            latMin={LAT_MIN}
            latMax={LAT_MAX}
            simpleLayout={false} // 壓力測試時也使用地理佈局
            panelWidth={dimensions.width}
            panelHeight={dimensions.height}
            renderTrigger={renderTrigger}
            timeWindow={timeWindow}
          />
        )}
      </div>
    </div>
  )
}

RealtimeWaveformDeck.propTypes = {
  waveDataMap: PropTypes.object.isRequired,
  displayStations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  title: PropTypes.string.isRequired,
  timeWindow: PropTypes.number.isRequired,
}

export default RealtimeWaveformDeck
