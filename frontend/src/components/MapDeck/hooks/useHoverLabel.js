import { useMemo } from 'react';
import { TextLayer } from '@deck.gl/layers';
import { COLORS } from '../constants';

/**
 * 懸停標籤圖層 Hook
 * 當滑鼠懸停在測站上時顯示測站名稱
 */
export function useHoverLabel({ hoverInfo }) {
    return useMemo(() => {
        if (!hoverInfo?.object) {
            return null;
        }

        return new TextLayer({
            id: 'station-labels',
            data: [hoverInfo.object],
            getPosition: d => [d.longitude, d.latitude],
            getText: d => d.station,
            getSize: 14,
            getColor: COLORS.LABEL_TEXT,
            getPixelOffset: [0, 18],
            fontFamily: 'monospace',
            fontWeight: 'bold',
            outlineWidth: 4,
            outlineColor: COLORS.LABEL_OUTLINE
        });
    }, [hoverInfo]);
}
