import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { extractFirstEntry } from './unzip.ts';
import { DAY_MS, parseDailyKlines } from './study-lib.ts';
import type { DailyRow } from './study-lib.ts';
import { rankRegimeDays, splitShockPicks } from './study2-lib.ts';
import type { Study2Config } from './study2-lib.ts';

// Applies the pre-registered v2 selection rules to Binance Vision DAILY klines.
const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'eval/study2.json' },
    out: { type: 'string', default: 'eval/events.v2.json' },
    'daily-dir': { type: 'string' }, // offline mode: <dir>/<SYMBOL>/*.csv
  },
});
const cfg: Study2Config = JSON.parse(readFileSync(values.config as string, 'utf8'));
const fromMs = Date.parse(cfg.from);
const toMs = Date.parse(cfg.to) + DAY_MS;

async function monthlyText(symbol: string, y: number, m: number): Promise<string | null> {
  const mm = String(m).padStart(2, '0');
  const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1d/${symbol}-1d-${y}-${mm}.zip`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (res.ok) return extractFirstEntry(Buffer.from(await res.arrayBuffer())).toString('utf8');
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`could not download ${url}`);
}

const events: unknown[] = [];
const maskDays: Record<string, string[]> = {};
const counts: Record<string, number> = {};
for (const symbol of cfg.symbols) {
  const rows: DailyRow[] = [];
  let missing = 0;
  if (values['daily-dir']) {
    const dir = join(values['daily-dir'] as string, symbol);
    for (const f of readdirSync(dir).filter((x: string) => x.endsWith('.csv')).sort()) rows.push(...parseDailyKlines(readFileSync(join(dir, f), 'utf8')));
  } else {
    const a = new Date(fromMs);
    const b = new Date(toMs);
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth() + 1; y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth() + 1); m === 12 ? (y++, (m = 1)) : m++) {
      const text = await monthlyText(symbol, y, m);
      if (text === null) missing++;
      else rows.push(...parseDailyKlines(text));
    }
  }
  const inRange = rows.filter((r) => Date.parse(r.date) >= fromMs && Date.parse(r.date) < toMs);
  const { v1, heldOut } = splitShockPicks(inRange, cfg.v1PerSymbol, cfg.heldOutPerSymbol, cfg.minSeparationDays);
  const regime = rankRegimeDays(inRange, cfg, [...v1, ...heldOut].map((d) => d.date), cfg.regimePerSymbol);
  maskDays[symbol] = v1.map((d) => d.date);
  const add = (cls: string, date: string, rangePct: number, ratio?: number) => {
    const start = Date.parse(date);
    events.push({ id: `${symbol}-${date}`, name: `${symbol}-${date}`, symbol, date, cls, start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString(), rangePct: Math.round(rangePct * 100) / 100, ratio: ratio === undefined ? undefined : Math.round(ratio * 100) / 100 });
  };
  for (const d of heldOut) add('heldout', d.date, d.rangePct);
  for (const d of regime) add('regime', d.date, d.rangePct, d.ratio);
  counts[`${symbol} days scanned`] = inRange.length;
  counts[`${symbol} monthly files missing`] = missing;
  console.log(`${symbol}: scanned ${inRange.length} days (${missing} monthly files missing); v1 mask days ${v1.length}, held-out ${heldOut.length}, regime ${regime.length}`);
}
const out = values.out as string;
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ _meta: { maskDays, counts }, events }, null, 2));
console.log(`wrote ${out} (${events.length} analysed events)`);
