import test from 'node:test';
import assert from 'node:assert/strict';
import { SentinelEngine, defaultConfig } from '../src/engine/engine.ts';
import { simulate } from '../src/sim/synth.ts';

const strip = (o: ReturnType<SentinelEngine['update']>) => ({ r: o.ready, p: o.p, s: o.score, a: o.alert });

test('engine becomes ready without an order-book feed, scores stay in [0,100]', () => {
  const { bars } = simulate({ n: 800, seed: 1 });
  const e = new SentinelEngine(defaultConfig('SIM'));
  let readyAt = -1;
  bars.forEach((b, i) => {
    const o = e.update(b);
    if (o.ready && readyAt < 0) readyAt = i;
    assert.ok(o.score >= 0 && o.score <= 100);
  });
  assert.ok(readyAt > 0 && readyAt < 400, `readyAt ${readyAt}`);
});

test('no lookahead: outputs on a prefix are identical whatever data comes later', () => {
  const a = simulate({ n: 2000, seed: 3 }).bars;
  const b = simulate({ n: 2000, seed: 99 }).bars;
  const k = 1200;
  const mixed = a.slice(0, k).concat(b.slice(k).map((x, i) => ({ ...x, t: a[k + i].t })));
  for (const mode of ['fixed', 'learned'] as const) {
    const e1 = new SentinelEngine(defaultConfig('SIM', { ensemble: mode }));
    const e2 = new SentinelEngine(defaultConfig('SIM', { ensemble: mode }));
    for (let i = 0; i < k; i++) {
      assert.deepEqual(strip(e1.update(a[i])), strip(e2.update(mixed[i])), `${mode} bar ${i}`);
    }
  }
});

test('detects an injected volatility break quickly (fixed and learned)', () => {
  const { bars } = simulate({ n: 6000, seed: 5, events: [{ type: 'vol', at: 4000, len: 120, mag: 4 }] });
  for (const mode of ['fixed', 'learned'] as const) {
    const e = new SentinelEngine(defaultConfig('SIM', { ensemble: mode }));
    let first = -1;
    bars.forEach((b, i) => {
      const o = e.update(b);
      if (o.ready && o.alert && i >= 4000 && first < 0) first = i;
    });
    assert.ok(first >= 4000 && first - 4000 <= 30, `${mode} first alert ${first}`);
  }
});

test('learned weights stay finite and non-negative; explainability sums to the logit', () => {
  const { bars } = simulate({ n: 5000, seed: 8, withObi: true, events: [{ type: 'drift', at: 3000, len: 40, mag: -2 }] });
  const e = new SentinelEngine(defaultConfig('SIM', { ensemble: 'learned' }));
  const outs = bars.map((b) => e.update(b)).filter((o) => o.ready);
  const lastReady = outs[outs.length - 1];
  const w = e.weights;
  assert.ok(w.w.every((v) => Number.isFinite(v) && v >= 0) && Number.isFinite(w.b));
  assert.ok(lastReady && lastReady.detectors.length === 6);
  const logit = w.b + lastReady.detectors.reduce((s, d) => s + d.contribution, 0);
  assert.ok(Math.abs(1 / (1 + Math.exp(-logit)) - lastReady.p) < 1e-9);
});

test('regression: false alarms just before a real jump must not mask it (cooldown escalation)', () => {
  // seed 3 produced alerts at bars 9975 and 9990, which previously suppressed the jump at 10000.
  const { bars } = simulate({ n: 10100, seed: 3, events: [{ type: 'jump', at: 10000, len: 60, mag: -60 }] });
  const e = new SentinelEngine(defaultConfig('SIM'));
  let hit = -1;
  bars.forEach((b, i) => {
    const o = e.update(b);
    if (o.alert && i >= 10000 && i <= 10005 && hit < 0) hit = i;
  });
  assert.ok(hit >= 10000, `jump alert ${hit}`);
});
