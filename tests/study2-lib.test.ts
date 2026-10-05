import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveThreshold } from '../src/engine/threshold.ts';
import { mulberry32, randn } from '../src/sim/rng.ts';
import { selectEvents } from '../eval/study-lib.ts';
import type { DailyRow } from '../eval/study-lib.ts';
import { alertsForBudgets, onsetV2, outcomesForSlice, quietFlags, rankRegimeDays, recallAtRate, splitShockPicks } from '../eval/study2-lib.ts';
import type { Study2Config } from '../eval/study2-lib.ts';

const T0 = Date.UTC(2024, 0, 1);
const iso = (i: number) => new Date(T0 + i * 86_400_000).toISOString().slice(0, 10);
const day = (i: number, rangePct: number): DailyRow => ({ date: iso(i), open: 100, high: 100 + rangePct, low: 100 });
const baseCfg = (o: Partial<Study2Config> = {}): Study2Config => ({
  version: 2, symbols: ['SIMX'], from: '2024-01-01', to: '2024-12-31', v1PerSymbol: 2, heldOutPerSymbol: 3, regimePerSymbol: 3,
  minSeparationDays: 3, regimeRefDays: 7, regimeMinRangePct: 4, regimeExcludeDays: 1, onsetWindowMin: 60, onsetRefDays: 7, onsetMultiple: 4,
  detectLeadMin: 30, detectLagMin: 120, warmupDays: 7, tailHours: 12, guardMinutes: 60, postGuardMinutes: 720, budgets: [6],
  nominalBudget: 6, targetRates: [3, 5], primaryRate: 5, cooldownBars: 15, bootstrapResamples: 100, randomReps: 50, seed: 1,
  referenceMethod: 'zscore_matched', fullMethod: 'sentinel_fixed', ...o,
});

test('splitShockPicks: v1 picks are exactly the v1 rule; held-out are the next picks', () => {
  const rows = [day(0, 50), day(10, 40), day(20, 30), day(30, 20), day(40, 10), day(41, 9)];
  const { v1, heldOut } = splitShockPicks(rows, 2, 3, 3);
  assert.deepEqual(v1.map((r) => r.date), selectEvents(rows, 2, 3).map((r) => r.date));
  assert.deepEqual(v1.map((r) => r.date), [iso(0), iso(10)]);
  assert.deepEqual(heldOut.map((r) => r.date), [iso(20), iso(30), iso(40)]); // day 41 skipped: adjacent to 40
});

test('rankRegimeDays: ratio ranking, minimum range, shock exclusion and separation', () => {
  const rows = Array.from({ length: 40 }, (_, i) => day(i, 2));
  rows[15] = day(15, 8); // ratio 4
  rows[22] = day(22, 7); // ratio 3.5
  rows[20] = day(20, 6); // ratio 3 but within 3 days of day 22 -> skipped
  rows[11] = day(11, 9); // adjacent to the shock day 10 -> excluded
  rows[30] = day(30, 3); // below the 4% minimum range
  const picks = rankRegimeDays(rows, baseCfg(), [iso(10)], 5);
  assert.deepEqual(picks.map((p) => p.date), [iso(15), iso(22)]);
  assert.ok(picks[0].ratio > picks[1].ratio && picks[0].ratio > 3.5);
});

function walk(days: number, seed: number, jumps: { minute: number; ret: number }[] = []) {
  const rng = mulberry32(seed);
  const m = new Map<number, number>();
  let p = 100;
  for (let i = 0; i < days * 1440; i++) {
    p *= Math.exp(0.0003 * randn(rng));
    for (const j of jumps) if (j.minute === i) p *= Math.exp(j.ret);
    m.set(T0 + i * 60_000, p);
  }
  return m;
}

test('onsetV2: fresh onset at the jump minute; in-progress flag; no-onset case', () => {
  const dayStart = T0 + 8 * 86_400_000;
  const dayEnd = dayStart + 86_400_000;
  const o = { onsetWindowMin: 60, onsetRefDays: 7, onsetMultiple: 8 }; // ~5.4 sigma(hourly): chance crossings are negligible
  const fresh = onsetV2(walk(10, 5, [{ minute: 8 * 1440 + 600, ret: 0.05 }]), dayStart, dayEnd, o);
  assert.equal(fresh.onset, dayStart + 600 * 60_000);
  assert.equal(fresh.inProgress, false);
  const prog = onsetV2(walk(10, 5, [{ minute: 8 * 1440 - 30, ret: 0.05 }]), dayStart, dayEnd, o);
  assert.equal(prog.inProgress, true);
  assert.equal(prog.onset, dayStart);
  const none = onsetV2(walk(10, 5), dayStart, dayEnd, { ...o, onsetMultiple: 20 });
  assert.equal(none.onset, null);
  const thin = onsetV2(new Map(), dayStart, dayEnd, o);
  assert.match(thin.reason ?? '', /insufficient/);
});

test('recallAtRate interpolates linearly and is NaN outside the swept range', () => {
  const pts = [{ rate: 1, recall: 0.2 }, { rate: 3, recall: 0.6 }, { rate: 9, recall: 0.8 }];
  assert.ok(Math.abs(recallAtRate(pts, 2) - 0.4) < 1e-12);
  assert.ok(Math.abs(recallAtRate(pts, 6) - 0.7) < 1e-12);
  assert.ok(Number.isNaN(recallAtRate(pts, 0.5)) && Number.isNaN(recallAtRate(pts, 10)));
  assert.ok(Number.isNaN(recallAtRate([{ rate: 1, recall: 1 }], 1)));
});

test('alertsForBudgets reproduces AdaptiveThreshold exactly for every budget', () => {
  const rng = mulberry32(77);
  const scores = Array.from({ length: 5000 }, (_, i) => Math.abs(randn(rng)) ** 2 * (1 + (i % 700 < 30 ? 6 : 0)));
  const budgets = [2, 6, 12, 24];
  const got = alertsForBudgets(scores, budgets, { window: 1440, minObs: 300, cooldown: 15, escalationFactor: 10 });
  budgets.forEach((b, k) => {
    const t = new AdaptiveThreshold({ window: 1440, exceedRate: (b * 60) / 86400, minObs: 300, floor: 0, cooldown: 15, escalationFactor: 10 });
    const want: number[] = [];
    scores.forEach((v, i) => { if (t.update(v).alert) want.push(i); });
    assert.deepEqual(got[k], want, `budget ${b}`);
  });
  assert.ok(got[3].length >= got[0].length); // bigger budget, at least as many alerts
});

test('outcomesForSlice: detection, latency and quiet false alarms', () => {
  const rng = mulberry32(3);
  const n = 3000;
  const s = Array.from({ length: n }, () => rng());
  const onsetIdx = 2000;
  s[onsetIdx] = 50;
  s[500] = 50; // a spike in the quiet zone: one false alarm
  const series = { idx: s.map((_, i) => i), t: s.map((_, i) => T0 + i * 60_000), s };
  const bars = s.map((_, i) => ({ t: T0 + i * 60_000, close: 1, open: 1, volume: 1 }));
  const quiet = quietFlags(bars, [{ from: T0 + 1900 * 60_000, to: T0 + 2500 * 60_000 }]);
  assert.equal(quiet[2000], 0);
  assert.equal(quiet[500], 1);
  const [o] = outcomesForSlice(series, quiet, T0 + onsetIdx * 60_000, baseCfg());
  assert.equal(o.detected, true);
  assert.equal(o.latencyMin, 0);
  assert.ok(o.fa >= 1);
  assert.ok(Math.abs(o.quietDays - (n - 601) / 1440) < 1e-9);
});
