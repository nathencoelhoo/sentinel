# SENTINEL study v2 (exploratory)

Status: EXPLORATORY. It was designed after seeing the v1 results, to address v1's stated limitations. Parameters live in
`eval/study2.json` and were fixed before any v2 result existed. Only the held-out events are new data for the methods;
no detector or ensemble hyperparameter was changed after v1.

## Questions
1. At a MATCHED realised quiet-period alert rate, does SENTINEL's recall differ from an equally thresholded z-score?
   (v1 compared methods at the same nominal budget, which produced different realised rates.)
2. Does the answer hold on held-out shock events that v1 never used?
3. Does it hold on subtler volatility-regime days?

## Primary endpoint (stated in advance)
Recall difference `sentinel_fixed` minus `zscore_matched` at a matched realised rate of 5 quiet-period alerts/day, on
held-out shock events with a fresh onset. Decision rule: the paired 95% interval must exclude 0 to call a difference;
otherwise the result is "no clear difference". Everything else is secondary or descriptive.

## Events (prices only, no detector involved)
- Shock days: UTC days ranked by (high - low)/open, 2020-01-01 to 2026-08-31, same greedy rule and 3-day separation as v1.
  The first 20 picks per symbol are v1 (used here only to mask quiet periods); picks 21 to 50 are the held-out set.
- Regime days: ratio = day range / median range of the previous 7 days; at least 4% range; not within 1 day of any shock
  day; top 30 per symbol with 3-day separation.

## Onset (trailing reference, no midnight anchor)
theta = 6 x the median |60-minute log return| over the 7 days before the event day. Onset = first minute of the event day
whose |60-minute return| >= theta. Events already above theta at 00:00 UTC are "in progress": excluded from the primary
analysis, reported as a sensitivity analysis. The multiple 6 (about 4 sigma for Gaussian noise) was chosen so that chance
crossings on quiet days are rare; a multiple of 4 produced spurious early onsets on pure noise in a unit test. It was set
before any v2 result existed.

## Detection and alert policy
Detection = an alert in [onset - 30, onset + 120] minutes. Every method records a raw score per bar; ONE alert policy is then
applied to all of them (adaptive 1-day quantile threshold, 15-bar cooldown, severity escalation) over a sweep of budgets
(1, 2, 3, 4, 6, 8, 12, 16, 24 per day). Each method gets a recall-versus-realised-alert-rate curve, interpolated linearly at
target rates 3, 5 and 8 alerts/day. Warm-up is 7 days for every method (v1 used 3), which gives the learned ensemble more time.

## Statistics
Cluster bootstrap over calendar days (BTC and ETH on the same day share a cluster), 2000 resamples, 95% percentile
intervals. Differences use identical resamples (paired). A random alerter at the same rate provides the chance level.
No multiplicity correction; read intervals, not p-values. Ablations are compared directly with the full ensemble.

## Not covered
Drift events (slow trends) and level-2 order-book data (no free history). A live recording would be needed for the latter.

## Reproduce
Actions > `study2` workflow > Run workflow. Tables appear on the run summary; full results are attached as an artifact.

## v2b: single-detector baselines (post-hoc extension)
Added AFTER the v2 results were seen, because the primary endpoint was positive and the obvious next question is whether the
ensemble beats its own components. Five baselines `solo_<detector>` run each detector ALONE through exactly the same pipeline
(rolling-ECDF normalisation, one-feature logistic, adaptive threshold, cooldown, escalation) on the same events, with the same
onset rule, budget sweep and statistics. All five are reported, not only the best (picking the best afterwards would inflate it).
There is no decision rule: this is descriptive. Reading guide: if the full ensemble is clearly above every single detector, the
gain is attributable to combining them; if a single detector matches it, the gain comes from the shared normalisation and
alert policy rather than from ensembling. The v2 analysis (all other rows) is reproduced unchanged by the same run.
Run via the `study2b` workflow (`--solo`, output in results/study2b).
