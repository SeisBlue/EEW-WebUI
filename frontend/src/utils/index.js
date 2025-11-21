/**
 * 工具函數統一導出入口
 * 
 * 使用方式:
 * import { pgaToIntensity, extractStationCode } from './utils';
 */

// 震度相關
export {
    getIntensityValue,
    getIntensityColor,
    pgaToIntensity
} from './intensity';

// 測站相關
export {
    isTSMIPStation,
    extractStationCode
} from './station';

// 時間解析
export {
    parseEarthwormTime
} from './time';
