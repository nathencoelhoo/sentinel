/** Fixed-capacity FIFO ring buffer of numbers. */
export class RingBuffer {
  readonly capacity: number;
  private readonly buf: number[];
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array<number>(capacity).fill(0);
  }
  push(x: number): void {
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  get length(): number {
    return this.count;
  }
  /** i = 0 is the oldest retained element. */
  at(i: number): number {
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.buf[(start + i) % this.capacity];
  }
  toArray(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.at(i));
    return out;
  }
}

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}
function upperBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Rolling window that also keeps a sorted copy: O(1) median, O(log n) rank, O(n) insert. */
export class SortedWindow {
  readonly capacity: number;
  private readonly ring: number[] = [];
  private readonly sorted: number[] = [];
  private idx = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }
  get size(): number {
    return this.sorted.length;
  }
  get values(): readonly number[] {
    return this.sorted;
  }
  push(x: number): void {
    if (!Number.isFinite(x)) return;
    if (this.ring.length < this.capacity) {
      this.ring.push(x);
    } else {
      const old = this.ring[this.idx];
      this.sorted.splice(lowerBound(this.sorted, old), 1);
      this.ring[this.idx] = x;
      this.idx = (this.idx + 1) % this.capacity;
    }
    this.sorted.splice(lowerBound(this.sorted, x), 0, x);
  }
  /** Mid-rank empirical CDF in (0,1): (#{<x} + 0.5 #{==x}) / (n+1). Query BEFORE pushing x. */
  ecdf(x: number): number {
    const lo = lowerBound(this.sorted, x);
    const hi = upperBound(this.sorted, x);
    return (lo + 0.5 * (hi - lo)) / (this.sorted.length + 1);
  }
  quantile(q: number): number {
    const n = this.sorted.length;
    if (n === 0) return NaN;
    const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return this.sorted[lo] + (this.sorted[hi] - this.sorted[lo]) * (pos - lo);
  }
  median(): number {
    return this.quantile(0.5);
  }
}

/** Robust scale: sigma_hat = 1.4826 * MAD (consistent for Gaussian data). */
export function robustSigma(w: SortedWindow): number {
  const med = w.median();
  const dev = w.values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const m = dev.length;
  if (m === 0) return NaN;
  const mad = m % 2 ? dev[(m - 1) / 2] : (dev[m / 2 - 1] + dev[m / 2]) / 2;
  return 1.4826 * mad;
}

/** Zero-mean EWMA of squared inputs with optional winsorisation (contamination guard). */
export class EwmaVar {
  readonly lambda: number;
  private v: number | null = null;
  constructor(lambda: number) {
    this.lambda = lambda;
  }
  get sigma(): number | null {
    return this.v === null ? null : Math.sqrt(this.v);
  }
  update(x: number, clip = Infinity): void {
    if (this.v === null || this.v <= 0) {
      this.v = x * x;
      return;
    }
    let y = x;
    const c = clip * Math.sqrt(this.v);
    if (Math.abs(y) > c) y = Math.sign(y) * c;
    this.v = this.lambda * this.v + (1 - this.lambda) * y * y;
  }
}

/** Lanczos approximation of ln Gamma(x). */
export function lgamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const xm = x - 1;
  let a = c[0];
  const t = xm + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (xm + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm + 0.5) * Math.log(t) - t + Math.log(a);
}

export function logaddexp(a: number, b: number): number {
  const m = Math.max(a, b);
  if (m === -Infinity) return -Infinity;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

export function logsumexp(xs: number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

export function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
