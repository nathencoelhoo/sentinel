/**
 * Online logistic ensemble over per-detector "surprise" features x_j >= 0.
 *
 *   $$ p = \sigma\Big(b + \sum_j w_j x_j\Big), \qquad \sigma(z) = 1/(1+e^{-z}) $$
 *
 * Prior (the hand-tuned "fixed" ensemble): w_j = 1.5/n, b = -4.5, i.e.
 * p = sigma(1.5 (mean(x) - 3)): ~5% at typical surprise (mean x ~ 1), 50% at mean x = 3.
 *
 * Learned variant: SGD on log-loss with an L2 pull back to the prior and
 * non-negativity (more surprise can never lower the anomaly probability):
 *
 *   $$ w_j \leftarrow \max\big(0,\; w_j - \eta[(p - y) x_j + \lambda (w_j - w_j^{0})]\big) $$
 *
 * lr = 0 gives exactly the fixed ensemble.
 */
export class LogisticEnsemble {
  readonly w: number[];
  b: number;
  readonly lr: number;
  readonly l2: number;
  private readonly w0: number[];
  private readonly b0: number;

  constructor(n: number, opts: { lr?: number; l2?: number; w0?: number[]; b0?: number } = {}) {
    this.lr = opts.lr ?? 0;
    this.l2 = opts.l2 ?? 0.01;
    this.w0 = opts.w0 ?? new Array<number>(n).fill(1.5 / n);
    this.b0 = opts.b0 ?? -4.5;
    this.w = [...this.w0];
    this.b = this.b0;
  }

  predict(x: number[]): { p: number; logit: number; contributions: number[] } {
    let logit = this.b;
    const contributions = x.map((xj, j) => this.w[j] * xj);
    for (const c of contributions) logit += c;
    return { p: 1 / (1 + Math.exp(-logit)), logit, contributions };
  }

  update(x: number[], y: 0 | 1): void {
    if (this.lr === 0) return;
    const { p } = this.predict(x);
    const err = p - y;
    const clip = (g: number) => Math.max(-5, Math.min(5, g));
    for (let j = 0; j < this.w.length; j++) {
      const g = clip(err * x[j] + this.l2 * (this.w[j] - this.w0[j]));
      this.w[j] = Math.max(0, this.w[j] - this.lr * g);
    }
    this.b -= this.lr * clip(err + this.l2 * (this.b - this.b0));
  }
}
