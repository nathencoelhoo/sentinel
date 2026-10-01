import test from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, SortedWindow, lgamma, pearson, robustSigma } from '../src/engine/stats.ts';

const approx = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

test('SortedWindow keeps a sorted rolling window', () => {
  const w = new SortedWindow(3);
  [5, 1, 3, 9].forEach((x) => w.push(x)); // evicts 5
  assert.deepEqual([...w.values], [1, 3, 9]);
  assert.equal(w.median(), 3);
  assert.equal(w.quantile(1), 9);
});

test('ecdf is a mid-rank estimate and ignores non-finite pushes', () => {
  const w = new SortedWindow(10);
  [1, 2, 3, 4].forEach((x) => w.push(x));
  w.push(NaN);
  assert.equal(w.size, 4);
  approx(w.ecdf(2.5), 0.4);
  approx(w.ecdf(2), 0.3);
});

test('RingBuffer wraps and keeps order', () => {
  const r = new RingBuffer(3);
  [1, 2, 3, 4, 5].forEach((x) => r.push(x));
  assert.deepEqual(r.toArray(), [3, 4, 5]);
});

test('lgamma matches known values', () => {
  approx(lgamma(5), Math.log(24), 1e-9);
  approx(lgamma(0.5), 0.5 * Math.log(Math.PI), 1e-9);
  approx(lgamma(1.5), 0.5 * Math.log(Math.PI) - Math.log(2), 1e-9);
});

test('robustSigma ignores outliers; pearson basics', () => {
  const w = new SortedWindow(100);
  for (let i = 0; i < 90; i++) w.push(Math.sin(i) );
  for (let i = 0; i < 10; i++) w.push(1000);
  assert.ok(robustSigma(w) < 2);
  approx(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), 0);
});
