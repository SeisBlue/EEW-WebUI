import { useMemo } from 'react';
import { PathLayer } from '@deck.gl/layers';
import { TIME_AXIS_Y_OFFSET, COLORS } from '../constants';

/**
 * 時間軸圖層 Hook
 * 繪製時間軸線和刻度
 */
export function useTimeAxisLayer({ xOffset, waveWidth, panelHeight }) {
    return useMemo(() => {
        const timeAxisY = panelHeight - TIME_AXIS_Y_OFFSET;

        const lines = [{
            path: [[xOffset, timeAxisY], [xOffset + waveWidth, timeAxisY]],
            color: COLORS.TIME_AXIS
        }];

        const numTicks = 7;
        for (let i = 0; i < numTicks; i++) {
            const x = xOffset + waveWidth - (i / (numTicks - 1)) * waveWidth;
            lines.push({
                path: [[x, timeAxisY - 5], [x, timeAxisY + 5]],
                color: COLORS.TIME_AXIS
            });
        }

        return new PathLayer({
            id: 'time-axis',
            data: lines,
            getPath: d => d.path,
            getColor: d => d.color,
            widthMinPixels: 1.5
        });
    }, [xOffset, waveWidth, panelHeight]);
}
