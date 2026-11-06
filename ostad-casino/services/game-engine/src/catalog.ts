/**
 * Game catalog metadata shared by the lobby, API and admin console.
 * Limits are the demo-credit table limits enforced by the engines.
 */
import type { GameKey } from "@ostad/ledger";

export interface GameDefinition {
  key: GameKey;
  name: string;
  category: "CASINO" | "TABLE" | "CARD" | "SLOTS";
  tagline: string;
  description: string;
  rules: string[];
  fairness: string;
  minStakeMinor: number;
  maxStakeMinor: number;
  enabled: boolean;
  accent: string;
  glyph: string;
  houseEdgeNote: string;
}

export const GAME_CATALOG: readonly GameDefinition[] = [
  {
    key: "roulette",
    name: "Achaemenid Roulette",
    category: "TABLE",
    tagline: "European single-zero wheel",
    description:
      "A single-zero European wheel with the full inside and outside bet set. Every spin is drawn from the server RNG stream after the wheel commitment is published.",
    rules: [
      "European wheel: pockets 0–36, single zero.",
      "Inside bets: straight (35:1), split (17:1), street (11:1), corner (8:1), six-line (5:1).",
      "Outside bets: red/black, odd/even, low/high (1:1), dozens and columns (2:1).",
      "Stake returns include the original wager, so a winning even-money bet pays 2× the stake.",
      "The house edge is the standard 2.70% of a single-zero wheel.",
    ],
    fairness:
      "The pocket is selected with an unbiased integer draw from the provably-fair RNG stream; the server seed hash is published before the spin.",
    minStakeMinor: 100,
    maxStakeMinor: 500_000,
    enabled: true,
    accent: "#c8a24a",
    glyph: "◉",
    houseEdgeNote: "2.70% theoretical",
  },
  {
    key: "blackjack",
    name: "Royal Blackjack",
    category: "CARD",
    tagline: "Six-deck shoe, dealer stands on soft 17",
    description:
      "Classic six-deck blackjack with hit, stand and double. Natural blackjack pays 3:2 and pushes return the stake.",
    rules: [
      "Six-deck shoe, reshuffled every round from the server RNG stream.",
      "Natural blackjack pays 3:2; a dealer natural against your natural is a push.",
      "Double is available on the first two cards only and doubles the escrowed stake.",
      "Dealer hits to 17 and stands on all 17s, including soft 17.",
      "Bust over 21 loses regardless of the dealer hand.",
    ],
    fairness:
      "The shoe is shuffled server-side from the same committed seed stream. The dealer hole card is withheld from the client until settlement.",
    minStakeMinor: 100,
    maxStakeMinor: 500_000,
    enabled: true,
    accent: "#b56a3c",
    glyph: "♠",
    houseEdgeNote: "≈0.6% with basic strategy",
  },
  {
    key: "slots",
    name: "Persepolis Reels",
    category: "SLOTS",
    tagline: "5 reels · 3 rows · 20 paylines",
    description:
      "A five-reel, three-row slot with Persian iconography, wild substitution, scatter pays and configurable active paylines.",
    rules: [
      "Five reels, three rows, up to 20 configurable paylines evaluated left to right.",
      "The Wing wild substitutes for every symbol except the Royal Seal scatter.",
      "Three, four or five scatters pay 5×, 25× or 200× the line bet.",
      "Stake multipliers of 1×, 2×, 5× and 10× are available.",
      "Auto-spin is capped at 100 demo spins per request.",
    ],
    fairness:
      "The complete 5×3 grid is drawn from the server RNG stream before any evaluation; the client never receives or sends reel positions.",
    minStakeMinor: 100,
    maxStakeMinor: 100_000,
    enabled: true,
    accent: "#8f7bd6",
    glyph: "❖",
    houseEdgeNote: "≈4.2% theoretical",
  },
  {
    key: "poker",
    name: "Palace Hold'em",
    category: "TABLE",
    tagline: "No-limit Texas Hold'em · 2–9 seats",
    description:
      "Server-authoritative Texas Hold'em with blinds, four betting rounds, side pots and showdown ranking. Demo tables seat practice opponents.",
    rules: [
      "No-limit Texas Hold'em, two to nine seats per table.",
      "Small blind then big blind are posted automatically at the start of each hand.",
      "Preflop, flop, turn and river betting rounds with fold, check, call, raise and all-in.",
      "Side pots are formed from unequal all-in stacks and awarded by hand strength.",
      "Showdown uses the best five-card hand from seven cards.",
    ],
    fairness:
      "The deck is shuffled with the committed seed stream at the start of each hand. Other seats' hole cards are stripped from the API response until showdown.",
    minStakeMinor: 2_000,
    maxStakeMinor: 500_000,
    enabled: true,
    accent: "#3f7f6a",
    glyph: "♛",
    houseEdgeNote: "No rake in demo mode",
  },
] as const;

export const GAME_CATEGORIES = ["CASINO", "TABLE", "CARD", "SLOTS"] as const;

export function getGameDefinition(key: string): GameDefinition | undefined {
  return GAME_CATALOG.find((game) => game.key === key);
}
