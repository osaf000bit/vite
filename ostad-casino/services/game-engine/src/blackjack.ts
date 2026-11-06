/**
 * OSTAD CASINO — blackjack demo engine (server authoritative).
 *
 * Six-deck shoe reshuffled every round from the server RNG stream. Player can
 * hit, stand or double. Dealer hits to 17 and stands on soft 17. Every state
 * transition happens on the server; the client only sends an action name.
 */
import type { RngStream } from "@ostad/rng";
import { blackjackValue, cardLabel, isBlackjack, standardDeck, type Card } from "./cards";

export const BLACKJACK_LIMITS = {
  minStakeMinor: 100,
  maxStakeMinor: 500_000,
  decks: 6,
  blackjackPayoutNumerator: 3,
  blackjackPayoutDenominator: 2,
} as const;

export type BlackjackOutcome =
  | "PLAYER_BLACKJACK"
  | "PLAYER_WIN"
  | "DEALER_WIN"
  | "PUSH"
  | "PLAYER_BUST"
  | "DEALER_BUST";

export type BlackjackStatus = "PLAYER_TURN" | "SETTLED";

export interface BlackjackState {
  deck: Card[];
  playerHand: Card[];
  dealerHand: Card[];
  /** Escrowed demo stake in minor units, already doubled when `doubled`. */
  stakeMinor: number;
  doubled: boolean;
  status: BlackjackStatus;
  outcome: BlackjackOutcome | null;
  /** Total returned to the player (stake included) on settlement. */
  payoutMinor: number;
  playerTotal: number;
  dealerTotal: number;
  dealerHoleRevealed: boolean;
  actions: BlackjackAction[];
  message: string;
}

export type BlackjackAction = "hit" | "stand" | "double";

export class BlackjackRulesError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BlackjackRulesError";
  }
}

export function shuffleShoe(stream: RngStream, decks = BLACKJACK_LIMITS.decks): Card[] {
  return stream.shuffle(standardDeck(decks));
}

function draw(state: BlackjackState): Card {
  const card = state.deck.pop();
  if (!card) throw new BlackjackRulesError("shoe_empty", "Shoe exhausted");
  return card;
}

function totals(state: BlackjackState): void {
  state.playerTotal = blackjackValue(state.playerHand).total;
  state.dealerTotal = blackjackValue(state.dealerHand).total;
}

/** Pure settlement: computes the outcome and the amount returned to the player. */
export function settleBlackjack(state: BlackjackState): BlackjackState {
  const playerBJ = isBlackjack(state.playerHand);
  const dealerBJ = isBlackjack(state.dealerHand);
  const stake = state.stakeMinor;
  let outcome: BlackjackOutcome;
  let payout: number;

  if (playerBJ && dealerBJ) {
    outcome = "PUSH";
    payout = stake;
  } else if (playerBJ) {
    outcome = "PLAYER_BLACKJACK";
    payout =
      stake +
      Math.floor(
        (stake * BLACKJACK_LIMITS.blackjackPayoutNumerator) / BLACKJACK_LIMITS.blackjackPayoutDenominator,
      );
  } else if (dealerBJ) {
    outcome = "DEALER_WIN";
    payout = 0;
  } else if (state.playerTotal > 21) {
    outcome = "PLAYER_BUST";
    payout = 0;
  } else if (state.dealerTotal > 21) {
    outcome = "DEALER_BUST";
    payout = stake * 2;
  } else if (state.playerTotal > state.dealerTotal) {
    outcome = "PLAYER_WIN";
    payout = stake * 2;
  } else if (state.playerTotal === state.dealerTotal) {
    outcome = "PUSH";
    payout = stake;
  } else {
    outcome = "DEALER_WIN";
    payout = 0;
  }

  return {
    ...state,
    status: "SETTLED",
    outcome,
    payoutMinor: payout,
    dealerHoleRevealed: true,
    message: describeOutcome(outcome),
  };
}

export function describeOutcome(outcome: BlackjackOutcome): string {
  switch (outcome) {
    case "PLAYER_BLACKJACK":
      return "Blackjack! Paid 3:2";
    case "PLAYER_WIN":
      return "You win";
    case "DEALER_WIN":
      return "Dealer wins";
    case "PUSH":
      return "Push — stake returned";
    case "PLAYER_BUST":
      return "Bust — dealer wins";
    case "DEALER_BUST":
      return "Dealer busts — you win";
  }
}

function dealerPlay(state: BlackjackState): BlackjackState {
  const hole = state.dealerHand[1];
  void hole;
  while (blackjackValue(state.dealerHand).total < 17) {
    state.dealerHand.push(draw(state));
  }
  totals(state);
  return settleBlackjack({ ...state, dealerHoleRevealed: true });
}

/** Start a round: deal two cards each, resolve naturals immediately. */
export function startBlackjack(stream: RngStream, stakeMinor: number): BlackjackState {
  if (!Number.isInteger(stakeMinor) || stakeMinor < BLACKJACK_LIMITS.minStakeMinor) {
    throw new BlackjackRulesError("invalid_stake", "Stake is below the demo table minimum");
  }
  if (stakeMinor > BLACKJACK_LIMITS.maxStakeMinor) {
    throw new BlackjackRulesError("invalid_stake", "Stake exceeds the demo table maximum");
  }
  const base: BlackjackState = {
    deck: shuffleShoe(stream),
    playerHand: [],
    dealerHand: [],
    stakeMinor,
    doubled: false,
    status: "PLAYER_TURN",
    outcome: null,
    payoutMinor: 0,
    playerTotal: 0,
    dealerTotal: 0,
    dealerHoleRevealed: false,
    actions: [],
    message: "",
  };

  base.playerHand.push(draw(base), draw(base));
  base.dealerHand.push(draw(base), draw(base));
  totals(base);

  if (isBlackjack(base.playerHand) || isBlackjack(base.dealerHand)) {
    return settleBlackjack({ ...base, dealerHoleRevealed: true });
  }
  return { ...base, message: "Your move" };
}

/** Apply a player action. Returns the new state; throws on an illegal action. */
export function actBlackjack(state: BlackjackState, action: BlackjackAction): BlackjackState {
  if (state.status !== "PLAYER_TURN") {
    throw new BlackjackRulesError("round_complete", "This round is already settled");
  }
  const next: BlackjackState = structuredClone(state);

  if (action === "hit") {
    next.playerHand.push(draw(next));
    totals(next);
    next.actions.push("hit");
    if (next.playerTotal > 21) return settleBlackjack({ ...next, dealerHoleRevealed: true });
    if (next.playerTotal === 21) return dealerPlay(next);
    return { ...next, message: "Your move" };
  }

  if (action === "stand") {
    next.actions.push("stand");
    return dealerPlay(next);
  }

  if (action === "double") {
    if (next.playerHand.length !== 2) {
      throw new BlackjackRulesError("double_not_allowed", "Double is only available on the first two cards");
    }
    // The extra stake is escrowed by the caller before settlement is trusted.
    next.stakeMinor = state.stakeMinor * 2;
    next.doubled = true;
    next.actions.push("double");
    next.playerHand.push(draw(next));
    totals(next);
    if (next.playerTotal > 21) return settleBlackjack({ ...next, dealerHoleRevealed: true });
    return dealerPlay(next);
  }

  throw new BlackjackRulesError("unknown_action", "Unknown action");
}

export interface BlackjackView {
  playerHand: string[];
  dealerHand: string[];
  dealerHidden: boolean;
  playerTotal: number;
  dealerTotal: number | null;
  status: BlackjackStatus;
  outcome: BlackjackOutcome | null;
  stakeMinor: number;
  payoutMinor: number;
  doubled: boolean;
  availableActions: BlackjackAction[];
  message: string;
}

/** Client-safe projection. The dealer hole card is never leaked pre-reveal. */
export function blackjackView(state: BlackjackState): BlackjackView {
  return {
    playerHand: state.playerHand.map(cardLabel),
    dealerHand: state.dealerHoleRevealed
      ? state.dealerHand.map(cardLabel)
      : [cardLabel(state.dealerHand[0]), "▣"],
    dealerHidden: !state.dealerHoleRevealed,
    playerTotal: state.playerTotal,
    dealerTotal: state.dealerHoleRevealed ? state.dealerTotal : null,
    status: state.status,
    outcome: state.outcome,
    stakeMinor: state.stakeMinor,
    payoutMinor: state.payoutMinor,
    doubled: state.doubled,
    availableActions:
      state.status === "PLAYER_TURN"
        ? state.playerHand.length === 2 && !state.doubled
          ? ["hit", "stand", "double"]
          : ["hit", "stand"]
        : [],
    message: state.message,
  };
}
