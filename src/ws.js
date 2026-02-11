/**
 * WebSocket client for external state control.
 * Connects to a configurable WebSocket server and translates messages into state changes.
 * Stub for now — will be wired up later.
 */

export class WebSocketClient {
  constructor(url = 'ws://localhost:9876', onMessage = () => {}) {
    this.url = url;
    this.onMessage = onMessage;
    this.ws = null;
    this.connected = false;
    this._reconnectTimer = null;
    this._reconnectDelay = 5000;
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.connected = true;
        console.log(`[WS] Connected to ${this.url}`);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.onMessage(data);
        } catch (e) {
          console.warn('[WS] Invalid message:', event.data);
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        console.log('[WS] Disconnected, reconnecting...');
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        // Silently handle — onclose will fire next
      };
    } catch (e) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this._reconnectDelay);
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
