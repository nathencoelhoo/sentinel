import type { Detector } from '../types.ts';
import { EwmaVar } from '../stats.ts';

/**
 * EWMA volatility band: ratio of fast to slow RiskMetrics-style volatility.
 *
 *   $$ \sigma^2_{t,\lambda} = \lambda \sigma^2_{t-1,\lambda} + (1-\lambda) r_t^2, \qquad
 *      s_t = \sigma_{t,0.94} / \sigma_{t,0.995} $$
 *
 * s_t >> 1 means short-horizon volatility has broken out of its long-run band.
 */
export class EwmaVol implements Detector {
  readonly name = 'ewma_vol';
  readonly optional = false;
  private readonly fast = new EwmaVar(0.94);
  private readonly slow = new EwmaVar(0.995);
  private n = 0;
  private readonly warmup: number;

  constructor(warmup = 100) {
    this.warmup = warmup;
  }

  update(_bar: unknown, ret: number): number | null {
    this.fast.update(ret);
    this.slow.update(ret);
    this.n++;
    if (this.n < this.warmup) return null;
    return (this.fast.sigma ?? 0) / Math.max(this.slow.sigma ?? 0, 1e-9);
  }
}
