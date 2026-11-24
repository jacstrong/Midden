/**
 * One WebSocket per page, shared by the channels that need it: the open case (ServerStore) and
 * tasks (TaskStore). The hub owns connecting, backoff, the heartbeat and the browser's
 * online/offline events; each channel says hello when the socket opens and handles its own
 * messages. Sharing matters in Firefox, which admits one connecting socket per address and
 * would otherwise queue one channel's reconnect behind the other's.
 */
import type { ClientMessage, ServerMessage } from '@midden/core';
import { notifyUnauthorized } from './api';

export interface SocketChannel {
  /** A connection attempt is starting. */
  onConnecting?(): void;
  /** The socket opened (or was already open when the channel joined): say hello. */
  onOpen(): void;
  onMessage(m: ServerMessage): void;
  /** The socket dropped; the hub reconnects by itself. */
  onClose(): void;
}

const defaultUrl = (): string =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;

export class SocketHub {
  /** Heartbeat: detect a dead socket (NAT timeout, sleep, airplane mode) within a few seconds. */
  static pingIntervalMs = 10_000;
  static pongTimeoutMs = 4_000;
  /** A socket that stays open this long counts as a good connection, and resets the backoff. */
  static stableMs = 5_000;
  private static readonly hubs = new Map<string, SocketHub>();

  /** The page's shared hub for a URL (the app's own `/api/ws` by default). */
  static shared(url: string = defaultUrl()): SocketHub {
    let hub = SocketHub.hubs.get(url);
    if (!hub) {
      hub = new SocketHub(url, () => SocketHub.hubs.delete(url));
      SocketHub.hubs.set(url, hub);
    }
    return hub;
  }

  private ws: WebSocket | null = null;
  private readonly channels = new Set<SocketChannel>();
  private backoff = 500;
  /** When the current socket opened. Backoff only resets once a socket has stayed up a while. */
  private openedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private listening = false;

  constructor(
    readonly url: string,
    private readonly onEmpty: () => void = () => {},
  ) {}

  private readonly onBrowserOffline = (): void => {
    // The OS says the network is gone: drop the socket now instead of waiting for the heartbeat.
    this.ws?.close();
  };
  private readonly onBrowserOnline = (): void => {
    if (this.ws || this.channels.size === 0) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.backoff = 500;
    this.connect();
  };

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  add(ch: SocketChannel): void {
    this.channels.add(ch);
    if (!this.listening) {
      window.addEventListener('offline', this.onBrowserOffline);
      window.addEventListener('online', this.onBrowserOnline);
      this.listening = true;
    }
    if (this.isOpen) ch.onOpen();
    else if (!this.ws && !this.reconnectTimer) this.connect();
    else ch.onConnecting?.();
  }

  /** Remove a channel; the last one out closes the socket. */
  remove(ch: SocketChannel): void {
    if (!this.channels.delete(ch) || this.channels.size > 0) return;
    window.removeEventListener('offline', this.onBrowserOffline);
    window.removeEventListener('online', this.onBrowserOnline);
    this.listening = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.onEmpty();
  }

  send(msg: ClientMessage): void {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (this.channels.size === 0) return;
    for (const ch of this.channels) ch.onConnecting?.();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.openedAt = Date.now();
      this.startHeartbeat();
      for (const ch of [...this.channels]) ch.onOpen();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      if (m.t === 'pong') {
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        return;
      }
      for (const ch of [...this.channels]) ch.onMessage(m);
    };
    ws.onclose = (ev?: CloseEvent) => {
      this.stopHeartbeat();
      if (this.ws === ws) this.ws = null;
      // A server that accepts the socket and then closes it at once (a signed-out session, a bad
      // origin) would otherwise be retried every half second for ever.
      if (this.openedAt && Date.now() - this.openedAt >= SocketHub.stableMs) this.backoff = 500;
      this.openedAt = 0;
      // The session is gone, say after the server's data was reset: show the sign-in page.
      if (ev?.code === 4401) notifyUnauthorized();
      for (const ch of [...this.channels]) ch.onClose();
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.channels.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(10_000, this.backoff * 2);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.isOpen) return;
      this.send({ t: 'ping' });
      this.pongTimer = setTimeout(() => this.ws?.close(), SocketHub.pongTimeoutMs);
    }, SocketHub.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }
}
