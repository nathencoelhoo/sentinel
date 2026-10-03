import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { extractFirstEntry } from './unzip.ts';
import { DAY_MS, parseDailyKlines, selectEvents } from './study-lib.ts';
import type { DailyRow, StudyConfig } from './study-lib.ts';

// Applies the pre-registered event rule to Binance Vision DAILY klines (tiny monthly files).
const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'eval/study.json' },
    out: { type: 'string', default: 'eval/events.study.json' },
    'daily-dir': { type: 'string' }, // offline mode: <dir>/<SYMBOL>/*.csv
  },
});
const cfg: StudyConfig = JSON.parse(readFileSync(values.config as string, 'utf8'));
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
const meta: Record<string, { daysScanned: number; monthsMissing: number }> = {};
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
  meta[symbol] = { daysScanned: inRange.length, monthsMissing: missing };
  for (const d of selectEvents(inRange, cfg.topPerSymbol, cfg.minSeparationDays)) {
    const start = Date.parse(d.date);
    events.push({
      id: `${symbol}-${d.date}`,
      name: `${symbol}-${d.date}`,
      symbol,
      date: d.date,
      start: new Date(start).toISOString(),
      end: new Date(start + DAY_MS).toISOString(),
      rangePct: Math.round(d.rangePct * 100) / 100,
    });
  }
  console.log(`${symbol}: scanned ${inRange.length} days, ${missing} monthly file(s) missing, selected ${events.filter((e) => (e as { symbol: string }).symbol === symbol).length}`);
}
const out = values.out as string;
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ _meta: { rule: 'top daily (high-low)/open, min separation', ...meta }, events }, null, 2));
console.log(`wrote ${out} (${events.length} events)`);
