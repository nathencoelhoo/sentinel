import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../src/sim/synth.ts';

const DAY = 86_400_000;

test('study-select (offline) then study-run: full pipeline on fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-study-'));
  const t0 = Date.UTC(2024, 0, 1);
  // --- minute bars with three -10% jumps on days 4, 7 and 10 (ordinary days have 3-7% ranges)
  const days = [4, 7, 10];
  const { bars } = simulate({
    n: 13 * 1440,
    seed: 21,
    events: days.map((d) => ({ type: 'jump' as const, at: d * 1440 + 600, len: 60, mag: -200 })),
  });
  const symDir = join(root, 'data', 'SIMX');
  mkdirSync(symDir, { recursive: true });
  let prev = bars[0].close;
  const rows = bars.map((b) => {
    const r = [b.t, prev, Math.max(prev, b.close), Math.min(prev, b.close), b.close, b.volume, b.t + 59_999, 0, 1, 0, 0, 0].join(',');
    prev = b.close;
    return r;
  });
  writeFileSync(join(symDir, 'SIMX-1m.csv'), rows.join('\n') + '\n');

  // --- daily klines for the selection step (range is large only on the jump days)
  const dailyDir = join(root, 'daily', 'SIMX');
  mkdirSync(dailyDir, { recursive: true });
  const daily: string[] = [];
  for (let d = 0; d < 13; d++) {
    const slice = bars.slice(d * 1440, (d + 1) * 1440);
    const hi = Math.max(...slice.map((b) => b.close));
    const lo = Math.min(...slice.map((b) => b.close));
    daily.push([t0 + d * DAY, slice[0].close, hi, lo, slice[slice.length - 1].close, 1, 0].join(','));
  }
  writeFileSync(join(dailyDir, 'SIMX-1d.csv'), daily.join('\n') + '\n');

  const cfg = {
    version: 1, symbols: ['SIMX'], from: '2024-01-04', to: '2024-01-13', topPerSymbol: 3, minSeparationDays: 3,
    onsetMovePct: 5, detectLeadMin: 30, detectLagMin: 120, warmupDays: 3, tailHours: 12, guardMinutes: 60,
    postGuardMinutes: 720, alarmsPerDay: 6, cooldownBars: 15, bootstrapResamples: 300, randomReps: 200, seed: 1,
    referenceMethod: 'zscore_matched',
  };
  const cfgPath = join(root, 'study.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const eventsPath = join(root, 'events.json');
  const run = (args: string[]) => execFileSync(process.execPath, args, { encoding: 'utf8' });

  const sel = run(['eval/study-select.ts', '--config', cfgPath, '--out', eventsPath, '--daily-dir', join(root, 'daily')]);
  assert.match(sel, /selected 3/);
  const ev = JSON.parse(readFileSync(eventsPath, 'utf8')).events as { date: string }[];
  assert.deepEqual(ev.map((e) => e.date).sort(), ['2024-01-05', '2024-01-08', '2024-01-11']); // days 4, 7, 10

  const out = join(root, 'results');
  const stdout = run(['eval/study-run.ts', '--config', cfgPath, '--events', eventsPath, '--data', join(root, 'data'), '--out', out, '--ablate']);
  assert.match(stdout, /done SIMX-2024-01-05/);
  assert.ok(existsSync(join(out, 'summary.md')));
  const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(s.used.length, 3);
  assert.equal(s.rows.length, 9); // 4 standard + 5 ablations
  const sf = s.rows.find((r: { method: string }) => r.method === 'sentinel_fixed');
  assert.ok(sf.recall.est >= 2 / 3, `recall ${sf.recall.est}`);
  assert.ok(sf.chance.mean >= 0 && sf.chance.mean <= 1);
  assert.ok(sf.vsRef && Number.isFinite(sf.vsRef.dRecall.est));
  assert.equal(s.meta.configHash.length, 64);
  assert.match(readFileSync(join(out, 'summary.md'), 'utf8'), /Paired difference vs `zscore_matched`/);
});
