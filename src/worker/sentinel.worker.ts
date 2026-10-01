/// Runs entirely off the UI thread: REST backfill, WebSocket feeds, aggregation, engines.
import { SentinelHost } from './host.ts';
import { ReconnectingSocket } from '../feeds/reconnectingSocket.ts';
import { parseBinance, parseCoinbase } from '../feeds/parsers.ts';
import type { FeedEvent } from '../feeds/parsers.ts';
import { binanceKlinesUrl, coinbaseCandlesUrl, parseBinanceKlines, parseCoinbaseCandles } from '../feeds/history.ts';
import type { Bar } from '../engine/types.ts';
import type { UiMessage, WorkerCommand, WorkerConfig } from './protocol.ts';

const ctx = self as unknown as {
  postMessage(m: UiMessage): void;
  onmessage: ((e: { data: WorkerCommand }) => void) | null;
};
let teardown: (() => void) | null = null;

ctx.onmessage = (e) => {
  teardown?.();
  teardown = null;
  if (e.data.type === 'start') teardown = start(e.data.config);
};

async function getJson(url: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function history(symbol: string, cfg: WorkerConfig): Promise<Bar[]> {
  const now = Date.now();
  if (symbol.startsWith('binance:')) {
    return parseBinanceKlines(await getJson(binanceKlinesUrl(symbol.slice(8), cfg.binanceHost)), now);
  }
  const product = symbol.slice('coinbase:'.length);
  const page = 300 * 60_000;
  const pages = await Promise.all([
    getJson(coinbaseCandlesUrl(product)),
    getJson(coinbaseCandlesUrl(product, now - 2 * page, now - page)),
  ]);
  const byT = new Map<number, Bar>();
  for (const p of pages) for (const b of parseCoinbaseCandles(p, now)) byT.set(b.t, b);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

function start(cfg: WorkerConfig): () => void {
  const post = (m: UiMessage) => ctx.postMessage(m);
  const host = new SentinelHost(cfg, post);
  const handle = (ev: FeedEvent | null) => {
    if (!ev) return;
    if (ev.kind === 'trade') host.onTrade(ev.symbol, ev.trade);
    else host.onObi(ev.symbol, ev.obi);
  };
  const sockets: ReconnectingSocket[] = [];
  let pumpTimer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;

  const binance = cfg.symbols.filter((s) => s.startsWith('binance:')).map((s) => s.slice('binance:'.length));
  const coinbase = cfg.symbols.filter((s) => s.startsWith('coinbase:')).map((s) => s.slice('coinbase:'.length));

  void (async () => {
    // Backfill needs 1-minute bars to match the REST history granularity.
    if (cfg.backfill && cfg.barSeconds === 60) {
      await Promise.all(
        cfg.symbols.map(async (s) => {
          try {
            host.backfill(s, await history(s, cfg));
          } catch (err) {
            post({ type: 'error', message: `backfill ${s}: ${(err as Error).message}` });
          }
        }),
      );
    }
    if (cancelled) return;

    if (binance.length) {
      const base = cfg.binanceHost === 'us' ? 'wss://stream.binance.us:9443' : 'wss://stream.binance.com:9443';
      const streams = binance.flatMap((s) => [`${s.toLowerCase()}@trade`, `${s.toLowerCase()}@depth10@100ms`]).join('/');
      sockets.push(
        new ReconnectingSocket({
          url: `${base}/stream?streams=${streams}`,
          onMessage: (d) => {
            try {
              handle(parseBinance(JSON.parse(d)));
            } catch {
              /* ignore malformed frame */
            }
          },
          onStatus: (state, attempt) => post({ type: 'status', venue: 'binance', state, attempt }),
        }),
      );
    }
    if (coinbase.length) {
      sockets.push(
        new ReconnectingSocket({
          url: 'wss://ws-feed.exchange.coinbase.com',
          onOpen: (send) => send(JSON.stringify({ type: 'subscribe', product_ids: coinbase, channels: ['matches'] })),
          onMessage: (d) => {
            try {
              handle(parseCoinbase(JSON.parse(d)));
            } catch {
              /* ignore malformed frame */
            }
          },
          onStatus: (state, attempt) => post({ type: 'status', venue: 'coinbase', state, attempt }),
        }),
      );
    }
    sockets.forEach((s) => s.start());
    pumpTimer = setInterval(() => host.pump(), 100);
  })();

  return () => {
    cancelled = true;
    sockets.forEach((s) => s.stop());
    if (pumpTimer) clearInterval(pumpTimer);
  };
}
