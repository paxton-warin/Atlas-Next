/** Cookie continuity on normal Scramjet WebSockets. Socket establishment is
 * already asynchronous; await the same durable profile jar, then call the
 * unchanged selected-node transport. No iframe policy or resource allowlist. */
import type { ScramjetProfileBridge } from './scramjet-profile.ts';
export function installProfileWebSocketTransport(transport: any, bridge: Pick<ScramjetProfileBridge, 'getRequestHeader' | 'topLevelURL'>) {
  const original = transport.connect;
  if (typeof original !== 'function') throw TypeError('Normal WebSocket transport required');
  let live = true;
  const sockets = new Set<() => void>();
  function connect(url: URL, protocols: string[], requestHeaders: [string, string][], onopen: Function, ondata: Function, onclose: Function, onerror: Function) {
    let native: [Function, Function] | undefined, closed = false;
    const queued: unknown[] = [];
    const stop = () => {
      if (closed) return;
      closed = true; queued.length = 0; sockets.delete(stop);
      native?.[1](1000, '');
    };
    sockets.add(stop);
    const request = new URL(url.href); request.protocol = request.protocol === 'wss:' ? 'https:' : 'http:';
    const origin = requestHeaders.find(([key]) => key.toLowerCase() === 'origin')?.[1];
    const documentURL = origin && /^https?:\/\//.test(origin) ? origin + '/' : bridge.topLevelURL();
    void bridge.getRequestHeader({ requestURL: request.href, documentURL,
      topLevelURL: bridge.topLevelURL(), credentials: 'include', method: 'GET' }).then(cookie => {
      if (!live || closed) return;
      const headers = requestHeaders.filter(([name]) => name.toLowerCase() !== 'cookie');
      if (cookie) headers.push(['Cookie', cookie]);
      native = original.call(transport, url, protocols, headers,
        (...args: unknown[]) => { if (!closed) onopen(...args); },
        (...args: unknown[]) => { if (!closed) ondata(...args); },
        (...args: unknown[]) => { if (!closed) { closed = true; sockets.delete(stop); onclose(...args); } },
        (...args: unknown[]) => { if (!closed) onerror(...args); });
      for (const value of queued.splice(0)) native![0](value);
    }).catch(() => {
      if (closed) return;
      closed = true; sockets.delete(stop); onerror(); onclose(1006, '');
    });
    return [
      (value: unknown) => { if (!closed) { if (native) native[0](value); else queued.push(value); } },
      (code?: number, reason?: string) => {
        if (closed) return;
        closed = true; sockets.delete(stop); queued.length = 0;
        if (native) native[1](code, reason);
        else queueMicrotask(() => onclose(code ?? 1000, reason ?? ''));
      },
    ];
  }
  transport.connect = connect;
  return () => {
    if (!live) return;
    live = false;
    if (transport.connect === connect) transport.connect = original;
    for (const close of [...sockets]) close();
  };
}
