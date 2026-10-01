import type { Bar } from '../engine/types.ts';
import { mulberry32, randn } from './rng.ts';

export interface SimEventSpec {
  type: 'vol' | 'drift' | 'jump';
  /** Start bar index. */
  at: number;
  /** Duration in bars. */
  len: number;
  /** vol: sigma multiplier. drift/jump: signed size in units of base sigma (0.0005). */
  mag: number;
}
export interface SimOptions {
  n: number;
  seed: number;
  barSeconds?: number;
  events?: SimEventSpec[];
  /** Emit a synthetic order-book imbalance series (off by default: keeps synthetic evals unflattering). */
  withObi?: boolean;
  symbol?: string;
  t0?: number;
}
export interface SimEventWindow {
  name: string;
  symbol: string;
  start: number;
  end: number;
  onset: number;
}

const SIGMA0 = 0.0005;

/** Student-t(4) innovation scaled to unit variance (fat tails like real returns). */
function tInnov(rng: () => number): number {
  const z = randn(rng);
  let chi = 0;
  for (let i = 0; i < 4; i++) chi += randn(rng) ** 2;
  return z / Math.sqrt(chi / 4) / Math.SQRT2;
}

/** Synthetic 1-bar series: slow stochastic volatility, fat tails, volume tied to |return|, injected events. */
export function simulate(o: SimOptions): { bars: Bar[]; events: SimEventWindow[] } {
  const rng = mulberry32(o.seed);
  const dt = (o.barSeconds ?? 60) * 1000;
  const t0 = o.t0 ?? Date.UTC(2024, 0, 1);
  const symbol = o.symbol ?? 'SIM';
  const evs = o.events ?? [];
  let price = 100;
  let lv = 0;
  const bars: Bar[] = [];
  for (let i = 0; i < o.n; i++) {
    lv = 0.995 * lv + 0.06 * randn(rng);
    let sig = SIGMA0 * Math.exp(lv);
    let volMult = 1;
    let drift = 0;
    let jump = 0;
    let obiShift = 0;
    for (const ev of evs) {
      if (i < ev.at || i >= ev.at + ev.len) continue;
      if (ev.type === 'vol') {
        sig *= ev.mag;
        volMult *= 3;
      } else if (ev.type === 'drift') {
        drift += ev.mag * SIGMA0;
        volMult *= 2;
        obiShift += Math.sign(ev.mag) * 0.4;
      } else {
        if (i === ev.at) {
          jump = ev.mag * SIGMA0;
          volMult *= 5;
          obiShift += Math.sign(ev.mag) * 0.4;
        } else {
          sig *= 2;
        }
      }
    }
    const ret = drift + jump + sig * tInnov(rng);
    price *= Math.exp(ret);
    const volume = 10 * Math.exp(0.3 * randn(rng)) * (1 + Math.abs(ret) / 0.001) * volMult;
    const bar: Bar = { t: t0 + i * dt, close: price, volume };
    if (o.withObi) bar.obi = Math.max(-1, Math.min(1, 0.15 * randn(rng) + obiShift));
    bars.push(bar);
  }
  const events = evs.map((e) => ({
    name: `${e.type}@${e.at}`,
    symbol,
    start: t0 + e.at * dt,
    end: t0 + (e.at + e.len) * dt,
    onset: t0 + e.at * dt,
  }));
  return { bars, events };
}
