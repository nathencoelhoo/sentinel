import type { Bar } from '../engine/types.ts';
import { SentinelEngine, defaultConfig } from '../engine/engine.ts';
import { ContagionTracker } from '../engine/contagion.ts';
import { BarAggregator } from '../feeds/aggregator.ts';
import type { Trade } from '../feeds/aggregator.ts';
import { BoundedQueue } from '../feeds/queue.ts';
import type { BackfillPoint, HostConfig, UiMessage } from './protocol.ts';

interface PerSymbol {
  agg: BarAggregator;
  engine: SentinelEngine;
  prevClose: number | null;
  barsSeen: number;
}

/**
 * Pure orchestration (no DOM / Worker globals, so it is unit-testable):
 *   trades -> bounded queue (backpressure) -> aggregator (out-of-order grace) -> engine -> UI messages
 * plus contagion across symbols and latency / throughput metrics.
 * Drive it by calling onTrade/onObi from the feeds and pump() every ~100 ms.
 */
export class SentinelHost {
  private readonly cfg: HostConfig;
  private readonly emit: (m: UiMessage) => void;
  private readonly now: () => number;
  private readonly perf: () => number;
  private readonly per = new Map<string, PerSymbol>();
  private readonly queue: BoundedQueue<{ s: string; trade: Trade }>;
  private readonly contagion = new ContagionTracker();
  private readonly pendingByT = new Map<number, Record<string, { ret: number; score: number }>>();
  private readonly latUs: number[] = [];
  private lagEwma = 0;
  private ticks = 0;
  private barsTotal = 0;
  private lastMetrics: number;
  private lastForming = 0;
  private lastTickCount = 0;
  private contagionEvery = 0;

  constructor(cfg: HostConfig, emit: (m: UiMessage) => void, now = () => Date.now(), perf = () => performance.now()) {
    this.cfg = cfg;
    this.emit = emit;
    this.now = now;
    this.perf = perf;
    this.queue = new BoundedQueue(cfg.maxQueue ?? 100_000);
    this.lastMetrics = now();
    for (const s of cfg.symbols) {
      this.per.set(s, {
        agg: new BarAggregator({ barSeconds: cfg.barSeconds, graceMs: cfg.graceMs ?? 2000 }),
        engine: new SentinelEngine(
          defaultConfig(s, { barSeconds: cfg.barSeconds, ensemble: cfg.ensemble, alarmsPerDay: cfg.alarmsPerDay }),
        ),
        prevClose: null,
        barsSeen: 0,
      });
    }
  }

  /** Warm the engine with historical bars (ascending, completed bars only) so it is ready immediately. */
  backfill(symbol: string, bars: Bar[]): void {
    const p = this.per.get(symbol);
    if (!p || bars.length === 0) return;
    const points: BackfillPoint[] = [];
    for (const b of bars) {
      const out = p.engine.update(b);
      p.prevClose = b.close;
      p.barsSeen++;
      points.push({ t: b.t, close: b.close, score: out.score, alert: out.alert });
    }
    const last = bars[bars.length - 1];
    p.agg.seed(last.t, last.close);
    this.emit({ type: 'backfill', symbol, points: points.slice(-600) });
  }

  onTrade(symbol: string, trade: Trade): void {
    if (!this.per.has(symbol)) return;
    this.queue.push({ s: symbol, trade });
    this.ticks++;
    const lag = Math.max(0, this.now() - trade.t);
    this.lagEwma = this.lagEwma === 0 ? lag : 0.98 * this.lagEwma + 0.02 * lag;
  }

  /** Order-book imbalance sample; attached to the bar containing the current time. */
  onObi(symbol: string, obi: number): void {
    this.per.get(symbol)?.agg.setObi(this.now(), obi);
  }

  pump(): void {
    const now = this.now();
    for (const { s, trade } of this.queue.drain(this.cfg.maxPerPump ?? 20_000)) {
      const p = this.per.get(s)!;
      for (const bar of p.agg.push(trade)) this.processBar(s, p, bar);
    }
    const watermark = now - Math.min(Math.max(this.lagEwma, 0), 5000);
    for (const [s, p] of this.per) for (const bar of p.agg.advance(watermark)) this.processBar(s, p, bar);

    if (now - this.lastForming >= 500) {
      this.lastForming = now;
      for (const [s, p] of this.per) {
        const f = p.agg.forming();
        if (f) this.emit({ type: 'forming', symbol: s, t: f.t, price: f.price });
      }
    }
    if (now - this.lastMetrics >= 1000) this.emitMetrics(now);
  }

  private processBar(symbol: string, p: PerSymbol, bar: Bar): void {
    const t0 = this.perf();
    const out = p.engine.update(bar);
    const dtUs = (this.perf() - t0) * 1000;
    this.latUs.push(dtUs);
    if (this.latUs.length > 512) this.latUs.shift();
    this.barsTotal++;
    p.barsSeen++;
    const ret = p.prevClose && p.prevClose > 0 ? Math.log(bar.close / p.prevClose) : 0;
    p.prevClose = bar.close;

    this.emit({
      type: 'bar',
      symbol,
      t: bar.t,
      close: bar.close,
      volume: bar.volume,
      ret,
      ready: out.ready,
      score: out.score,
      p: out.p,
      threshold: out.threshold,
      alert: out.alert,
      detectors: out.detectors,
    });
    if (out.ready && out.alert) {
      this.emit({
        type: 'alert',
        symbol,
        t: bar.t,
        price: bar.close,
        score: out.score,
        p: out.p,
        threshold: out.threshold,
        detectors: out.detectors,
      });
    }
    if (this.cfg.ensemble === 'learned' && p.barsSeen % 10 === 0) {
      this.emit({ type: 'weights', symbol, ...p.engine.weights });
    }
    this.trackContagion(symbol, bar.t, ret, out.score);
  }

  private trackContagion(symbol: string, t: number, ret: number, score: number): void {
    const rec = this.pendingByT.get(t) ?? {};
    rec[symbol] = { ret, score };
    this.pendingByT.set(t, rec);
    if (Object.keys(rec).length === this.per.size) {
      this.contagion.update(rec);
      this.pendingByT.delete(t);
      if (++this.contagionEvery % 5 === 0) {
        this.emit({ type: 'contagion', links: this.contagion.snapshot(), warnings: this.contagion.warnings(50) });
      }
    }
    const horizon = t - 5 * this.cfg.barSeconds * 1000;
    for (const k of this.pendingByT.keys()) if (k < horizon) this.pendingByT.delete(k);
  }

  private emitMetrics(now: number): void {
    const dt = Math.max(1, now - this.lastMetrics) / 1000;
    const sorted = [...this.latUs].sort((a, b) => a - b);
    const q = (f: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : 0);
    let late = 0;
    let dupes = 0;
    let gap = 0;
    for (const p of this.per.values()) {
      late += p.agg.stats.late;
      dupes += p.agg.stats.dupes;
      gap += p.agg.stats.gapFilled;
    }
    this.emit({
      type: 'metrics',
      m: {
        t: now,
        ticksPerSec: Math.round((this.ticks - this.lastTickCount) / dt),
        queueDepth: this.queue.length,
        dropped: this.queue.dropped,
        bars: this.barsTotal,
        engineP50Us: Math.round(q(0.5)),
        engineP95Us: Math.round(q(0.95)),
        feedLagMs: Math.round(this.lagEwma),
        late,
        dupes,
        gapFilled: gap,
      },
    });
    this.lastTickCount = this.ticks;
    this.lastMetrics = now;
  }
}
