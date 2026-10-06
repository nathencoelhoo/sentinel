import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadKlines } from './klines.ts';
import type { KBar } from './klines.ts';
import { DAY_MS } from './study-lib.ts';
import type { ChanceWindow, Mask } from './study-lib.ts';
import { onsetV2, outcomesForSlice, quietFlags, scoreSlice, scorerSpecs, summarizeSubset, toStudy2Markdown } from './study2-lib.ts';
import type { MethodOutcomes, Study2Config, SubsetSummary } from './study2-lib.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'eval/study2.json' },
    events: { type: 'string', default: 'eval/events.v2.json' },
    data: { type: 'string', default: 'data' },
    out: { type: 'string', default: 'results/study2' },
    solo: { type: 'boolean', default: false },
  },
});
const MIN = 60_000;
const cfgText = readFileSync(values.config as string, 'utf8');
const cfg: Study2Config = JSON.parse(cfgText);
const file = JSON.parse(readFileSync(values.events as string, 'utf8')) as {
  _meta: { maskDays: Record<string, string[]> };
  events: { id: string; symbol: string; date: string; cls: 'heldout' | 'regime'; start: string; end: string; rangePct: number }[];
};
const events = file.events.map((e) => ({ ...e, startMs: Date.parse(e.start), endMs: Date.parse(e.end) }));

const specs = scorerSpecs({ solo: values.solo });
const all: MethodOutcomes[] = specs.map((s) => ({ method: s.name, byBudget: cfg.budgets.map(() => []) }));
const windows: ChanceWindow[] = [];
const used: { id: string; symbol: string; date: string; cls: string; onset: number; inProgress: boolean; theta: number; rangePct: number }[] = [];
const excluded: { id: string; reason: string }[] = [];
const barCache = new Map<string, KBar[]>();
const t0 = Date.now();

for (const e of events) {
  const dir = join(values.data as string, e.symbol);
  if (!existsSync(dir)) {
    excluded.push({ id: e.id, reason: 'no data directory' });
    continue;
  }
  if (!barCache.has(e.symbol)) barCache.set(e.symbol, loadKlines(dir, -Infinity, Infinity));
  const from = e.startMs - cfg.warmupDays * DAY_MS;
  const to = e.endMs + cfg.tailHours * 3_600_000;
  const bars = barCache.get(e.symbol)!.filter((b) => b.t >= from && b.t <= to);
  const expected = (to - from) / MIN;
  if (bars.length < 0.95 * expected) {
    excluded.push({ id: e.id, reason: `insufficient data (${bars.length}/${Math.round(expected)} bars)` });
    continue;
  }
  const closeByT = new Map<number, number>(bars.map((b) => [b.t, b.close]));
  const info = onsetV2(closeByT, e.startMs, e.endMs, cfg);
  if (info.onset === null) {
    excluded.push({ id: e.id, reason: info.reason ?? 'no onset' });
    continue;
  }
  const masks: Mask[] = [
    ...events.filter((o) => o.symbol === e.symbol).map((o) => ({ from: o.startMs - cfg.guardMinutes * MIN, to: o.endMs + cfg.postGuardMinutes * MIN })),
    ...(file._meta.maskDays[e.symbol] ?? []).map((d) => ({ from: Date.parse(d) - cfg.guardMinutes * MIN, to: Date.parse(d) + DAY_MS + cfg.postGuardMinutes * MIN })),
  ];
  const quiet = quietFlags(bars, masks);
  specs.forEach((s, mi) => {
    const series = scoreSlice(s.make(e.symbol), bars);
    outcomesForSlice(series, quiet, info.onset as number, cfg).forEach((o, b) => all[mi].byBudget[b].push(o));
  });
  windows.push({
    wStart: Math.round((info.onset - cfg.detectLeadMin * MIN - bars[0].t) / MIN),
    wEnd: Math.round((info.onset + cfg.detectLagMin * MIN - bars[0].t) / MIN),
  });
  used.push({ id: e.id, symbol: e.symbol, date: e.date, cls: e.cls, onset: info.onset, inProgress: info.inProgress, theta: info.theta, rangePct: e.rangePct });
  console.log(`done ${e.id} [${e.cls}] onset ${new Date(info.onset).toISOString().slice(0, 16)}${info.inProgress ? ' (in progress at open)' : ''}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

const idxOf = (pred: (u: (typeof used)[number]) => boolean) => used.map((u, i) => (pred(u) ? i : -1)).filter((i) => i >= 0);
const subsetDefs: [string, number[]][] = [
  ['heldout_fresh', idxOf((u) => u.cls === 'heldout' && !u.inProgress)],
  ['regime_fresh', idxOf((u) => u.cls === 'regime' && !u.inProgress)],
  ['heldout_all', idxOf((u) => u.cls === 'heldout')],
  ['regime_all', idxOf((u) => u.cls === 'regime')],
];
const clusterIds = used.map((u) => u.date);
const subsets: SubsetSummary[] = [];
for (const [name, idx] of subsetDefs) {
  if (idx.length < 5) {
    console.warn(`subset ${name}: only ${idx.length} events, skipped`);
    continue;
  }
  subsets.push(summarizeSubset(name, idx, clusterIds, windows, all, cfg));
}
if (subsets.length === 0) {
  console.error('no subset has enough events');
  process.exit(1);
}
const counts: Record<string, number> = {
  'analysed events selected': events.length,
  'excluded (data/onset)': excluded.length,
  'used': used.length,
  'held-out fresh': subsetDefs[0][1].length,
  'regime fresh': subsetDefs[1][1].length,
  'in progress at open': used.filter((u) => u.inProgress).length,
};
const meta = { sha: process.env.GITHUB_SHA ?? 'local', configHash: createHash('sha256').update(cfgText).digest('hex') };
mkdirSync(values.out as string, { recursive: true });
writeFileSync(join(values.out as string, 'summary.json'), JSON.stringify({ meta, config: cfg, counts, used, excluded, subsets, outcomes: all }, null, 2));
writeFileSync(join(values.out as string, 'summary.md'), toStudy2Markdown(cfg, meta, counts, subsets));
console.log(readFileSync(join(values.out as string, 'summary.md'), 'utf8'));
