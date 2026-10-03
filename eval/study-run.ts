import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ablationMethods, standardMethods } from './harness.ts';
import { loadKlines } from './klines.ts';
import { findOnset, runOnSlice, scoreEvent, summarizeStudy, toStudyMarkdown } from './study-lib.ts';
import type { ChanceWindow, EventRun, MethodRuns, StudyConfig } from './study-lib.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'eval/study.json' },
    events: { type: 'string', default: 'eval/events.study.json' },
    data: { type: 'string', default: 'data' },
    out: { type: 'string', default: 'results/study' },
    ablate: { type: 'boolean', default: false },
  },
});
const MIN = 60_000;
const cfgText = readFileSync(values.config as string, 'utf8');
const cfg: StudyConfig = JSON.parse(cfgText);
const raw: { id: string; symbol: string; date: string; start: string; end: string; rangePct?: number }[] = JSON.parse(readFileSync(values.events as string, 'utf8')).events;
const events = raw.map((e) => ({ ...e, startMs: Date.parse(e.start), endMs: Date.parse(e.end) }));

const specs = [...standardMethods(60, cfg.alarmsPerDay), ...(values.ablate ? ablationMethods(60, cfg.alarmsPerDay) : [])];
const perMethod: MethodRuns[] = specs.map((s) => ({ method: s.name, runs: [] }));
const windows: ChanceWindow[] = [];
const used: { id: string; onset: number; rangePct: number }[] = [];
const excluded: { id: string; reason: string }[] = [];
const barCache = new Map<string, ReturnType<typeof loadKlines>>();

for (const e of events) {
  const dir = join(values.data as string, e.symbol);
  if (!existsSync(dir)) {
    excluded.push({ id: e.id, reason: 'no data directory' });
    continue;
  }
  const from = e.startMs - cfg.warmupDays * 86_400_000;
  const to = e.endMs + cfg.tailHours * 3_600_000;
  const key = e.symbol;
  if (!barCache.has(key)) barCache.set(key, loadKlines(dir, -Infinity, Infinity));
  const bars = barCache.get(key)!.filter((b) => b.t >= from && b.t <= to);
  const expected = (to - from) / MIN;
  if (bars.length < 0.95 * expected) {
    excluded.push({ id: e.id, reason: `insufficient data (${bars.length}/${Math.round(expected)} bars)` });
    continue;
  }
  const onset = findOnset(bars, e.startMs, e.endMs, cfg.onsetMovePct);
  if (onset === null) {
    excluded.push({ id: e.id, reason: `no ${cfg.onsetMovePct}% move from the day's open` });
    continue;
  }
  const masks = events
    .filter((o) => o.symbol === e.symbol)
    .map((o) => ({ from: o.startMs - cfg.guardMinutes * MIN, to: o.endMs + cfg.postGuardMinutes * MIN }));
  specs.forEach((s, i) => {
    const run = runOnSlice(() => s.make(e.symbol), bars, masks);
    perMethod[i].runs.push(scoreEvent(e.id, e.symbol, e.date, onset, run, cfg));
  });
  windows.push({
    wStart: Math.round((onset - cfg.detectLeadMin * MIN - bars[0].t) / MIN),
    wEnd: Math.round((onset + cfg.detectLagMin * MIN - bars[0].t) / MIN),
  });
  used.push({ id: e.id, onset, rangePct: e.rangePct ?? NaN });
  console.log(`done ${e.id} (onset ${new Date(onset).toISOString().slice(0, 16)})`);
}
if (used.length < 3) {
  console.error(`only ${used.length} usable events; refusing to summarise`);
  process.exit(1);
}
const rows = summarizeStudy(perMethod, windows, cfg);
const meta = { sha: process.env.GITHUB_SHA ?? 'local', configHash: createHash('sha256').update(cfgText).digest('hex') };
mkdirSync(values.out as string, { recursive: true });
writeFileSync(join(values.out as string, 'summary.json'), JSON.stringify({ meta, config: cfg, rows, used, excluded, perEvent: perMethod as { method: string; runs: EventRun[] }[] }, null, 2));
writeFileSync(join(values.out as string, 'summary.md'), toStudyMarkdown(cfg, rows, used, excluded, meta));
console.log(readFileSync(join(values.out as string, 'summary.md'), 'utf8'));
