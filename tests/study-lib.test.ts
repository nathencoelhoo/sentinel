import test from 'node:test';
import assert from 'node:assert/strict';
import { chanceRecall, findOnset, parseDailyKlines, scoreEvent, selectEvents } from '../eval/study-lib.ts';
import type { StudyConfig } from '../eval/study-lib.ts';
import { parseKlineCsv } from '../eval/klines.ts';

const day = (d: string, o: number, h: number, l: number) => ({ date: d, open: o, high: h, low: l });
const cfg = { detectLeadMin: 30, detectLagMin: 120 } as StudyConfig;

test('selectEvents ranks by range, enforces separation, is deterministic', () => {
  const rows = [
    day('2020-03-12', 100, 110, 60), // 50%
    day('2020-03-13', 100, 105, 62), // 43% but adjacent -> skipped with minSep 3
    day('2020-03-20', 100, 108, 70), // 38%
    day('2021-05-19', 100, 101, 80), // 21%
    day('2021-05-20', 100, 101, 99), // 2%
  ];
  const p = selectEvents(rows, 3, 3);
  assert.deepEqual(p.map((x) => x.date), ['2020-03-12', '2020-03-20', '2021-05-19']);
  assert.deepEqual(selectEvents(rows, 3, 3), p);
  assert.equal(selectEvents(rows, 10, 3).length, 3); // 05-20 is adjacent to 05-19, 03-13 to 03-12
});

test('parseDailyKlines handles ms and microsecond timestamps and skips junk', () => {
  const csv = '1583971200000,1,2,0.5,1.5,10\n1735689600000000,3,4,2,3.5,10\nopen_time,open,high,low,close,volume\n';
  assert.deepEqual(parseDailyKlines(csv).map((r) => r.date), ['2020-03-12', '2025-01-01']);
  assert.equal(parseKlineCsv('1583971200000000,1,1,1,2,3,0\n').length, 1);
});

test('findOnset: first minute >= pct away from the day open; null if thin or no move', () => {
  const start = Date.UTC(2024, 0, 1);
  const bars = Array.from({ length: 1440 }, (_, i) => ({ t: start + i * 60_000, open: 100, close: i < 300 ? 100.2 : 98.5, volume: 1 }));
  assert.equal(findOnset(bars, start, start + 86_400_000, 1), start + 300 * 60_000);
  assert.equal(findOnset(bars, start, start + 86_400_000, 5), null);
  assert.equal(findOnset(bars.slice(0, 100), start, start + 86_400_000, 1), null);
});

test('scoreEvent: detection window includes early warning (negative latency)', () => {
  const onset = 1_000_000_000;
  const run = (alerts: number[]) => ({ alerts, quietAlerts: 2, quietReadyBars: 2880 });
  const early = scoreEvent('e', 'S', 'd', onset, run([onset - 10 * 60_000]), cfg);
  assert.ok(early.detected && early.latencyMin === -10 && early.quietDays === 2);
  assert.equal(scoreEvent('e', 'S', 'd', onset, run([onset - 60 * 60_000]), cfg).detected, false); // too early
  assert.equal(scoreEvent('e', 'S', 'd', onset, run([onset + 121 * 60_000]), cfg).detected, false); // too late
  assert.equal(scoreEvent('e', 'S', 'd', onset, run([onset + 120 * 60_000]), cfg).latencyMin, 120);
});

test('chanceRecall matches theory for a 150-minute window', () => {
  const windows = Array.from({ length: 30 }, () => ({ wStart: 4000, wEnd: 4150 }));
  const c = chanceRecall(windows, 6, 15, 400, 7);
  // ~ 150 / mean gap(240 bars) = 0.625 expected alerts => detection probability ~ 0.45
  assert.ok(c.mean > 0.38 && c.mean < 0.55, `mean ${c.mean}`);
  assert.ok(c.lo <= c.mean && c.mean <= c.hi);
  assert.deepEqual(chanceRecall(windows, 0, 15, 10, 1), { mean: 0, lo: 0, hi: 0 });
  assert.ok(chanceRecall(windows, 30, 15, 400, 7).mean > c.mean); // more alerts => easier by chance
});
