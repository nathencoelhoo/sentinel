import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { extractFirstEntry } from './unzip.ts';

// Downloads daily 1m kline zips from data.binance.vision (public, no API key) and extracts them in pure Node.
const { values } = parseArgs({
  options: {
    events: { type: 'string', default: 'eval/events.example.json' },
    data: { type: 'string', default: 'data' },
    'warmup-days': { type: 'string', default: '3' },
    'tail-hours': { type: 'string', default: '12' },
  },
});
const events: { symbol: string; start: string; end: string }[] = JSON.parse(readFileSync(values.events as string, 'utf8')).events;
const warm = Number(values['warmup-days']);
const tail = Number(values['tail-hours']);
const day = 86_400_000;
let ok = 0;
let missing = 0;
let failed = 0;

async function get(url: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      console.warn(`  HTTP ${res.status} (attempt ${attempt + 1}) ${url}`);
    } catch (err) {
      console.warn(`  ${(err as Error).message} (attempt ${attempt + 1}) ${url}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`gave up on ${url}`);
}

for (const e of events) {
  const dir = join(values.data as string, e.symbol);
  mkdirSync(dir, { recursive: true });
  const first = Math.floor((Date.parse(e.start) - warm * day) / day) * day;
  const last = Math.floor((Date.parse(e.end) + tail * 3_600_000) / day) * day;
  for (let t = first; t <= last; t += day) {
    const d = new Date(t).toISOString().slice(0, 10);
    const out = join(dir, `${e.symbol}-1m-${d}.csv`);
    if (existsSync(out)) continue;
    const url = `https://data.binance.vision/data/spot/daily/klines/${e.symbol}/1m/${e.symbol}-1m-${d}.zip`;
    try {
      const zip = await get(url);
      if (!zip) {
        console.warn(`404 (no such file on Binance) ${e.symbol} ${d}`);
        missing++;
        continue;
      }
      writeFileSync(out, extractFirstEntry(zip));
      ok++;
      console.log(`ok ${e.symbol} ${d}`);
    } catch (err) {
      failed++;
      console.warn(`fail ${e.symbol} ${d}: ${(err as Error).message}`);
    }
  }
}
console.log(`\ndone: ${ok} downloaded, ${missing} missing (404), ${failed} failed. Next: npm run eval`);
