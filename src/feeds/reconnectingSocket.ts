export type SocketStatus = 'connecting' | 'open' | 'closed' | 'stale';

/** The subset of the WebSocket API we use (so tests can inject a fake). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface ReconnectingSocketOptions {
  url: string;
  onMessage: (data: string) => void;
  /** Called on every (re)connect: send your subscribe message here. */
  onOpen?: (send: (s: string) => void) => void;
  onStatus?: (s: SocketStatus, attempt: number) => void;
  factory?: SocketFactory;
  /** No message for this long on an open socket => treat as dead and reconnect. */
  staleMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  rand?: () => number;
}

/**
 * WebSocket with exponential backoff + jitter and a stale-connection watchdog.
 *   delay_k = min(maxDelay, base * 2^k) * (0.5 + rand/2)
 * The attempt counter resets only after a MESSAGE is received on the new connection,
 * so a server that accepts and immediately drops us keeps backing off.
 * Events from superseded sockets are ignored (generation token).
 */
export class ReconnectingSocket {
  private readonly o: Required<Omit<ReconnectingSocketOptions, 'onOpen' | 'onStatus'>> &
    Pick<ReconnectingSocketOptions, 'onOpen' | 'onStatus'>;
  private sock: SocketLike | null = null;
  private gen = 0;
  private attempt = 0;
  private lastMsg = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ReconnectingSocketOptions) {
    this.o = {
      staleMs: 15_000,
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      rand: Math.random,
      factory: (url) => new WebSocket(url) as unknown as SocketLike,
      ...opts,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => this.checkStale(), Math.max(1000, this.o.staleMs / 3));
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnectTimer = null;
    this.watchdog = null;
    this.teardownSocket();
    this.o.onStatus?.('closed', this.attempt);
  }

  private teardownSocket(): void {
    const s = this.sock;
    this.sock = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const id = ++this.gen;
    this.o.onStatus?.('connecting', this.attempt);
    const s = this.o.factory(this.o.url);
    this.sock = s;
    s.onopen = () => {
      if (id !== this.gen) return;
      this.lastMsg = Date.now();
      this.o.onStatus?.('open', this.attempt);
      this.o.onOpen?.((m) => s.send(m));
    };
    s.onmessage = (ev) => {
      if (id !== this.gen) return;
      this.lastMsg = Date.now();
      this.attempt = 0;
      this.o.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    };
    const dead = () => {
      if (id !== this.gen) return;
      this.o.onStatus?.('closed', this.attempt);
      this.scheduleReconnect();
    };
    s.onclose = dead;
    s.onerror = dead;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.gen++; // invalidate the dead socket's handlers
    this.teardownSocket();
    const raw = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** this.attempt);
    const delay = raw * (0.5 + this.o.rand() / 2);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private checkStale(): void {
    if (this.stopped || this.reconnectTimer || !this.sock) return;
    if (Date.now() - this.lastMsg > this.o.staleMs) {
      this.o.onStatus?.('stale', this.attempt);
      this.scheduleReconnect();
    }
  }
}
