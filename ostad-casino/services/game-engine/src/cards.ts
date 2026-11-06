/** Shared card primitives for blackjack and poker. Server-side only. */

export type Suit = "S" | "H" | "D" | "C";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const RANK_LABEL: Record<Rank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

export const SUIT_SYMBOL: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

export function cardCode(card: Card): string {
  return `${RANK_LABEL[card.rank]}${card.suit}`;
}

export function cardLabel(card: Card): string {
  return `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}`;
}

export function standardDeck(decks = 1): Card[] {
  const deck: Card[] = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) deck.push({ rank, suit });
    }
  }
  return deck;
}

/** Blackjack pip value; aces are counted separately as 11 or 1. */
export function blackjackValue(cards: readonly Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === 14) {
      aces += 1;
      total += 11;
    } else if (card.rank >= 11) {
      total += 10;
    } else {
      total += card.rank;
    }
  }
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces -= 1;
  }
  return { total, soft: softAces > 0 && total <= 21 };
}

export function isBlackjack(cards: readonly Card[]): boolean {
  return cards.length === 2 && blackjackValue(cards).total === 21;
}

/* ─────────────────────────── Poker hand evaluation ─────────────────────────── */

export type HandCategory =
  | "HIGH_CARD"
  | "ONE_PAIR"
  | "TWO_PAIR"
  | "THREE_OF_A_KIND"
  | "STRAIGHT"
  | "FLUSH"
  | "FULL_HOUSE"
  | "FOUR_OF_A_KIND"
  | "STRAIGHT_FLUSH"
  | "ROYAL_FLUSH";

export const HAND_CATEGORY_LABEL: Record<HandCategory, string> = {
  HIGH_CARD: "High Card",
  ONE_PAIR: "One Pair",
  TWO_PAIR: "Two Pair",
  THREE_OF_A_KIND: "Three of a Kind",
  STRAIGHT: "Straight",
  FLUSH: "Flush",
  FULL_HOUSE: "Full House",
  FOUR_OF_A_KIND: "Four of a Kind",
  STRAIGHT_FLUSH: "Straight Flush",
  ROYAL_FLUSH: "Royal Flush",
};

export interface EvaluatedHand {
  category: HandCategory;
  /** Comparable score; higher wins. Ties broken by kickers encoded in score. */
  score: number;
  bestFive: Card[];
  label: string;
}

const CATEGORY_BASE: Record<HandCategory, number> = {
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
};

function combinations<T>(items: readonly T[], choose: number): T[][] {
  const out: T[][] = [];
  const walk = (start: number, acc: T[]) => {
    if (acc.length === choose) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      acc.push(items[i]);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

function rankCounts(cards: readonly Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

function straightHigh(sortedDesc: readonly Rank[]): number | null {
  const unique = Array.from(new Set(sortedDesc)).sort((a, b) => b - a);
  if (unique.length !== 5) return null;
  // Wheel: A-5 straight (Ace plays low).
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
    return 5;
  }
  for (let i = 0; i < unique.length - 1; i += 1) {
    if (unique[i] - unique[i + 1] !== 1) return null;
  }
  return unique[0];
}

function encodeScore(category: HandCategory, kickers: number[]): number {
  // 4 bits per kicker is not enough (ranks 2..14), use base-16 with 6 slots.
  let score = CATEGORY_BASE[category];
  for (let i = 0; i < 6; i += 1) score = score * 16 + (kickers[i] ?? 0);
  return score;
}

/** Evaluate exactly five cards. */
export function evaluateFive(cards: readonly Card[]): EvaluatedHand {
  if (cards.length !== 5) throw new Error("evaluateFive requires exactly 5 cards");
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a) as Rank[];
  const counts = rankCounts(cards);
  const groups = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0] - a[0];
  });
  const isFlush = cards.every((card) => card.suit === cards[0].suit);
  const high = straightHigh(ranks);

  if (isFlush && high !== null) {
    const category: HandCategory = high === 14 ? "ROYAL_FLUSH" : "STRAIGHT_FLUSH";
    return {
      category,
      score: encodeScore(category, [high]),
      bestFive: cards.slice(),
      label: `${HAND_CATEGORY_LABEL[category]}${high === 14 ? "" : `, ${rankName(high)} high`}`,
    };
  }
  if (groups[0][1] === 4) {
    const kicker = groups[1][0];
    return {
      category: "FOUR_OF_A_KIND",
      score: encodeScore("FOUR_OF_A_KIND", [groups[0][0], kicker]),
      bestFive: cards.slice(),
      label: `Four of a Kind, ${rankName(groups[0][0])}s`,
    };
  }
  if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) {
    return {
      category: "FULL_HOUSE",
      score: encodeScore("FULL_HOUSE", [groups[0][0], groups[1][0]]),
      bestFive: cards.slice(),
      label: `Full House, ${rankName(groups[0][0])}s full of ${rankName(groups[1][0])}s`,
    };
  }
  if (isFlush) {
    return {
      category: "FLUSH",
      score: encodeScore("FLUSH", ranks),
      bestFive: cards.slice(),
      label: `Flush, ${rankName(ranks[0])} high`,
    };
  }
  if (high !== null) {
    return {
      category: "STRAIGHT",
      score: encodeScore("STRAIGHT", [high]),
      bestFive: cards.slice(),
      label: `Straight, ${rankName(high)} high`,
    };
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return {
      category: "THREE_OF_A_KIND",
      score: encodeScore("THREE_OF_A_KIND", [groups[0][0], ...kickers]),
      bestFive: cards.slice(),
      label: `Three of a Kind, ${rankName(groups[0][0])}s`,
    };
  }
  if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) {
    const [hi, lo] = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    const kicker = groups[2][0];
    return {
      category: "TWO_PAIR",
      score: encodeScore("TWO_PAIR", [hi, lo, kicker]),
      bestFive: cards.slice(),
      label: `Two Pair, ${rankName(hi)}s and ${rankName(lo)}s`,
    };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((g) => g[0]);
    return {
      category: "ONE_PAIR",
      score: encodeScore("ONE_PAIR", [groups[0][0], ...kickers]),
      bestFive: cards.slice(),
      label: `One Pair, ${rankName(groups[0][0])}s`,
    };
  }
  return {
    category: "HIGH_CARD",
    score: encodeScore("HIGH_CARD", ranks),
    bestFive: cards.slice(),
    label: `High Card, ${rankName(ranks[0])}`,
  };
}

/** Best five-card hand out of 5–7 cards. */
export function evaluateBest(cards: readonly Card[]): EvaluatedHand {
  if (cards.length < 5) throw new Error("evaluateBest requires at least 5 cards");
  if (cards.length === 5) return evaluateFive(cards);
  let best: EvaluatedHand | null = null;
  for (const combo of combinations(cards, 5)) {
    const evaluated = evaluateFive(combo);
    if (!best || evaluated.score > best.score) best = evaluated;
  }
  return best!;
}

export function rankName(rank: number): string {
  if (rank === 14) return "Ace";
  if (rank === 13) return "King";
  if (rank === 12) return "Queen";
  if (rank === 11) return "Jack";
  return String(rank);
}

export function compareHands(a: EvaluatedHand, b: EvaluatedHand): number {
  if (a.score === b.score) return 0;
  return a.score > b.score ? 1 : -1;
}
