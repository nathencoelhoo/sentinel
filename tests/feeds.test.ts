import test from 'node:test';
import assert from 'node:assert/strict';
import { obiFromBook, parseBinance, parseCoinbase } from '../src/feeds/parsers.ts';
import { binanceKlinesUrl, parseBinanceKlines, parseCoinbaseCandles } from '../src/feeds/history.ts';

test('parseBinance: trade, partial depth, and junk', () => {
  const trade = parseBinance({ stream: 'btcusdt@trade', data: { e: 'trade', s: 'BTCUSDT', t: 12345, p: '64000.10', q: '0.5', T: 1700000000000 } });
  assert.deepEqual(trade, { kind: 'trade', symbol: 'binance:BTCUSDT', trade: { t: 1700000000000, price: 64000.1, qty: 0.5, id: 12345 } });
  const depth = parseBinance({ stream: 'ethusdt@depth10@100ms', data: { lastUpdateId: 1, bids: [['1', '3']], asks: [['2', '1']] } });
  assert.deepEqual(depth, { kind: 'obi', symbol: 'binance:ETHUSDT', obi: 0.5 });
  assert.equal(parseBinance({ result: null, id: 1 }), null);
  assert.equal(parseBinance({ stream: 'btcusdt@trade', data: { p: 'x', q: '1', T: 1 } }), null);
});

test('parseCoinbase: match and last_match accepted, others ignored', () => {
  const m = { type: 'match', trade_id: 30, product_id: 'BTC-USD', size: '5.2', price: '400.23', time: '2026-10-01T12:00:00.123456Z' };
  const ev = parseCoinbase(m);
  assert.equal(ev?.kind, 'trade');
  assert.equal(ev && ev.kind === 'trade' ? ev.symbol : '', 'coinbase:BTC-USD');
  assert.ok(parseCoinbase({ ...m, type: 'last_match' }));
  assert.equal(parseCoinbase({ type: 'subscriptions', channels: [] }), null);
  assert.equal(parseCoinbase({ ...m, time: 'garbage' }), null);
});

test('obiFromBook bounds and degenerate books', () => {
  assert.equal(obiFromBook([['1', '1']], [['2', '1']]), 0);
  assert.equal(obiFromBook([['1', '1']], []), 1);
  assert.equal(obiFromBook([], []), null);
});

test('history parsers drop the still-open bar and sort ascending', () => {
  const now = 10 * 60_000 + 5000;
  const klines = [
    [9 * 60_000, '1', '1', '1', '10', '2'],
    [8 * 60_000, '1', '1', '1', '9', '1'],
    [10 * 60_000, '1', '1', '1', '11', '3'], // open bar
  ];
  assert.deepEqual(parseBinanceKlines(klines, now).map((b) => b.close), [9, 10]);
  const cb = [[9 * 60, 1, 1, 1, 10, 2], [10 * 60, 1, 1, 1, 11, 3], [8 * 60, 1, 1, 1, 9, 1]];
  assert.deepEqual(parseCoinbaseCandles(cb, now).map((b) => b.t), [8 * 60_000, 9 * 60_000]);
  assert.match(binanceKlinesUrl('BTCUSDT', 'us'), /api\.binance\.us.*interval=1m/);
  assert.deepEqual(parseBinanceKlines('nope', now), []);
});
