/**
 * OSTAD CASINO — risk engine (demo mode).
 *
 * Demo play carries no financial exposure, so this engine detects *behaviour*
 * that a regulated operator would need to act on and produces audit-table risk
 * events. It never changes a game outcome.
 */
export type RiskSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH";

export interface RiskEventDraft {
  severity: RiskSeverity;
  eventType: string;
  detail: Record<string, unknown>;
}

export interface RiskContext {
  userId: string;
  stakedLastHourMinor: number;
  stakedLast24hMinor: number;
  roundsLastMinute: number;
  netLast24hMinor: number;
  distinctChains: number;
  failedAuthAttempts: number;
  rapidBetStreak: number;
}

export const RISK_THRESHOLDS = {
  roundsPerMinute: 45,
  stakedLastHourMinor: 1_500_000,
  stakedLast24hMinor: 4_000_000,
  lossStreakMinor: 2_500_000,
  failedAuthAttempts: 6,
  rapidBetStreak: 25,
  distinctChains: 3,
} as const;

/** Evaluate a player snapshot and return any events worth recording. */
export function evaluateRisk(context: RiskContext): RiskEventDraft[] {
  const events: RiskEventDraft[] = [];

  if (context.roundsLastMinute >= RISK_THRESHOLDS.roundsPerMinute) {
    events.push({
      severity: "MEDIUM",
      eventType: "VELOCITY_SPIKE",
      detail: { roundsLastMinute: context.roundsLastMinute, threshold: RISK_THRESHOLDS.roundsPerMinute },
    });
  }
  if (context.stakedLastHourMinor >= RISK_THRESHOLDS.stakedLastHourMinor) {
    events.push({
      severity: "MEDIUM",
      eventType: "HOURLY_STAKE_CAP_APPROACHED",
      detail: {
        stakedLastHourMinor: context.stakedLastHourMinor,
        threshold: RISK_THRESHOLDS.stakedLastHourMinor,
      },
    });
  }
  if (context.stakedLast24hMinor >= RISK_THRESHOLDS.stakedLast24hMinor) {
    events.push({
      severity: "HIGH",
      eventType: "DAILY_STAKE_CAP_APPROACHED",
      detail: {
        stakedLast24hMinor: context.stakedLast24hMinor,
        threshold: RISK_THRESHOLDS.stakedLast24hMinor,
      },
    });
  }
  if (context.rapidBetStreak >= RISK_THRESHOLDS.rapidBetStreak) {
    events.push({
      severity: "LOW",
      eventType: "RAPID_BET_STREAK",
      detail: { streak: context.rapidBetStreak },
    });
  }
  if (context.netLast24hMinor <= -RISK_THRESHOLDS.lossStreakMinor) {
    events.push({
      severity: "LOW",
      eventType: "SUSTAINED_LOSSES",
      detail: { netLast24hMinor: context.netLast24hMinor },
    });
  }
  if (context.failedAuthAttempts >= RISK_THRESHOLDS.failedAuthAttempts) {
    events.push({
      severity: "HIGH",
      eventType: "REPEATED_AUTH_FAILURES",
      detail: { failedAuthAttempts: context.failedAuthAttempts },
    });
  }
  if (context.distinctChains >= RISK_THRESHOLDS.distinctChains) {
    events.push({
      severity: "INFO",
      eventType: "MULTI_CHAIN_ACTIVITY",
      detail: { distinctChains: context.distinctChains },
    });
  }

  return events;
}

/**
 * Demo-only RTP drift watch. Operators with legal obligations would surface this
 * to compliance; in demo mode it is informational telemetry for the admin panel.
 */
export function rtpDrift(input: {
  totalStakedMinor: number;
  totalPaidMinor: number;
  theoreticalEdge: number;
}): { observedRtp: number | null; theoreticalRtp: number; drift: number | null; alert: boolean } {
  const theoreticalRtp = 1 - input.theoreticalEdge;
  if (input.totalStakedMinor <= 0) {
    return { observedRtp: null, theoreticalRtp, drift: null, alert: false };
  }
  const observedRtp = input.totalPaidMinor / input.totalStakedMinor;
  const drift = observedRtp - theoreticalRtp;
  return { observedRtp, theoreticalRtp, drift, alert: Math.abs(drift) > 0.15 };
}
