/** One aggregated market bar. Feeds aggregate raw ticks into fixed-width bars. */
export interface Bar {
  t: number; // bar open time, ms since epoch (UTC)
  close: number;
  volume: number; // base-asset volume traded in the bar
  obi?: number; // optional L2 order-book imbalance in [-1, 1]
}

export interface Detector {
  readonly name: string;
  /** True if the detector may legitimately be absent (e.g. no L2 feed). */
  readonly optional: boolean;
  /**
   * Causal update: consumes bar t (and its log return) and returns a raw
   * non-negative anomaly statistic using only data up to and including t,
   * or null while warming up / when its input is unavailable.
   */
  update(bar: Bar, ret: number): number | null;
}

export interface DetectorReading {
  name: string;
  raw: number | null;
  feature: number; // surprise feature -ln(1-u) fed to the ensemble
  contribution: number; // w_j * x_j, in logit units (explainability)
  imputed: boolean;
}

export interface EngineOutput {
  t: number;
  symbol: string;
  ready: boolean;
  p: number; // ensemble probability in [0,1]
  score: number; // 100 * p
  threshold: number; // adaptive alert threshold on p
  alert: boolean;
  detectors: DetectorReading[];
}

/** Minimal interface shared by SENTINEL and the baselines so the harness treats them alike. */
export interface AlertEngine {
  update(bar: Bar): { t: number; ready: boolean; alert: boolean; score: number };
}
