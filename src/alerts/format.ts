export interface AlertPayload {
  symbol: string;
  t: number;
  price: number;
  score: number;
  threshold: number;
  top: { name: string; contribution: number }[];
}

const SYMBOL_RE = /^[a-z]{3,12}:[A-Z0-9-]{3,20}$/;
const NAME_RE = /^[a-z_]{1,32}$/;

/** Strict validation of untrusted client input. Returns null if anything is off. */
export function validateAlert(body: unknown): AlertPayload | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return null;
  const { symbol, t, price, score, threshold, top } = b as Record<string, unknown>;
  if (typeof symbol !== 'string' || !SYMBOL_RE.test(symbol)) return null;
  if (![t, price, score, threshold].every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  if (!Array.isArray(top) || top.length > 6) return null;
  const clean: AlertPayload['top'] = [];
  for (const d of top as Record<string, unknown>[]) {
    if (typeof d?.name !== 'string' || !NAME_RE.test(d.name) || typeof d.contribution !== 'number' || !Number.isFinite(d.contribution)) {
      return null;
    }
    clean.push({ name: d.name, contribution: d.contribution });
  }
  return { symbol, t: t as number, price: price as number, score: score as number, threshold: threshold as number, top: clean };
}

/** Plain text only (no markup), so nothing user-controlled can inject formatting or mentions. */
export function formatAlert(a: AlertPayload): string {
  const when = new Date(a.t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const drivers = a.top.map((d) => `${d.name} ${d.contribution >= 0 ? '+' : ''}${d.contribution.toFixed(2)}`).join(', ');
  return [
    `SENTINEL alert: ${a.symbol}`,
    `score ${a.score.toFixed(1)} (alert level p > ${a.threshold.toFixed(2)})`,
    `price ${a.price} at ${when}`,
    drivers ? `top drivers: ${drivers}` : '',
    'Research signal, not financial advice.',
  ]
    .filter(Boolean)
    .join('\n');
}
