import type { Bar, Detector } from '../types.ts';
import { SortedWindow, robustSigma } from '../stats.ts';

/**
 * Robust z-score (median / MAD). Used for returns and for order-book imbalance.
 *
 *   $$ z_t = \frac{|x_t - \mathrm{med}(x_{t-W:t-1})|}{1.4826 \cdot \mathrm{MAD}(x_{t-W:t-1})} $$
 *
 * The window excludes x_t (causal) and median/MAD have a 50% breakdown point,
 * so past crashes do not inflate the scale the way a rolling std-dev does.
 */
export class RobustZ implements Detector {
  readonly name: string;
  readonly optional: boolean;
  private readonly win: SortedWindow;
  private readonly minObs: number;
  private readonly extract: (bar: Bar, ret: number) => number | undefined;

  constructor(
    name: string,
    extract: (bar: Bar, ret: number) => number | undefined,
    opts: { window?: number; minObs?: number; optional?: boolean } = {},
  ) {
    this.name = name;
    this.extract = extract;
    this.optional = opts.optional ?? false;
    this.win = new SortedWindow(opts.window ?? 240);
    this.minObs = opts.minObs ?? 60;
  }

  update(bar: Bar, ret: number): number | null {
    const x = this.extract(bar, ret);
    if (x === undefined || !Number.isFinite(x)) return null;
    let out: number | null = null;
    if (this.win.size >= this.minObs) {
      const sigma = Math.max(robustSigma(this.win), 1e-6);
      out = Math.abs(x - this.win.median()) / sigma;
    }
    this.win.push(x);
    return out;
  }
}
