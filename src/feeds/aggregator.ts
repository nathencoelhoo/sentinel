import type { Bar } from '../engine/types.ts';

export interface Trade {
  /** Exchange timestamp, ms since epoch. */
  t: number;
  price: number;
  qty: number;
  /** Exchange trade id, used to drop duplicates replayed after a reconnect. */
  id?: string | number;
}

interface Bucket {
  t: number;
  close: number;
  closeTs: number;
  volume: number;
}

export interface AggregatorStats {
  late: number; // trades older than an already-emitted bar (dropped)
  dupes: number;
  invalid: number;
  gapFilled: number; // flat bars synthesised for empty intervals
  gapSkipped: number; // gaps too long to fill (outage)
}

/**
 * Tick -> fixed-width bar aggregator, tolerant of out-of-order delivery.
 *
 *  - Close = price of the latest trade by EXCHANGE timestamp (not arrival order).
 *  - A bar is finalised only once the watermark passes bar_end + graceMs, so trades that
 *    arrive slightly late still land in the right bar. Later than that: dropped and counted.
 *  - Duplicate trade ids (e.g. replay after reconnect) are ignored.
 *  - Empty intervals produce flat zero-volume bars (up to maxGapFill) so the engine sees
 *    contiguous time; longer gaps are skipped rather than fabricated.
 *  - Latest order-book imbalance sample per bar is attached to the bar.
 */
export class BarAggregator {
  readonly barMs: number;
  readonly stats: AggregatorStats = { late: 0, dupes: 0, invalid: 0, gapFilled: 0, gapSkipped: 0 };
  private readonly graceMs: number;
  private readonly maxGapFill: number;
  private readonly open = new Map<number, Bucket>();
  private readonly obi = new Map<number, number>();
  private readonly seen = new Set<string | number>();
  private readonly seenOrder: (string | number)[] = [];
  private readonly seenCap: number;
  private lastEmitted: number | null = null;
  private lastClose: number | null = null;
  private maxTs = -Infinity;

  constructor(opts: { barSeconds: number; graceMs?: number; maxGapFill?: number; dedupeCap?: number }) {
    this.barMs = opts.barSeconds * 1000;
    this.graceMs = opts.graceMs ?? 2000;
    this.maxGapFill = opts.maxGapFill ?? 10;
    this.seenCap = opts.dedupeCap ?? 5000;
  }

  /** Continue after a history backfill: bars at or before lastBarStart are considered emitted. */
  seed(lastBarStart: number, lastClose: number): void {
    this.lastEmitted = lastBarStart;
    this.lastClose = lastClose;
  }

  push(trade: Trade): Bar[] {
    if (!(trade.price > 0) || !(trade.qty >= 0) || !Number.isFinite(trade.t)) {
      this.stats.invalid++;
      return [];
    }
    if (trade.id !== undefined) {
      if (this.seen.has(trade.id)) {
        this.stats.dupes++;
        return [];
      }
      this.seen.add(trade.id);
      this.seenOrder.push(trade.id);
      if (this.seenOrder.length > this.seenCap) this.seen.delete(this.seenOrder.shift()!);
    }
    const start = Math.floor(trade.t / this.barMs) * this.barMs;
    if (this.lastEmitted !== null && start <= this.lastEmitted) {
      this.stats.late++;
      return [];
    }
    let b = this.open.get(start);
    if (!b) {
      b = { t: start, close: trade.price, closeTs: trade.t, volume: 0 };
      this.open.set(start, b);
    }
    b.volume += trade.qty;
    if (trade.t >= b.closeTs) {
      b.close = trade.price;
      b.closeTs = trade.t;
    }
    if (trade.t > this.maxTs) this.maxTs = trade.t;
    return this.flush(this.maxTs);
  }

  /** Attach the latest order-book imbalance sample (in [-1,1]) to the bar containing `t`. */
  setObi(t: number, value: number): void {
    if (!Number.isFinite(value)) return;
    const start = Math.floor(t / this.barMs) * this.barMs;
    if (this.lastEmitted !== null && start <= this.lastEmitted) return;
    this.obi.set(start, Math.max(-1, Math.min(1, value)));
  }

  /** Advance the watermark without a trade (illiquid symbols, wall-clock driven). */
  advance(watermarkMs: number): Bar[] {
    return this.flush(Math.max(watermarkMs, this.maxTs));
  }

  /** The still-forming bar (for live display only; never fed to the engine). */
  forming(): { t: number; price: number } | null {
    let latest: Bucket | null = null;
    for (const b of this.open.values()) if (!latest || b.t > latest.t) latest = b;
    return latest ? { t: latest.t, price: latest.close } : null;
  }

  private emit(t: number, close: number, volume: number, out: Bar[]): void {
    const bar: Bar = { t, close, volume };
    const o = this.obi.get(t);
    if (o !== undefined) bar.obi = o;
    this.obi.delete(t);
    out.push(bar);
    this.lastEmitted = t;
    this.lastClose = close;
  }

  private fillTo(untilExclusive: number, out: Bar[]): void {
    if (this.lastEmitted === null || this.lastClose === null) return;
    const missing = (untilExclusive - this.lastEmitted) / this.barMs - 1;
    if (missing <= 0) return;
    if (missing > this.maxGapFill) {
      this.stats.gapSkipped++;
      this.lastEmitted = untilExclusive - this.barMs;
      return;
    }
    for (let t = this.lastEmitted + this.barMs; t < untilExclusive; t += this.barMs) {
      this.emit(t, this.lastClose, 0, out);
      this.stats.gapFilled++;
    }
  }

  private flush(watermark: number): Bar[] {
    const out: Bar[] = [];
    const ready = [...this.open.values()]
      .filter((b) => b.t + this.barMs + this.graceMs <= watermark)
      .sort((a, b) => a.t - b.t);
    for (const b of ready) {
      this.fillTo(b.t, out);
      this.emit(b.t, b.close, b.volume, out);
      this.open.delete(b.t);
    }
    // Empty trailing intervals that have fully elapsed (no trades at all).
    if (this.lastEmitted !== null) {
      const completeEnd = Math.floor((watermark - this.graceMs) / this.barMs) * this.barMs; // start of first incomplete bar
      const firstOpen = Math.min(completeEnd, ...[...this.open.keys()]);
      if (firstOpen > this.lastEmitted + this.barMs) this.fillTo(firstOpen, out);
    }
    for (const k of this.obi.keys()) if (this.lastEmitted !== null && k <= this.lastEmitted) this.obi.delete(k);
    return out;
  }
}
