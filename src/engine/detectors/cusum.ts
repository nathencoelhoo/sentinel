import type { Detector } from '../types.ts';
import { EwmaVar } from '../stats.ts';

/**
 * Two-sided CUSUM on standardised returns (Page, 1954).
 *
 *   $$ z_t = r_t / \hat\sigma_{t-1}, \quad
 *      S^+_t = \max(0, S^+_{t-1} + z_t - k), \quad
 *      S^-_t = \max(0, S^-_{t-1} - z_t - k) $$
 *
 * Output is max(S+, S-). On exceeding h the sums restart (standard CUSUM
 * practice) after the exceeding value has been reported. Sigma-hat is an EWMA
 * winsorised at 5 sigma so a single crash bar does not hide the drift behind it.
 */
export class Cusum implements Detector {
  readonly name = 'cusum';
  readonly optional = false;
  private readonly scale = new EwmaVar(0.99);
  private sPos = 0;
  private sNeg = 0;
  private n = 0;
  private readonly k: number;
  private readonly h: number;
  private readonly warmup: number;

  constructor(opts: { k?: number; h?: number; warmup?: number } = {}) {
    this.k = opts.k ?? 0.5;
    this.h = opts.h ?? 10;
    this.warmup = opts.warmup ?? 100;
  }

  update(_bar: unknown, ret: number): number | null {
    const s = this.scale.sigma;
    this.scale.update(ret, 5);
    this.n++;
    if (s === null || this.n < this.warmup) return null;
    const z = ret / Math.max(s, 1e-9);
    this.sPos = Math.max(0, this.sPos + z - this.k);
    this.sNeg = Math.max(0, this.sNeg - z - this.k);
    const out = Math.max(this.sPos, this.sNeg);
    if (out > this.h) {
      this.sPos = 0;
      this.sNeg = 0;
    }
    return out;
  }
}
