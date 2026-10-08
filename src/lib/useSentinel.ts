'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectorReading } from '../engine/types.ts';
import type { PairLink } from '../engine/contagion.ts';
import type { Metrics, UiMessage, WorkerConfig, WorkerCommand } from '../worker/protocol.ts';

export const DEFAULT_SYMBOLS = [
  'binance:BTCUSDT',
  'binance:ETHUSDT',
  'binance:SOLUSDT',
  'binance:BNBUSDT',
  'binance:XRPUSDT',
  
];

export interface Pt {
  time: number; // seconds (UTC)
  value: number;
}
export interface SymState {
  prices: Pt[];
  scores: Pt[];
  alertTimes: number[];
  forming: Pt | null;
  ready: boolean;
  last: { score: number; p: number; threshold: number; detectors: DetectorReading[] } | null;
  heat: number[];
}
export interface AlertRec {
  id: number;
  symbol: string;
  t: number;
  price: number;
  score: number;
  p: number;
  threshold: number;
  detectors: DetectorReading[];
  delivery: 'off' | 'pending' | 'sent' | 'failed';
}
export interface AlertRules {
  enabled: boolean;
  minScore: number;
  apiKey: string;
}
export interface Snapshot {
  version: number;
  running: boolean;
  symbols: Record<string, SymState>;
  alerts: AlertRec[];
  metrics: Metrics | null;
  status: Record<string, string>;
  contagion: { links: PairLink[]; warnings: { leader: string; follower: string; lagBars: number; lagCorr: number }[] };
  weights: Record<string, { names: string[]; w: number[]; b: number }>;
  errors: string[];
}

const MAX_PTS = 1500;
const MAX_HEAT = 90;
const MAX_ALERTS = 200;
const RULES_KEY = 'sentinel.rules.v1';

const emptySym = (): SymState => ({ prices: [], scores: [], alertTimes: [], forming: null, ready: false, last: null, heat: [] });
const emptySnap = (): Snapshot => ({
  version: 0,
  running: false,
  symbols: {},
  alerts: [],
  metrics: null,
  status: {},
  contagion: { links: [], warnings: [] },
  weights: {},
  errors: [],
});

function trim<T>(a: T[], n: number): void {
  if (a.length > n) a.splice(0, a.length - n);
}

/** Owns the Web Worker and a mutable store; React re-renders at most every 250 ms. */
export function useSentinel() {
  const store = useRef<Snapshot>(emptySnap());
  const dirty = useRef(false);
  const worker = useRef<Worker | null>(null);
  const alertId = useRef(0);
  const lastSent = useRef<Record<string, number>>({});
  const rulesRef = useRef<AlertRules>({ enabled: false, minScore: 80, apiKey: '' });
  const [snap, setSnap] = useState<Snapshot>(store.current);
  const [rules, setRulesState] = useState<AlertRules>(rulesRef.current);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RULES_KEY);
      if (raw) {
        const r = { ...rulesRef.current, ...JSON.parse(raw) } as AlertRules;
        rulesRef.current = r;
        setRulesState(r);
      }
    } catch {
      /* storage unavailable */
    }
    const id = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      store.current.version++;
      setSnap({ ...store.current });
    }, 250);
    return () => clearInterval(id);
  }, []);

  const setRules = useCallback((r: AlertRules) => {
    rulesRef.current = r;
    setRulesState(r);
    try {
      localStorage.setItem(RULES_KEY, JSON.stringify(r));
    } catch {
      /* ignore */
    }
  }, []);

  const dispatchAlert = useCallback(async (rec: AlertRec) => {
    const r = rulesRef.current;
    if (!r.enabled || !r.apiKey || rec.score < r.minScore) {
      rec.delivery = 'off';
      return;
    }
    const now = Date.now();
    if (now - (lastSent.current[rec.symbol] ?? 0) < 60_000) {
      rec.delivery = 'off'; // per-symbol 60 s notification cooldown
      return;
    }
    lastSent.current[rec.symbol] = now;
    rec.delivery = 'pending';
    const top = [...rec.detectors].sort((a, b) => b.contribution - a.contribution).slice(0, 3).map((d) => ({ name: d.name, contribution: d.contribution }));
    try {
      const res = await fetch('/api/alert', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sentinel-key': r.apiKey },
        body: JSON.stringify({ symbol: rec.symbol, t: rec.t, price: rec.price, score: rec.score, threshold: rec.threshold, top }),
      });
      rec.delivery = res.ok ? 'sent' : 'failed';
    } catch {
      rec.delivery = 'failed';
    }
    dirty.current = true;
  }, []);

  const onMessage = useCallback(
    (m: UiMessage) => {
      const s = store.current;
      const sym = (k: string) => (s.symbols[k] ??= emptySym());
      switch (m.type) {
        case 'backfill': {
          const st = sym(m.symbol);
          st.prices = m.points.map((p) => ({ time: p.t / 1000, value: p.close }));
          st.scores = m.points.map((p) => ({ time: p.t / 1000, value: p.score }));
          st.alertTimes = m.points.filter((p) => p.alert).map((p) => p.t / 1000);
          st.heat = m.points.slice(-MAX_HEAT).map((p) => p.score);
          break;
        }
        case 'bar': {
          const st = sym(m.symbol);
          const time = m.t / 1000;
          const lastT = st.prices.length ? st.prices[st.prices.length - 1].time : 0;
          if (time > lastT) {
            st.prices.push({ time, value: m.close });
            st.scores.push({ time, value: m.score });
            st.heat.push(m.score);
            trim(st.prices, MAX_PTS);
            trim(st.scores, MAX_PTS);
            trim(st.heat, MAX_HEAT);
          }
          if (m.alert && m.ready) st.alertTimes.push(time);
          st.ready = m.ready;
          st.forming = null;
          if (m.ready) st.last = { score: m.score, p: m.p, threshold: m.threshold, detectors: m.detectors };
          break;
        }
        case 'forming':
          sym(m.symbol).forming = { time: m.t / 1000, value: m.price };
          break;
        case 'alert': {
          const rec: AlertRec = {
            id: ++alertId.current,
            symbol: m.symbol,
            t: m.t,
            price: m.price,
            score: m.score,
            p: m.p,
            threshold: m.threshold,
            detectors: m.detectors,
            delivery: 'off',
          };
          s.alerts.unshift(rec);
          if (s.alerts.length > MAX_ALERTS) s.alerts.length = MAX_ALERTS; // newest first: drop the oldest at the end
          void dispatchAlert(rec);
          break;
        }
        case 'metrics':
          s.metrics = m.m;
          break;
        case 'contagion':
          s.contagion = { links: m.links, warnings: m.warnings };
          break;
        case 'weights':
          s.weights[m.symbol] = { names: m.names, w: m.w, b: m.b };
          break;
        case 'status':
          s.status[m.venue] = m.state;
          break;
        case 'error':
          s.errors = [m.message, ...s.errors].slice(0, 5);
          break;
      }
      dirty.current = true;
    },
    [dispatchAlert],
  );

  const stop = useCallback(() => {
    worker.current?.postMessage({ type: 'stop' } satisfies WorkerCommand);
    worker.current?.terminate();
    worker.current = null;
    store.current.running = false;
    dirty.current = true;
  }, []);

  const start = useCallback(
    (config: WorkerConfig) => {
      stop();
      store.current = { ...emptySnap(), running: true };
      const w = new Worker(new URL('../worker/sentinel.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<UiMessage>) => onMessage(e.data);
      w.onerror = (e) => onMessage({ type: 'error', message: `worker: ${e.message}` });
      w.postMessage({ type: 'start', config } satisfies WorkerCommand);
      worker.current = w;
      dirty.current = true;
    },
    [onMessage, stop],
  );

  useEffect(() => () => stop(), [stop]);

  return { snap, start, stop, rules, setRules };
}
