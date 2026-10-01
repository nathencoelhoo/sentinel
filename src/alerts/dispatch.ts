import { timingSafeEqual } from 'node:crypto';
import { formatAlert } from './format.ts';
import type { AlertPayload } from './format.ts';

export interface AlertEnv {
  ALERT_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  DISCORD_WEBHOOK_URL?: string;
}

/** Constant-time key comparison; fails closed when no key is configured. */
export function keyOk(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Fixed-window limiter (best-effort: per serverless instance, not global). */
export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private hits: number[] = [];
  constructor(max = 20, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export async function dispatchAlert(
  a: AlertPayload,
  env: AlertEnv,
  fetchFn: typeof fetch = fetch,
): Promise<{ telegram: boolean | null; discord: boolean | null }> {
  const text = formatAlert(a);
  const res: { telegram: boolean | null; discord: boolean | null } = { telegram: null, discord: null };
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const r = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      });
      res.telegram = r.ok;
    } catch {
      res.telegram = false;
    }
  }
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      const r = await fetchFn(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
      });
      res.discord = r.ok;
    } catch {
      res.discord = false;
    }
  }
  return res;
}
