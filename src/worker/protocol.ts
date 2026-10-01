import type { DetectorReading } from '../engine/types.ts';
import type { PairLink } from '../engine/contagion.ts';

export interface HostConfig {
  symbols: string[]; // canonical keys, e.g. binance:BTCUSDT, coinbase:BTC-USD
  barSeconds: number;
  ensemble: 'fixed' | 'learned';
  alarmsPerDay: number;
  graceMs?: number;
  maxQueue?: number;
  maxPerPump?: number;
}

export interface WorkerConfig extends HostConfig {
  /** Binance spot host: 'com' (global) or 'us' (for US users, where .com is blocked). */
  binanceHost: 'com' | 'us';
  backfill: boolean;
}

export interface Metrics {
  t: number;
  ticksPerSec: number;
  queueDepth: number;
  dropped: number;
  bars: number;
  engineP50Us: number;
  engineP95Us: number;
  feedLagMs: number;
  late: number;
  dupes: number;
  gapFilled: number;
}

export interface BackfillPoint {
  t: number;
  close: number;
  score: number;
  alert: boolean;
}

export type UiMessage =
  | { type: 'backfill'; symbol: string; points: BackfillPoint[] }
  | {
      type: 'bar';
      symbol: string;
      t: number;
      close: number;
      volume: number;
      ret: number;
      ready: boolean;
      score: number;
      p: number;
      threshold: number;
      alert: boolean;
      detectors: DetectorReading[];
    }
  | { type: 'forming'; symbol: string; t: number; price: number }
  | {
      type: 'alert';
      symbol: string;
      t: number;
      price: number;
      score: number;
      p: number;
      threshold: number;
      detectors: DetectorReading[];
    }
  | { type: 'metrics'; m: Metrics }
  | { type: 'contagion'; links: PairLink[]; warnings: { leader: string; follower: string; lagBars: number; lagCorr: number }[] }
  | { type: 'weights'; symbol: string; names: string[]; w: number[]; b: number }
  | { type: 'status'; venue: string; state: string; attempt: number }
  | { type: 'error'; message: string };

export type WorkerCommand = { type: 'start'; config: WorkerConfig } | { type: 'stop' };
