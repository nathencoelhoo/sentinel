import type { AlertEngine, Bar } from '../types.ts';
import { RingBuffer } from '../stats.ts';
import { AdaptiveThreshold } from '../threshold.ts';

export interface ZBaselineOptions {
  /** 'fixed': classic |z| > fixedZ rule. 'matched': same statistic, adaptive threshold at the same alarm budget as SENTINEL. */
  mode: 'fixed' | 'matched';
  barSeconds: number;
  alarmsPerDay: number;
  window?: number;
  fixedZ?: number;
  cooldownBars?: number;
  warmupBars?: number;
}

/** Naive baseline: rolling mean/std z-score of log returns. */
export class ZScoreBaseline implements AlertEngine {
  private readonly o: Required<ZBaselineOptions>;
  private readonly win: RingBuffer;
  private readonly thr: AdaptiveThreshold;
  private prev: number | null = null;
  private count = 0;
  private sinceAlert: number;

  constructor(opts: ZBaselineOptions) {
    this.o = { window: 100, fixedZ: 3, cooldownBars: 15, warmupBars: 310, ...opts };
    this.win = new RingBuffer(this.o.window);
    this.sinceAlert = this.o.cooldownBars;
    this.thr = new AdaptiveThreshold({
      window: 1440,
      exceedRate: (opts.alarmsPerDay * opts.barSeconds) / 86400,
      minObs: 300,
      floor: 0,
      cooldown: this.o.cooldownBars,
    });
  }

  update(bar: Bar): { t: number; ready: boolean; alert: boolean; score: number } {
    if (this.prev === null || !(bar.close > 0) || !(this.prev > 0)) {
      this.prev = bar.close;
      return { t: bar.t, ready: false, alert: false, score: 0 };
    }
    const ret = Math.log(bar.close / this.prev);
    this.prev = bar.close;
    let z = 0;
    if (this.win.length >= this.o.window) {
      let mean = 0;
      for (let i = 0; i < this.win.length; i++) mean += this.win.at(i);
      mean /= this.win.length;
      let v = 0;
      for (let i = 0; i < this.win.length; i++) v += (this.win.at(i) - mean) ** 2;
      const sd = Math.sqrt(v / (this.win.length - 1));
      z = sd > 0 ? Math.abs(ret - mean) / sd : 0;
    }
    this.win.push(ret);
    this.count++;
    const ready = this.count >= this.o.warmupBars;

    let alert: boolean;
    if (this.o.mode === 'matched') {
      alert = this.thr.update(z).alert;
    } else {
      this.sinceAlert++;
      alert = z > this.o.fixedZ && this.sinceAlert >= this.o.cooldownBars;
      if (alert) this.sinceAlert = 0;
    }
    return { t: bar.t, ready, alert: ready && alert, score: z };
  }
}
