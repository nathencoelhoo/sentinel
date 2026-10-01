import type { Detector } from '../types.ts';
import { EwmaVar, lgamma, logaddexp, logsumexp } from '../stats.ts';

/** Log-density of the Student-t posterior predictive of a Normal-Gamma model. */
export function studentTLogPdf(x: number, mu: number, kappa: number, alpha: number, beta: number): number {
  const df = 2 * alpha;
  const scale2 = (beta * (kappa + 1)) / (alpha * kappa);
  return (
    lgamma((df + 1) / 2) -
    lgamma(df / 2) -
    0.5 * Math.log(df * Math.PI * scale2) -
    ((df + 1) / 2) * Math.log(1 + (x - mu) ** 2 / (df * scale2))
  );
}

/**
 * Bayesian online changepoint detection (Adams & MacKay, 2007) with a
 * Normal-Gamma conjugate model on standardised returns and constant hazard H.
 *
 *   $$ P(r_t \mid x_{1:t}) \propto \sum_{r_{t-1}} P(x_t \mid r_{t-1}, x^{(r)}) \, P(r_t \mid r_{t-1}) \, P(r_{t-1} \mid x_{1:t-1}) $$
 *   $$ P(r_t = 0 \mid \cdot) = H \sum_{r} \pi_r P(r), \qquad P(r_t = r+1 \mid \cdot) = (1-H)\,\pi_r P(r) $$
 *
 * With constant hazard, P(r_t = 0) equals H identically, so the informative
 * output is the mass on SHORT run lengths: S_t = P(r_t <= shortRun). It jumps
 * towards 1 once a new regime has been "explained" by a recently born run.
 * Run lengths are truncated at maxRun by merging the tail bucket.
 */
export class Bocpd implements Detector {
  readonly name = 'bocpd';
  readonly optional = false;
  private readonly scale = new EwmaVar(0.99);
  private n = 0;
  private logR: number[] = [0];
  private mu: number[] = [0];
  private kappa: number[] = [1];
  private alpha: number[] = [1];
  private beta: number[] = [1];
  private readonly hazard: number;
  private readonly maxRun: number;
  private readonly shortRun: number;
  private readonly warmup: number;

  constructor(opts: { hazard?: number; maxRun?: number; shortRun?: number; warmup?: number } = {}) {
    this.hazard = opts.hazard ?? 1 / 200;
    this.maxRun = opts.maxRun ?? 150;
    this.shortRun = opts.shortRun ?? 5;
    this.warmup = opts.warmup ?? 100;
  }

  update(_bar: unknown, ret: number): number | null {
    const s = this.scale.sigma;
    this.scale.update(ret, 6);
    this.n++;
    if (s === null || this.n < this.warmup) return null;
    const x = Math.max(-15, Math.min(15, ret / Math.max(s, 1e-9)));

    const m = this.logR.length;
    const joint = new Array<number>(m);
    for (let i = 0; i < m; i++) {
      joint[i] = this.logR[i] + studentTLogPdf(x, this.mu[i], this.kappa[i], this.alpha[i], this.beta[i]);
    }
    const logH = Math.log(this.hazard);
    const log1mH = Math.log1p(-this.hazard);

    const logR = [logsumexp(joint) + logH];
    const mu = [0];
    const kappa = [1];
    const alpha = [1];
    const beta = [1];
    for (let i = 0; i < m; i++) {
      logR.push(joint[i] + log1mH);
      const k1 = this.kappa[i] + 1;
      mu.push((this.kappa[i] * this.mu[i] + x) / k1);
      kappa.push(k1);
      alpha.push(this.alpha[i] + 0.5);
      beta.push(this.beta[i] + (this.kappa[i] * (x - this.mu[i]) ** 2) / (2 * k1));
    }
    if (logR.length > this.maxRun + 1) {
      const L = logR.length;
      logR[L - 2] = logaddexp(logR[L - 2], logR[L - 1]);
      mu[L - 2] = mu[L - 1];
      kappa[L - 2] = kappa[L - 1];
      alpha[L - 2] = alpha[L - 1];
      beta[L - 2] = beta[L - 1];
      logR.pop();
      mu.pop();
      kappa.pop();
      alpha.pop();
      beta.pop();
    }
    const z = logsumexp(logR);
    for (let i = 0; i < logR.length; i++) logR[i] -= z;
    this.logR = logR;
    this.mu = mu;
    this.kappa = kappa;
    this.alpha = alpha;
    this.beta = beta;

    let mass = 0;
    for (let i = 0; i < Math.min(this.shortRun, logR.length); i++) mass += Math.exp(logR[i]);
    return mass;
  }
}
