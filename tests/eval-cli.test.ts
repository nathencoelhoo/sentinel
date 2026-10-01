import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../src/sim/synth.ts';

/** Writes Binance-format kline CSVs (one with a header + microsecond timestamps) and runs the real CLI on them. */
test('eval CLI: loads Binance-format CSVs (ms, µs, header row), replays, writes json + markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-eval-'));
  const symDir = join(root, 'data', 'SIMX');
  mkdirSync(symDir, { recursive: true });
  const { bars } = simulate({
    n: 9000,
    seed: 12,
    events: [{ type: 'vol', at: 5000, len: 150, mag: 5 }, { type: 'jump', at: 7500, len: 60, mag: -60 }],
  });
  const row = (b: (typeof bars)[number], mul: number) =>
    [b.t * mul, 1, 1, 1, b.close, b.volume, (b.t + 59_999) * mul, 0, 1, 0, 0, 0].join(',');
  const half = 4500;
  writeFileSync(join(symDir, 'SIMX-1m-a.csv'), bars.slice(0, half).map((b) => row(b, 1)).join('\n') + '\n');
  writeFileSync(
    join(symDir, 'SIMX-1m-b.csv'),
    'open_time,open,high,low,close,volume,close_time,qv,n,tb,tq,ignore\n' + bars.slice(half - 5).map((b) => row(b, 1000)).join('\n') + '\n', // µs + 5 overlapping rows
  );
  const iso = (i: number) => new Date(bars[0].t + i * 60_000).toISOString();
  const events = join(root, 'events.json');
  writeFileSync(
    events,
    JSON.stringify({ events: [
      { name: 'vol', symbol: 'SIMX', start: iso(5000), end: iso(5150) },
      { name: 'jump', symbol: 'SIMX', start: iso(7500), end: iso(7560) },
    ] }),
  );
  const out = join(root, 'results');
  const stdout = execFileSync(
    process.execPath,
    ['eval/run.ts', '--data', join(root, 'data'), '--events', events, '--out', out, '--warmup-days', '3', '--ablate'],
    { encoding: 'utf8' },
  );
  // window = [first start - 3 d, last end + 12 h] = minutes 680..8280 => 7601 bars. A wrong µs->ms
  // conversion or an unskipped header would change this count.
  assert.match(stdout, /SIMX: 7601 bars/);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  const methods = summary.summary.map((r: { method: string }) => r.method);
  assert.deepEqual(methods.slice(0, 4), ['zscore_fixed3', 'zscore_matched', 'sentinel_fixed', 'sentinel_learned']);
  assert.equal(methods.length, 9); // 4 standard + 5 leave-one-out ablations
  assert.ok(methods.includes('sentinel_without_bocpd'));
  assert.ok(existsSync(join(out, 'summary.md')));
  assert.match(readFileSync(join(out, 'summary.md'), 'utf8'), /\| sentinel_fixed \|/);
  const s = summary.summary.find((r: { method: string }) => r.method === 'sentinel_fixed');
  assert.ok(Number(s.recall.split('/')[0]) >= 1, `recall ${s.recall}`);
});
