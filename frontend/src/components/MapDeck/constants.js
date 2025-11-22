/**
 * MapDeck 常數定義
 */

// 地圖樣式
export const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json';

// 初始視圖狀態
export const INITIAL_VIEW_STATE = {
  longitude: 120.95,
  latitude: 23.6,
  zoom: 6.8,
  pitch: 0,
  bearing: 0
};

// 網格範圍
export const GRID_BOUNDS = {
  minLat: 20,
  maxLat: 30,
  lonMin: 115,
  lonMax: 125
};

// 顏色定義
export const COLORS = {
  GRID_MAJOR: [100, 181, 246, 100],
  GRID_MINOR: [100, 181, 246, 50],
  GRID_LABEL: [100, 181, 246, 200],
  STATION_BORDER_DEFAULT: [255, 255, 255, 150],
  STATION_BORDER_PICK: [255, 235, 59, 255],
  LABEL_TEXT: [255, 255, 255, 255],
  LABEL_OUTLINE: [0, 0, 0, 150]
};

// 測站點大小
export const STATION_RADIUS = {
  DEFAULT: 400,
  ACTIVE: 800,
  MIN_PIXELS: 3,
  MAX_PIXELS: 15
};

// Pick 邊框寬度
export const PICK_BORDER_WIDTH = {
  DEFAULT: 1,
  ACTIVE: 20
};
