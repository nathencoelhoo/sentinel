'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, HistogramSeries, LineSeries, createChart, createSeriesMarkers } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, ISeriesMarkersPluginApi, Time, UTCTimestamp } from 'lightweight-charts';
import { DEFAULT_SYMBOLS, useSentinel } from '../lib/useSentinel.ts';
import type { AlertRec, AlertRules, Snapshot, SymState } from '../lib/useSentinel.ts';
import type { WorkerConfig } from '../worker/protocol.ts';

const ts = (n: number) => n as UTCTimestamp;
const fmtTime = (ms: number) => new Date(ms).toISOString().slice(11, 19);

function PriceChart({ st, version }: { st: SymState | undefined; version: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<'Line'> | null>(null);
  const score = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#a1a1aa' },
      grid: { vertLines: { color: '#27272a' }, horzLines: { color: '#27272a' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    price.current = c.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2 });
    score.current = c.addSeries(HistogramSeries, { color: '#f97316', priceFormat: { type: 'price', precision: 0, minMove: 1 } }, 1);
    markers.current = createSeriesMarkers(price.current, []);
    try {
      c.panes()[1]?.setHeight(110);
    } catch {
      /* pane API unavailable: default split */
    }
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    if (!st || !price.current || !score.current) return;
    const p = st.prices.map((x) => ({ time: ts(x.time), value: x.value }));
    if (st.forming && (p.length === 0 || st.forming.time > p[p.length - 1].time)) p.push({ time: ts(st.forming.time), value: st.forming.value });
    price.current.setData(p);
    score.current.setData(st.scores.map((x) => ({ time: ts(x.time), value: x.value })));
    markers.current?.setMarkers(
      st.alertTimes.slice(-60).map((t) => ({ time: ts(t), position: 'aboveBar' as const, color: '#ef4444', shape: 'arrowDown' as const, text: 'alert' })),
    );
  }, [st, version]);

  return <div ref={el} className="h-[420px] w-full" />;
}

function heatColor(score: number): string {
  const i = Math.min(1, Math.sqrt(Math.max(score, 0) / 100));
  return `hsl(${15 - 10 * i}, 90%, ${9 + 48 * i}%)`;
}

function Heatmap({ snap, selected, onSelect }: { snap: Snapshot; selected: string; onSelect: (s: string) => void }) {
  const syms = Object.keys(snap.symbols);
  return (
    <div className="space-y-1">
      {syms.map((s) => {
        const st = snap.symbols[s];
        return (
          <button key={s} onClick={() => onSelect(s)} className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${s === selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'}`}>
            <span className="w-32 shrink-0 truncate font-mono text-xs text-zinc-300">{s}</span>
            <span className="flex h-4 flex-1 gap-px overflow-hidden">
              {st.heat.map((v, i) => (
                <span key={i} title={`${v.toFixed(1)}`} className="h-full flex-1" style={{ background: heatColor(v) }} />
              ))}
            </span>
            <span className={`w-10 text-right font-mono text-xs ${st.ready ? 'text-zinc-300' : 'text-amber-500'}`}>{st.ready ? (st.last?.score ?? 0).toFixed(0) : 'warm'}</span>
          </button>
        );
      })}
      {syms.length === 0 && <p className="text-sm text-zinc-500">Press Start to connect.</p>}
    </div>
  );
}

function Explain({ snap, selected }: { snap: Snapshot; selected: string }) {
  const st = snap.symbols[selected];
  const lastAlert = snap.alerts.find((a) => a.symbol === selected);
  const w = snap.weights[selected];
  const rows = (ds: AlertRec['detectors']) => {
    const max = Math.max(0.0001, ...ds.map((d) => d.contribution));
    return [...ds]
      .sort((a, b) => b.contribution - a.contribution)
      .map((d) => (
        <div key={d.name} className="flex items-center gap-2 text-xs">
          <span className="w-36 shrink-0 truncate font-mono text-zinc-400">{d.name}{d.imputed ? ' *' : ''}</span>
          <span className="h-2 flex-1 rounded bg-zinc-800">
            <span className="block h-2 rounded bg-orange-500" style={{ width: `${(100 * d.contribution) / max}%` }} />
          </span>
          <span className="w-12 text-right font-mono text-zinc-300">{d.contribution.toFixed(2)}</span>
        </div>
      ));
  };
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-sm font-medium text-zinc-200">Now: what is driving {selected}</h3>
        {st?.last ? <div className="space-y-1">{rows(st.last.detectors)}</div> : <p className="text-sm text-zinc-500">Waiting for the engine to warm up.</p>}
        <p className="mt-1 text-xs text-zinc-500">Bars = each detector's contribution to the ensemble logit. * = missing input, imputed.</p>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium text-zinc-200">Why did the last alert fire?</h3>
        {lastAlert ? (
          <>
            <p className="mb-1 text-xs text-zinc-400">{fmtTime(lastAlert.t)} UTC, score {lastAlert.score.toFixed(1)}, price {lastAlert.price}</p>
            <div className="space-y-1">{rows(lastAlert.detectors)}</div>
          </>
        ) : (
          <p className="text-sm text-zinc-500">No alert yet for this symbol.</p>
        )}
      </div>
      {w && (
        <div>
          <h3 className="mb-1 text-sm font-medium text-zinc-200">Learned weights (online)</h3>
          <p className="font-mono text-xs text-zinc-400">{w.names.map((n, i) => `${n} ${w.w[i].toFixed(3)}`).join(' | ')} | bias {w.b.toFixed(2)}</p>
        </div>
      )}
    </div>
  );
}

function Metrics({ snap }: { snap: Snapshot }) {
  const m = snap.metrics;
  const cell = (k: string, v: string) => (
    <div className="rounded bg-zinc-900 px-3 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{k}</div>
      <div className="font-mono text-sm text-zinc-100">{v}</div>
    </div>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(snap.status).map(([v, s]) => cell(v, s))}
      {cell('ticks/s', m ? String(m.ticksPerSec) : '-')}
      {cell('queue / dropped', m ? `${m.queueDepth} / ${m.dropped}` : '-')}
      {cell('engine p50 / p95', m ? `${m.engineP50Us} / ${m.engineP95Us} µs` : '-')}
      {cell('feed lag', m ? `${m.feedLagMs} ms` : '-')}
      {cell('bars', m ? String(m.bars) : '-')}
      {cell('late / dupes / filled', m ? `${m.late} / ${m.dupes} / ${m.gapFilled}` : '-')}
    </div>
  );
}

function Alerts({ snap }: { snap: Snapshot }) {
  return (
    <ul className="max-h-64 space-y-1 overflow-auto text-xs">
      {snap.alerts.length === 0 && <li className="text-zinc-500">No alerts yet.</li>}
      {snap.alerts.map((a) => (
        <li key={a.id} className="flex items-center justify-between rounded bg-zinc-900 px-2 py-1">
          <span className="font-mono text-zinc-300">{fmtTime(a.t)} {a.symbol}</span>
          <span className="font-mono text-orange-400">{a.score.toFixed(0)}</span>
          <span className={a.delivery === 'sent' ? 'text-emerald-400' : a.delivery === 'failed' ? 'text-red-400' : 'text-zinc-500'}>{a.delivery}</span>
        </li>
      ))}
    </ul>
  );
}

function Contagion({ snap }: { snap: Snapshot }) {
  const links = [...snap.contagion.links].filter((l) => l.leader).sort((a, b) => b.lagCorr - a.lagCorr).slice(0, 5);
  return (
    <div className="space-y-1 text-xs">
      {snap.contagion.warnings.map((w, i) => (
        <p key={i} className="rounded bg-red-950 px-2 py-1 text-red-300">
          {w.leader} is anomalous; {w.follower} has historically followed within ~{w.lagBars} bar(s) (r={w.lagCorr.toFixed(2)})
        </p>
      ))}
      {links.length === 0 ? (
        <p className="text-zinc-500">No significant lead-lag yet (at 1-minute scale most co-movement is simultaneous).</p>
      ) : (
        links.map((l, i) => (
          <p key={i} className="font-mono text-zinc-400">{l.leader} → {l.follower}: lag {Math.abs(l.lag)} bar(s), r={l.lagCorr.toFixed(2)}</p>
        ))
      )}
    </div>
  );
}

function RulesForm({ rules, setRules }: { rules: AlertRules; setRules: (r: AlertRules) => void }) {
  return (
    <div className="space-y-2 text-xs text-zinc-300">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={rules.enabled} onChange={(e) => setRules({ ...rules, enabled: e.target.checked })} />
        Send Telegram/Discord alerts
      </label>
      <label className="flex items-center gap-2">
        Min score
        <input type="number" min={0} max={100} value={rules.minScore} onChange={(e) => setRules({ ...rules, minScore: Number(e.target.value) })} className="w-16 rounded bg-zinc-800 px-1" />
      </label>
      <label className="flex items-center gap-2">
        API key
        <input type="password" value={rules.apiKey} onChange={(e) => setRules({ ...rules, apiKey: e.target.value })} className="flex-1 rounded bg-zinc-800 px-1" placeholder="ALERT_API_KEY" />
      </label>
      <p className="text-zinc-500">Alerts only fire while this tab is open. Key is stored in this browser only.</p>
    </div>
  );
}

export default function Dashboard() {
  const { snap, start, stop, rules, setRules } = useSentinel();
  const [selected, setSelected] = useState(DEFAULT_SYMBOLS[0]);
  const [cfg, setCfg] = useState<WorkerConfig>({
    symbols: DEFAULT_SYMBOLS,
    barSeconds: 60,
    ensemble: 'fixed',
    alarmsPerDay: 6,
    binanceHost: 'com',
    backfill: true,
  });
  const st = snap.symbols[selected];
  const warming = useMemo(() => Object.values(snap.symbols).some((s) => !s.ready), [snap.version]);

  return (
    <main className="mx-auto max-w-7xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">SENTINEL</h1>
          <p className="text-xs text-zinc-500">Real-time anomaly detection. Research tool, not financial advice.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select value={cfg.ensemble} onChange={(e) => setCfg({ ...cfg, ensemble: e.target.value as WorkerConfig['ensemble'] })} className="rounded bg-zinc-800 px-2 py-1">
            <option value="fixed">ensemble: fixed</option>
            <option value="learned">ensemble: learned</option>
          </select>
          <select value={cfg.barSeconds} onChange={(e) => setCfg({ ...cfg, barSeconds: Number(e.target.value) })} className="rounded bg-zinc-800 px-2 py-1">
            <option value={60}>60 s bars (backfilled)</option>
            <option value={15}>15 s bars (live warm-up)</option>
            <option value={5}>5 s bars (live warm-up)</option>
          </select>
          <select value={cfg.binanceHost} onChange={(e) => setCfg({ ...cfg, binanceHost: e.target.value as 'com' | 'us' })} className="rounded bg-zinc-800 px-2 py-1">
            <option value="com">binance.com</option>
            <option value="us">binance.us (US users)</option>
          </select>
          <label className="flex items-center gap-1">
            alarms/day
            <input type="number" min={1} max={100} value={cfg.alarmsPerDay} onChange={(e) => setCfg({ ...cfg, alarmsPerDay: Math.max(1, Number(e.target.value)) })} className="w-14 rounded bg-zinc-800 px-1 py-1" />
          </label>
          {snap.running ? (
            <button onClick={stop} className="rounded bg-zinc-700 px-3 py-1">Stop</button>
          ) : (
            <button onClick={() => start(cfg)} className="rounded bg-sky-600 px-3 py-1 font-medium">Start</button>
          )}
          {snap.running && <button onClick={() => start(cfg)} className="rounded bg-zinc-800 px-3 py-1">Restart</button>}
        </div>
      </header>

      <Metrics snap={snap} />
      {snap.errors.length > 0 && <p className="rounded bg-amber-950 px-3 py-1 text-xs text-amber-300">{snap.errors[0]}</p>}
      {warming && snap.running && <p className="text-xs text-amber-500">Some symbols are still warming up (need ~300 bars; 60 s bars are backfilled from REST history).</p>}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <h2 className="mb-2 font-mono text-sm text-zinc-300">{selected}</h2>
            <PriceChart st={st} version={snap.version} />
          </div>
          <div className="rounded-lg border border-zinc-800 p-3">
            <Explain snap={snap} selected={selected} />
          </div>
        </section>
        <aside className="space-y-4">
          <div className="rounded-lg border border-zinc-800 p-3">
            <h2 className="mb-2 text-sm font-medium">Anomaly heatmap (last {90} bars)</h2>
            <Heatmap snap={snap} selected={selected} onSelect={setSelected} />
          </div>
          <div className="rounded-lg border border-zinc-800 p-3">
            <h2 className="mb-2 text-sm font-medium">Contagion</h2>
            <Contagion snap={snap} />
          </div>
          <div className="rounded-lg border border-zinc-800 p-3">
            <h2 className="mb-2 text-sm font-medium">Alerts</h2>
            <Alerts snap={snap} />
          </div>
          <div className="rounded-lg border border-zinc-800 p-3">
            <h2 className="mb-2 text-sm font-medium">Alert rules</h2>
            <RulesForm rules={rules} setRules={setRules} />
          </div>
        </aside>
      </div>
    </main>
  );
}
