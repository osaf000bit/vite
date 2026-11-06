/**
 * Per-wallet demo controls. These are product limits, not regulatory controls,
 * and they are enforced on the server for every game action.
 */
export interface DemoLimits {
  /** Maximum single demo stake in minor units. */
  maxStakeMinor: number;
  /** Maximum total demo staked per rolling 24h, minor units. */
  dailyStakeCapMinor: number;
  /** Reminder threshold; the UI shows a responsible-play notice. */
  sessionMinutesReminder: number;
}

export const DEFAULT_DEMO_LIMITS: DemoLimits = {
  maxStakeMinor: 500_000,
  dailyStakeCapMinor: 5_000_000,
  sessionMinutesReminder: 60,
};

export function withinDemoLimits(
  limits: DemoLimits,
  args: { stakeMinor: number; stakedLast24hMinor: number },
): { ok: boolean; reason?: "stake_above_max" | "daily_cap_reached" } {
  if (args.stakeMinor > limits.maxStakeMinor) return { ok: false, reason: "stake_above_max" };
  if (args.stakedLast24hMinor + args.stakeMinor > limits.dailyStakeCapMinor) {
    return { ok: false, reason: "daily_cap_reached" };
  }
  return { ok: true };
}
