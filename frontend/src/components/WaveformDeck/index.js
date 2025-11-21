/**
 * WaveformDeck 統一導出入口
 * 
 * 此模組提供波形顯示相關的組件：
 * - RealtimeWaveformDeck: 即時波形顯示（自動滾動）
 * - WaveformPanel: 核心渲染組件（可重用）
 * 
 * 未來可擴展：
 * - HistoricalWaveformDeck: 歷史波形顯示（拖拽平移、框選）
 */

// 主要組件
export { default as RealtimeWaveformDeck } from './RealtimeWaveformDeck';
export { default as WaveformPanel } from './WaveformPanel';

// 常數和工具（如需要可導出）
export * from './constants';
export * from './utils';
