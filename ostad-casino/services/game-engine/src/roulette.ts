/**
 * OSTAD CASINO — European roulette demo engine (server authoritative).
 *
 * Single-zero wheel (0–36). The engine receives a server-side RNG stream, picks
 * the pocket, then evaluates every placed bet against the payout table. The
 * client never supplies a result, a multiplier or a payout — it supplies a
 * selection and an integer stake only.
 */
import type { RngStream } from "@ostad/rng";

/** Physical pocket order of a European wheel. */
export const EUROPEAN_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5,
  24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

export const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export function isRed(n: number): boolean {
  return RED_NUMBERS.has(n);
}

export function rouletteColor(n: number): "RED" | "BLACK" | "GREEN" {
  if (n === 0) return "GREEN";
  return isRed(n) ? "RED" : "BLACK";
}

export type RouletteBetType =
  | "straight"
  | "split"
  | "street"
  | "corner"
  | "sixline"
  | "red"
  | "black"
  | "odd"
  | "even"
  | "low"
  | "high"
  | "dozen"
  | "column";

export const PAYOUT_MULTIPLIER: Record<RouletteBetType, number> = {
  straight: 35,
  split: 17,
  street: 11,
  corner: 8,
  sixline: 5,
  red: 1,
  black: 1,
  odd: 1,
  even: 1,
  low: 1,
  high: 1,
  dozen: 2,
  column: 2,
};

export interface RouletteBet {
  type: RouletteBetType;
  /** Pocket numbers covered (inside bets only). */
  numbers?: number[];
  /** 1–3 for dozens and columns. */
  index?: number;
  /** Integer minor units, server-validated. */
  stakeMinor: number;
}

export interface RouletteBetResult {
  bet: RouletteBet;
  won: boolean;
  /** Total returned to the player (stake × (multiplier+1)) on a win, else 0. */
  payoutMinor: number;
  label: string;
}

export interface RouletteRoundResult {
  number: number;
  color: "RED" | "BLACK" | "GREEN";
  parity: "ODD" | "EVEN" | "NONE";
  half: "LOW" | "HIGH" | "NONE";
  dozen: 1 | 2 | 3 | null;
  column: 1 | 2 | 3 | null;
  wheelIndex: number;
  bets: RouletteBetResult[];
  totalStakeMinor: number;
  totalPayoutMinor: number;
  netMinor: number;
}

export class RulesError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RulesError";
  }
}

export const ROULETTE_LIMITS = {
  minStakeMinor: 100, // 1.00 demo credit
  maxStakePerBetMinor: 500_000, // 5,000.00 demo credits
  maxTotalStakeMinor: 2_000_000, // 20,000.00
  maxBetsPerRound: 24,
} as const;

const COLUMN_OF = (n: number): 1 | 2 | 3 | null => {
  if (n === 0) return null;
  const mod = n % 3;
  if (mod === 1) return 1;
  if (mod === 2) return 2;
  return 3;
};

const DOZEN_OF = (n: number): 1 | 2 | 3 | null => {
  if (n === 0) return null;
  if (n <= 12) return 1;
  if (n <= 24) return 2;
  return 3;
};

function validateNumbers(type: RouletteBetType, numbers: number[] | undefined): number[] {
  const expected: Partial<Record<RouletteBetType, number>> = {
    straight: 1,
    split: 2,
    street: 3,
    corner: 4,
    sixline: 6,
  };
  const want = expected[type];
  if (!want) return [];
  if (!numbers || numbers.length !== want) {
    throw new RulesError("invalid_selection", `${type} requires exactly ${want} numbers`);
  }
  const sorted = numbers.slice().sort((a, b) => a - b);
  for (const n of sorted) {
    if (!Number.isInteger(n) || n < 0 || n > 36) {
      throw new RulesError("invalid_selection", "Roulette numbers must be 0–36");
    }
    if (n === 0 && type !== "straight") {
      throw new RulesError("invalid_selection", "0 is only available as a straight-up bet");
    }
  }
  if (new Set(sorted).size !== sorted.length) {
    throw new RulesError("invalid_selection", "Bet selection contains duplicate numbers");
  }

  // Layout geometry: table is 12 rows × 3 columns (col 1 = 1,4,7…).
  if (type === "split") {
    const [a, b] = sorted;
    const sameRow = Math.floor((a - 1) / 3) === Math.floor((b - 1) / 3) && b - a === 1;
    const sameColumn = (a - 1) % 3 === (b - 1) % 3 && b - a === 3;
    if (!sameRow && !sameColumn) throw new RulesError("invalid_selection", "Not an adjacent split");
  }
  if (type === "street") {
    const start = sorted[0];
    if ((start - 1) % 3 !== 0 || sorted[2] - start !== 2) {
      throw new RulesError("invalid_selection", "Streets cover a full row of three numbers");
    }
  }
  if (type === "corner") {
    const [a, b, c, d] = sorted;
    const ok = b - a === 1 && c - b === 2 && d - c === 1;
    if (!ok) throw new RulesError("invalid_selection", "Corners cover a 2×2 block");
  }
  if (type === "sixline") {
    const start = sorted[0];
    if ((start - 1) % 3 !== 0 || sorted[5] - start !== 5) {
      throw new RulesError("invalid_selection", "Six-line covers two adjacent rows");
    }
  }
  return sorted;
}

/** Server-side validation of the full bet slip. */
export function validateBets(bets: RouletteBet[]): RouletteBet[] {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new RulesError("no_bets", "Place at least one demo bet");
  }
  if (bets.length > ROULETTE_LIMITS.maxBetsPerRound) {
    throw new RulesError("too_many_bets", "Too many bets in a single round");
  }
  let total = 0;
  return bets.map((bet) => {
    if (!PAYOUT_MULTIPLIER[bet.type]) {
      throw new RulesError("invalid_bet_type", "Unknown bet type");
    }
    if (!Number.isInteger(bet.stakeMinor) || bet.stakeMinor < ROULETTE_LIMITS.minStakeMinor) {
      throw new RulesError("invalid_stake", "Bet is below the demo table minimum");
    }
    if (bet.stakeMinor > ROULETTE_LIMITS.maxStakePerBetMinor) {
      throw new RulesError("invalid_stake", "Bet exceeds the demo table maximum");
    }
    total += bet.stakeMinor;
    if (total > ROULETTE_LIMITS.maxTotalStakeMinor) {
      throw new RulesError("limit_exceeded", "Total demo stake exceeds the table limit");
    }
    const numbers = validateNumbers(bet.type, bet.numbers);
    let index = bet.index;
    if (bet.type === "dozen" || bet.type === "column") {
      if (index !== 1 && index !== 2 && index !== 3) {
        throw new RulesError("invalid_selection", "Dozens and columns are numbered 1–3");
      }
    } else {
      index = undefined;
    }
    return { type: bet.type, numbers: numbers.length ? numbers : undefined, index, stakeMinor: bet.stakeMinor };
  });
}

export function betLabel(bet: RouletteBet): string {
  switch (bet.type) {
    case "straight":
      return `Straight ${bet.numbers?.[0]}`;
    case "split":
      return `Split ${bet.numbers?.join("/")}`;
    case "street":
      return `Street ${bet.numbers?.join("-")}`;
    case "corner":
      return `Corner ${bet.numbers?.join("-")}`;
    case "sixline":
      return `Six Line ${bet.numbers?.join("-")}`;
    case "red":
      return "Red";
    case "black":
      return "Black";
    case "odd":
      return "Odd";
    case "even":
      return "Even";
    case "low":
      return "Low (1–18)";
    case "high":
      return "High (19–36)";
    case "dozen":
      return `Dozen ${bet.index}`;
    case "column":
      return `Column ${bet.index}`;
  }
}

function betWins(bet: RouletteBet, n: number): boolean {
  if (n === 0) return bet.type === "straight" && bet.numbers?.[0] === 0;
  switch (bet.type) {
    case "straight":
    case "split":
    case "street":
    case "corner":
    case "sixline":
      return (bet.numbers ?? []).includes(n);
    case "red":
      return isRed(n);
    case "black":
      return !isRed(n);
    case "odd":
      return n % 2 === 1;
    case "even":
      return n % 2 === 0;
    case "low":
      return n >= 1 && n <= 18;
    case "high":
      return n >= 19 && n <= 36;
    case "dozen":
      return DOZEN_OF(n) === bet.index;
    case "column":
      return COLUMN_OF(n) === bet.index;
  }
}

/**
 * Spin the wheel using the provided server-side stream and evaluate the slip.
 * `stream` must come from the RNG service — the only source of outcome entropy.
 */
export function spinRoulette(stream: RngStream, rawBets: RouletteBet[]): RouletteRoundResult {
  const bets = validateBets(rawBets);
  const wheelIndex = stream.int(EUROPEAN_WHEEL.length);
  const number = EUROPEAN_WHEEL[wheelIndex];
  const color = rouletteColor(number);

  const results: RouletteBetResult[] = bets.map((bet) => {
    const won = betWins(bet, number);
    const multiplier = PAYOUT_MULTIPLIER[bet.type];
    return {
      bet,
      won,
      payoutMinor: won ? bet.stakeMinor * (multiplier + 1) : 0,
      label: betLabel(bet),
    };
  });

  const totalStakeMinor = bets.reduce((sum, b) => sum + b.stakeMinor, 0);
  const totalPayoutMinor = results.reduce((sum, r) => sum + r.payoutMinor, 0);

  return {
    number,
    color,
    parity: number === 0 ? "NONE" : number % 2 === 1 ? "ODD" : "EVEN",
    half: number === 0 ? "NONE" : number <= 18 ? "LOW" : "HIGH",
    dozen: DOZEN_OF(number) as 1 | 2 | 3 | null,
    column: COLUMN_OF(number) as 1 | 2 | 3 | null,
    wheelIndex,
    bets: results,
    totalStakeMinor,
    totalPayoutMinor,
    netMinor: totalPayoutMinor - totalStakeMinor,
  };
}
