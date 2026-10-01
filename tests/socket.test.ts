import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectingSocket } from '../src/feeds/reconnectingSocket.ts';
import type { SocketLike } from '../src/feeds/reconnectingSocket.ts';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
}

function setup(extra: { staleMs?: number } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const socks: FakeSocket[] = [];
  const statuses: string[] = [];
  const msgs: string[] = [];
  const rs = new ReconnectingSocket({
    url: 'wss://x',
    factory: () => { const s = new FakeSocket(); socks.push(s); return s; },
    onMessage: (d) => msgs.push(d),
    onOpen: (send) => send('SUB'),
    onStatus: (s) => statuses.push(s),
    rand: () => 1, // jitter factor 1.0 => deterministic delays
    baseDelayMs: 500,
    ...extra,
  });
  return { rs, socks, statuses, msgs };
}

test('subscribes on open; backs off exponentially; resets only after a message', () => {
  const { rs, socks, msgs } = setup();
  try {
    rs.start();
    socks[0].onopen!();
    assert.deepEqual(socks[0].sent, ['SUB']);
    socks[0].onclose!(); // fail 1 -> delay 500
    mock.timers.tick(499);
    assert.equal(socks.length, 1);
    mock.timers.tick(1);
    assert.equal(socks.length, 2);
    socks[1].onopen!();
    socks[1].onclose!(); // fail 2 without any message -> delay 1000
    mock.timers.tick(999);
    assert.equal(socks.length, 2);
    mock.timers.tick(1);
    assert.equal(socks.length, 3);
    socks[2].onopen!();
    socks[2].onmessage!({ data: 'hello' }); // healthy => attempt resets
    assert.deepEqual(msgs, ['hello']);
    socks[2].onclose!();
    mock.timers.tick(500);
    assert.equal(socks.length, 4);
    rs.stop();
  } finally {
    mock.timers.reset();
  }
});

test('stale connection (no messages) is torn down and re-established', () => {
  const { rs, socks, statuses } = setup({ staleMs: 3000 });
  try {
    rs.start();
    socks[0].onopen!();
    mock.timers.tick(4500);
    assert.ok(statuses.includes('stale'));
    assert.ok(socks[0].closed);
    mock.timers.tick(1000);
    assert.equal(socks.length, 2);
    rs.stop();
  } finally {
    mock.timers.reset();
  }
});

test('stop() prevents any further reconnect and ignores events from old sockets', () => {
  const { rs, socks } = setup();
  try {
    rs.start();
    const first = socks[0];
    rs.stop();
    first.onclose?.();
    mock.timers.tick(60_000);
    assert.equal(socks.length, 1);
  } finally {
    mock.timers.reset();
  }
});
