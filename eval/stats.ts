import { mulberry32 } from '../src/sim/rng.ts';

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = Math.min(Math.max(q, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return percentile(s, 0.5);
}

export interface CI {
  est: number;
  lo: number;
  hi: number;
  /** Number of valid bootstrap resamples behind lo/hi. */
  n: number;
}

/**
 * Cluster bootstrap. Events on the same calendar day (e.g. BTC and ETH on 2020-03-12) are not
 * independent, so whole clusters are resampled with replacement; `stat` receives event indices.
 * Using one `stat` that computes a DIFFERENCE gives a paired interval (same resamples for both methods).
 * Percentile interval, 95%. Resamples where stat is NaN (e.g. no detected events) are skipped.
 */
export function bootstrapClusters(clusterIds: string[], stat: (idx: number[]) => number, reps: number, seed: number): CI {
  const groups = new Map<string, number[]>();
  clusterIds.forEach((c, i) => {
    const g = groups.get(c);
    if (g) g.push(i);
    else groups.set(c, [i]);
  });
  const g = [...groups.values()];
  const est = stat(clusterIds.map((_, i) => i));
  const rng = mulberry32(seed);
  const samples: number[] = [];
  for (let r = 0; r < reps; r++) {
    const idx: number[] = [];
    for (let k = 0; k < g.length; k++) idx.push(...g[Math.floor(rng() * g.length)]);
    const v = stat(idx);
    if (Number.isFinite(v)) samples.push(v);
  }
  samples.sort((a, b) => a - b);
  if (samples.length < 20) return { est, lo: NaN, hi: NaN, n: samples.length };
  return { est, lo: percentile(samples, 0.025), hi: percentile(samples, 0.975), n: samples.length };
}
