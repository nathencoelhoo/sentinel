import type { Bar } from '../engine/types.ts';

// REST backfill so a freshly opened dashboard is "ready" immediately instead of after ~5 h of live bars.
export function binanceKlinesUrl(symbol: string, host: 'com' | 'us' = 'com', limit = 1000): string {
  return `https://api.binance.${host}/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`;
}
/** Coinbase returns at most 300 candles per request; pass a start/end window to page backwards. */
export function coinbaseCandlesUrl(product: string, startMs?: number, endMs?: number): string {
  const q = startMs !== undefined && endMs !== undefined
    ? `&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`
    : '';
  return `https://api.exchange.coinbase.com/products/${product}/candles?granularity=60${q}`;
}

/** Rows: [openTime, open, high, low, close, volume, closeTime, ...]. Drops the still-open bar. */
export function parseBinanceKlines(rows: unknown, nowMs: number, barMs = 60_000): Bar[] {
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[][])
    .map((r) => ({ t: Number(r[0]), close: Number(r[4]), volume: Number(r[5]) }))
    .filter((b) => Number.isFinite(b.t) && b.close > 0 && Number.isFinite(b.volume) && b.t + barMs <= nowMs)
    .sort((a, b) => a.t - b.t);
}

/** Rows (newest first): [timeSec, low, high, open, close, volume]. Drops the still-open bar. */
export function parseCoinbaseCandles(rows: unknown, nowMs: number, barMs = 60_000): Bar[] {
  if (!Array.isArray(rows)) return [];
  return (rows as unknown[][])
    .map((r) => ({ t: Number(r[0]) * 1000, close: Number(r[4]), volume: Number(r[5]) }))
    .filter((b) => Number.isFinite(b.t) && b.close > 0 && Number.isFinite(b.volume) && b.t + barMs <= nowMs)
    .sort((a, b) => a.t - b.t);
}
