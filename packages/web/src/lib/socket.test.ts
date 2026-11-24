import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from './api';
import { SocketHub, type SocketChannel } from './socket';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const channel = (): SocketChannel => ({ onOpen() {}, onMessage() {}, onClose() {} });

describe('SocketHub', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setUnauthorizedHandler(() => {});
  });

  it('backs off when the server keeps closing the socket as soon as it opens', () => {
    const hub = new SocketHub('ws://test/api/ws');
    const ch = channel();
    hub.add(ch);
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ws = FakeSocket.instances.at(-1)!;
      ws.open();
      ws.close(4403);
      const before = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([500, 1000, 2000, 4000, 8000]);
    hub.remove(ch);
  });

  it('resets the backoff after a connection that stayed up', () => {
    const hub = new SocketHub('ws://test/api/ws');
    const ch = channel();
    hub.add(ch);
    FakeSocket.instances[0]!.open();
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(500);
    FakeSocket.instances[1]!.open();
    FakeSocket.instances[1]!.close();
    vi.advanceTimersByTime(1000);
    const ws = FakeSocket.instances[2]!;
    ws.open();
    vi.advanceTimersByTime(SocketHub.stableMs);
    ws.close();
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances).toHaveLength(4);
    hub.remove(ch);
  });

  it('signs the page out when the server says the session is gone', () => {
    const signedOut = vi.fn();
    setUnauthorizedHandler(signedOut);
    const hub = new SocketHub('ws://test/api/ws');
    const ch = channel();
    hub.add(ch);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.close(4401);
    expect(signedOut).toHaveBeenCalledOnce();
    hub.remove(ch);
  });
});
