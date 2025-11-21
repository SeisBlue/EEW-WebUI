import { useMemo } from 'react';

const EEW_TARGETS = [
  'NOU', 'TIPB', 'ILA', 'TWC', 'ENT',
  'HWA', 'EGFH', 'EYUL', 'TTN', 'ECS', 'TAWH', 'HEN',
  'TAP', 'A024', 'NTS', 'NTY', 'NCU', 'B011',
  'HSN1', 'HSN', 'NJD', 'B131', 'TWQ1', 'B045',
  'TCU', 'WDJ', 'WHP', 'WNT1', 'WPL', 'WHY',
  'WCHH', 'WYL', 'WDL', 'WSL', 'CHY1', 'C095', 'WCKO',
  'TAI', 'C015', 'CHN1', 'KAU', 'SCS', 'SPT', 'SSD',
  'PNG', 'KNM', 'MSU'
];

/**
 * Custom hook for calculating station display lists
 * @param {Object} options - Configuration options
 * @param {string} options.selectionMode - Current selection mode ('target', 'active', 'all_site', 'custom')
 * @param {Array} options.customStations - Custom station list
 * @param {Object} options.waveDataMap - Wave data map
 * @param {Object} options.stationMap - Station metadata map
 * @param {Array} options.allTargetStations - All target stations
 * @returns {Object} { displayStations, mapDisplayStations, stationsToSubscribe }
 */
export function useStationDisplay({
  selectionMode,
  customStations,
  waveDataMap,
  stationMap,
  allTargetStations
}) {
  // Calculate the list of stations to display in the waveform panel
  const displayStations = useMemo(() => {
    // Helper function to sort stations, prioritizing those with picks
    const sortWithPicks = (stationList) => {
      return [...stationList].sort((a, b) => {
        const aHasPick = waveDataMap[a]?.picks?.length > 0;
        const bHasPick = waveDataMap[b]?.picks?.length > 0;

        if (aHasPick && !bHasPick) return -1; // a comes first
        if (!aHasPick && bHasPick) return 1;  // b comes first

        // If both or neither have picks, sort by latitude
        return (stationMap[b]?.latitude ?? 0) - (stationMap[a]?.latitude ?? 0);
      });
    };

    switch (selectionMode) {
      case 'active':
        const received = Object.keys(waveDataMap);
        return sortWithPicks(received);
      case 'all_site':
        return sortWithPicks(Object.keys(stationMap));
      case 'custom':
        return customStations; // Custom order is preserved
      case 'target':
      default:
        return sortWithPicks(EEW_TARGETS);
    }
  }, [selectionMode, waveDataMap, customStations, stationMap]);

  // Calculate the list of stations to display on the map
  const mapDisplayStations = useMemo(() => {
    const targetStationsMap = new Map(allTargetStations.map(s => [s.station, s]));
    const stationsToShow = new Set(displayStations);

    // Add stations with active picks to the map, even if not in displayStations
    Object.keys(waveDataMap).forEach(stationCode => {
      if (waveDataMap[stationCode]?.picks?.length > 0) {
        stationsToShow.add(stationCode);
      }
    });

    return Array.from(stationsToShow)
      .map(stationCode => {
        if (targetStationsMap.has(stationCode)) {
          return targetStationsMap.get(stationCode);
        }
        if (stationMap[stationCode]) {
          return {
            station: stationCode,
            longitude: stationMap[stationCode].longitude,
            latitude: stationMap[stationCode].latitude,
            network: '',
            county: '',
            station_zh: stationCode,
            elevation: 0,
            status: 'unknown',
            lastSeen: null,
            pga: null,
          };
        }
        return null;
      })
      .filter(Boolean);
  }, [displayStations, allTargetStations, stationMap, waveDataMap]);

  // Calculate stations to subscribe - memoized to prevent unnecessary re-subscriptions
  const stationsToSubscribe = useMemo(() => {
    switch (selectionMode) {
      case 'active':
        return ['__ALL_Z__'];
      case 'custom':
        return customStations;
      case 'all_site':
        return Object.keys(stationMap);
      case 'target':
      default:
        return EEW_TARGETS;
    }
  }, [selectionMode, customStations, stationMap]);

  return {
    displayStations,
    mapDisplayStations,
    stationsToSubscribe
  };
}
