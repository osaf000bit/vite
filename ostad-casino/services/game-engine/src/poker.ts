/**
 * OSTAD CASINO — Texas Hold'em demo engine (server authoritative).
 *
 * Full hand lifecycle: blinds, preflop/flop/turn/river betting rounds, fold /
 * check / call / raise / all-in, side pots, showdown and hand ranking.
 *
 * The deck is shuffled from the server RNG stream at the start of every hand.
 * Hole cards of other seats are never included in the client view, and bot
 * decisions use HMAC-derived entropy from the hidden server seed, so a client
 * cannot predict or influence the deal or the bot action.
 */
import { createHmac } from "node:crypto";
import { RngStream, hashServerSeed, roundCommitment } from "@ostad/rng";
import {
  cardLabel,
  compareHands,
  evaluateBest,
  standardDeck,
  HAND_CATEGORY_LABEL,
  type Card,
  type EvaluatedHand,
} from "./cards";

export type PokerStreet = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN" | "COMPLETE";
export type PokerActionType = "fold" | "check" | "call" | "raise" | "allin";
export type PokerPlayerStatus = "ACTIVE" | "FOLDED" | "ALL_IN" | "OUT";

export interface PokerSeat {
  seat: number;
  playerId: string;
  displayName: string;
  isBot: boolean;
  stackMinor: number;
  holeCards: Card[];
  status: PokerPlayerStatus;
  /** Chips committed on the current street. */
  streetCommittedMinor: number;
  /** Chips committed across the whole hand (drives side pots). */
  totalCommittedMinor: number;
  hasActed: boolean;
  lastAction: string | null;
}

export interface PokerPotAward {
  seat: number;
  playerId: string;
  amountMinor: number;
  handLabel: string | null;
}

export interface PokerHandResult {
  handNumber: number;
  winners: PokerPotAward[];
  showdown: {
    seat: number;
    displayName: string;
    cards: string[];
    hand: string;
  }[];
  totalPotMinor: number;
}

export interface PokerState {
  tableId: string;
  tableName: string;
  handNumber: number;
  maxSeats: number;
  smallBlindMinor: number;
  bigBlindMinor: number;
  dealerSeat: number;
  activeSeat: number | null;
  street: PokerStreet;
  community: Card[];
  deck: Card[];
  seats: PokerSeat[];
  currentBetMinor: number;
  minRaiseMinor: number;
  potMinor: number;
  log: string[];
  result: PokerHandResult | null;
  /** Server-only fairness material. Never serialised to the client. */
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  commitment: string;
  createdAt: string;
  updatedAt: string;
}

export const POKER_LIMITS = {
  minSeats: 2,
  maxSeats: 9,
  defaultSeats: 6,
  minBuyInMinor: 2_000,
  maxBuyInMinor: 500_000,
  raiseCapPerStreet: 4,
} as const;

export class PokerRulesError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PokerRulesError";
  }
}

function nextSeatIndex(seats: PokerSeat[], from: number): number {
  for (let step = 1; step <= seats.length; step += 1) {
    const idx = (from + step) % seats.length;
    if (seats[idx].status === "ACTIVE") return idx;
  }
  return from;
}

/** Deterministic, seed-derived entropy for bot decisions (server-side only). */
function botEntropy(serverSeed: string, handNumber: number, seat: number, salt: string): number {
  const digest = createHmac("sha256", serverSeed)
    .update(`poker-bot:${handNumber}:${seat}:${salt}`)
    .digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

export interface PokerSeatInit {
  seat: number;
  playerId: string;
  displayName: string;
  isBot: boolean;
  stackMinor: number;
}

export function createPokerState(args: {
  tableId: string;
  tableName?: string;
  maxSeats: number;
  smallBlindMinor: number;
  bigBlindMinor: number;
  serverSeed: string;
  clientSeed: string;
  nonce: number;
  seats: PokerSeatInit[];
}): PokerState {
  if (args.seats.length < POKER_LIMITS.minSeats) {
    throw new PokerRulesError("not_enough_players", "Texas Hold'em needs at least two players");
  }
  if (args.seats.length > (args.maxSeats ?? POKER_LIMITS.maxSeats)) {
    throw new PokerRulesError("too_many_players", "Table is full");
  }
  for (const seat of args.seats) {
    if (!Number.isInteger(seat.stackMinor) || seat.stackMinor < args.bigBlindMinor) {
      throw new PokerRulesError("invalid_stack", "Seat stack must cover at least one big blind");
    }
  }
  return {
    tableId: args.tableId,
    tableName: args.tableName ?? "OSTAD Hold'em",
    handNumber: 0,
    maxSeats: args.maxSeats,
    smallBlindMinor: args.smallBlindMinor,
    bigBlindMinor: args.bigBlindMinor,
    dealerSeat: 0,
    activeSeat: null,
    street: "PREFLOP",
    community: [],
    deck: [],
    seats: args.seats.map((seat) => ({
      seat: seat.seat,
      playerId: seat.playerId,
      displayName: seat.displayName,
      isBot: seat.isBot,
      stackMinor: seat.stackMinor,
      holeCards: [],
      status: "ACTIVE" as PokerPlayerStatus,
      streetCommittedMinor: 0,
      totalCommittedMinor: 0,
      hasActed: false,
      lastAction: null,
    })),
    currentBetMinor: 0,
    minRaiseMinor: args.bigBlindMinor,
    potMinor: 0,
    log: [],
    result: null,
    serverSeed: args.serverSeed,
    serverSeedHash: hashServerSeed(args.serverSeed),
    clientSeed: args.clientSeed,
    nonce: args.nonce,
    commitment: roundCommitment(hashServerSeed(args.serverSeed), args.clientSeed, args.nonce),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function collectPot(state: PokerState): void {
  state.potMinor = state.seats.reduce((sum, seat) => sum + seat.totalCommittedMinor, 0);
}

export function startHand(state: PokerState): PokerState {
  const next = structuredClone(state);
  const live = next.seats.filter((seat) => seat.stackMinor > 0);
  if (live.length < 2) throw new PokerRulesError("table_empty", "Not enough funded seats to deal");

  next.handNumber += 1;
  next.nonce = state.nonce + next.handNumber;
  next.commitment = roundCommitment(next.serverSeedHash, next.clientSeed, next.nonce);
  const stream = new RngStream(next.serverSeed, next.clientSeed, next.nonce);
  next.deck = stream.shuffle(standardDeck(1));
  next.community = [];
  next.street = "PREFLOP";
  next.currentBetMinor = 0;
  next.minRaiseMinor = next.bigBlindMinor;
  next.potMinor = 0;
  next.result = null;
  next.log = [];

  for (const seat of next.seats) {
    seat.holeCards = [];
    seat.streetCommittedMinor = 0;
    seat.totalCommittedMinor = 0;
    seat.hasActed = false;
    seat.lastAction = null;
    seat.status = seat.stackMinor > 0 ? "ACTIVE" : "OUT";
  }

  next.dealerSeat = (state.dealerSeat + 1) % next.seats.length;
  while (next.seats[next.dealerSeat].status === "OUT") {
    next.dealerSeat = (next.dealerSeat + 1) % next.seats.length;
  }

  // Deal two hole cards per live seat, starting left of the dealer.
  for (let round = 0; round < 2; round += 1) {
    let idx = next.dealerSeat;
    for (let i = 0; i < next.seats.length; i += 1) {
      idx = (idx + 1) % next.seats.length;
      const seat = next.seats[idx];
      if (seat.status === "OUT") continue;
      const card = next.deck.pop();
      if (!card) throw new PokerRulesError("deck_exhausted", "Deck exhausted");
      seat.holeCards.push(card);
    }
  }

  // Post blinds.
  const liveSeats = next.seats.filter((seat) => seat.status === "ACTIVE");
  const isHeadsUp = liveSeats.length === 2;
  const sbSeatIdx = isHeadsUp
    ? next.dealerSeat
    : ((next.dealerSeat + 1) % next.seats.length);
  const bbSeatIdx = isHeadsUp
    ? nextSeatsWhere(next.seats, next.dealerSeat, () => true, 1)
    : nextSeatsWhere(next.seats, next.dealerSeat, () => true, 2);

  postBlind(next, sbSeatIdx, next.smallBlindMinor, "small blind");
  postBlind(next, bbSeatIdx, next.bigBlindMinor, "big blind");
  next.currentBetMinor = next.bigBlindMinor;
  next.minRaiseMinor = next.bigBlindMinor;
  collectPot(next);

  next.activeSeat = isHeadsUp ? sbSeatIdx : nextSeatIndex(next.seats, bbSeatIdx);
  next.seats[next.activeSeat].hasActed = false;
  next.log.push(`Hand #${next.handNumber} dealt — blinds ${next.smallBlindMinor}/${next.bigBlindMinor}`);
  next.updatedAt = new Date().toISOString();
  return next;
}

function nextSeatsWhere(
  seats: PokerSeat[],
  from: number,
  predicate: (seat: PokerSeat) => boolean,
  offset: number,
): number {
  let idx = from;
  let found = 0;
  for (let step = 1; step <= seats.length * 2; step += 1) {
    idx = (idx + 1) % seats.length;
    if (!predicate(seats[idx])) continue;
    found += 1;
    if (found === offset) return idx;
  }
  return from;
}

function postBlind(state: PokerState, seatIdx: number, amountMinor: number, label: string): void {
  const seat = state.seats[seatIdx];
  const pay = Math.min(amountMinor, seat.stackMinor);
  seat.stackMinor -= pay;
  seat.streetCommittedMinor += pay;
  seat.totalCommittedMinor += pay;
  seat.lastAction = `${label} ${pay}`;
  if (seat.stackMinor === 0) seat.status = "ALL_IN";
  state.log.push(`${seat.displayName} posts ${label} ${pay}`);
}

function commit(state: PokerState, seat: PokerSeat, amountMinor: number): number {
  const pay = Math.min(amountMinor, seat.stackMinor);
  seat.stackMinor -= pay;
  seat.streetCommittedMinor += pay;
  seat.totalCommittedMinor += pay;
  if (seat.stackMinor === 0) seat.status = "ALL_IN";
  collectPot(state);
  return pay;
}

function activePlayers(state: PokerState): PokerSeat[] {
  return state.seats.filter((seat) => seat.status === "ACTIVE" || seat.status === "ALL_IN");
}

function bettingRoundComplete(state: PokerState): boolean {
  const contenders = state.seats.filter(
    (seat) => seat.status === "ACTIVE" || seat.status === "ALL_IN",
  );
  if (contenders.filter((seat) => seat.status === "ACTIVE").length === 0) return true;
  for (const seat of contenders) {
    if (seat.status !== "ACTIVE") continue;
    if (!seat.hasActed) return false;
    if (seat.streetCommittedMinor !== state.currentBetMinor) return false;
  }
  return true;
}

function advanceStreet(state: PokerState): PokerState {
  const next = structuredClone(state);
  for (const seat of next.seats) {
    seat.streetCommittedMinor = 0;
    seat.hasActed = false;
    seat.lastAction = null;
  }
  next.currentBetMinor = 0;
  next.minRaiseMinor = next.bigBlindMinor;

  const order: PokerStreet[] = ["PREFLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"];
  const currentIndex = order.indexOf(next.street);
  const nextStreet = order[Math.min(currentIndex + 1, order.length - 1)];
  next.street = nextStreet;

  if (nextStreet === "FLOP") {
    next.deck.pop(); // burn
    next.community.push(next.deck.pop()!, next.deck.pop()!, next.deck.pop()!);
    next.log.push(`Flop: ${next.community.map(cardLabel).join(" ")}`);
  } else if (nextStreet === "TURN") {
    next.deck.pop();
    next.community.push(next.deck.pop()!);
    next.log.push(`Turn: ${next.community.map(cardLabel).join(" ")}`);
  } else if (nextStreet === "RIVER") {
    next.deck.pop();
    next.community.push(next.deck.pop()!);
    next.log.push(`River: ${next.community.map(cardLabel).join(" ")}`);
  }

  if (nextStreet === "SHOWDOWN") {
    return finishHand(next);
  }

  next.activeSeat = nextSeatIndex(next.seats, next.dealerSeat);
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Split the pot into main/side pots by contribution level and award each layer. */
function finishHand(state: PokerState): PokerState {
  const next = structuredClone(state);
  next.street = "SHOWDOWN";

  const live = next.seats.filter((seat) => seat.status !== "OUT" && seat.status !== "FOLDED");
  const evaluated = new Map<number, EvaluatedHand>();
  for (const seat of live) {
    evaluated.set(seat.seat, evaluateBest([...seat.holeCards, ...next.community]));
  }

  const contenders = next.seats.filter((seat) => seat.totalCommittedMinor > 0);
  const levels = Array.from(new Set(contenders.map((seat) => seat.totalCommittedMinor))).sort(
    (a, b) => a - b,
  );

  const awardBySeat = new Map<number, number>();
  let previousLevel = 0;
  const showdownRows: PokerHandResult["showdown"] = [];

  for (const level of levels) {
    const layerSize = level - previousLevel;
    const inLayer = contenders.filter((seat) => seat.totalCommittedMinor >= level);
    const layerPot = layerSize * inLayer.length;
    previousLevel = level;
    if (layerPot <= 0) continue;
    const eligible = inLayer.filter((seat) => seat.status !== "FOLDED");
    if (eligible.length === 0) continue;

    let bestScore = -1;
    let winners: PokerSeat[] = [];
    for (const seat of eligible) {
      const hand = evaluated.get(seat.seat);
      const score = hand ? hand.score : -1;
      if (score > bestScore) {
        bestScore = score;
        winners = [seat];
      } else if (score === bestScore) {
        winners.push(seat);
      }
    }
    const share = Math.floor(layerPot / winners.length);
    let remainder = layerPot - share * winners.length;
    for (const winner of winners) {
      const bonus = remainder > 0 ? 1 : 0;
      remainder -= bonus;
      awardBySeat.set(winner.seat, (awardBySeat.get(winner.seat) ?? 0) + share + bonus);
    }
  }

  const winners: PokerPotAward[] = [];
  for (const [seatIndex, amount] of awardBySeat.entries()) {
    const seat = next.seats[seatIndex];
    seat.stackMinor += amount;
    const hand = evaluated.get(seatIndex);
    winners.push({
      seat: seatIndex,
      playerId: seat.playerId,
      amountMinor: amount,
      handLabel: hand ? HAND_CATEGORY_LABEL[hand.category] : null,
    });
    next.log.push(`${seat.displayName} wins ${amount}`);
  }

  for (const seat of live) {
    const hand = evaluated.get(seat.seat);
    showdownRows.push({
      seat: seat.seat,
      displayName: seat.displayName,
      cards: [...seat.holeCards, ...next.community].map(cardLabel),
      hand: hand ? hand.label : "—",
    });
  }

  const totalPot = next.potMinor;
  next.result = {
    handNumber: next.handNumber,
    winners,
    showdown: showdownRows,
    totalPotMinor: totalPot,
  };
  next.street = "COMPLETE";
  next.activeSeat = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Award the pot without showdown when everyone else folded. */
function awardUncontested(state: PokerState): PokerState {
  const next = structuredClone(state);
  const lastSeat = next.seats.find((seat) => seat.status === "ACTIVE" || seat.status === "ALL_IN");
  const amount = next.potMinor;
  if (lastSeat) {
    lastSeat.stackMinor += amount;
    next.result = {
      handNumber: next.handNumber,
      winners: [
        { seat: lastSeat.seat, playerId: lastSeat.playerId, amountMinor: amount, handLabel: null },
      ],
      showdown: [],
      totalPotMinor: amount,
    };
    next.log.push(`${lastSeat.displayName} wins ${amount} — everyone else folded`);
  }
  next.street = "COMPLETE";
  next.activeSeat = null;
  next.updatedAt = new Date().toISOString();
  return next;
}

export interface PokerActionInput {
  seat: number;
  action: PokerActionType;
  /** Total street commitment for a raise (not the delta). */
  raiseToMinor?: number;
}

function applyAction(state: PokerState, input: PokerActionInput): PokerState {
  const next = structuredClone(state);
  if (next.activeSeat === null) throw new PokerRulesError("hand_complete", "No active seat to act");
  if (input.seat !== next.activeSeat) throw new PokerRulesError("out_of_turn", "Not your turn");
  const seat = next.seats[input.seat];
  if (seat.status !== "ACTIVE") throw new PokerRulesError("not_active", "Seat cannot act");

  switch (input.action) {
    case "fold": {
      seat.status = "FOLDED";
      seat.hasActed = true;
      seat.lastAction = "fold";
      next.log.push(`${seat.displayName} folds`);
      break;
    }
    case "check": {
      if (seat.streetCommittedMinor !== next.currentBetMinor) {
        throw new PokerRulesError("cannot_check", "You cannot check facing a bet");
      }
      seat.hasActed = true;
      seat.lastAction = "check";
      next.log.push(`${seat.displayName} checks`);
      break;
    }
    case "call": {
      const needed = next.currentBetMinor - seat.streetCommittedMinor;
      if (needed <= 0) throw new PokerRulesError("nothing_to_call", "Nothing to call");
      const paid = commit(next, seat, needed);
      seat.hasActed = true;
      seat.lastAction = `call ${paid}`;
      next.log.push(`${seat.displayName} calls ${paid}`);
      break;
    }
    case "allin": {
      const paid = commit(next, seat, seat.stackMinor);
      seat.hasActed = true;
      seat.lastAction = `all-in ${paid}`;
      if (seat.streetCommittedMinor > next.currentBetMinor) {
        next.minRaiseMinor = Math.max(
          next.minRaiseMinor,
          seat.streetCommittedMinor - next.currentBetMinor,
        );
        next.currentBetMinor = seat.streetCommittedMinor;
      }
      next.log.push(`${seat.displayName} is all-in for ${paid}`);
      break;
    }
    case "raise": {
      const target = input.raiseToMinor;
      if (!Number.isInteger(target) || target === undefined) {
        throw new PokerRulesError("invalid_raise", "Raise amount is required");
      }
      const minTarget = next.currentBetMinor + next.minRaiseMinor;
      const maxTarget = seat.streetCommittedMinor + seat.stackMinor;
      const raiseTo = Math.min(target as number, maxTarget);
      if (raiseTo < minTarget && raiseTo < maxTarget) {
        throw new PokerRulesError(
          "raise_too_small",
          `Minimum raise is to ${minTarget} (all-in is ${maxTarget})`,
        );
      }
      const delta = raiseTo - seat.streetCommittedMinor;
      commit(next, seat, delta);
      if (seat.status === "ACTIVE") {
        next.minRaiseMinor = Math.max(next.minRaiseMinor, raiseTo - next.currentBetMinor);
      }
      next.currentBetMinor = Math.max(next.currentBetMinor, raiseTo);
      seat.hasActed = true;
      seat.lastAction = `raise to ${raiseTo}`;
      next.log.push(`${seat.displayName} raises to ${raiseTo}`);
      // A raise reopens the action for everyone else.
      for (const other of next.seats) {
        if (other.seat !== seat.seat && other.status === "ACTIVE") other.hasActed = false;
      }
      seat.hasActed = true;
      break;
    }
    default:
      throw new PokerRulesError("unknown_action", "Unknown poker action");
  }

  const remaining = next.seats.filter((seat2) => seat2.status === "ACTIVE");
  if (remaining.length === 0) {
    return bettingRoundComplete(next) ? advanceStreet(next) : next;
  }
  if (activePlayers(next).filter((s) => s.status !== "FOLDED").length === 1) {
    return awardUncontested(next);
  }
  if (remaining.length === 1) {
    const otherLive = activePlayers(next).filter((s) => s.status === "ALL_IN");
    if (otherLive.length === 0) return awardUncontested(next);
  }

  if (bettingRoundComplete(next)) return advanceStreet(next);

  next.activeSeat = nextSeatIndex(next.seats, input.seat);
  next.updatedAt = new Date().toISOString();
  return next;
}

/** Heuristic bot policy driven by hidden server entropy (never client input). */
export function botDecide(state: PokerState, seatIndex: number): PokerActionInput {
  const seat = state.seats[seatIndex];
  const noise = botEntropy(state.serverSeed, state.handNumber, seat.seat, state.street);
  const known = [...seat.holeCards, ...state.community];
  let strength = 0.35;
  if (state.community.length >= 3) {
    const hand = evaluateBest(known);
    const rank = HAND_CATEGORY_LABEL[hand.category];
    strength =
      rank === "High Card"
        ? 0.22
        : rank === "One Pair"
          ? 0.42
          : rank === "Two Pair"
            ? 0.6
            : rank === "Three of a Kind"
              ? 0.72
              : rank === "Straight"
                ? 0.8
                : rank === "Flush"
                  ? 0.86
                  : 0.92;
    // Kicker strength.
    strength += Math.min(0.06, (hand.score % 16) / 400);
  } else if (seat.holeCards.length === 2) {
    const [a, b] = seat.holeCards.map((card) => card.rank).sort((x, y) => y - x);
    strength = 0.18 + (a + b) / 40;
    if (a === b) strength += 0.16;
    if (a === 14) strength += 0.06;
  }
  strength = Math.min(0.97, Math.max(0.05, strength + (noise - 0.5) * 0.2));

  const toCall = state.currentBetMinor - seat.streetCommittedMinor;
  const potOdds = toCall > 0 ? toCall / (state.potMinor + toCall) : 0;
  const canRaise = seat.stackMinor > toCall + state.bigBlindMinor;

  if (toCall === 0) {
    if (strength > 0.72 && canRaise && noise > 0.25) {
      const raiseTo = Math.min(
        state.currentBetMinor + Math.max(state.bigBlindMinor, Math.floor(state.potMinor * 0.6)),
        seat.streetCommittedMinor + seat.stackMinor,
      );
      if (raiseTo > state.currentBetMinor) {
        return { seat: seatIndex, action: "raise", raiseToMinor: raiseTo };
      }
    }
    return { seat: seatIndex, action: "check" };
  }

  if (strength < potOdds - 0.05) return { seat: seatIndex, action: "fold" };
  if (strength > 0.78 && canRaise && noise > 0.45) {
    const raiseTo = Math.min(
      state.currentBetMinor + Math.max(state.bigBlindMinor, Math.floor(state.potMinor * 0.5)),
      seat.streetCommittedMinor + seat.stackMinor,
    );
    if (raiseTo > state.currentBetMinor) {
      return { seat: seatIndex, action: "raise", raiseToMinor: raiseTo };
    }
  }
  if (toCall >= seat.stackMinor) return { seat: seatIndex, action: "allin" };
  return { seat: seatIndex, action: "call" };
}

/**
 * Play the current hand forward until it is the human player's turn or the hand
 * is complete. Bots only act through the same rules path as a human.
 */
export function advanceBots(state: PokerState, maxSteps = 200): PokerState {
  let current = state;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.street === "COMPLETE" || current.street === "SHOWDOWN") return current;
    if (current.activeSeat === null) return current;
    const seat = current.seats[current.activeSeat];
    if (!seat.isBot) return current;
    current = applyAction(current, botDecide(current, current.activeSeat));
  }
  return current;
}

export function actPoker(state: PokerState, input: PokerActionInput): PokerState {
  const applied = applyAction(state, input);
  return advanceBots(applied);
}

/* ─────────────────────────────── Client view ─────────────────────────────── */

export interface PokerSeatView {
  seat: number;
  displayName: string;
  isBot: boolean;
  isYou: boolean;
  stackMinor: number;
  streetCommittedMinor: number;
  status: PokerPlayerStatus;
  cards: string[] | null;
  lastAction: string | null;
  isDealer: boolean;
  isTurn: boolean;
}

export interface PokerView {
  tableId: string;
  tableName: string;
  handNumber: number;
  street: PokerStreet;
  community: string[];
  seats: PokerSeatView[];
  potMinor: number;
  currentBetMinor: number;
  minRaiseMinor: number;
  activeSeat: number | null;
  yourSeat: number | null;
  yourCards: string[];
  legalActions: { action: PokerActionType; raiseToMinor?: number }[];
  log: string[];
  result: PokerHandResult | null;
  fairness: { serverSeedHash: string; clientSeed: string; nonce: number; commitment: string };
  blinds: { smallBlindMinor: number; bigBlindMinor: number };
}

/** Project state for one player. Never leaks other seats' hole cards or the seed. */
export function pokerView(state: PokerState, viewerPlayerId: string | null): PokerView {
  const yourSeat = viewerPlayerId
    ? (state.seats.find((seat) => seat.playerId === viewerPlayerId)?.seat ?? null)
    : null;
  const legalActions: PokerView["legalActions"] = [];
  if (yourSeat !== null && state.activeSeat === yourSeat) {
    const seat = state.seats[yourSeat];
    const toCall = state.currentBetMinor - seat.streetCommittedMinor;
    legalActions.push({ action: "fold" });
    if (toCall === 0) legalActions.push({ action: "check" });
    else legalActions.push({ action: "call" });
    const maxTarget = seat.streetCommittedMinor + seat.stackMinor;
    if (maxTarget > state.currentBetMinor) {
      legalActions.push({
        action: "raise",
        raiseToMinor: Math.min(
          Math.max(state.currentBetMinor + state.minRaiseMinor, state.bigBlindMinor),
          maxTarget,
        ),
      });
      legalActions.push({ action: "allin" });
    }
  }

  return {
    tableId: state.tableId,
    tableName: state.tableName,
    handNumber: state.handNumber,
    street: state.street,
    community: state.community.map(cardLabel),
    seats: state.seats.map((seat) => ({
      seat: seat.seat,
      displayName: seat.displayName,
      isBot: seat.isBot,
      isYou: seat.seat === yourSeat,
      stackMinor: seat.stackMinor,
      streetCommittedMinor: seat.streetCommittedMinor,
      status: seat.status,
      cards:
        seat.status === "FOLDED"
          ? null
          : seat.seat === yourSeat || state.street === "SHOWDOWN" || state.street === "COMPLETE"
            ? seat.holeCards.map(cardLabel)
            : seat.holeCards.length > 0
              ? ["▣", "▣"]
              : null,
      lastAction: seat.lastAction,
      isDealer: state.dealerSeat === seat.seat,
      isTurn: state.activeSeat === seat.seat,
    })),
    potMinor: state.potMinor,
    currentBetMinor: state.currentBetMinor,
    minRaiseMinor: state.minRaiseMinor,
    activeSeat: state.activeSeat,
    yourSeat,
    yourCards:
      yourSeat !== null ? state.seats[yourSeat].holeCards.map(cardLabel) : [],
    legalActions,
    log: state.log.slice(-12),
    result: state.result,
    fairness: {
      serverSeedHash: state.serverSeedHash,
      clientSeed: state.clientSeed,
      nonce: state.nonce,
      commitment: state.commitment,
    },
    blinds: { smallBlindMinor: state.smallBlindMinor, bigBlindMinor: state.bigBlindMinor },
  };
}

export interface PokerHandStrength {
  label: string;
  category: string;
}

/** Advisory only — shown to the player as a hint, never used for settlement. */
export function describeStrength(state: PokerState, seatIndex: number): PokerHandStrength | null {
  const seat = state.seats[seatIndex];
  if (!seat || seat.holeCards.length < 2) return null;
  const known = [...seat.holeCards, ...state.community];
  if (known.length < 5) return { label: "Pre-flop", category: "PREFLOP" };
  const hand = evaluateBest(known);
  return { label: hand.label, category: hand.category };
}

/** Compare helper exported for tests of showdown ordering. */
export function compareForTest(a: Card[], b: Card[], board: Card[]): number {
  return compareHands(evaluateBest([...a, ...board]), evaluateBest([...b, ...board]));
}
