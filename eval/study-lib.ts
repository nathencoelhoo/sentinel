import type { AlertEngine } from '../src/engine/types.ts';
import { mulberry32 } from '../src/sim/rng.ts';
import { bootstrapClusters, median, percentile } from './stats.ts';
import type { CI } from './stats.ts';
import { normalizeTs } from './klines.ts';
import type { KBar } from './klines.ts';

export const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export interface StudyConfig {
  version: number;
  symbols: string[];
  from: string;
  to: string;
  topPerSymbol: number;
  minSeparationDays: number;
  onsetMovePct: number;
  detectLeadMin: number;
  detectLagMin: number;
  warmupDays: number;
  tailHours: number;
  guardMinutes: number;
  postGuardMinutes: number;
  alarmsPerDay: number;
  cooldownBars: number;
  bootstrapResamples: number;
  randomReps: number;
  seed: number;
  referenceMethod: string;
}

export interface DailyRow {
  date: string; // YYYY-MM-DD (UTC)
  open: number;
  high: number;
  low: number;
}
export interface RankedDay extends DailyRow {
  rangePct: number;
}

/** Parse Binance 1d kline CSV text into daily rows. */
export function parseDailyKlines(text: string): DailyRow[] {
  const rows: DailyRow[] = [];
  for (const line of text.split('\n')) {
    const c = line.split(',');
    if (c.length < 6) continue;
    const t0 = Number(c[0]);
    if (!Number.isFinite(t0)) continue;
    const open = Number(c[1]);
    const high = Number(c[2]);
    const low = Number(c[3]);
    if (!(open > 0) || !(high >= low) || !(low > 0)) continue;
    rows.push({ date: new Date(normalizeTs(t0)).toISOString().slice(0, 10), open, high, low });
  }
  return rows;
}

/**
 * Pre-registered event rule: rank days by (high - low) / open, take the top `k`, greedily skipping any
 * day within `minSepDays` of an already chosen one. Depends only on price data, never on any detector.
 */
export function selectEvents(rows: DailyRow[], k: number, minSepDays: number): RankedDay[] {
  const ranked: RankedDay[] = rows
    .map((r) => ({ ...r, rangePct: (100 * (r.high - r.low)) / r.open }))
    .sort((a, b) => b.rangePct - a.rangePct || a.date.localeCompare(b.date));
  const picked: RankedDay[] = [];
  for (const r of ranked) {
    if (picked.length >= k) break;
    const d = Date.parse(r.date);
    if (picked.every((p) => Math.abs(Date.parse(p.date) - d) >= minSepDays * DAY_MS)) picked.push(r);
  }
  return picked;
}

/**
 * Onset rule: first minute of the UTC day [start, end) at which the close is at least `pct` percent away
 * from the day's opening price. Fixed in advance, price-only, identical for every method.
 * (Note: it is a simple move rule, so it does not favour a volatility-based detector.)
 */
export function findOnset(bars: KBar[], start: number, end: number, pct: number): number | null {
  const day = bars.filter((b) => b.t >= start && b.t < end);
  if (day.length < 720) return null;
  const open = day[0].open;
  for (const b of day) if (Math.abs(b.close / open - 1) >= pct / 100) return b.t;
  return null;
}

export interface Mask {
  from: number;
  to: number;
}

/** Replays one event slice through a fresh engine; counts alerts and quiet-zone exposure. */
export function runOnSlice(
  make: () => AlertEngine,
  bars: KBar[],
  masks: Mask[],
): { alerts: number[]; quietAlerts: number; quietReadyBars: number } {
  const eng = make();
  const alerts: number[] = [];
  let quietAlerts = 0;
  let quietReadyBars = 0;
  for (const bar of bars) {
    const o = eng.update(bar);
    if (!o.ready) continue;
    const quiet = !masks.some((m) => bar.t >= m.from && bar.t <= m.to);
    if (quiet) quietReadyBars++;
    if (o.alert) {
      alerts.push(bar.t);
      if (quiet) quietAlerts++;
    }
  }
  return { alerts, quietAlerts, quietReadyBars };
}

export interface EventRun {
  id: string;
  symbol: string;
  date: string;
  onset: number;
  detected: boolean;
  /** Minutes from onset to the first alert inside the detection window (negative = early warning). */
  latencyMin: number | null;
  faCount: number;
  quietDays: number;
  totalAlerts: number;
}

export function scoreEvent(
  id: string,
  symbol: string,
  date: string,
  onset: number,
  run: { alerts: number[]; quietAlerts: number; quietReadyBars: number },
  cfg: StudyConfig,
): EventRun {
  const lo = onset - cfg.detectLeadMin * MIN_MS;
  const hi = onset + cfg.detectLagMin * MIN_MS;
  const first = run.alerts.find((t) => t >= lo && t <= hi);
  return {
    id,
    symbol,
    date,
    onset,
    detected: first !== undefined,
    latencyMin: first === undefined ? null : (first - onset) / MIN_MS,
    faCount: run.quietAlerts,
    quietDays: run.quietReadyBars / 1440,
    totalAlerts: run.alerts.length,
  };
}

export interface ChanceWindow {
  /** Bar indices relative to the event slice start. */
  wStart: number;
  wEnd: number;
}

/**
 * "Skill vs chance": recall of a RANDOM alerter that fires at the same background rate and with the same
 * minimum spacing as the method under test. Renewal process: gap = cooldown + ceil(Exp) with mean 1440/rate.
 * Returns the mean recall over events and a 95% range across `reps` simulations.
 */
export function chanceRecall(
  windows: ChanceWindow[],
  alertsPerDay: number,
  cooldownBars: number,
  reps: number,
  seed: number,
  readyIdx = 310,
): { mean: number; lo: number; hi: number } {
  if (!(alertsPerDay > 0) || windows.length === 0) return { mean: 0, lo: 0, hi: 0 };
  const rng = mulberry32(seed);
  const meanGap = 1440 / alertsPerDay;
  const extra = Math.max(1, meanGap - cooldownBars);
  const out: number[] = [];
  for (let r = 0; r < reps; r++) {
    let hits = 0;
    for (const w of windows) {
      let t = readyIdx + Math.floor(rng() * meanGap);
      while (t <= w.wEnd) {
        if (t >= w.wStart) {
          hits++;
          break;
        }
        t += cooldownBars + Math.ceil(-Math.log(1 - rng()) * extra);
      }
    }
    out.push(hits / windows.length);
  }
  out.sort((a, b) => a - b);
  return { mean: out.reduce((a, b) => a + b, 0) / out.length, lo: percentile(out, 0.025), hi: percentile(out, 0.975) };
}

export interface MethodRuns {
  method: string;
  runs: EventRun[];
}
export interface SummaryRow {
  method: string;
  recall: CI;
  chance: { mean: number; lo: number; hi: number };
  skill: number;
  faPerDay: CI;
  medianLatencyMin: CI;
  vsRef?: { dRecall: CI; dFaPerDay: CI; dLatencyMin: CI };
}

const recallOf = (runs: EventRun[]) => (idx: number[]) => (idx.length ? idx.filter((i) => runs[i].detected).length / idx.length : NaN);
const faOf = (runs: EventRun[]) => (idx: number[]) => {
  let fa = 0;
  let d = 0;
  for (const i of idx) {
    fa += runs[i].faCount;
    d += runs[i].quietDays;
  }
  return d > 0 ? fa / d : NaN;
};
const latOf = (runs: EventRun[]) => (idx: number[]) => median(idx.map((i) => runs[i].latencyMin).filter((x): x is number => x !== null));
const pairedLat = (a: EventRun[], b: EventRun[]) => (idx: number[]) =>
  median(idx.filter((i) => a[i].latencyMin !== null && b[i].latencyMin !== null).map((i) => (a[i].latencyMin as number) - (b[i].latencyMin as number)));

export function summarizeStudy(all: MethodRuns[], windows: ChanceWindow[], cfg: StudyConfig): SummaryRow[] {
  const ref = all.find((m) => m.method === cfg.referenceMethod);
  const ids = all[0].runs.map((r) => r.date); // cluster = calendar day
  const B = cfg.bootstrapResamples;
  return all.map((m, k) => {
    const recall = bootstrapClusters(ids, recallOf(m.runs), B, cfg.seed + 10 * k + 1);
    const faPerDay = bootstrapClusters(ids, faOf(m.runs), B, cfg.seed + 10 * k + 2);
    const medianLatencyMin = bootstrapClusters(ids, latOf(m.runs), B, cfg.seed + 10 * k + 3);
    const chance = chanceRecall(windows, faPerDay.est, cfg.cooldownBars, cfg.randomReps, cfg.seed + 10 * k + 4);
    const row: SummaryRow = { method: m.method, recall, chance, skill: recall.est - chance.mean, faPerDay, medianLatencyMin };
    if (ref && ref !== m) {
      const rr = recallOf(ref.runs);
      const rf = faOf(ref.runs);
      const mr = recallOf(m.runs);
      const mf = faOf(m.runs);
      row.vsRef = {
        dRecall: bootstrapClusters(ids, (i) => mr(i) - rr(i), B, cfg.seed + 10 * k + 5),
        dFaPerDay: bootstrapClusters(ids, (i) => mf(i) - rf(i), B, cfg.seed + 10 * k + 6),
        dLatencyMin: bootstrapClusters(ids, pairedLat(m.runs, ref.runs), B, cfg.seed + 10 * k + 7),
      };
    }
    return row;
  });
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const ci = (c: CI, d = 2) => `${f(c.est, d)} [${f(c.lo, d)}, ${f(c.hi, d)}]`;
/** A paired interval that excludes 0 is called out; everything else is "no clear difference". */
const verdict = (c: CI) => (!Number.isFinite(c.lo) ? 'n/a' : c.lo > 0 ? 'higher' : c.hi < 0 ? 'lower' : 'no clear difference');

export function toStudyMarkdown(
  cfg: StudyConfig,
  rows: SummaryRow[],
  used: { id: string; onset: number; rangePct: number }[],
  excluded: { id: string; reason: string }[],
  meta: { sha: string; configHash: string },
): string {
  const L: string[] = [];
  L.push(`# SENTINEL study results (alarm budget ${cfg.alarmsPerDay}/day)`, '');
  L.push(`Config hash \`${meta.configHash.slice(0, 12)}\`, commit \`${meta.sha.slice(0, 10)}\`. Events used: ${used.length}, excluded: ${excluded.length}.`, '');
  L.push(`Detection = an alert within [onset - ${cfg.detectLeadMin} min, onset + ${cfg.detectLagMin} min]; onset = first minute the price is >= ${cfg.onsetMovePct}% from the UTC day's open. 95% intervals are cluster-bootstrap (clusters = calendar day), ${cfg.bootstrapResamples} resamples.`, '');
  L.push('## Per method', '');
  L.push('| method | recall | chance recall at same alert rate [95% range] | recall minus chance | false alarms/day | median latency (min) |', '|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| ${r.method} | ${ci(r.recall)} | ${f(r.chance.mean)} [${f(r.chance.lo)}, ${f(r.chance.hi)}] | ${f(r.skill)} | ${ci(r.faPerDay)} | ${ci(r.medianLatencyMin, 0)} |`);
  }
  L.push('', `## Paired difference vs \`${cfg.referenceMethod}\` (same resamples; an interval excluding 0 is a clear difference)`, '');
  L.push('| method | recall diff | false alarms/day diff | latency diff (min, events both detect) |', '|---|---|---|---|');
  for (const r of rows) {
    if (!r.vsRef) continue;
    L.push(`| ${r.method} | ${ci(r.vsRef.dRecall)} (${verdict(r.vsRef.dRecall)}) | ${ci(r.vsRef.dFaPerDay)} (${verdict(r.vsRef.dFaPerDay)}) | ${ci(r.vsRef.dLatencyMin, 0)} (${verdict(r.vsRef.dLatencyMin)}) |`);
  }
  L.push('', '## Events', '', '| event | onset (UTC) | day range % |', '|---|---|---|');
  for (const u of used) L.push(`| ${u.id} | ${new Date(u.onset).toISOString().slice(0, 16)} | ${f(u.rangePct, 1)} |`);
  if (excluded.length) {
    L.push('', 'Excluded:', '');
    for (const x of excluded) L.push(`- ${x.id}: ${x.reason}`);
  }
  L.push(
    '',
    '## Caveats',
    '',
    '- BTC and ETH shocks are highly correlated; the bootstrap resamples days, but the effective sample is still small.',
    '- False alarms are alerts in "quiet" periods that exclude the selected event days; other volatile periods remain, so false-alarm rates are upper bounds.',
    '- Each event is replayed with a cold engine and 3 days of warm-up, so the learned ensemble has little time to learn.',
    '- Data: Binance Vision (CC BY-NC-SA 4.0, non-commercial). Research output, not trading advice.',
  );
  return L.join('\n') + '\n';
}
