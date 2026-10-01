import type { AlertEngine, Bar, Detector, DetectorReading, EngineOutput } from './types.ts';
import { EwmaVar, SortedWindow } from './stats.ts';
import { LogisticEnsemble } from './ensemble.ts';
import { AdaptiveThreshold } from './threshold.ts';
import { RobustZ } from './detectors/robustZ.ts';
import { EwmaVol } from './detectors/ewmaVol.ts';
import { Cusum } from './detectors/cusum.ts';
import { Bocpd } from './detectors/bocpd.ts';
import { VolumeSpike } from './detectors/volumeSpike.ts';

export interface EngineConfig {
  symbol: string;
  barSeconds: number;
  /** 'fixed' = hand-tuned prior weights; 'learned' = online logistic with delayed weak labels. */
  ensemble: 'fixed' | 'learned';
  /** Target exceedance budget per day (controls the adaptive threshold quantile). */
  alarmsPerDay: number;
  cooldownBars: number;
  /** Optional absolute floor on p for an alert (0 = pure quantile rule). */
  minP: number;
  ecdfWindow: number;
  ecdfMin: number;
  thresholdWindow: number;
  lr: number;
  l2: number;
  /** Weak label: a |return| >= labelTheta * sigma_t occurs within the next labelHorizon bars. */
  labelHorizon: number;
  labelTheta: number;
}

export function defaultConfig(symbol: string, o: Partial<EngineConfig> = {}): EngineConfig {
  return {
    symbol,
    barSeconds: 60,
    ensemble: 'fixed',
    alarmsPerDay: 6,
    cooldownBars: 15,
    minP: 0,
    ecdfWindow: 2000,
    ecdfMin: 200,
    thresholdWindow: 1440,
    lr: 0.002,
    l2: 0.01,
    labelHorizon: 30,
    labelTheta: 4,
    ...o,
  };
}

export function defaultDetectors(): Detector[] {
  return [
    new RobustZ('robust_z', (_b, r) => r),
    new EwmaVol(),
    new Cusum(),
    new Bocpd(),
    new VolumeSpike(),
    new RobustZ('order_book_imbalance', (b) => b.obi, { optional: true }),
  ];
}

/**
 * SENTINEL per-symbol streaming engine.
 *
 * Pipeline per bar (strictly causal):
 *   1. each detector emits a raw statistic s_j
 *   2. rolling ECDF (queried before insertion): u_j = F_hat(s_j)
 *   3. surprise feature x_j = -ln(1 - u_j)   (Exp(1)-distributed under the null)
 *   4. missing features are imputed with the mean of the present ones
 *   5. ensemble probability p; adaptive quantile threshold -> alert
 *   6. (learned mode) features are queued and the ensemble is updated with a
 *      weak label only once `labelHorizon` bars have elapsed (delayed feedback,
 *      so no label ever uses information the engine could not have had).
 */
export class SentinelEngine implements AlertEngine {
  readonly cfg: EngineConfig;
  private readonly detectors: Detector[];
  private readonly ecdfs: SortedWindow[];
  private readonly ensemble: LogisticEnsemble;
  private readonly threshold: AdaptiveThreshold;
  private readonly sigma = new EwmaVar(0.99);
  private prevClose: number | null = null;
  private idx = 0;
  private hist: number[] = [];
  private pending: { idx: number; x: number[]; sigma: number }[] = [];

  constructor(cfg: EngineConfig, detectors: Detector[] = defaultDetectors()) {
    this.cfg = cfg;
    this.detectors = detectors;
    this.ecdfs = detectors.map(() => new SortedWindow(cfg.ecdfWindow));
    this.ensemble = new LogisticEnsemble(detectors.length, {
      lr: cfg.ensemble === 'learned' ? cfg.lr : 0,
      l2: cfg.l2,
    });
    this.threshold = new AdaptiveThreshold({
      window: cfg.thresholdWindow,
      exceedRate: (cfg.alarmsPerDay * cfg.barSeconds) / 86400,
      minObs: 300,
      floor: cfg.minP,
      cooldown: cfg.cooldownBars,
    });
  }

  get weights(): { names: string[]; w: number[]; b: number } {
    return { names: this.detectors.map((d) => d.name), w: [...this.ensemble.w], b: this.ensemble.b };
  }

  private notReady(t: number): EngineOutput {
    return { t, symbol: this.cfg.symbol, ready: false, p: 0, score: 0, threshold: 1, alert: false, detectors: [] };
  }

  private matureLabels(): void {
    const H = this.cfg.labelHorizon;
    while (this.pending.length > 0 && this.pending[0].idx + H <= this.idx) {
      const item = this.pending.shift()!;
      if (item.idx + H !== this.idx) continue;
      let m = 0;
      for (const v of this.hist) if (v > m) m = v;
      const y = item.sigma > 0 && m >= this.cfg.labelTheta * item.sigma ? 1 : 0;
      this.ensemble.update(item.x, y);
    }
  }

  update(bar: Bar): EngineOutput {
    if (this.prevClose === null || !(this.prevClose > 0) || !(bar.close > 0)) {
      this.prevClose = bar.close;
      return this.notReady(bar.t);
    }
    const ret = Math.log(bar.close / this.prevClose);
    this.prevClose = bar.close;
    if (!Number.isFinite(ret)) return this.notReady(bar.t);

    this.idx++;
    this.sigma.update(ret, 6);
    this.hist.push(Math.abs(ret));
    if (this.hist.length > this.cfg.labelHorizon) this.hist.shift();
    this.matureLabels();

    const feats: (number | null)[] = [];
    const raws: (number | null)[] = [];
    for (let j = 0; j < this.detectors.length; j++) {
      const raw = this.detectors[j].update(bar, ret);
      raws.push(raw);
      if (raw !== null && Number.isFinite(raw)) {
        const e = this.ecdfs[j];
        feats.push(e.size >= this.cfg.ecdfMin ? -Math.log(1 - e.ecdf(raw)) : null);
        e.push(raw);
      } else {
        feats.push(null);
      }
    }

    for (let j = 0; j < this.detectors.length; j++) {
      if (!this.detectors[j].optional && feats[j] === null) return this.notReady(bar.t);
    }
    const present = feats.filter((f): f is number => f !== null);
    if (present.length === 0) return this.notReady(bar.t);
    const fill = present.reduce((a, b) => a + b, 0) / present.length;
    const x = feats.map((f) => f ?? fill);

    const { p, contributions } = this.ensemble.predict(x);
    const { threshold, alert } = this.threshold.update(p);
    this.pending.push({ idx: this.idx, x, sigma: this.sigma.sigma ?? 0 });

    const detectors: DetectorReading[] = this.detectors.map((d, j) => ({
      name: d.name,
      raw: raws[j],
      feature: x[j],
      contribution: contributions[j],
      imputed: feats[j] === null,
    }));
    return {
      t: bar.t,
      symbol: this.cfg.symbol,
      ready: true,
      p,
      score: Math.round(p * 1000) / 10,
      threshold,
      alert,
      detectors,
    };
  }
}
