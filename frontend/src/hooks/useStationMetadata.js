import { useState, useEffect } from 'react';
import Papa from 'papaparse';

/**
 * Custom hook for loading station metadata from CSV files
 * @returns {Object} { allTargetStations, stationMap }
 */
export function useStationMetadata() {
    const [allTargetStations, setAllTargetStations] = useState([]);
    const [stationMap, setStationMap] = useState({});

    // Load eew_target.csv
    useEffect(() => {
        Papa.parse('/eew_target.csv', {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const stations = results.data.map(s => ({
                    network: s.network,
                    county: s.county,
                    station: s.station,
                    station_zh: s.station_zh,
                    longitude: parseFloat(s.longitude),
                    latitude: parseFloat(s.latitude),
                    elevation: parseFloat(s.elevation),
                    status: 'unknown',
                    lastSeen: null,
                    pga: null,
                }));
                setAllTargetStations(stations);
                console.log('📍 [useStationMetadata] Loaded', stations.length, 'target stations from eew_target.csv');
            },
            error: (err) => console.error('❌ [useStationMetadata] Failed to load eew_target.csv:', err)
        });
    }, []);

    // Load site_info.csv
    useEffect(() => {
        Papa.parse('/site_info.csv', {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const newStationMap = {};
                results.data.forEach(s => {
                    if (s.Station) {
                        newStationMap[s.Station] = {
                            station: s.Station,
                            latitude: parseFloat(s.Latitude),
                            longitude: parseFloat(s.Longitude),
                        };
                    }
                });
                setStationMap(newStationMap);
                console.log('📍 [useStationMetadata] stationMap updated:', Object.keys(newStationMap).length, 'stations from site_info.csv');
            },
            error: (err) => console.error('❌ [useStationMetadata] Failed to load site_info.csv:', err)
        });
    }, []);

    return {
        allTargetStations,
        stationMap
    };
}
