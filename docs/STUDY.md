# SENTINEL pre-registered study

Question: at a matched alarm budget, does the SENTINEL ensemble detect large market shocks earlier, or with
fewer false alarms, than a z-score baseline that uses the same adaptive threshold, and than chance?

The design below is frozen in `eval/study.json` BEFORE any result exists. Changing it afterwards makes
the study exploratory; bump `version` and say why.

## Events (rule, not judgement)
- Symbols: BTCUSDT, ETHUSDT. Days 2020-01-01 to 2026-08-31 from Binance Vision daily klines.
- Rank UTC days by (high - low) / open. Take the top 20 per symbol, skipping any day within 3 days of a chosen one.
- The rule uses prices only, never any detector's output.

## Onset and detection
- Onset = first minute the close is >= 1.0% away from the UTC day's open (identical for all methods).
- Detected = at least one alert in [onset - 30 min, onset + 120 min]. Latency = first such alert minus onset (negative = early).
- Events with no 1% move or missing data are excluded and listed in the report.

## Methods (hyperparameters fixed, nothing tuned on these events)
`zscore_fixed3`, `zscore_matched` (reference), `sentinel_fixed`, `sentinel_learned`, and five leave-one-out ablations.
All use the same alarm budget (6/day) and 15-bar cooldown. Each event is replayed with a cold engine and 3 days of warm-up.

## Statistics
- Chance baseline: a random alerter with the same background alert rate and spacing as the method, 1000 simulations.
  Report recall, chance recall and the difference ("skill").
- 95% intervals: cluster bootstrap over calendar days (BTC and ETH on the same day move together), 2000 resamples.
- Method-vs-reference differences use identical resamples (paired). Only an interval excluding 0 is called a difference.

## Known limitations
- Roughly 40 correlated events: small effective sample; expect wide intervals.
- "Quiet" periods exclude the selected event days but not other volatile times, so false-alarm rates are upper bounds.
- The onset rule is a plain move rule chosen to be neutral; a different rule could change latencies.
- The learned ensemble gets only 3 days to learn per event.
- Binance Vision data is licensed CC BY-NC-SA 4.0 (non-commercial); credit "Binance Vision".

## Reproduce
Run the `study` workflow on GitHub (Actions), or locally:
`node eval/study-select.ts && node eval/fetch.ts --events eval/events.study.json && node eval/study-run.ts --ablate`
