import { useState, useEffect, useRef, useMemo, memo } from 'react'
import PropTypes from 'prop-types'
import DeckGL from '@deck.gl/react'
import { OrthographicView } from '@deck.gl/core'
import { PathLayer, TextLayer } from '@deck.gl/layers'
import { pgaToIntensity, getIntensityValue } from '../utils'
import './RealtimeWaveformDeck.css'

const LAT_MAX = 26.3
const LAT_MIN = 21.3 // 涵蓋整個台灣（包括離島）

// 時間軸設定
const SAMPLE_RATE = 100 // 100 Hz

// 佈局常數（使用固定像素而非比例，以確保文字不會溢出）
const LEFT_MARGIN = 80          // 左側留白（測站代碼的顯示空間）
const RIGHT_MARGIN = 120        // 右側留白（測站名稱和 PGA 的顯示空間）
const BOTTOM_MARGIN = 60        // 底部留白（為時間軸預留空間）
const TIME_AXIS_Y_OFFSET = 60   // 時間軸距離底部的距離

const GeographicWavePanel = memo(function GeographicWavePanel({ title, stations, stationMap, waveDataMap, latMin, latMax, panelWidth, panelHeight, renderTrigger, timeWindow, baseTime }) {

  const minLat = latMin ?? LAT_MIN
  const maxLat = latMax ?? LAT_MAX

  // 計算佈局尺寸（使用固定邊界，波形寬度自動適應）
  const xOffset = LEFT_MARGIN
  const waveWidth = Math.max(100, panelWidth - LEFT_MARGIN - RIGHT_MARGIN) // 至少保留 100px 給波形

  // 計算波形路徑數據（使用 PathLayer）- 優化版本
  const waveformLayers = useMemo(() => {
    const waveHeight = 45
    // const now = renderTrigger // 不再依賴 renderTrigger 計算座標

    // 預計算所有測站的 Y 位置
    const stationPositions = new Map()
    const availableHeight = panelHeight - BOTTOM_MARGIN
    stations.forEach((stationCode) => {
      const station = stationMap[stationCode]
      if (!station || !station.latitude) return

      const centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * availableHeight
      stationPositions.set(stationCode, centerY)
    })

    // 合併所有基線到單個數據集
    const baselineData = []
    const waveformData = []
    const pickLines = []
    const pickLabels = []

    stations.forEach((stationCode) => {
      const centerY = stationPositions.get(stationCode)
      if (centerY === undefined) return

      const waveData = waveDataMap[stationCode]

      // 添加基線
      baselineData.push({
        path: [[xOffset, centerY], [xOffset + waveWidth, centerY]],
        color: [255, 255, 255, 26],
        width: 0.5
      })

      // 處理波形數據
      if (waveData?.dataPoints?.length > 0) {
        const displayScale = waveData.displayScale || 1.0

        // 計算速度：像素/毫秒
        const speed = waveWidth / (timeWindow * 1000)

        // 根據 PGA 計算震度等級 (使用 utils.js 的函數)
        const pga = waveData.lastPga || 0
        const intensityStr = pgaToIntensity(pga)
        const intensityValue = getIntensityValue(intensityStr)

        // 根據震度和 pick 決定顏色和寬度
        let waveColor
        let lineWidth  // 改名為 lineWidth 避免與外部 waveWidth 衝突
        const hasPicks = waveData.picks && waveData.picks.length > 0

        if (intensityValue >= 4) {
          // 4 級以上：正常綠色
          waveColor = [76, 175, 80, 230]
        } else {
          // 0-3 級：調淡 (降低 alpha)
          waveColor = [76, 175, 80, 70]
        }

        // 有 pick 的波形調粗
        lineWidth = hasPicks ? 2.0 : 1.2

        waveData.dataPoints.forEach(point => {
          const { timestamp, endTimestamp, values, samprate, isGap } = point

          // 跳過斷點標記
          if (isGap) {
            return
          }

          // 這裡只做簡單的範圍檢查，確保數據不是太舊或太新
          // 精確的裁剪交給 Viewport 或 Shader
          // 但為了性能，還是過濾掉完全在視圖外的數據
          // 假設 baseTime 是 T0
          // 當前時間 T
          // 視窗顯示範圍是 [T - timeWindow, T]
          // 轉換為相對 T0 的時間： [T - T0 - timeWindow, T - T0]
          // 對應的 X 座標範圍...
          // 簡單起見，這裡不過濾，或者只過濾非常遠的數據

          const pathPoints = []

          // 使用實際的採樣率和時間戳
          const effectiveSamprate = samprate || SAMPLE_RATE
          const len = values.length

          // 動態降採樣：根據時間窗口和波形寬度自動調整
          // 目標：保持每像素約 0.5 - 1 個數據點，避免過度繪製
          // waveWidth 像素對應 timeWindow 秒，每秒 SAMPLE_RATE 個點
          // 總點數 = timeWindow * effectiveSamprate
          // 理想點數 = waveWidth * 1.0
          // downsampleFactor = 總點數 / 理想點數
          const totalPoints = timeWindow * effectiveSamprate
          const targetPoints = waveWidth * 0.5 // 稍微降低密度以提升性能
          const calculatedFactor = Math.floor(totalPoints / targetPoints)
          const downsampleFactor = Math.max(1, calculatedFactor)

          // 優化：使用 for 循環代替 forEach，減少函數調用開銷
          for (let idx = 0; idx < len; idx += downsampleFactor) {
            // 計算這個樣本點的實際時間
            const sampleTime = timestamp + (idx / effectiveSamprate) * 1000  // 毫秒

            // 計算相對於 baseTime 的 X 座標
            // 公式：x = xOffset + waveWidth + speed * (sampleTime - baseTime - timeWindow * 1000)
            // 當 sampleTime = baseTime + timeWindow * 1000 (即 T = baseTime + timeWindow) 時，應該在最右邊 (xOffset + waveWidth)
            // 實際上，我們希望當 sampleTime = currentRenderTime 時，它在最右邊
            // 所以這裡計算的是 "絕對" X 座標，相機之後會平移
            // 讓 sampleTime = baseTime 時，x = xOffset + waveWidth
            // 這樣隨著時間增加，相機向右移動，看到的波形就是向左移動

            // 修正公式：
            // 定義 X=0 在 baseTime 時刻的 "最右邊" (xOffset + waveWidth)
            // 每個樣本的 X = (xOffset + waveWidth) + (sampleTime - baseTime) * speed
            // 相機的 Target X 也會隨時間增加

            const x = (xOffset + waveWidth) + (sampleTime - baseTime) * speed

            const normalizedValue = values[idx] / displayScale
            const clampedValue = Math.max(-1, Math.min(1, normalizedValue))
            const y = centerY - clampedValue * (waveHeight / 2)

            pathPoints.push([x, y])
          }

          if (pathPoints.length > 1) {
            waveformData.push({
              path: pathPoints,
              color: waveColor,
              width: lineWidth
            })
          }
        })
      }

      // 處理 Pick 標記
      if (waveData?.picks?.length > 0) {
        const speed = waveWidth / (timeWindow * 1000)

        waveData.picks.forEach(pick => {
          const pickTime = pick.time

          // 計算 X 座標
          const x = (xOffset + waveWidth) + (pickTime - baseTime) * speed

          // Pick 線
          pickLines.push({
            path: [[x, centerY - waveHeight / 2], [x, centerY + waveHeight / 2]],
            color: [255, 235, 59, 200], // 黃色
            width: 2
          })

          // Pick 文字
          pickLabels.push({
            position: [x, centerY - waveHeight / 2 - 8],
            text: pick.type || 'P',
            color: [255, 235, 59, 255],
            size: 12,
            anchor: 'middle'
          })
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
          getPath: [waveDataMap, baseTime] // 不再依賴 renderTrigger
        }
      }))
    }

    // 繪製 Pick 線
    if (pickLines.length > 0) {
      layers.push(new PathLayer({
        id: 'pick-lines',
        data: pickLines,
        getPath: d => d.path,
        getColor: d => d.color,
        getWidth: d => d.width,
        widthMinPixels: 1,
        updateTriggers: {
          getPath: [waveDataMap, baseTime]
        }
      }))
    }

    // 繪製 Pick 標籤
    if (pickLabels.length > 0) {
      layers.push(new TextLayer({
        id: 'pick-labels',
        data: pickLabels,
        getPosition: d => d.position,
        getText: d => d.text,
        getColor: d => d.color,
        getSize: d => d.size,
        getTextAnchor: d => d.anchor,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        updateTriggers: {
          getPosition: [waveDataMap, baseTime]
        }
      }))
    }

    return layers
  }, [stations, stationMap, waveDataMap, minLat, maxLat, panelWidth, panelHeight, title, baseTime, timeWindow, waveWidth, xOffset])

  // 文字標籤圖層 - 優化版本
  const labelLayers = useMemo(() => {
    const labels = []

    stations.forEach((stationCode) => {
      const station = stationMap[stationCode]
      if (!station) return

      // 計算 Y 位置
      let centerY

      if (!station.latitude) return
      // 調整為可用高度（扣除底部時間軸空間）
      const availableHeight = panelHeight - BOTTOM_MARGIN
      centerY = ((maxLat - station.latitude) / (maxLat - minLat)) * availableHeight

      const waveData = waveDataMap[stationCode]

      // 計算震度等級來決定文字顏色和位置
      let textAlpha = 255 // 預設完全不透明
      let stationLabelOffset = -10  // 測站代碼的 X offset
      let pgaLabelOffset = 5        // PGA 的 X offset

      if (waveData?.lastPga !== undefined) {
        const pga = waveData.lastPga
        const intensityStr = pgaToIntensity(pga)
        const intensityValue = getIntensityValue(intensityStr)

        if (intensityValue < 2) {
          textAlpha = 50  // 0 級：alpha 80
        } else if (intensityValue < 3) {
          textAlpha = 100  // 1-2 級：alpha 70
        } else {
          textAlpha = 255 // 3 級以上：正常顏色
          // 4 級以上：文字位置往外挪
          stationLabelOffset = -40
          pgaLabelOffset = 60
        }
      }

      // 測站代碼標籤
      labels.push({
        position: [xOffset + stationLabelOffset, centerY],
        text: stationCode,
        color: waveData ? [224, 224, 224, textAlpha] : [102, 102, 102, 255],
        size: 10,
        anchor: 'end',
        alignmentBaseline: 'center'
      })

      // 測站中文名稱
      if (station.station_zh) {
        labels.push({
          position: [xOffset + waveWidth + pgaLabelOffset, centerY - 8],
          text: station.station_zh,
          color: [224, 224, 224, textAlpha],
          size: 9,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }
      // PGA 數值
      if (waveData?.lastPga) {
        labels.push({
          position: [xOffset + waveWidth + pgaLabelOffset, centerY + 2],
          text: `PGA: ${waveData.lastPga.toFixed(2)}`,
          color: [76, 175, 80, textAlpha],
          size: 9,
          anchor: 'start',
          alignmentBaseline: 'center'
        })
      }
    })

    // 時間軸標籤 - 顯示實際時間和相對時間差
    const timeAxisY = panelHeight - TIME_AXIS_Y_OFFSET
    const numTicks = 7
    const now = new Date(renderTrigger) // 使用 renderTrigger 的時間

    for (let i = 0; i < numTicks; i++) {
      const timeValue = -i * (timeWindow / (numTicks - 1))
      const x = xOffset + waveWidth - (i / (numTicks - 1)) * waveWidth

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
        getColor: waveDataMap,
        getText: [waveDataMap, renderTrigger] // 添加 renderTrigger 以更新時間顯示
      }
    })]
  }, [stations, stationMap, waveDataMap, minLat, maxLat, panelWidth, panelHeight, renderTrigger, timeWindow, waveWidth, xOffset])

  // 緯度網格線
  const gridLayers = useMemo(() => {
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
  }, [minLat, maxLat, panelWidth, panelHeight])

  // 時間軸線
  const timeAxisLayer = useMemo(() => {
    const timeAxisY = panelHeight - TIME_AXIS_Y_OFFSET

    const lines = [{
      path: [[xOffset, timeAxisY], [xOffset + waveWidth, timeAxisY]],
      color: [255, 255, 255, 128]  // 增加不透明度，更清晰
    }]

    const numTicks = 7
    for (let i = 0; i < numTicks; i++) {
      const x = xOffset + waveWidth - (i / (numTicks - 1)) * waveWidth
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
  }, [panelWidth, panelHeight, xOffset])

  const allLayers = [...gridLayers, timeAxisLayer, ...waveformLayers, ...labelLayers]



  // 定義兩個 View
  const views = [
    new OrthographicView({
      id: 'static-view',
      controller: false,
      x: 0,
      y: 0,
      width: '100%',
      height: '100%'
    }),
    new OrthographicView({
      id: 'wave-view',
      controller: false,
      x: xOffset, // 限制視圖 X 起點
      y: 0,
      width: waveWidth, // 限制視圖寬度，超出部分會被裁剪
      height: '100%'
    })
  ]

  // 確保尺寸有效
  const validWidth = Math.max(panelWidth, 1)
  const validHeight = Math.max(panelHeight, 1)

  // 計算 wave-view 的相機位置
  const waveSpeed = waveWidth / (timeWindow * 1000) // pixels / ms (使用 waveWidth 確保與波形繪製速度一致)
  const cameraXOffset = (renderTrigger - baseTime) * waveSpeed

  // 使用左上角为原点的坐标系统
  // static-view 保持固定
  const staticViewState = {
    target: [validWidth / 2, validHeight / 2, 0],
    zoom: 0
  }

  // wave-view 隨時間移動
  // 由於 wave-view 的視口被限制在 [xOffset, xOffset + waveWidth]
  // 我們需要調整 target，使得世界坐標系中的波形正確映射到視口中
  // OrthographicView 將 target 映射到視口中心
  // 視口中心在屏幕上的位置是 xOffset + waveWidth / 2
  // 我們希望世界坐標中的 (xOffset + waveWidth / 2 + cameraXOffset) 映射到這個中心
  const waveViewState = {
    target: [xOffset + waveWidth / 2 + cameraXOffset, validHeight / 2, 0],
    zoom: 0
  }

  const viewState = {
    'static-view': staticViewState,
    'wave-view': waveViewState
  }

  // Layer Filter: 分配圖層到對應的 View
  const layerFilter = ({ layer, viewport }) => {
    if (viewport.id === 'static-view') {
      return ['grid-lines', 'grid-labels', 'time-axis', 'labels', 'baselines'].includes(layer.id)
    } else if (viewport.id === 'wave-view') {
      return ['waveforms', 'pick-lines', 'pick-labels'].includes(layer.id)
    }
    return false
  }

  // 計算有資料的測站數量
  const activeStationCount = useMemo(() => {
    return stations.filter(stationCode => {
      return waveDataMap?.[stationCode]?.pgaHistory?.length > 0;
    }).length;
  }, [stations, waveDataMap]);

  return (
    <div className="geographic-wave-panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <span className="station-count">{activeStationCount} / {stations.length} 站</span>
        <span className="time-window-display" style={{ marginLeft: '10px', color: '#64B5F6', fontSize: '12px' }}>
          時間窗口: {timeWindow.toFixed(1)}s
        </span>
      </div>
      <div className="deckgl-container" style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0e27' }}>
        <DeckGL
          views={views}
          viewState={viewState}
          layers={allLayers}
          layerFilter={layerFilter}
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
    prevProps.panelWidth === nextProps.panelWidth &&
    prevProps.panelHeight === nextProps.panelHeight &&
    prevProps.renderTrigger === nextProps.renderTrigger && // 比較 renderTrigger
    prevProps.timeWindow === nextProps.timeWindow &&
    prevProps.baseTime === nextProps.baseTime
  )
})

GeographicWavePanel.propTypes = {
  title: PropTypes.string.isRequired,
  stations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  waveDataMap: PropTypes.object.isRequired,
  latMin: PropTypes.number,
  latMax: PropTypes.number,
  panelWidth: PropTypes.number.isRequired,
  panelHeight: PropTypes.number.isRequired,
  renderTrigger: PropTypes.number.isRequired,
  timeWindow: PropTypes.number.isRequired,
  baseTime: PropTypes.number.isRequired
}

function RealtimeWaveformDeck({ waveDataMap, displayStations, stationMap, title, timeWindow: initialTimeWindow, onTimeWindowChange, latMin, latMax }) {
  const [renderTrigger, setRenderTrigger] = useState(Date.now()) // 使用時間戳作為觸發器
  const [baseTime] = useState(Date.now()) // 基準時間，組件掛載時確定
  const panelRef = useRef(null)
  const animationFrameRef = useRef(null) // 用於保存 requestAnimationFrame 的 ID
  const [dimensions, setDimensions] = useState(null)
  
  // 時間軸縮放狀態（可通過滾輪調整）
  const [timeWindow, setTimeWindow] = useState(initialTimeWindow)
  const MIN_TIME_WINDOW = 1   // 最小時間窗口：1 秒
  const MAX_TIME_WINDOW = 120 // 最大時間窗口：120 秒

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

  // 滾輪縮放時間軸
  useEffect(() => {
    const handleWheel = (e) => {
      // 只在波形面板內處理滾輪事件
      if (!panelRef.current?.contains(e.target)) return
      
      e.preventDefault()
      
      // 計算縮放因子（向上滾動縮小時間窗口，向下滾動放大時間窗口）
      const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9
      
      setTimeWindow(prev => {
        const newWindow = prev * zoomFactor
        // 限制在最小和最大時間窗口之間
        const clamped = Math.max(MIN_TIME_WINDOW, Math.min(MAX_TIME_WINDOW, newWindow))
        
        // 通知父組件更新
        if (onTimeWindowChange) {
          // 使用 debounce 或直接調用，這裡直接調用因為頻率不高
          onTimeWindowChange(clamped)
        }
        
        return clamped
      })
    }

    const panel = panelRef.current
    if (panel) {
      panel.addEventListener('wheel', handleWheel, { passive: false })
    }

    return () => {
      if (panel) {
        panel.removeEventListener('wheel', handleWheel)
      }
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
  )
}

RealtimeWaveformDeck.propTypes = {
  waveDataMap: PropTypes.object.isRequired,
  displayStations: PropTypes.array.isRequired,
  stationMap: PropTypes.object.isRequired,
  title: PropTypes.string.isRequired,
  timeWindow: PropTypes.number.isRequired,
  latMin: PropTypes.number,  // 可選：地圖的最小緯度
  latMax: PropTypes.number,  // 可選：地圖的最大緯度
  onTimeWindowChange: PropTypes.func // 可選：時間窗口改變回調
}

export default RealtimeWaveformDeck
