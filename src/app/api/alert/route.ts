import { NextResponse } from 'next/server';
import { validateAlert } from '../../../alerts/format.ts';
import { RateLimiter, dispatchAlert, keyOk } from '../../../alerts/dispatch.ts';

export const runtime = 'nodejs';
const limiter = new RateLimiter(20, 60_000); // best-effort, per serverless instance

/**
 * Sends a Telegram / Discord message. Secrets stay server-side. Fails CLOSED:
 * no ALERT_API_KEY configured => 503; wrong key => 401. Input is strictly validated.
 */
export async function POST(req: Request) {
  const expected = process.env.ALERT_API_KEY;
  if (!expected) return NextResponse.json({ error: 'alerts not configured' }, { status: 503 });
  if (!keyOk(req.headers.get('x-sentinel-key'), expected)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!limiter.allow()) return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  if (Number(req.headers.get('content-length') ?? 0) > 4096) return NextResponse.json({ error: 'too large' }, { status: 413 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 });
  }
  const alert = validateAlert(body);
  if (!alert) return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  const sent = await dispatchAlert(alert, {
    ALERT_API_KEY: process.env.ALERT_API_KEY,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
  });
  return NextResponse.json({ sent });
}
