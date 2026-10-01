import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, standardMethods, summarize } from '../eval/harness.ts';
import { simulate } from '../src/sim/synth.ts';

test('harness: replay produces sane metrics and detects injected events', () => {
  const { bars, events } = simulate({
    n: 9000,
    seed: 12,
    events: [
      { type: 'vol', at: 5000, len: 150, mag: 5 },
      { type: 'jump', at: 7500, len: 60, mag: -60 },
    ],
  });
  const res = evaluate('SIM', bars, events, standardMethods(60, 6), { barSeconds: 60 });
  const rows = summarize(res);
  assert.equal(rows.length, 4);
  const s = rows.find((r) => r.method === 'sentinel_fixed')!;
  assert.ok(Number(s.recall.split('/')[0]) >= 1, `recall ${s.recall}`);
  assert.ok(res[0].quietDays > 1);
  for (const r of rows) assert.ok(Number.isFinite(r.falseAlarmsPerDay));
});
