import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Bar } from '../src/engine/types.ts';
import { ablationMethods, evaluate, standardMethods, summarize, toMarkdown } from './harness.ts';
import type { EventWindow, MethodResult } from './harness.ts';

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: 'data' },
    events: { type: 'string', default: 'eval/events.example.json' },
    'alarms-per-day': { type: 'string', default: '6' },
    'warmup-days': { type: 'string', default: '3' },
    'tail-hours': { type: 'string', default: '12' },
    out: { type: 'string', default: 'results' },
    ablate: { type: 'boolean', default: false },
  },
});

const barSeconds = 60;
const alarmsPerDay = Number(values['alarms-per-day']);
const warmupMs = Number(values['warmup-days']) * 86_400_000;
const tailMs = Number(values['tail-hours']) * 3_600_000;

interface RawEvent {
  name: string;
  symbol: string;
  start: string;
  end: string;
  onset?: string;
}
const rawEvents: RawEvent[] = JSON.parse(readFileSync(values.events as string, 'utf8')).events;
const events: EventWindow[] = rawEvents.map((e) => ({
  name: e.name,
  symbol: e.symbol,
  start: Date.parse(e.start),
  end: Date.parse(e.end),
  onset: e.onset ? Date.parse(e.onset) : undefined,
}));

/** Binance kline CSV: open_time, open, high, low, close, volume, ... (µs timestamps since 2025 are normalised). */
function loadKlines(dir: string, from: number, to: number): Bar[] {
  const bars = new Map<number, Bar>();
  for (const f of readdirSync(dir).filter((x: string) => x.endsWith('.csv')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      const c = line.split(',');
      if (c.length < 6) continue;
      let t = Number(c[0]);
      if (!Number.isFinite(t)) continue;
      if (t > 1e14) t = Math.floor(t / 1000);
      if (t < from || t > to) continue;
      bars.set(t, { t, close: Number(c[4]), volume: Number(c[5]) });
    }
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}

const all: MethodResult[] = [];
const bySymbol = Map.groupBy(events, (e) => e.symbol);
for (const [symbol, evs] of bySymbol) {
  const dir = join(values.data as string, symbol);
  if (!existsSync(dir)) {
    console.warn(`skip ${symbol}: no data in ${dir} (run: npm run eval:fetch)`);
    continue;
  }
  const from = Math.min(...evs.map((e) => e.start)) - warmupMs;
  const to = Math.max(...evs.map((e) => e.end)) + tailMs;
  const bars = loadKlines(dir, from, to);
  console.log(`${symbol}: ${bars.length} bars, ${evs.length} event window(s)`);
  if (bars.length < 1000) continue;
  const specs = [...standardMethods(barSeconds, alarmsPerDay), ...(values.ablate ? ablationMethods(barSeconds, alarmsPerDay) : [])];
  all.push(...evaluate(symbol, bars, evs, specs, { barSeconds }));
}
const summary = summarize(all);
console.table(summary);
mkdirSync(values.out as string, { recursive: true });
writeFileSync(join(values.out as string, 'summary.json'), JSON.stringify({ alarmsPerDay, summary, detail: all }, null, 2));
writeFileSync(join(values.out as string, 'summary.md'), toMarkdown(alarmsPerDay, summary, all));
console.log(`wrote ${join(values.out as string, 'summary.json')} and summary.md`);
