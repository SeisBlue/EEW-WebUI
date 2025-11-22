/**
 * 波形顯示相關的常數定義
 */

// 緯度範圍
export const LAT_MAX = 26.3;
export const LAT_MIN = 21.3; // 涵蓋整個台灣（包括離島）

// 採樣率
export const SAMPLE_RATE = 100; // 100 Hz

// 佈局常數（使用固定像素而非比例，以確保文字不會溢出）
export const LEFT_MARGIN = 120;   // 左側留白（測站代碼的顯示空間）
export const RIGHT_MARGIN = 120;  // 右側留白（測站名稱和 PGA 的顯示空間）
export const BOTTOM_MARGIN = 60;  // 底部留白（為時間軸預留空間）

// 波形高度
export const WAVE_AMPLITUDE_SCALE = 8.0; // 波形振幅放大倍率

// 顏色定義
export const COLORS = {
    BASELINE: [255, 255, 255, 26],        // 白色，透明度低
    WAVEFORM_ACTIVE: [76, 175, 80, 150],  // 綠色，高透明度
    WAVEFORM_DIM: [76, 175, 80, 60],      // 綠色，低透明度
    PICK_MARKER: [255, 235, 59, 200],     // 黃色，中等透明度
    PICK_LABEL: [255, 235, 59, 255],      // 黃色，不透明
    PICK_BG: [0, 0, 0, 255],              // 黑色，不透明
    GRID_MAJOR: [100, 181, 246, 76],      // 淺藍色，低透明度
    GRID_MINOR: [100, 181, 246, 38],      // 淺藍色，更低透明度
    GRID_LABEL: [100, 181, 246],          // 淺藍色
    TIME_AXIS: [255, 255, 255, 128],      // 白色，中等透明度
    LABEL_DEFAULT: [224, 224, 224, 255],  // 淺灰色，不透明
    LABEL_INACTIVE: [102, 102, 102, 255], // 深灰色，不透明
    LABEL_PGA: [255, 255, 255],             // 白色
    TIME_CURRENT: [76, 175, 80, 255],     // 綠色，不透明
    TIME_RELATIVE: [144, 202, 249, 255],  // 藍色，不透明
};
