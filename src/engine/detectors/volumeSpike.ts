import type { Bar, Detector } from '../types.ts';
import { SortedWindow } from '../stats.ts';

/**
 * Volume spike ratio: v_t / median(v_{t-W:t-1}). Median (not mean) so earlier
 * spikes do not mask new ones. No intraday seasonality adjustment (documented limitation).
 */
export class VolumeSpike implements Detector {
  readonly name = 'volume_spike';
  readonly optional = false;
  private readonly win: SortedWindow;
  private readonly minObs: number;

  constructor(opts: { window?: number; minObs?: number } = {}) {
    this.win = new SortedWindow(opts.window ?? 240);
    this.minObs = opts.minObs ?? 60;
  }

  update(bar: Bar): number | null {
    const v = bar.volume;
    if (!Number.isFinite(v) || v < 0) return null;
    let out: number | null = null;
    if (this.win.size >= this.minObs) out = v / Math.max(this.win.median(), 1e-9);
    this.win.push(v);
    return out;
  }
}
