/**
 * OSTAD CASINO — 5×3 video slot demo engine (server authoritative).
 *
 * Reels are weighted symbol sets; the whole grid is drawn from the server RNG
 * stream before any evaluation happens, so the outcome cannot be influenced by
 * the client. Paylines are configurable and are evaluated centre-out.
 */
import type { RngStream } from "@ostad/rng";

export type SlotSymbol =
  | "WILD"
  | "SCATTER"
  | "CROWN"
  | "FALCON"
  | "WING"
  | "LOTUS"
  | "SUN"
  | "GEM"
  | "TEN";

export interface SlotSymbolSpec {
  symbol: SlotSymbol;
  label: string;
  glyph: string;
  /** Payout multiples of the line bet for 3, 4 and 5 of a kind. */
  payThree: number;
  payFour: number;
  payFive: number;
  weight: number;
  wild?: boolean;
  scatter?: boolean;
}

export const SLOT_SYMBOLS: readonly SlotSymbolSpec[] = [
  { symbol: "WILD", label: "Achaemenid Wing", glyph: "◈", payThree: 0, payFour: 0, payFive: 0, weight: 3, wild: true },
  { symbol: "SCATTER", label: "Royal Seal", glyph: "✶", payThree: 0, payFour: 0, payFive: 0, weight: 2, scatter: true },
  { symbol: "CROWN", label: "Crown", glyph: "♛", payThree: 25, payFour: 100, payFive: 500, weight: 4 },
  { symbol: "FALCON", label: "Falcon", glyph: "❖", payThree: 15, payFour: 60, payFive: 250, weight: 6 },
  { symbol: "WING", label: "Winged Disc", glyph: "❂", payThree: 10, payFour: 40, payFive: 150, weight: 8 },
  { symbol: "LOTUS", label: "Lotus", glyph: "✿", payThree: 8, payFour: 25, payFive: 100, weight: 10 },
  { symbol: "SUN", label: "Sun", glyph: "☀", payThree: 6, payFour: 18, payFive: 70, weight: 12 },
  { symbol: "GEM", label: "Lapis", glyph: "◆", payThree: 4, payFour: 12, payFive: 45, weight: 14 },
  { symbol: "TEN", label: "Ten", glyph: "X", payThree: 2, payFour: 6, payFive: 20, weight: 20 },
] as const;

export const REELS = 5;
export const ROWS = 3;

/** 20 paylines over a 5×3 grid; each entry is the row index per reel. */
export const PAYLINES: readonly (readonly number[])[] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2],
  [2, 2, 1, 0, 0],
  [1, 0, 0, 0, 1],
  [1, 2, 2, 2, 1],
  [1, 0, 1, 2, 1],
  [1, 2, 1, 0, 1],
  [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2],
  [1, 1, 0, 1, 1],
  [1, 1, 2, 1, 1],
  [0, 1, 0, 1, 0],
  [2, 1, 2, 1, 2],
  [0, 2, 0, 2, 0],
  [2, 0, 2, 0, 2],
  [0, 0, 2, 0, 0],
] as const;

export const SLOT_LIMITS = {
  minStakeMinor: 100,
  maxStakeMinor: 100_000,
  /** Line bets are the stake divided by the number of active lines. */
  maxAutospins: 100,
  scatterPayThree: 5,
  scatterPayFour: 25,
  scatterPayFive: 200,
} as const;

export interface SlotLineWin {
  line: number;
  path: number[];
  symbol: SlotSymbol;
  count: number;
  amountMinor: number;
  positions: { reel: number; row: number }[];
}

export interface SlotSpinResult {
  grid: SlotSymbol[][]; // [reel][row]
  lines: SlotLineWin[];
  scatterCount: number;
  scatterPayoutMinor: number;
  /** Wild substitutes for every symbol except scatter. */
  multiplier: number;
  totalStakeMinor: number;
  totalPayoutMinor: number;
  netMinor: number;
  activeLines: number;
}

export class SlotRulesError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SlotRulesError";
  }
}

const SPEC_BY_SYMBOL = new Map(SLOT_SYMBOLS.map((spec) => [spec.symbol, spec]));

function symbolAt(grid: SlotSymbol[][], reel: number, row: number): SlotSymbol {
  const column = grid[reel];
  if (!column || row < 0 || row >= column.length) {
    throw new SlotRulesError("invalid_grid", "Payline leaves the visible grid");
  }
  return column[row];
}

function payoutFor(spec: SlotSymbolSpec, count: number): number {
  if (count === 5) return spec.payFive;
  if (count === 4) return spec.payFour;
  if (count === 3) return spec.payThree;
  return 0;
}

/** Evaluate a payline. Wilds substitute; wild-only runs pay as the top symbol. */
export function evaluateLine(
  grid: SlotSymbol[][],
  path: readonly number[],
  lineIndex: number,
  lineStakeMinor: number,
): SlotLineWin | null {
  const symbols = path.map((row, reel) => symbolAt(grid, reel, row));
  let baseSymbol: SlotSymbol | null = null;
  let count = 0;

  for (const symbol of symbols) {
    const spec = SPEC_BY_SYMBOL.get(symbol)!;
    if (spec.scatter) break;
    if (spec.wild) {
      count += 1;
      continue;
    }
    if (baseSymbol === null) {
      baseSymbol = symbol;
      count += 1;
      continue;
    }
    if (symbol === baseSymbol) {
      count += 1;
      continue;
    }
    break;
  }

  if (count < 3) return null;

  // A run made exclusively of wilds pays as the highest-value base symbol.
  const payingSymbol: SlotSymbol = baseSymbol ?? "CROWN";
  const spec = SPEC_BY_SYMBOL.get(payingSymbol)!;
  const multiplier = payoutFor(spec, count);
  if (multiplier <= 0) return null;

  return {
    line: lineIndex + 1,
    path: path.slice(),
    symbol: payingSymbol,
    count,
    amountMinor: Math.round(lineStakeMinor * multiplier),
    positions: path.slice(0, count).map((row, reel) => ({ reel, row })),
  };
}

function weightedSymbol(stream: RngStream): SlotSymbol {
  const weights = SLOT_SYMBOLS.map((spec) => spec.weight);
  return SLOT_SYMBOLS[stream.weightedIndex(weights)].symbol;
}

/** Draw the full 5×3 grid, then evaluate every active line plus scatters. */
export function spinSlots(
  stream: RngStream,
  opts: { stakeMinor: number; activeLines?: number; multiplier?: number },
): SlotSpinResult {
  const stakeMinor = opts.stakeMinor;
  if (!Number.isInteger(stakeMinor) || stakeMinor < SLOT_LIMITS.minStakeMinor) {
    throw new SlotRulesError("invalid_stake", "Stake is below the demo minimum");
  }
  if (stakeMinor > SLOT_LIMITS.maxStakeMinor) {
    throw new SlotRulesError("invalid_stake", "Stake exceeds the demo maximum");
  }
  const activeLines = opts.activeLines ?? PAYLINES.length;
  if (!Number.isInteger(activeLines) || activeLines < 1 || activeLines > PAYLINES.length) {
    throw new SlotRulesError("invalid_lines", `Active lines must be 1–${PAYLINES.length}`);
  }
  const multiplier = opts.multiplier ?? 1;
  if (![1, 2, 5, 10].includes(multiplier)) {
    throw new SlotRulesError("invalid_multiplier", "Multiplier must be 1, 2, 5 or 10");
  }

  // Grid draw order is fixed: reel-major, 3 rows per reel.
  const grid: SlotSymbol[][] = [];
  for (let reel = 0; reel < REELS; reel += 1) {
    const column: SlotSymbol[] = [];
    for (let row = 0; row < ROWS; row += 1) column.push(weightedSymbol(stream));
    grid.push(column);
  }

  const lineStakeMinor = Math.floor(stakeMinor / activeLines);
  const lines: SlotLineWin[] = [];
  for (let i = 0; i < activeLines; i += 1) {
    const win = evaluateLine(grid, PAYLINES[i], i, lineStakeMinor * multiplier);
    if (win) lines.push(win);
  }

  let scatterCount = 0;
  for (const column of grid) {
    for (const symbol of column) if (symbol === "SCATTER") scatterCount += 1;
  }
  const scatterMultiplier =
    scatterCount >= 5
      ? SLOT_LIMITS.scatterPayFive
      : scatterCount === 4
        ? SLOT_LIMITS.scatterPayFour
        : scatterCount === 3
          ? SLOT_LIMITS.scatterPayThree
          : 0;
  const scatterPayoutMinor = Math.round(lineStakeMinor * scatterMultiplier * multiplier);

  const lineTotal = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const totalPayoutMinor = lineTotal + scatterPayoutMinor;

  return {
    grid,
    lines,
    scatterCount,
    scatterPayoutMinor,
    multiplier,
    totalStakeMinor: stakeMinor,
    totalPayoutMinor,
    netMinor: totalPayoutMinor - stakeMinor,
    activeLines,
  };
}

export function slotSymbolSpec(symbol: SlotSymbol): SlotSymbolSpec {
  return SPEC_BY_SYMBOL.get(symbol)!;
}
