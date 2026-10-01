import type { AlertEngine, Bar } from '../src/engine/types.ts';
import { SentinelEngine, defaultConfig, defaultDetectors } from '../src/engine/engine.ts';
import { ZScoreBaseline } from '../src/engine/detectors/zscoreBaseline.ts';

export interface EventWindow {
  name: string;
  symbol: string;
  start: number; // ms epoch, UTC
  end: number;
  /** Hand-labelled onset (with hindsight). If absent, latency is measured from `start`. */
  onset?: number;
}
export interface MethodSpec {
  name: string;
  make: (symbol: string) => AlertEngine;
}
export interface EventResult {
  name: string;
  detected: boolean;
  latencyMin: number | null;
}
export interface MethodResult {
  method: string;
  events: EventResult[];
  falseAlarms: number;
  quietDays: number;
  alertsInWindow: number;
}
export interface SummaryRow {
  method: string;
  recall: string;
  medianLatencyMin: number | null;
  falseAlarmsPerDay: number;
  precision: number;
  alertsInWindow: number;
  falseAlarms: number;
}

/** Same code path for every method; alert statistics are compared at a matched alarm budget. */
export function standardMethods(barSeconds: number, alarmsPerDay: number): MethodSpec[] {
  const common = { barSeconds, alarmsPerDay };
  return [
    { name: 'zscore_fixed3', make: () => new ZScoreBaseline({ mode: 'fixed', ...common }) },
    { name: 'zscore_matched', make: () => new ZScoreBaseline({ mode: 'matched', ...common }) },
    { name: 'sentinel_fixed', make: (s) => new SentinelEngine(defaultConfig(s, { ...common, ensemble: 'fixed' })) },
    { name: 'sentinel_learned', make: (s) => new SentinelEngine(defaultConfig(s, { ...common, ensemble: 'learned' })) },
  ];
}

/**
 * Replays `bars` (one symbol, ascending time) through each method.
 *  - detection: first alert inside [start, end]; latency from onset (or start)
 *  - false alarm: alert in the quiet zone = outside every event window and its
 *    guard zones ([start-guard, start) and (end, end+tail]), after engine warm-up
 *  - alerts in guard zones count as neither (pre-event run-up / aftershocks)
 */
export function evaluate(
  symbol: string,
  bars: Bar[],
  events: EventWindow[],
  specs: MethodSpec[],
  opts: { barSeconds: number; guardMinutes?: number; tailMinutes?: number },
): MethodResult[] {
  const guardMs = (opts.guardMinutes ?? 60) * 60_000;
  const tailMs = (opts.tailMinutes ?? 360) * 60_000;
  const inWindow = (t: number) => events.some((e) => t >= e.start && t <= e.end);
  const inGuard = (t: number) =>
    !inWindow(t) && events.some((e) => (t >= e.start - guardMs && t < e.start) || (t > e.end && t <= e.end + tailMs));

  return specs.map((spec) => {
    const eng = spec.make(symbol);
    const alerts: number[] = [];
    let quietReadyBars = 0;
    let falseAlarms = 0;
    let alertsInWindow = 0;
    for (const bar of bars) {
      const o = eng.update(bar);
      if (!o.ready) continue;
      const quiet = !inWindow(bar.t) && !inGuard(bar.t);
      if (quiet) quietReadyBars++;
      if (o.alert) {
        alerts.push(bar.t);
        if (inWindow(bar.t)) alertsInWindow++;
        else if (quiet) falseAlarms++;
      }
    }
    const evRes = events.map((e) => {
      const first = alerts.find((t) => t >= e.start && t <= e.end);
      return {
        name: e.name,
        detected: first !== undefined,
        latencyMin: first === undefined ? null : (first - (e.onset ?? e.start)) / 60_000,
      };
    });
    return {
      method: spec.name,
      events: evRes,
      falseAlarms,
      quietDays: (quietReadyBars * opts.barSeconds) / 86400,
      alertsInWindow,
    };
  });
}

export function summarize(all: MethodResult[]): SummaryRow[] {
  const methods = [...new Set(all.map((r) => r.method))];
  return methods.map((m) => {
    const rs = all.filter((r) => r.method === m);
    const evs = rs.flatMap((r) => r.events);
    const det = evs.filter((e) => e.detected);
    const lat = det.map((e) => e.latencyMin as number).sort((a, b) => a - b);
    const fa = rs.reduce((s, r) => s + r.falseAlarms, 0);
    const days = rs.reduce((s, r) => s + r.quietDays, 0);
    const inW = rs.reduce((s, r) => s + r.alertsInWindow, 0);
    return {
      method: m,
      recall: `${det.length}/${evs.length}`,
      medianLatencyMin: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null,
      falseAlarmsPerDay: days > 0 ? Math.round((fa / days) * 100) / 100 : 0,
      precision: inW + fa > 0 ? Math.round((inW / (inW + fa)) * 1000) / 1000 : 0,
      alertsInWindow: inW,
      falseAlarms: fa,
    };
  });
}

/**
 * Leave-one-out ablation: the fixed ensemble with each REQUIRED detector removed (prior weights
 * re-normalise automatically). The order-book detector is excluded: klines carry no L2 data.
 */
export function ablationMethods(barSeconds: number, alarmsPerDay: number): MethodSpec[] {
  return defaultDetectors()
    .filter((d) => !d.optional)
    .map((d) => d.name)
    .map((name) => ({
      name: `sentinel_without_${name}`,
      make: (s: string) =>
        new SentinelEngine(
          defaultConfig(s, { barSeconds, alarmsPerDay, ensemble: 'fixed' }),
          defaultDetectors().filter((x) => x.name !== name),
        ),
    }));
}

/** Paste-ready markdown for the writeup (summary table + per-event detection matrix). */
export function toMarkdown(alarmsPerDay: number, summary: SummaryRow[], all: MethodResult[]): string {
  const f = (v: number | null) => (v === null ? 'n/a' : v.toFixed(0));
  const lines = [
    `# SENTINEL replay results (alarm budget ${alarmsPerDay}/day)`,
    '',
    '| method | recall | median latency (min) | false alarms/day | precision (lower bound) | alerts in window | false alarms |',
    '|---|---|---|---|---|---|---|',
    ...summary.map((r) => `| ${r.method} | ${r.recall} | ${f(r.medianLatencyMin)} | ${r.falseAlarmsPerDay} | ${r.precision} | ${r.alertsInWindow} | ${r.falseAlarms} |`),
    '',
    '## Per event (latency in minutes from window start/onset; `-` = missed)',
    '',
  ];
  const methods = [...new Set(all.map((r) => r.method))];
  const names = [...new Set(all.flatMap((r) => r.events.map((e) => e.name)))];
  lines.push(`| event | ${methods.join(' | ')} |`, `|---|${methods.map(() => '---').join('|')}|`);
  for (const n of names) {
    const cells = methods.map((m) => {
      const hits = all.filter((r) => r.method === m).flatMap((r) => r.events.filter((e) => e.name === n));
      return hits.map((e) => (e.detected ? f(e.latencyMin) : '-')).join(' / ') || '?';
    });
    lines.push(`| ${n} | ${cells.join(' | ')} |`);
  }
  lines.push('', 'Caveats: day-level hand-labelled windows, few events, precision counts unlabelled anomalies as false alarms.');
  return lines.join('\n') + '\n';
}
