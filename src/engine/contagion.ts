import { RingBuffer, pearson } from './stats.ts';

export interface PairLink {
  a: string;
  b: string;
  /** Contemporaneous Pearson correlation of returns. */
  corr: number;
  /** Lag (bars) maximising corr(score_a[t-lag], score_b[t]); lag > 0 means a leads b. */
  lag: number;
  lagCorr: number;
  leader: string | null;
  follower: string | null;
}

/**
 * Cross-asset contagion: rolling return correlation + lead-lag cross-correlation
 * of anomaly-score series.
 *
 *   $$ \rho_{ab}(\ell) = \mathrm{corr}(s^a_{t-\ell},\, s^b_t), \quad \ell \in [-L, L] $$
 *
 * A leader is declared only if the best lag is non-zero, rho(lag) >= minCorr and
 * it beats the contemporaneous correlation by `margin` (at 1-minute scale most
 * crypto co-movement is simultaneous, and we say so rather than invent a leader).
 */
export class ContagionTracker {
  private readonly rets = new Map<string, RingBuffer>();
  private readonly scores = new Map<string, RingBuffer>();
  private readonly o: { window: number; maxLag: number; minCorr: number; margin: number };

  constructor(opts: { window?: number; maxLag?: number; minCorr?: number; margin?: number } = {}) {
    this.o = { window: 240, maxLag: 6, minCorr: 0.3, margin: 0.05, ...opts };
  }

  /** Push one time-aligned observation per symbol. */
  update(obs: Record<string, { ret: number; score: number }>): void {
    for (const [sym, v] of Object.entries(obs)) {
      if (!this.rets.has(sym)) {
        this.rets.set(sym, new RingBuffer(this.o.window));
        this.scores.set(sym, new RingBuffer(this.o.window));
      }
      this.rets.get(sym)!.push(v.ret);
      this.scores.get(sym)!.push(v.score);
    }
  }

  snapshot(): PairLink[] {
    const syms = [...this.rets.keys()];
    const links: PairLink[] = [];
    for (let i = 0; i < syms.length; i++) {
      for (let j = i + 1; j < syms.length; j++) {
        const a = syms[i];
        const b = syms[j];
        const ra = this.rets.get(a)!.toArray();
        const rb = this.rets.get(b)!.toArray();
        const sa = this.scores.get(a)!.toArray();
        const sb = this.scores.get(b)!.toArray();
        const n = Math.min(sa.length, sb.length);
        if (n < this.o.maxLag * 4) continue;
        const corr = pearson(ra.slice(-n), rb.slice(-n));
        const A = sa.slice(-n);
        const B = sb.slice(-n);
        const L = this.o.maxLag;
        let bestLag = 0;
        let best = -Infinity;
        let zero = 0;
        for (let lag = -L; lag <= L; lag++) {
          const x = lag >= 0 ? A.slice(0, n - lag) : A.slice(-lag);
          const y = lag >= 0 ? B.slice(lag) : B.slice(0, n + lag);
          const c = pearson(x, y);
          if (lag === 0) zero = c;
          if (c > best) {
            best = c;
            bestLag = lag;
          }
        }
        const isLead = bestLag !== 0 && best >= this.o.minCorr && best > zero + this.o.margin;
        links.push({
          a,
          b,
          corr,
          lag: bestLag,
          lagCorr: best,
          leader: isLead ? (bestLag > 0 ? a : b) : null,
          follower: isLead ? (bestLag > 0 ? b : a) : null,
        });
      }
    }
    return links;
  }

  /** Early warnings: leaders whose latest score is >= scoreThreshold, with the follower and expected delay. */
  warnings(scoreThreshold: number): { leader: string; follower: string; lagBars: number; lagCorr: number }[] {
    const out: { leader: string; follower: string; lagBars: number; lagCorr: number }[] = [];
    for (const l of this.snapshot()) {
      if (l.leader === null || l.follower === null) continue;
      const s = this.scores.get(l.leader)!;
      if (s.length > 0 && s.at(s.length - 1) >= scoreThreshold) {
        out.push({ leader: l.leader, follower: l.follower, lagBars: Math.abs(l.lag), lagCorr: l.lagCorr });
      }
    }
    return out;
  }
}
