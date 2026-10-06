import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../src/sim/synth.ts';
import { mulberry32 } from '../src/sim/rng.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const run = (args: string[]) => execFileSync(process.execPath, args, { encoding: 'utf8' });
const baseCfg = {
  version: 2, symbols: ['SIMX'], from: '2024-01-01', to: '2024-04-30', v1PerSymbol: 2, heldOutPerSymbol: 3, regimePerSymbol: 3,
  minSeparationDays: 3, regimeRefDays: 7, regimeMinRangePct: 4, regimeExcludeDays: 1, onsetWindowMin: 60, onsetRefDays: 7, onsetMultiple: 10,
  detectLeadMin: 30, detectLagMin: 120, warmupDays: 7, tailHours: 12, guardMinutes: 60, postGuardMinutes: 720, budgets: [2, 4, 8, 16],
  nominalBudget: 4, targetRates: [3, 5], primaryRate: 5, cooldownBars: 15, bootstrapResamples: 200, randomReps: 100, seed: 1,
  referenceMethod: 'zscore_matched', fullMethod: 'sentinel_fixed',
};

test('study2-select (offline): held-out and regime classes obey the rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-s2sel-'));
  const dir = join(root, 'daily', 'SIMX');
  mkdirSync(dir, { recursive: true });
  const rng = mulberry32(9);
  const rows = Array.from({ length: 100 }, (_, i) => {
    const rangePct = 2 + 12 * rng() ** 3;
    return [T0 + i * DAY, 100, 100 + rangePct, 100, 100, 1, 0].join(',');
  });
  writeFileSync(join(dir, 'd.csv'), rows.join('\n') + '\n');
  const cfgPath = join(root, 'study2.json');
  writeFileSync(cfgPath, JSON.stringify(baseCfg));
  const out = join(root, 'events.json');
  run(['eval/study2-select.ts', '--config', cfgPath, '--out', out, '--daily-dir', join(root, 'daily')]);
  const j = JSON.parse(readFileSync(out, 'utf8')) as { _meta: { maskDays: Record<string, string[]> }; events: { date: string; cls: string }[] };
  const held = j.events.filter((e) => e.cls === 'heldout').map((e) => Date.parse(e.date));
  const reg = j.events.filter((e) => e.cls === 'regime').map((e) => Date.parse(e.date));
  const v1 = j._meta.maskDays.SIMX.map((d) => Date.parse(d));
  assert.equal(held.length, 3);
  assert.equal(v1.length, 2);
  assert.ok(reg.length >= 1 && reg.length <= 3);
  for (const r of reg) for (const s of [...held, ...v1]) assert.ok(Math.abs(r - s) > DAY, 'regime day too close to a shock day');
  for (const a of [...held, ...v1]) for (const b of [...held, ...v1]) if (a !== b) assert.ok(Math.abs(a - b) >= 3 * DAY);
});

test('study2-run: full pipeline on fixtures (fresh onsets, budget sweep, matched-rate output)', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-s2run-'));
  const days = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  const { bars } = simulate({ n: 20 * 1440, seed: 33, events: days.map((d) => ({ type: 'jump' as const, at: d * 1440 + 600, len: 60, mag: -200 })) });
  const symDir = join(root, 'data', 'SIMX');
  mkdirSync(symDir, { recursive: true });
  let prev = bars[0].close;
  writeFileSync(join(symDir, 'SIMX-1m.csv'), bars.map((b) => { const r = [b.t, prev, prev, prev, b.close, b.volume, b.t + 59_999, 0, 1, 0, 0, 0].join(','); prev = b.close; return r; }).join('\n') + '\n');
  const events = days.map((d, k) => ({
    id: `SIMX-${new Date(T0 + d * DAY).toISOString().slice(0, 10)}`, symbol: 'SIMX', date: new Date(T0 + d * DAY).toISOString().slice(0, 10),
    cls: k < 5 ? 'heldout' : 'regime', start: new Date(T0 + d * DAY).toISOString(), end: new Date(T0 + (d + 1) * DAY).toISOString(), rangePct: 10,
  }));
  const evPath = join(root, 'events.json');
  writeFileSync(evPath, JSON.stringify({ _meta: { maskDays: { SIMX: [] } }, events }));
  const cfgPath = join(root, 'study2.json');
  writeFileSync(cfgPath, JSON.stringify(baseCfg));
  const out = join(root, 'results');
  const stdout = run(['eval/study2-run.ts', '--config', cfgPath, '--events', evPath, '--data', join(root, 'data'), '--out', out, '--solo']);
  assert.match(stdout, /done SIMX-2024-01-09 \[heldout\]/);
  assert.ok(existsSync(join(out, 'summary.md')));
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(s.used.length, 10);
  assert.ok(s.used.every((u: { inProgress: boolean }) => u.inProgress === false));
  const held = s.subsets.find((x: { name: string }) => x.name === 'heldout_fresh');
  assert.equal(held.n, 5);
  assert.equal(Object.keys(held.cells).length, 13); // zscore + fixed + learned + 5 ablations + 5 solo
  assert.ok(held.cells.solo_cusum[0].vsFull !== undefined, 'solo rows are compared with the full ensemble');
  const nom = held.nominal.sentinel_fixed;
  assert.ok(nom.recall.est >= 0.6, `nominal recall ${nom.recall.est}`);
  assert.equal(held.curves.sentinel_fixed.length, baseCfg.budgets.length);
  assert.equal(held.chance.length, 2);
  assert.equal(s.meta.configHash.length, 64);
  const md = readFileSync(join(out, 'summary.md'), 'utf8');
  assert.match(md, /Primary endpoint/);
  assert.match(md, /matched realised/i);
  assert.match(md, /Post-hoc extension \(v2b\)/);
});
