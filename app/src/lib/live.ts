import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type Config, call } from './api.ts';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Keeps one WebSocket per open project. The server only says "something changed"; we refetch
 * this project's queries (debounced), so the socket carries no data and needs no schema.
 */
export function useLive(cfg: Config, slug: string | undefined): LiveState {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');

  useEffect(() => {
    if (!slug || !cfg.server) return;
    let ws: WebSocket | undefined;
    let closed = false;
    let retry = 0;
    let ping: ReturnType<typeof setInterval> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => qc.invalidateQueries({ queryKey: ['p', slug] }), 200);
    };

    const open = async () => {
      setState('connecting');
      try {
        const { ticket } = await call<{ ticket: string }>(cfg, 'POST', `/api/projects/${slug}/ticket`);
        if (closed) return;
        const url = new URL(`/api/projects/${slug}/live`, cfg.server);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket);
        ws = new WebSocket(url);
        ws.onopen = () => {
          retry = 0;
          setState('live');
          refresh(); // catch up on anything missed while offline
          ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
        };
        ws.onmessage = (e) => {
          if (e.data !== 'pong') refresh();
        };
        ws.onclose = () => {
          clearInterval(ping);
          if (closed) return;
          setState('offline');
          reconnect = setTimeout(open, Math.min(15_000, 1000 * 2 ** retry++));
        };
      } catch {
        if (closed) return;
        setState('offline');
        reconnect = setTimeout(open, Math.min(15_000, 1000 * 2 ** retry++));
      }
    };
    open();
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(debounce);
      clearTimeout(reconnect);
      ws?.close();
    };
  }, [cfg, slug, qc]);

  return state;
}
