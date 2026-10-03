import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapClusters, median, percentile } from '../eval/stats.ts';
import { mulberry32, randn } from '../src/sim/rng.ts';

test('median and percentile basics', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(percentile([0, 10], 0.5), 5);
});

test('bootstrap CI for a mean covers the truth and is deterministic per seed', () => {
  const rng = mulberry32(5);
  const xs = Array.from({ length: 60 }, () => 1 + randn(rng));
  const ids = xs.map((_, i) => `d${i}`);
  const mean = (idx: number[]) => idx.reduce((s, i) => s + xs[i], 0) / idx.length;
  const a = bootstrapClusters(ids, mean, 1000, 1);
  const b = bootstrapClusters(ids, mean, 1000, 1);
  assert.deepEqual(a, b);
  assert.ok(a.lo < 1 && a.hi > 1, `[${a.lo}, ${a.hi}]`);
  assert.ok(a.hi - a.lo < 1);
});

test('clusters are resampled as units (same-day events move together)', () => {
  // two events per day; if clusters were split, resamples would sometimes contain an odd count
  const ids = ['a', 'a', 'b', 'b', 'c', 'c'];
  const sizes = new Set<number>();
  bootstrapClusters(ids, (idx) => (sizes.add(idx.length % 2), 0), 200, 3);
  assert.deepEqual([...sizes], [0]);
});

test('paired difference CI excludes zero when one method is clearly better', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `d${i}`);
  const a = ids.map((_, i) => (i % 5 === 0 ? 0 : 1)); // detects 80%
  const b = ids.map((_, i) => (i % 2 === 0 ? 0 : 1)); // detects 50%
  const rec = (x: number[]) => (idx: number[]) => idx.reduce((s, i) => s + x[i], 0) / idx.length;
  const d = bootstrapClusters(ids, (idx) => rec(a)(idx) - rec(b)(idx), 1000, 9);
  assert.ok(d.lo > 0, `[${d.lo}, ${d.hi}]`);
});

test('NaN resamples are skipped; too few valid resamples gives NaN bounds', () => {
  const ids = ['a', 'b'];
  const ci = bootstrapClusters(ids, () => NaN, 100, 1);
  assert.ok(Number.isNaN(ci.lo) && ci.n === 0);
});
