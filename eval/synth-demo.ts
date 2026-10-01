import { evaluate, standardMethods, summarize } from './harness.ts';
import type { MethodResult } from './harness.ts';
import { simulate } from '../src/sim/synth.ts';

// End-to-end plumbing check on synthetic data. NOT evidence about real markets.
const barSeconds = 60;
const alarmsPerDay = 6;
const all: MethodResult[] = [];
for (const seed of [1, 2, 3, 4, 5]) {
  const { bars, events } = simulate({
    n: 12000,
    seed,
    events: [
      { type: 'vol', at: 4000, len: 120, mag: 4 },
      { type: 'drift', at: 7000, len: 40, mag: -2 },
      { type: 'jump', at: 10000, len: 60, mag: -60 },
    ],
  });
  all.push(...evaluate('SIM', bars, events, standardMethods(barSeconds, alarmsPerDay), { barSeconds }));
}
console.log(`Synthetic replay: 5 seeds x 3 injected events, alarm budget ${alarmsPerDay}/day`);
console.table(summarize(all));
