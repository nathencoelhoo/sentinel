import test from 'node:test';
import assert from 'node:assert/strict';
import { ContagionTracker } from '../src/engine/contagion.ts';
import { mulberry32, randn } from '../src/sim/rng.ts';

test('finds a 3-bar lead-lag between anomaly-score series', () => {
  const rng = mulberry32(21);
  const c = new ContagionTracker({ window: 300, maxLag: 6 });
  const A: number[] = [];
  for (let t = 0; t < 400; t++) {
    const a = Math.max(0, randn(rng)) + (rng() < 0.05 ? 5 : 0);
    A.push(a);
    const b = (t >= 3 ? A[t - 3] : 0) + 0.2 * randn(rng);
    c.update({ A: { ret: randn(rng), score: a }, B: { ret: randn(rng), score: b } });
  }
  const link = c.snapshot()[0];
  assert.equal(link.lag, 3);
  assert.equal(link.leader, 'A');
  assert.equal(link.follower, 'B');
});

test('no leader is declared for simultaneous co-movement', () => {
  const rng = mulberry32(22);
  const c = new ContagionTracker({ window: 300, maxLag: 6 });
  for (let t = 0; t < 400; t++) {
    const s = Math.max(0, randn(rng)) + (rng() < 0.05 ? 5 : 0);
    c.update({ A: { ret: 0, score: s }, B: { ret: 0, score: s + 0.1 * randn(rng) } });
  }
  assert.equal(c.snapshot()[0].leader, null);
});
