import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bar } from '../src/engine/types.ts';

export interface KBar extends Bar {
  open: number;
}

/** Binance spot timestamps are microseconds from 2025-01-01 onwards; normalise to ms. */
export function normalizeTs(t: number): number {
  return t > 1e14 ? Math.floor(t / 1000) : t;
}

/** Binance kline CSV: open_time, open, high, low, close, volume, ... (header rows are skipped). */
export function parseKlineCsv(text: string, from = -Infinity, to = Infinity): KBar[] {
  const out: KBar[] = [];
  for (const line of text.split('\n')) {
    const c = line.split(',');
    if (c.length < 6) continue;
    const t0 = Number(c[0]);
    if (!Number.isFinite(t0)) continue;
    const t = normalizeTs(t0);
    if (t < from || t > to) continue;
    const close = Number(c[4]);
    if (!(close > 0)) continue;
    out.push({ t, open: Number(c[1]), close, volume: Number(c[5]) });
  }
  return out;
}

export function loadKlines(dir: string, from: number, to: number): KBar[] {
  const bars = new Map<number, KBar>();
  for (const f of readdirSync(dir).filter((x: string) => x.endsWith('.csv')).sort()) {
    for (const b of parseKlineCsv(readFileSync(join(dir, f), 'utf8'), from, to)) bars.set(b.t, b);
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}
