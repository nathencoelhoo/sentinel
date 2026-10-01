import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAlert, validateAlert } from '../src/alerts/format.ts';
import { RateLimiter, dispatchAlert, keyOk } from '../src/alerts/dispatch.ts';

const good = { symbol: 'binance:BTCUSDT', t: Date.UTC(2026, 9, 1, 12, 3), price: 64000.5, score: 87.34, threshold: 0.81, top: [{ name: 'bocpd', contribution: 2.1 }, { name: 'robust_z', contribution: -0.4 }] };

test('validateAlert accepts good input and rejects injection / bad types', () => {
  assert.ok(validateAlert(good));
  assert.equal(validateAlert({ ...good, symbol: 'binance:BTC\n@everyone' }), null);
  assert.equal(validateAlert({ ...good, top: [{ name: '<script>', contribution: 1 }] }), null);
  assert.equal(validateAlert({ ...good, price: '1' }), null);
  assert.equal(validateAlert({ ...good, top: new Array(7).fill({ name: 'a', contribution: 1 }) }), null);
  assert.equal(validateAlert(null), null);
});

test('formatAlert is plain text with drivers and a disclaimer', () => {
  const s = formatAlert(validateAlert(good)!);
  assert.match(s, /SENTINEL alert: binance:BTCUSDT/);
  assert.match(s, /bocpd \+2\.10, robust_z -0\.40/);
  assert.match(s, /2026-10-01 12:03 UTC/);
  assert.match(s, /not financial advice/);
});

test('keyOk fails closed and compares exactly', () => {
  assert.equal(keyOk('abc', undefined), false);
  assert.equal(keyOk(null, 'abc'), false);
  assert.equal(keyOk('abd', 'abc'), false);
  assert.equal(keyOk('abc', 'abc'), true);
});

test('RateLimiter caps per window and recovers', () => {
  const r = new RateLimiter(2, 1000);
  assert.ok(r.allow(0) && r.allow(10));
  assert.equal(r.allow(20), false);
  assert.ok(r.allow(1500));
});

test('dispatchAlert posts to configured channels only, suppresses mentions, survives failures', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: !url.includes('discord') };
  }) as unknown as typeof fetch;
  const a = validateAlert(good)!;
  const res = await dispatchAlert(a, { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C', DISCORD_WEBHOOK_URL: 'https://discord.test/hook' }, fakeFetch);
  assert.deepEqual(res, { telegram: true, discord: false });
  assert.match(calls[0].url, /api\.telegram\.org\/botT\/sendMessage/);
  assert.equal(calls[0].body.chat_id, 'C');
  assert.deepEqual((calls[1].body.allowed_mentions as { parse: string[] }).parse, []);
  const none = await dispatchAlert(a, {}, fakeFetch);
  assert.deepEqual(none, { telegram: null, discord: null });
  const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
  assert.deepEqual(await dispatchAlert(a, { DISCORD_WEBHOOK_URL: 'https://d.test' }, boom), { telegram: null, discord: false });
});
