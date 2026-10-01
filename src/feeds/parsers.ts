import type { Trade } from './aggregator.ts';

export type FeedEvent =
  | { kind: 'trade'; symbol: string; trade: Trade }
  | { kind: 'obi'; symbol: string; obi: number };

type Level = [string, string] | string[];

/** Order-book imbalance over the top `levels`: (sum bid qty - sum ask qty) / (sum both), in [-1, 1]. */
export function obiFromBook(bids: Level[], asks: Level[], levels = 10): number | null {
  let b = 0;
  let a = 0;
  for (const l of bids.slice(0, levels)) b += Number(l[1]);
  for (const l of asks.slice(0, levels)) a += Number(l[1]);
  const tot = a + b;
  return Number.isFinite(tot) && tot > 0 ? (b - a) / tot : null;
}

/** Canonical symbol keys: `binance:BTCUSDT`, `coinbase:BTC-USD`. */
export function parseBinance(msg: unknown, venue = 'binance'): FeedEvent | null {
  const m = msg as { stream?: string; data?: Record<string, unknown> } | null;
  if (!m || typeof m.stream !== 'string' || !m.data) return null;
  const d = m.data;
  const sym = m.stream.split('@')[0].toUpperCase();
  if (m.stream.includes('@trade')) {
    const price = Number(d.p);
    const qty = Number(d.q);
    const t = Number(d.T);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(t)) return null;
    return { kind: 'trade', symbol: `${venue}:${sym}`, trade: { t, price, qty, id: d.t as number } };
  }
  if (m.stream.includes('@depth') && Array.isArray(d.bids) && Array.isArray(d.asks)) {
    const obi = obiFromBook(d.bids as Level[], d.asks as Level[]);
    return obi === null ? null : { kind: 'obi', symbol: `${venue}:${sym}`, obi };
  }
  return null;
}

/** Coinbase Exchange `matches` channel (`match` and the initial `last_match`). */
export function parseCoinbase(msg: unknown): FeedEvent | null {
  const m = msg as Record<string, unknown> | null;
  if (!m || (m.type !== 'match' && m.type !== 'last_match')) return null;
  const price = Number(m.price);
  const qty = Number(m.size);
  const t = Date.parse(String(m.time));
  if (!Number.isFinite(price) || !Number.isFinite(qty) || !Number.isFinite(t) || typeof m.product_id !== 'string') return null;
  return { kind: 'trade', symbol: `coinbase:${m.product_id}`, trade: { t, price, qty, id: m.trade_id as number } };
}
