/**
 * OSTAD CASINO — compliance boundary (DEMO MODE ONLY).
 *
 * This module is the single gate for anything that could touch real value. In
 * the shipped build every real-money path is fail-closed: the feature flag is
 * false, the gate refuses, and no code path can deposit, withdraw, cash out or
 * move funds on-chain. It intentionally does NOT implement KYC or geofencing;
 * those are prerequisites for a regulated launch, not something this demo
 * pretends to have.
 */
export const APP_MODES = ["DEMO", "REGULATED_PENDING_AUTHORIZATION"] as const;
export type AppMode = (typeof APP_MODES)[number];

export interface ComplianceConfig {
  appMode: AppMode;
  realMoneyEnabled: boolean;
  ageGateAcknowledged: boolean;
  /** Jurisdictions where real-money play is blocked. Empty in demo mode. */
  blockedJurisdictions: readonly string[];
}

export const DEMO_COMPLIANCE: ComplianceConfig = {
  appMode: "DEMO",
  realMoneyEnabled: false,
  ageGateAcknowledged: false,
  blockedJurisdictions: [],
};

export interface ComplianceDecision {
  allowed: boolean;
  code:
    | "ALLOWED"
    | "REAL_MONEY_DISABLED"
    | "AGE_NOT_ACKNOWLEDGED"
    | "JURISDICTION_BLOCKED"
    | "NOT_IMPLEMENTED";
  message: string;
}

/** Every real-value operation must pass through here and is refused in demo. */
export function authorizeRealValueOperation(
  config: ComplianceConfig,
  operation: "deposit" | "withdrawal" | "cashout" | "token_transfer" | "real_money_wager",
): ComplianceDecision {
  if (!config.realMoneyEnabled || config.appMode === "DEMO") {
    return {
      allowed: false,
      code: "REAL_MONEY_DISABLED",
      message: `REAL_MONEY_ENABLED=false — ${operation} is unavailable. Demo credits have no cash value.`,
    };
  }
  // Even with the flag on, a regulated launch requires authorisation that this
  // build does not provide, so the operation stays closed rather than silently
  // enabling unlicensed gambling.
  return {
    allowed: false,
    code: "NOT_IMPLEMENTED",
    message:
      "Real-money operations require a licensed deployment with completed KYC, geofencing, responsible-gambling controls and independent audit.",
  };
}

export interface JurisdictionContext {
  countryCode?: string | null;
  region?: string | null;
}

export function isJurisdictionBlocked(
  config: ComplianceConfig,
  context: JurisdictionContext,
): boolean {
  if (!context.countryCode) return false;
  return config.blockedJurisdictions.includes(context.countryCode.toUpperCase());
}

export const RESPONSIBLE_GAMING = {
  minimumAge: 18,
  reminderIntervalMinutes: 30,
  selfExclusionOptions: [24 * 60, 7 * 24 * 60, 30 * 24 * 60],
  limitsArchitecture: [
    "Per-session stake cap enforced server-side on every game action.",
    "Daily stake cap evaluated from the ledger, not from client state.",
    "Self-exclusion timestamps stored per account and honoured at session creation.",
    "Cooling-off periods that immediately revoke live sessions.",
  ],
} as const;

export const DEMO_DISCLOSURES = [
  "OSTAD CASINO currently operates in DEMO MODE only.",
  "Demo credits have no cash value and cannot be withdrawn, transferred or exchanged.",
  "No deposits, withdrawals, cash-outs or on-chain settlement are implemented.",
  "No licence, certification or regulatory approval is claimed or implied.",
  "Players must be of legal age in their jurisdiction to use the platform.",
] as const;

/** Human-readable banner text reused by the UI and API responses. */
export const DEMO_BANNER = {
  headline: "DEMO MODE",
  subline: "NO REAL-MONEY WAGERING",
  detail: "Demo credits only — no cash value, no deposits, no withdrawals.",
} as const;
