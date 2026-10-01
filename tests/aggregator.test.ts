import test from 'node:test';
import assert from 'node:assert/strict';
import { BarAggregator } from '../src/feeds/aggregator.ts';
import { BoundedQueue } from '../src/feeds/queue.ts';

const M = 60_000;
const mk = (o: { maxGapFill?: number } = {}) => new BarAggregator({ barSeconds: 60, graceMs: 2000, ...o });

test('close follows exchange timestamp, not arrival order; bar emits only after grace', () => {
  const a = mk();
  assert.deepEqual(a.push({ t: 1000, price: 10, qty: 1 }), []);
  assert.deepEqual(a.push({ t: 30_000, price: 11, qty: 2 }), []);
  assert.deepEqual(a.push({ t: 20_000, price: 99, qty: 1 }), []); // arrives late, older ts
  assert.deepEqual(a.push({ t: 61_000, price: 12, qty: 1 }), []); // inside grace window of bar 0
  const out = a.push({ t: 62_500, price: 13, qty: 1 });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { t: 0, close: 11, volume: 4 });
});

test('trades older than an emitted bar are dropped and counted; duplicate ids ignored', () => {
  const a = mk();
  a.push({ t: 1000, price: 10, qty: 1, id: 1 });
  a.push({ t: 62_500, price: 12, qty: 1, id: 2 });
  assert.deepEqual(a.push({ t: 2000, price: 10, qty: 1, id: 3 }), []);
  assert.equal(a.stats.late, 1);
  a.push({ t: 63_000, price: 12, qty: 5, id: 2 });
  assert.equal(a.stats.dupes, 1);
  a.push({ t: 64_000, price: NaN, qty: 1 });
  assert.equal(a.stats.invalid, 1);
});

test('empty intervals become flat zero-volume bars; order is ascending', () => {
  const a = mk();
  const bars = [
    ...a.push({ t: 1000, price: 10, qty: 1 }),
    ...a.push({ t: 62_500, price: 12, qty: 1 }),
    ...a.push({ t: 4 * M + 5000, price: 14, qty: 1 }),
  ];
  assert.deepEqual(bars.map((b) => b.t), [0, M, 2 * M, 3 * M]);
  assert.deepEqual(bars.slice(2).map((b) => [b.volume, b.close]), [[0, 12], [0, 12]]);
  assert.equal(a.stats.gapFilled, 2);
});

test('outage longer than maxGapFill is skipped, not fabricated', () => {
  const a = mk({ maxGapFill: 2 });
  a.push({ t: 1000, price: 10, qty: 1 });
  const bars = a.push({ t: 10 * M + 5000, price: 14, qty: 1 });
  assert.deepEqual(bars.map((b) => b.t), [0]);
  assert.equal(a.stats.gapSkipped, 1);
});

test('advance() closes bars on the wall clock when no trades arrive', () => {
  const a = mk();
  a.push({ t: 1000, price: 10, qty: 1 });
  a.push({ t: 62_500, price: 12, qty: 1 });
  const bars = a.advance(3 * M + 2001);
  assert.deepEqual(bars.map((b) => [b.t, b.volume]), [[M, 1], [2 * M, 0]]);
});

test('latest order-book imbalance is attached; seed() makes older trades late', () => {
  const a = mk();
  a.setObi(30_000, 0.5);
  a.setObi(40_000, -0.2);
  a.push({ t: 1000, price: 10, qty: 1 });
  const out = a.push({ t: 62_500, price: 12, qty: 1 });
  assert.equal(out[0].obi, -0.2);
  const b = mk();
  b.seed(5 * M, 100);
  assert.deepEqual(b.push({ t: 5 * M + 10, price: 1, qty: 1 }), []);
  assert.equal(b.stats.late, 1);
});

test('BoundedQueue drops oldest under backpressure and counts it', () => {
  const q = new BoundedQueue<number>(3);
  [1, 2, 3, 4, 5].forEach((x) => q.push(x));
  assert.equal(q.dropped, 2);
  assert.deepEqual(q.drain(), [3, 4, 5]);
  assert.equal(q.length, 0);
  q.push(9);
  assert.deepEqual(q.drain(1), [9]);
});
