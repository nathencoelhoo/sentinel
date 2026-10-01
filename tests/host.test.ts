import test from 'node:test';
import assert from 'node:assert/strict';
import { SentinelHost } from '../src/worker/host.ts';
import type { UiMessage } from '../src/worker/protocol.ts';
import { simulate } from '../src/sim/synth.ts';

const M = 60_000;
const T0 = Date.UTC(2026, 0, 1);
const SYMS = ['sim:AAA', 'sim:BBB'];

function build(over: Partial<ConstructorParameters<typeof SentinelHost>[0]> = {}) {
  let now = T0;
  const msgs: UiMessage[] = [];
  const host = new SentinelHost(
    { symbols: SYMS, barSeconds: 60, ensemble: 'fixed', alarmsPerDay: 6, ...over },
    (m) => msgs.push(m),
    () => now,
    () => now, // deterministic "perf"
  );
  return { host, msgs, setNow: (t: number) => { now = t; } };
}

test('backfill -> live trades (out of order) -> ordered bars; a -3% crash raises an alert', () => {
  const { host, msgs, setNow } = build();
  const lastClose: Record<string, number> = {};
  SYMS.forEach((s, i) => {
    const { bars } = simulate({ n: 1500, seed: 5 + i, t0: T0 });
    host.backfill(s, bars);
    lastClose[s] = bars[bars.length - 1].close;
  });
  assert.equal(msgs.filter((m) => m.type === 'backfill').length, 2);

  const start = T0 + 1500 * M;
  const crashMinute = 5;
  const expectedClose: Record<number, number> = {};
  for (let k = 0; k < 10; k++) {
    const m = start + k * M;
    for (const s of SYMS) {
      if (k === crashMinute) lastClose[s] *= 0.97;
      const px = lastClose[s];
      if (s === 'sim:AAA') expectedClose[k] = px * 1.0002; // latest-by-timestamp trade of the minute
      // three trades per minute, delivered in REVERSED order (out-of-order feed)
      const trades = [
        { t: m + 1000, price: px, qty: 1, id: `${s}-${k}-a` },
        { t: m + 30_000, price: px * 1.0001, qty: 2, id: `${s}-${k}-b` },
        { t: m + 55_000, price: px * 1.0002, qty: 1, id: `${s}-${k}-c` },
      ].reverse();
      trades.forEach((tr, i) => {
        setNow(m + 55_100 + i * 10);
        host.onTrade(s, tr);
      });
      lastClose[s] = px * 1.0002;
    }
    setNow(m + 55_200);
    host.pump();
  }
  setNow(start + 12 * M);
  host.pump();

  const bars = msgs.filter((m): m is Extract<UiMessage, { type: 'bar' }> => m.type === 'bar' && m.symbol === 'sim:AAA');
  assert.ok(bars.length >= 9, `bars ${bars.length}`);
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].t > bars[i - 1].t, 'bars strictly ascending');
  assert.ok(bars.every((b) => b.ready), 'engine ready immediately thanks to backfill');
  // close follows the latest exchange timestamp even though trades arrived reversed
  const b0 = bars.find((b) => b.t === start)!;
  assert.ok(Math.abs(b0.close - expectedClose[0]) < 1e-9, `close ${b0.close} vs ${expectedClose[0]}`);
  const crashBar = start + crashMinute * M;
  const alerts = msgs.filter((m) => m.type === 'alert' && m.symbol === 'sim:AAA');
  assert.ok(alerts.some((a) => a.type === 'alert' && a.t === crashBar), 'alert on the crash bar');
  assert.ok(msgs.some((m) => m.type === 'metrics'));
  assert.ok(msgs.some((m) => m.type === 'contagion'));
});

test('backpressure: bounded queue drops oldest and reports it in metrics', () => {
  const { host, msgs, setNow } = build({ maxQueue: 10 });
  setNow(T0 + 5000);
  for (let i = 0; i < 100; i++) host.onTrade('sim:AAA', { t: T0 + 1000 + i, price: 10, qty: 1, id: i });
  setNow(T0 + 7000);
  host.pump();
  const metrics = msgs.filter((m): m is Extract<UiMessage, { type: 'metrics' }> => m.type === 'metrics').pop();
  assert.ok(metrics && metrics.m.dropped === 90, `dropped ${metrics?.m.dropped}`);
});

test('unknown symbols are ignored', () => {
  const { host, msgs, setNow } = build();
  setNow(T0 + 5000);
  host.onTrade('sim:ZZZ', { t: T0 + 1000, price: 10, qty: 1 });
  host.pump();
  assert.equal(msgs.filter((m) => m.type === 'bar').length, 0);
});
