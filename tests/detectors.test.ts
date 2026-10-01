import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, randn } from '../src/sim/rng.ts';
import { RobustZ } from '../src/engine/detectors/robustZ.ts';
import { EwmaVol } from '../src/engine/detectors/ewmaVol.ts';
import { Cusum } from '../src/engine/detectors/cusum.ts';
import { Bocpd } from '../src/engine/detectors/bocpd.ts';
import { VolumeSpike } from '../src/engine/detectors/volumeSpike.ts';

const bar = (i: number, volume = 1) => ({ t: i, close: 1, volume });

test('RobustZ flags an outlier even with a contaminated window', () => {
  const rng = mulberry32(1);
  const d = new RobustZ('z', (_b, r) => r);
  for (let i = 0; i < 300; i++) {
    const r = (i % 20 === 0 ? 10 : 1) * 1e-3 * randn(rng);
    d.update(bar(i), r);
  }
  const out = d.update(bar(300), 8e-3);
  assert.ok(out !== null && out > 5, `got ${out}`);
});

test('RobustZ returns null for missing input (optional order-book feed)', () => {
  const d = new RobustZ('obi', (b) => b.obi, { optional: true });
  assert.equal(d.update(bar(0), 0.001), null);
});

test('EwmaVol ratio ~1 in steady state, clearly >1 after a 4x vol step', () => {
  const rng = mulberry32(2);
  const d = new EwmaVol();
  let last = 0;
  for (let i = 0; i < 600; i++) last = d.update(bar(i), 1e-3 * randn(rng)) ?? 0;
  assert.ok(last > 0.5 && last < 1.8, `steady ${last}`);
  for (let i = 0; i < 20; i++) last = d.update(bar(600 + i), 4e-3 * randn(rng)) ?? 0;
  // fast vol ~3.4x, slow vol also drifts up (~1.5x) => expected ratio ~2.2, steady state ~1
  assert.ok(last > 1.5, `after step ${last}`);
});

test('Cusum stays quiet on noise and detects a drift within 15 bars', () => {
  const rng = mulberry32(3);
  const d = new Cusum();
  let max = 0;
  for (let i = 0; i < 500; i++) max = Math.max(max, d.update(bar(i), 1e-3 * randn(rng)) ?? 0);
  assert.ok(max <= 10, `noise max ${max}`);
  let hit = -1;
  for (let k = 0; k < 15 && hit < 0; k++) {
    const s = d.update(bar(500 + k), -2e-3 + 1e-3 * randn(rng)) ?? 0;
    if (s > 10) hit = k;
  }
  assert.ok(hit >= 0, 'drift not detected');
});

test('BOCPD short-run mass is low in steady state and >0.5 soon after a variance break', () => {
  const rng = mulberry32(4);
  const d = new Bocpd();
  const steady: number[] = [];
  for (let i = 0; i < 400; i++) {
    const m = d.update(bar(i), 1e-3 * randn(rng));
    if (m !== null && i > 200) steady.push(m);
  }
  const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
  assert.ok(mean < 0.1, `steady mean ${mean}`);
  let peak = 0;
  for (let k = 0; k < 10; k++) peak = Math.max(peak, d.update(bar(400 + k), 5e-3 * randn(rng)) ?? 0);
  assert.ok(peak > 0.5, `peak ${peak}`);
});

test('VolumeSpike ratio equals v / rolling median', () => {
  const d = new VolumeSpike();
  for (let i = 0; i < 100; i++) d.update(bar(i, 10));
  const out = d.update(bar(100, 50));
  assert.ok(out !== null && Math.abs(out - 5) < 1e-9);
});
