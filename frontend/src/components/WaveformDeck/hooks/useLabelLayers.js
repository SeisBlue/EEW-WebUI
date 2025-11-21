import { useMemo } from 'react';
import { TextLayer } from '@deck.gl/layers';
import { pgaToIntensity, getIntensityValue } from '../../../utils/intensity';
import { TIME_AXIS_Y_OFFSET, COLORS } from '../constants';
import { calculateStationYPosition } from '../utils';

/**
 * 文字標籤圖層 Hook
 * 繪製測站代碼、中文名稱、PGA 數值和時間軸標籤
 */
export function useLabelLayers({
    stations,
    stationMap,
    waveDataMap,
    xOffset,
    waveWidth,
    panelHeight,
    minLat,
    maxLat,
    renderTrigger,
    timeWindow,
    bottomMargin
}) {
    return useMemo(() => {
        const labels = [];

        stations.forEach((stationCode) => {
            const station = stationMap[stationCode];
            if (!station || !station.latitude) return;

            //計算 Y 位置
            const availableHeight = panelHeight - bottomMargin;
            const centerY = calculateStationYPosition(
                station.latitude,
                minLat,
                maxLat,
                availableHeight
            );

            const waveData = waveDataMap[stationCode];
            const hasPicks = waveData?.picks?.length > 0;
            const intensityValue = getIntensityValue(pgaToIntensity(waveData?.lastPga || 0));

            // 默認樣式
            let textAlpha = 255;
            let stationLabelOffset = -10;
            let pgaLabelOffset = 5;
            let labelColor = waveData ? COLORS.LABEL_DEFAULT : COLORS.LABEL_INACTIVE;
            let labelBackgroundColor = [0, 0, 0, 0];
            let labelPadding = [0, 0, 0, 0];
            let labelBorderRadius = 0;
            let labelFontWeight = 'normal';

            // 1. 確定推出狀態
            if (hasPicks || intensityValue >= 4) {
                stationLabelOffset = -40;
                pgaLabelOffset = 60;
            }

            // 2. 確定文字透明度
            if (intensityValue < 2 && !hasPicks) {
                textAlpha = 50;
            } else if (intensityValue < 3 && !hasPicks) {
                textAlpha = 100;
            } else {
                textAlpha = 255;
            }

            // 3. Pick 測站的特殊樣式
            if (hasPicks) {
                labelColor = COLORS.PICK_LABEL;
                labelBackgroundColor = COLORS.PICK_BG;
                labelPadding = [2, 5, 2, 5];
                labelBorderRadius = 4;
                labelFontWeight = 'bold';
            }

            // 4. 應用最終透明度
            labelColor = [...labelColor];
            labelColor[3] = textAlpha;

            // 測站代碼標籤
            labels.push({
                position: [xOffset + stationLabelOffset, centerY],
                text: stationCode,
                color: labelColor,
                backgroundColor: labelBackgroundColor,
                padding: labelPadding,
                borderRadius: labelBorderRadius,
                fontWeight: labelFontWeight,
                size: 10,
                anchor: 'end',
                alignmentBaseline: 'center',
            });

            // 測站中文名稱
            if (station.station_zh) {
                labels.push({
                    position: [xOffset + waveWidth + pgaLabelOffset, centerY - 8],
                    text: station.station_zh,
                    color: [224, 224, 224, textAlpha],
                    size: 9,
                    anchor: 'start',
                    alignmentBaseline: 'center'
                });
            }

            // PGA 數值
            if (waveData?.lastPga) {
                labels.push({
                    position: [xOffset + waveWidth + pgaLabelOffset, centerY + 2],
                    text: `PGA: ${waveData.lastPga.toFixed(2)}`,
                    color: [...COLORS.LABEL_PGA, textAlpha],
                    size: 9,
                    anchor: 'start',
                    alignmentBaseline: 'center'
                });
            }
        });

        // 時間軸標籤 - 顯示實際時間和相對時間差
        const timeAxisY = panelHeight - TIME_AXIS_Y_OFFSET;
        const numTicks = 7;
        const now = new Date(renderTrigger);

        for (let i = 0; i < numTicks; i++) {
            const timeValue = -i * (timeWindow / (numTicks - 1));
            const x = xOffset + waveWidth - (i / (numTicks - 1)) * waveWidth;

            let label;
            let color;
            if (timeValue === 0) {
                // 最右側：顯示當前實際時間
                label = now.toLocaleTimeString('zh-TW', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });
                color = COLORS.TIME_CURRENT;
            } else {
                // 其他位置：顯示相對時間差
                label = `${timeValue.toFixed(0)}s`;
                color = COLORS.TIME_RELATIVE;
            }

            labels.push({
                position: [x, timeAxisY + 8],
                text: label,
                color: color,
                size: 12,
                anchor: 'middle',
                alignmentBaseline: 'center'
            });
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
            getBackgroundColor: d => d.backgroundColor,
            getBorderRadius: d => d.borderRadius,
            getPadding: d => d.padding,
            getFontWeight: d => d.fontWeight,
            fontFamily: 'monospace',
            updateTriggers: {
                getColor: waveDataMap,
                getBackgroundColor: waveDataMap,
                getPosition: waveDataMap,
                getText: [waveDataMap, renderTrigger]
            }
        })];
    }, [stations, stationMap, waveDataMap, xOffset, waveWidth, panelHeight, minLat, maxLat, renderTrigger, timeWindow, bottomMargin]);
}
