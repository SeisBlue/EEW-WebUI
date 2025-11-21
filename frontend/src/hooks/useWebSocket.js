import { useState, useEffect, useRef } from 'react';

/**
 * Custom hook for WebSocket connection management with auto-reconnect
 * @param {Object} options - Configuration options
 * @param {Function} options.onWavePacket - Callback when wave packet is received
 * @param {Function} options.onPickPacket - Callback when pick packet is received
 * @param {Function} options.onHistoricalData - Callback when historical data is received
 * @returns {Object} { isConnected, socket }
 */
export function useWebSocket({ onWavePacket, onPickPacket, onHistoricalData }) {
  const [isConnected, setIsConnected] = useState(false);
  const [socket, setSocket] = useState(null);
  const reconnectTimer = useRef(null);
  const wavePacketBuffer = useRef([]);
  const pickPacketBuffer = useRef([]);

  // Use refs to store callbacks to avoid dependency issues
  const onWavePacketRef = useRef(onWavePacket);
  const onPickPacketRef = useRef(onPickPacket);
  const onHistoricalDataRef = useRef(onHistoricalData);

  // Update refs when callbacks change
  useEffect(() => {
    onWavePacketRef.current = onWavePacket;
    onPickPacketRef.current = onPickPacket;
    onHistoricalDataRef.current = onHistoricalData;
  }, [onWavePacket, onPickPacket, onHistoricalData]);

  useEffect(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;
    let wsInstance = null;

    const connect = () => {
      console.log('🔌 [useWebSocket] Attempting to connect to WebSocket...');
      wsInstance = new WebSocket(wsUrl);

      wsInstance.onopen = () => {
        console.log('✅ [useWebSocket] WebSocket Connected');
        setIsConnected(true);
        setSocket(wsInstance);
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
      };

      wsInstance.onclose = () => {
        console.log('❌ [useWebSocket] WebSocket Disconnected');
        setIsConnected(false);
        setSocket(null);
        // Automatically attempt to reconnect
        if (!reconnectTimer.current) {
          console.log('🔄 [useWebSocket] Reconnecting in 3 seconds...');
          reconnectTimer.current = setTimeout(connect, 3000);
        }
      };

      wsInstance.onerror = (error) => {
        console.error('❌ [useWebSocket] WebSocket Error:', error);
        // The onclose event will fire after an error, triggering the reconnect logic.
      };

      wsInstance.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.event === 'connect_init') {
          console.log('✅ [useWebSocket] Connection initialized');
        } else if (message.event === 'wave_packet') {
          wavePacketBuffer.current.push(message.data);
        } else if (message.event === 'pick_packet') {
          console.log('[useWebSocket] Received pick_packet:', message.data);
          pickPacketBuffer.current.push(message.data);
        } else if (message.event === 'historical_data') {
          console.log('[useWebSocket] Received historical_data:', message.data);
          onHistoricalDataRef.current?.(message.data);
        } else if (message.event === 'historical_picks_batch') {
          console.log(`[useWebSocket] Received ${message.data.count} historical picks in batch`);
          // 將所有 picks 加入 buffer，跟即時 picks 一起處理
          pickPacketBuffer.current.push(...message.data.picks);
        }
      };
    };

    connect(); // Initial connection attempt

    // Flush buffers periodically
    const flushInterval = setInterval(() => {
      if (wavePacketBuffer.current.length > 0) {
        onWavePacketRef.current?.(wavePacketBuffer.current);
        wavePacketBuffer.current = [];
      }
      if (pickPacketBuffer.current.length > 0) {
        onPickPacketRef.current?.(pickPacketBuffer.current);
        pickPacketBuffer.current = [];
      }
    }, 100); // Flush every 100ms

    return () => {
      // Cleanup on component unmount
      clearInterval(flushInterval);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
      if (wsInstance) {
        wsInstance.onclose = null; // Prevent reconnect logic from firing on unmount
        wsInstance.close();
      }
    };
  }, []); // Empty dependency array - only run once on mount

  return {
    isConnected,
    socket
  };
}
