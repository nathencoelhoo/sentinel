import test from 'node:test';
import assert from 'node:assert/strict';
import { LogisticEnsemble } from '../src/engine/ensemble.ts';
import { AdaptiveThreshold } from '../src/engine/threshold.ts';
import { mulberry32 } from '../src/sim/rng.ts';

test('prior ensemble: p = sigma(1.5 (mean x - 3))', () => {
  const e = new LogisticEnsemble(6);
  const { p: pLow } = e.predict([1, 1, 1, 1, 1, 1]);
  const { p: pMid } = e.predict([3, 3, 3, 3, 3, 3]);
  assert.ok(Math.abs(pLow - 1 / (1 + Math.exp(3))) < 1e-9);
  assert.ok(Math.abs(pMid - 0.5) < 1e-9);
});

test('lr = 0 never changes weights', () => {
  const e = new LogisticEnsemble(3, { lr: 0 });
  const before = [...e.w];
  e.update([5, 5, 5], 1);
  assert.deepEqual(e.w, before);
});

test('online learning separates classes, keeps weights >= 0', () => {
  const rng = mulberry32(7);
  const e = new LogisticEnsemble(3, { lr: 0.05, l2: 0 });
  for (let i = 0; i < 6000; i++) {
    const x = [rng() * 4, rng() * 4, rng() * 4];
    e.update(x, x[0] > 2 ? 1 : 0);
  }
  const hi = e.predict([3.5, 1, 1]).p;
  const lo = e.predict([0.5, 1, 1]).p;
  assert.ok(hi - lo > 0.3, `hi ${hi} lo ${lo}`);
  assert.ok(e.w.every((w) => w >= 0));
  assert.ok(e.w[0] > e.w[1] && e.w[0] > e.w[2]);
});

test('AdaptiveThreshold hits the target exceedance rate on iid scores', () => {
  const rng = mulberry32(9);
  const t = new AdaptiveThreshold({ window: 1000, exceedRate: 0.01, minObs: 300, floor: 0, cooldown: 1 });
  let alerts = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (t.update(rng()).alert) alerts++;
  const rate = alerts / (N - 300);
  assert.ok(rate > 0.006 && rate < 0.015, `rate ${rate}`);
});

test('AdaptiveThreshold cooldown spaces alerts', () => {
  const t = new AdaptiveThreshold({ window: 500, exceedRate: 0.05, minObs: 100, floor: 0, cooldown: 10, escalationFactor: 0 });
  const rng = mulberry32(11);
  let last = -100;
  for (let i = 0; i < 5000; i++) {
    if (t.update(rng()).alert) {
      assert.ok(i - last >= 10);
      last = i;
    }
  }
});

test('escalation: a much larger spike inside a cooldown fires; a modest repeat does not', () => {
  const mk = () => new AdaptiveThreshold({ window: 1000, exceedRate: 0.01, minObs: 300, floor: 0, cooldown: 15 });
  const warm = (t: AdaptiveThreshold) => {
    const rng = mulberry32(31);
    for (let i = 0; i < 600; i++) t.update(rng());
  };
  const a = mk();
  warm(a);
  assert.ok(a.update(5).alert); // first alert
  for (let i = 0; i < 4; i++) a.update(0.1);
  const big = a.update(50); // 10x larger, inside cooldown, beats everything seen
  assert.ok(big.alert && big.escalated);

  const b = mk();
  warm(b);
  assert.ok(b.update(5).alert);
  for (let i = 0; i < 4; i++) b.update(0.1);
  assert.equal(b.update(0.995).alert, false); // exceeds threshold but is not an escalation
});
