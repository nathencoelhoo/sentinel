import { SortedWindow } from './stats.ts';

export interface ThresholdOptions {
  window: number;
  exceedRate: number;
  minObs: number;
  floor: number;
  cooldown: number;
  /**
   * Severity escalation: inside a cooldown, an alert still fires if the score is
   * (a) above the normal threshold, (b) above the (1 - rho/escalationFactor) quantile
   * of the past window, i.e. an exceedance `escalationFactor` times rarer than the alarm
   * budget, and (c) higher than the last alert's score. 0 disables (plain cooldown).
   */
  escalationFactor?: number;
}

/**
 * Adaptive alert threshold controlling the exceedance rate per symbol.
 *
 *   $$ \tau_t = \max\big(\text{floor},\; Q_{1-\rho}(s_{t-W:t-1})\big), \qquad
 *      \tau^{esc}_t = Q_{1-\rho/k}(s_{t-W:t-1}) $$
 *
 * with rho = alarms-per-day * bar-seconds / 86400. Quantiles use PAST scores only.
 * A cooldown merges clustered exceedances into one alert, EXCEPT that an alert
 * which escalates past tau^esc and the previous alert's score is let through, so a
 * burst of earlier false alarms cannot mask a genuinely larger event.
 * Trade-off: a very long anomaly raises its own threshold as it fills the window.
 */
export class AdaptiveThreshold {
  private readonly win: SortedWindow;
  private readonly o: ThresholdOptions;
  private readonly k: number;
  private sinceAlert: number;
  private lastAlertValue = -Infinity;

  constructor(o: ThresholdOptions) {
    this.o = o;
    this.k = o.escalationFactor ?? 10;
    this.win = new SortedWindow(o.window);
    this.sinceAlert = o.cooldown;
  }

  update(v: number): { threshold: number; alert: boolean; escalated: boolean } {
    let threshold = Infinity;
    let escThreshold = Infinity;
    if (this.win.size >= this.o.minObs) {
      threshold = Math.max(this.o.floor, this.win.quantile(1 - this.o.exceedRate));
      if (this.k > 0) escThreshold = this.win.quantile(1 - this.o.exceedRate / this.k);
    }
    this.sinceAlert++;
    const exceeds = v > threshold;
    const inCooldown = this.sinceAlert < this.o.cooldown;
    const escalated = inCooldown && exceeds && v > escThreshold && v > this.lastAlertValue;
    const alert = exceeds && (!inCooldown || escalated);
    if (alert) {
      this.sinceAlert = 0;
      this.lastAlertValue = v;
    }
    this.win.push(v);
    return { threshold, alert, escalated };
  }
}
