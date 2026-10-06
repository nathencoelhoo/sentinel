import { SortedWindow } from '../src/engine/stats.ts';
import { SentinelEngine, defaultConfig, defaultDetectors } from '../src/engine/engine.ts';
import { ZScoreBaseline } from '../src/engine/detectors/zscoreBaseline.ts';
import { bootstrapClusters, median } from './stats.ts';
import type { CI } from './stats.ts';
import { DAY_MS, chanceRecall, selectEvents } from './study-lib.ts';
import type { ChanceWindow, DailyRow, Mask, RankedDay } from './study-lib.ts';
import type { KBar } from './klines.ts';

const MIN_MS = 60_000;

export interface Study2Config {
  version: number;
  symbols: string[];
  from: string;
  to: string;
  v1PerSymbol: number;
  heldOutPerSymbol: number;
  regimePerSymbol: number;
  minSeparationDays: number;
  regimeRefDays: number;
  regimeMinRangePct: number;
  regimeExcludeDays: number;
  onsetWindowMin: number;
  onsetRefDays: number;
  onsetMultiple: number;
  detectLeadMin: number;
  detectLagMin: number;
  warmupDays: number;
  tailHours: number;
  guardMinutes: number;
  postGuardMinutes: number;
  budgets: number[];
  nominalBudget: number;
  targetRates: number[];
  primaryRate: number;
  cooldownBars: number;
  bootstrapResamples: number;
  randomReps: number;
  seed: number;
  referenceMethod: string;
  fullMethod: string;
}

// ---------------------------------------------------------------- event selection

/** Same greedy rule as v1: the first `v1N` picks ARE the v1 events; the next `heldN` are held out. */
export function splitShockPicks(rows: DailyRow[], v1N: number, heldN: number, sepDays: number): { v1: RankedDay[]; heldOut: RankedDay[] } {
  const seq = selectEvents(rows, v1N + heldN, sepDays);
  return { v1: seq.slice(0, v1N), heldOut: seq.slice(v1N) };
}

export interface RegimeDay {
  date: string;
  rangePct: number;
  ratio: number;
}

/**
 * Volatility-regime days: ratio = day range / median range of the previous `regimeRefDays` days. Candidates need
 * a minimum range, must not lie within `regimeExcludeDays` of any shock day, and are picked greedily with the same
 * separation rule. Prices only; no detector is involved.
 */
export function rankRegimeDays(
  rows: DailyRow[],
  o: { regimeRefDays: number; regimeMinRangePct: number; regimeExcludeDays: number; minSeparationDays: number },
  shockDates: string[],
  k: number,
): RegimeDay[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const rr = sorted.map((r) => (r.high - r.low) / r.open);
  const t = sorted.map((r) => Date.parse(r.date));
  const shock = shockDates.map((d) => Date.parse(d));
  const cands: RegimeDay[] = [];
  for (let i = o.regimeRefDays; i < sorted.length; i++) {
    if (t[i] - t[i - o.regimeRefDays] !== o.regimeRefDays * DAY_MS) continue; // window must be contiguous
    const base = median(rr.slice(i - o.regimeRefDays, i));
    const rangePct = 100 * rr[i];
    if (!(base > 0) || rangePct < o.regimeMinRangePct) continue;
    if (shock.some((s) => Math.abs(s - t[i]) <= o.regimeExcludeDays * DAY_MS)) continue;
    cands.push({ date: sorted[i].date, rangePct, ratio: rr[i] / base });
  }
  cands.sort((a, b) => b.ratio - a.ratio || a.date.localeCompare(b.date));
  const picked: RegimeDay[] = [];
  for (const c of cands) {
    if (picked.length >= k) break;
    const d = Date.parse(c.date);
    if (picked.every((p) => Math.abs(Date.parse(p.date) - d) >= o.minSeparationDays * DAY_MS)) picked.push(c);
  }
  return picked;
}

// ---------------------------------------------------------------- onset (trailing reference)

export interface OnsetInfo {
  onset: number | null;
  /** True if the trailing-hour move at the day's first minute already exceeds the threshold. */
  inProgress: boolean;
  theta: number;
  reason?: string;
}

/**
 * Onset rule v2. theta = onsetMultiple x median |60-min log return| over the `onsetRefDays` BEFORE the event day
 * (a trailing, past-only reference; no midnight anchor). Onset = first minute of the day whose |60-min return| >= theta.
 * Events already above theta at the day's first minute are flagged `inProgress` and kept out of the primary analysis.
 */
export function onsetV2(closeByT: Map<number, number>, dayStart: number, dayEnd: number, o: { onsetWindowMin: number; onsetRefDays: number; onsetMultiple: number }): OnsetInfo {
  const w = o.onsetWindowMin * MIN_MS;
  const absRet = (t: number): number => {
    const a = closeByT.get(t);
    const b = closeByT.get(t - w);
    return a !== undefined && b !== undefined ? Math.abs(Math.log(a / b)) : NaN;
  };
  const ref: number[] = [];
  for (let t = dayStart - o.onsetRefDays * DAY_MS; t < dayStart; t += MIN_MS) {
    const v = absRet(t);
    if (Number.isFinite(v)) ref.push(v);
  }
  if (ref.length < 0.8 * o.onsetRefDays * 1440) return { onset: null, inProgress: false, theta: NaN, reason: 'insufficient reference data' };
  const theta = o.onsetMultiple * median(ref);
  if (!(theta > 0)) return { onset: null, inProgress: false, theta, reason: 'zero reference volatility' };
  const first = absRet(dayStart);
  const inProgress = Number.isFinite(first) && first >= theta;
  for (let t = dayStart; t < dayEnd; t += MIN_MS) {
    const v = absRet(t);
    if (Number.isFinite(v) && v >= theta) return { onset: t, inProgress, theta };
  }
  return { onset: null, inProgress, theta, reason: 'no hourly move above threshold' };
}

// ---------------------------------------------------------------- scoring and thresholds

export interface ScorerSpec {
  name: string;
  make: (symbol: string) => (bar: KBar) => { ready: boolean; s: number };
}

/** Methods record a raw anomaly score per bar; alert policies are applied afterwards, identically for all methods. */
export function scorerSpecs(opts: { solo?: boolean } = {}): ScorerSpec[] {
  const base = { barSeconds: 60, alarmsPerDay: 6 };
  const sentinel = (name: string, ensemble: 'fixed' | 'learned', keep: (detectorName: string) => boolean): ScorerSpec => ({
    name,
    make: (sym) => {
      const e = new SentinelEngine(defaultConfig(sym, { ...base, ensemble }), defaultDetectors().filter((d) => keep(d.name)));
      return (b) => {
        const o = e.update(b);
        return { ready: o.ready, s: o.p };
      };
    },
  });
  const required = defaultDetectors().filter((d) => !d.optional).map((d) => d.name);
  const specs: ScorerSpec[] = [
    {
      name: 'zscore_matched',
      make: () => {
        const e = new ZScoreBaseline({ mode: 'matched', ...base });
        return (b) => {
          const o = e.update(b);
          return { ready: o.ready, s: o.score };
        };
      },
    },
    sentinel('sentinel_fixed', 'fixed', () => true),
    sentinel('sentinel_learned', 'learned', () => true),
    ...required.map((n) => sentinel(`sentinel_without_${n}`, 'fixed', (d) => d !== n)),
  ];
  // Post-hoc extension (v2b): each detector ALONE, through the identical normalisation and alert pipeline.
  if (opts.solo) for (const n of required) specs.push(sentinel(`solo_${n}`, 'fixed', (d) => d === n));
  return specs;
}

export interface Series {
  idx: number[]; // index into the slice, ready bars only
  t: number[];
  s: number[];
}

export function scoreSlice(score: (bar: KBar) => { ready: boolean; s: number }, bars: KBar[]): Series {
  const out: Series = { idx: [], t: [], s: [] };
  bars.forEach((b, i) => {
    const r = score(b);
    if (r.ready && Number.isFinite(r.s)) {
      out.idx.push(i);
      out.t.push(b.t);
      out.s.push(r.s);
    }
  });
  return out;
}

/**
 * Applies the adaptive-quantile alert policy to one score series for MANY budgets at once. The window of past scores
 * is shared (it does not depend on the budget); cooldown and escalation state are per budget. Logic is identical to
 * AdaptiveThreshold (verified by a unit test). Returns alert positions (indices into `scores`) per budget.
 */
export function alertsForBudgets(scores: number[], budgets: number[], o: { window: number; minObs: number; cooldown: number; escalationFactor: number }): number[][] {
  const win = new SortedWindow(o.window);
  const rho = budgets.map((b) => (b * 60) / 86400);
  const since = budgets.map(() => o.cooldown);
  const last = budgets.map(() => -Infinity);
  const out: number[][] = budgets.map(() => []);
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    const ready = win.size >= o.minObs;
    for (let k = 0; k < budgets.length; k++) {
      let thr = Infinity;
      let esc = Infinity;
      if (ready) {
        thr = Math.max(0, win.quantile(1 - rho[k]));
        if (o.escalationFactor > 0) esc = win.quantile(1 - rho[k] / o.escalationFactor);
      }
      since[k]++;
      const exceeds = v > thr;
      const inCooldown = since[k] < o.cooldown;
      const alert = exceeds && (!inCooldown || (v > esc && v > last[k]));
      if (alert) {
        since[k] = 0;
        last[k] = v;
        out[k].push(i);
      }
    }
    win.push(v);
  }
  return out;
}

export function quietFlags(bars: KBar[], masks: Mask[]): Uint8Array {
  const q = new Uint8Array(bars.length);
  bars.forEach((b, i) => {
    q[i] = masks.some((m) => b.t >= m.from && b.t <= m.to) ? 0 : 1;
  });
  return q;
}

export interface Outcome {
  detected: boolean;
  latencyMin: number | null;
  fa: number;
  quietDays: number;
}

export function outcomesForSlice(series: Series, quiet: Uint8Array, onset: number, cfg: Study2Config): Outcome[] {
  const alerts = alertsForBudgets(series.s, cfg.budgets, { window: 1440, minObs: 300, cooldown: cfg.cooldownBars, escalationFactor: 10 });
  let quietBars = 0;
  for (const i of series.idx) if (quiet[i]) quietBars++;
  const lo = onset - cfg.detectLeadMin * MIN_MS;
  const hi = onset + cfg.detectLagMin * MIN_MS;
  return alerts.map((list) => {
    let fa = 0;
    let first: number | undefined;
    for (const k of list) {
      const t = series.t[k];
      if (quiet[series.idx[k]]) fa++;
      if (first === undefined && t >= lo && t <= hi) first = t;
    }
    return { detected: first !== undefined, latencyMin: first === undefined ? null : (first - onset) / MIN_MS, fa, quietDays: quietBars / 1440 };
  });
}

// ---------------------------------------------------------------- matched-rate statistics

export interface MethodOutcomes {
  method: string;
  byBudget: Outcome[][]; // [budget][event]
}
export interface RatePoint {
  rate: number;
  recall: number;
}

function pointAt(m: MethodOutcomes, b: number, idx: number[]): RatePoint {
  let fa = 0;
  let qd = 0;
  let det = 0;
  for (const i of idx) {
    const o = m.byBudget[b][i];
    fa += o.fa;
    qd += o.quietDays;
    if (o.detected) det++;
  }
  return { rate: qd > 0 ? fa / qd : NaN, recall: idx.length ? det / idx.length : NaN };
}

/** Linear interpolation of recall at a realised quiet-period alert rate; NaN outside the swept range. */
export function recallAtRate(points: RatePoint[], r: number): number {
  const p = points.filter((x) => Number.isFinite(x.rate) && Number.isFinite(x.recall)).sort((a, b) => a.rate - b.rate);
  if (p.length < 2 || r < p[0].rate || r > p[p.length - 1].rate) return NaN;
  for (let i = 1; i < p.length; i++) {
    if (r <= p[i].rate) {
      const a = p[i - 1];
      const b = p[i];
      return b.rate === a.rate ? b.recall : a.recall + ((b.recall - a.recall) * (r - a.rate)) / (b.rate - a.rate);
    }
  }
  return NaN;
}

export const matchedRecall = (m: MethodOutcomes, r: number, idx: number[]): number => recallAtRate(m.byBudget.map((_, b) => pointAt(m, b, idx)), r);

export interface Cell {
  rate: number;
  recall: CI;
  vsRef?: CI;
  vsFull?: CI;
}
export interface SubsetSummary {
  name: string;
  n: number;
  chance: { rate: number; mean: number; lo: number; hi: number }[];
  cells: Record<string, Cell[]>;
  nominal: Record<string, { realisedRate: CI; recall: CI; medianLatencyMin: CI; dLatencyVsRef?: CI }>;
  curves: Record<string, { budget: number; rate: number; recall: number }[]>;
}

export function summarizeSubset(
  name: string,
  idx: number[],
  clusterIds: string[],
  windows: ChanceWindow[],
  all: MethodOutcomes[],
  cfg: Study2Config,
): SubsetSummary {
  const B = cfg.bootstrapResamples;
  const ids = idx.map((i) => clusterIds[i]);
  const sel = (pos: number[]) => pos.map((j) => idx[j]);
  const ref = all.find((m) => m.method === cfg.referenceMethod);
  const full = all.find((m) => m.method === cfg.fullMethod);
  const nomB = cfg.budgets.indexOf(cfg.nominalBudget);
  let seed = cfg.seed;
  const next = () => ++seed;
  const subWindows = idx.map((i) => windows[i]);

  const chance = cfg.targetRates.map((r) => ({ rate: r, ...chanceRecall(subWindows, r, cfg.cooldownBars, cfg.randomReps, next()) }));
  const cells: Record<string, Cell[]> = {};
  const nominal: SubsetSummary['nominal'] = {};
  const curves: SubsetSummary['curves'] = {};
  for (const m of all) {
    cells[m.method] = cfg.targetRates.map((r) => {
      const cell: Cell = { rate: r, recall: bootstrapClusters(ids, (p) => matchedRecall(m, r, sel(p)), B, next()) };
      if (ref && ref !== m) cell.vsRef = bootstrapClusters(ids, (p) => matchedRecall(m, r, sel(p)) - matchedRecall(ref, r, sel(p)), B, next());
      if (full && full !== m && (m.method.startsWith('sentinel_without_') || m.method.startsWith('solo_') || m.method === 'sentinel_learned')) {
        cell.vsFull = bootstrapClusters(ids, (p) => matchedRecall(m, r, sel(p)) - matchedRecall(full, r, sel(p)), B, next());
      }
      return cell;
    });
    const rateStat = (p: number[]) => pointAt(m, nomB, sel(p)).rate;
    const recStat = (p: number[]) => pointAt(m, nomB, sel(p)).recall;
    const latStat = (p: number[]) => median(sel(p).map((i) => m.byBudget[nomB][i].latencyMin).filter((x): x is number => x !== null));
    nominal[m.method] = {
      realisedRate: bootstrapClusters(ids, rateStat, B, next()),
      recall: bootstrapClusters(ids, recStat, B, next()),
      medianLatencyMin: bootstrapClusters(ids, latStat, B, next()),
    };
    if (ref && ref !== m) {
      nominal[m.method].dLatencyVsRef = bootstrapClusters(
        ids,
        (p) => median(sel(p).filter((i) => m.byBudget[nomB][i].latencyMin !== null && ref.byBudget[nomB][i].latencyMin !== null).map((i) => (m.byBudget[nomB][i].latencyMin as number) - (ref.byBudget[nomB][i].latencyMin as number))),
        B,
        next(),
      );
    }
    curves[m.method] = cfg.budgets.map((b, k) => ({ budget: b, ...pointAt(m, k, idx) }));
  }
  return { name, n: idx.length, chance, cells, nominal, curves };
}

// ---------------------------------------------------------------- report

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const ci = (c: CI, d = 2) => `${f(c.est, d)} [${f(c.lo, d)}, ${f(c.hi, d)}]`;
export const verdict = (c: CI): string => (!Number.isFinite(c.lo) ? 'n/a' : c.lo > 0 ? 'higher' : c.hi < 0 ? 'lower' : 'no clear difference');

export function toStudy2Markdown(
  cfg: Study2Config,
  meta: { sha: string; configHash: string },
  counts: Record<string, number>,
  subsets: SubsetSummary[],
): string {
  const L: string[] = [];
  L.push('# SENTINEL study v2 (EXPLORATORY: designed after v1 results)', '');
  L.push(`Config hash \`${meta.configHash.slice(0, 12)}\`, commit \`${meta.sha.slice(0, 10)}\`.`, '');
  L.push('Events: ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') + '.', '');
  L.push(`Onset = first minute whose |${cfg.onsetWindowMin}-min return| >= ${cfg.onsetMultiple} x the median over the ${cfg.onsetRefDays} days before the event day. "Fresh" = not already above that level at 00:00 UTC. Detection = alert within [onset - ${cfg.detectLeadMin}, onset + ${cfg.detectLagMin}] min. Alert policy and budget sweep are identical for every method; recall is compared at a MATCHED realised quiet-period alert rate by interpolating each method's recall-vs-rate curve. 95% cluster-bootstrap intervals (clusters = calendar day), ${cfg.bootstrapResamples} resamples.`, '');
  const hasSolo = subsets.length > 0 && Object.keys(subsets[0].cells).some((m) => m.startsWith('solo_'));
  if (hasSolo) {
    L.push('**Post-hoc extension (v2b).** The `solo_*` rows (each detector alone, same normalisation and alert pipeline) were added after seeing the v2 results. They are descriptive, were not part of the stated plan, and all five are reported, not only the best. In the component tables, a negative difference for a `solo_*` row means that detector alone has LOWER recall than the full ensemble.', '');
  }
  const prim = subsets.find((s) => s.name === 'heldout_fresh');
  if (prim) {
    const k = cfg.targetRates.indexOf(cfg.primaryRate);
    const c = prim.cells[cfg.fullMethod]?.[k];
    L.push('## Primary endpoint', '');
    if (c?.vsRef) {
      L.push(`Recall difference, ${cfg.fullMethod} minus ${cfg.referenceMethod}, at a matched realised rate of ${cfg.primaryRate} alerts/day, held-out shock events with a fresh onset (n = ${prim.n}): **${ci(c.vsRef)}** (${verdict(c.vsRef)}).`, '');
    } else L.push('Primary endpoint not computable (too few events or rate outside swept range).', '');
  }
  for (const s of subsets) {
    if (!s.name.endsWith('_fresh')) continue;
    L.push(`## ${s.name} (n = ${s.n})`, '');
    L.push('### Recall at matched realised alert rate', '', `| method | ${cfg.targetRates.map((r) => `@${r}/day`).join(' | ')} |`, `|---|${cfg.targetRates.map(() => '---').join('|')}|`);
    L.push(`| random alerter (chance) | ${s.chance.map((c) => `${f(c.mean)} [${f(c.lo)}, ${f(c.hi)}]`).join(' | ')} |`);
    for (const [m, cs] of Object.entries(s.cells)) L.push(`| ${m} | ${cs.map((c) => ci(c.recall)).join(' | ')} |`);
    L.push('', `### Paired difference vs ${cfg.referenceMethod} (same resamples)`, '', `| method | ${cfg.targetRates.map((r) => `@${r}/day`).join(' | ')} |`, `|---|${cfg.targetRates.map(() => '---').join('|')}|`);
    for (const [m, cs] of Object.entries(s.cells)) if (cs[0].vsRef) L.push(`| ${m} | ${cs.map((c) => `${ci(c.vsRef as CI)} (${verdict(c.vsRef as CI)})`).join(' | ')} |`);
    L.push('', `### Component effects vs ${cfg.fullMethod}`, '', `| method | ${cfg.targetRates.map((r) => `@${r}/day`).join(' | ')} |`, `|---|${cfg.targetRates.map(() => '---').join('|')}|`);
    for (const [m, cs] of Object.entries(s.cells)) if (cs[0].vsFull) L.push(`| ${m} | ${cs.map((c) => `${ci(c.vsFull as CI)} (${verdict(c.vsFull as CI)})`).join(' | ')} |`);
    L.push('', `### At the nominal budget (${cfg.nominalBudget}/day)`, '', '| method | realised quiet alerts/day | recall | median latency, min | latency diff vs ref (min) |', '|---|---|---|---|---|');
    for (const [m, n] of Object.entries(s.nominal)) L.push(`| ${m} | ${ci(n.realisedRate)} | ${ci(n.recall)} | ${ci(n.medianLatencyMin, 0)} | ${n.dLatencyVsRef ? ci(n.dLatencyVsRef, 0) : '-'} |`);
    L.push('');
  }
  const sens = subsets.filter((s) => s.name.endsWith('_all'));
  if (sens.length) {
    L.push('## Sensitivity: including events already in progress at 00:00 UTC', '');
    for (const s of sens) {
      const k = cfg.targetRates.indexOf(cfg.primaryRate);
      const c = s.cells[cfg.fullMethod]?.[k];
      L.push(`- ${s.name} (n = ${s.n}): ${cfg.fullMethod} minus ${cfg.referenceMethod} at ${cfg.primaryRate}/day: ${c?.vsRef ? `${ci(c.vsRef)} (${verdict(c.vsRef)})` : 'n/a'}`);
    }
    L.push('');
  }
  L.push(
    '## Caveats',
    '',
    '- Exploratory: designed after v1; only the held-out events are new data. Hyperparameters were not changed.',
    '- Secondary and descriptive comparisons are not corrected for multiplicity; read intervals, not p-values.',
    '- Events are correlated across BTC and ETH; the bootstrap resamples calendar days.',
    '- Quiet-period alert rates are upper bounds on false alarms. Matched-rate recall relies on linear interpolation between budget points; "n/a" means the target rate lies outside that method\'s swept range (any interval shown next to it comes from resamples where it did not).',
    '- Data: Binance Vision (CC BY-NC-SA 4.0, non-commercial). Research output, not trading advice.',
  );
  return L.join('\n') + '\n';
}
