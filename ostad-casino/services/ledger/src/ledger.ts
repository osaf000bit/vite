/**
 * OSTAD CASINO — double-entry demo ledger.
 *
 * Invariants enforced here (and covered by tests):
 *  1. Every balance change is a ledger transaction whose entries sum to zero.
 *  2. Entries are append-only; nothing is ever updated or deleted.
 *  3. Each entry is hash-chained to the previous entry (tamper evidence).
 *  4. A transaction requires an idempotency key; replaying it returns the
 *     original result instead of double-posting.
 *  5. Balances are DERIVED from entries — never a mutable counter the frontend
 *     could touch, and never a value the client supplies.
 */
import type {
  BetRow,
  DatabaseFile,
  LedgerAccount,
  LedgerAccountType,
  LedgerDirection,
  LedgerEntry,
  LedgerTxnKind,
  GameKey,
} from "./types";
import { chainHash, withStore } from "./store";
import { newId, nowIso } from "./ids";

export const MINOR_UNITS_PER_CREDIT = 100;
export const DEMO_STARTING_CREDITS = 10_000;
export const DEMO_STARTING_MINOR = DEMO_STARTING_CREDITS * MINOR_UNITS_PER_CREDIT;
export const DEMO_CURRENCY = "DEMO_CREDIT" as const;

export function creditsToMinor(credits: number): number {
  if (!Number.isFinite(credits)) throw new LedgerError("invalid_amount", "Amount is not a number");
  return Math.round(credits * MINOR_UNITS_PER_CREDIT);
}

export function minorToCredits(minor: number): number {
  return Math.round(minor) / MINOR_UNITS_PER_CREDIT;
}

export function formatCredits(minor: number): string {
  return minorToCredits(minor).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export class LedgerError extends Error {
  constructor(
    readonly code:
      | "invalid_amount"
      | "insufficient_funds"
      | "unbalanced_txn"
      | "account_missing"
      | "idempotency_conflict"
      | "round_not_pending"
      | "limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export function accountCode(type: LedgerAccountType, userId?: string | null): string {
  switch (type) {
    case "PLAYER_DEMO":
      if (!userId) throw new LedgerError("account_missing", "Player account requires a user");
      return `PLAYER_DEMO:${userId}`;
    case "HOUSE_DEMO_POOL":
      return "HOUSE_DEMO_POOL:0000";
    case "HOUSE_RAKE":
      return "HOUSE_RAKE:0000";
    case "BONUS_POOL":
      return "BONUS_POOL:0000";
  }
}

export function findAccount(db: DatabaseFile, code: string): LedgerAccount | undefined {
  return db.ledger_accounts.find((account) => account.code === code);
}

/** Creates the account if absent; safe to call on every transaction. */
export function ensureAccount(
  db: DatabaseFile,
  type: LedgerAccountType,
  userId: string | null,
  createdAt = nowIso(),
): LedgerAccount {
  const code = accountCode(type, userId);
  const existing = findAccount(db, code);
  if (existing) return existing;
  const account: LedgerAccount = {
    id: newId("acct"),
    user_id: userId,
    type,
    currency: DEMO_CURRENCY,
    code,
    created_at: createdAt,
  };
  db.ledger_accounts.push(account);
  return account;
}

export function balanceOfAccount(db: DatabaseFile, accountId: string): number {
  let balance = 0;
  for (const entry of db.ledger_entries) {
    if (entry.account_id !== accountId) continue;
    // Debits to a player account reduce their credit; credits increase it.
    balance += entry.direction === "CREDIT" ? entry.amount_minor : -entry.amount_minor;
  }
  return balance;
}

export function demoBalanceMinor(db: DatabaseFile, userId: string): number {
  const account = findAccount(db, accountCode("PLAYER_DEMO", userId));
  if (!account) return 0;
  return balanceOfAccount(db, account.id);
}

export interface PostLeg {
  accountCode: string;
  direction: LedgerDirection;
  amountMinor: number;
  memo?: string;
}

export interface PostTransactionInput {
  idempotencyKey: string;
  kind: LedgerTxnKind;
  legs: PostLeg[];
  gameSessionId?: string | null;
  gameRoundId?: string | null;
  /** Fingerprint used to reject a reused idempotency key with different data. */
  requestFingerprint?: string | null;
}

export interface PostedTransaction {
  txnId: string;
  entries: LedgerEntry[];
  idempotentReplay: boolean;
}

/**
 * Post a balanced ledger transaction inside the current unit of work.
 * Caller must already be inside `withStore`. Never accepts a caller-supplied
 * balance or payout — amounts come from engine output or grant policy only.
 */
export function postTransaction(db: DatabaseFile, input: PostTransactionInput): PostedTransaction {
  if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
    throw new LedgerError("invalid_amount", "A valid idempotency key is required");
  }
  if (input.legs.length < 2) {
    throw new LedgerError("unbalanced_txn", "A ledger transaction needs at least two legs");
  }

  const existing = db.idempotency.find((record) => record.key === input.idempotencyKey);
  if (existing) {
    if (
      input.requestFingerprint &&
      existing.request_fingerprint &&
      existing.request_fingerprint !== input.requestFingerprint
    ) {
      throw new LedgerError("idempotency_conflict", "Idempotency key reused with different data");
    }
    const replay = JSON.parse(existing.result_json) as PostedTransaction;
    return { ...replay, idempotentReplay: true };
  }

  let debitTotal = 0;
  let creditTotal = 0;
  const resolved: { account: LedgerAccount; leg: PostLeg }[] = [];

  for (const leg of input.legs) {
    if (!Number.isInteger(leg.amountMinor) || leg.amountMinor <= 0) {
      throw new LedgerError("invalid_amount", "Ledger legs must be positive integer minor units");
    }
    const account = findAccount(db, leg.accountCode);
    if (!account) throw new LedgerError("account_missing", `Unknown ledger account ${leg.accountCode}`);
    if (leg.direction === "DEBIT") debitTotal += leg.amountMinor;
    else creditTotal += leg.amountMinor;
    resolved.push({ account, leg });
  }

  if (debitTotal !== creditTotal) {
    throw new LedgerError(
      "unbalanced_txn",
      `Unbalanced transaction: debit ${debitTotal} != credit ${creditTotal}`,
    );
  }

  const txnId = newId("txn");
  const createdAt = nowIso();
  const entries: LedgerEntry[] = [];

  for (const { account, leg } of resolved) {
    // A player may never spend more demo credit than the ledger says they hold.
    if (leg.direction === "DEBIT" && account.type === "PLAYER_DEMO") {
      const current = balanceOfAccount(db, account.id);
      if (current < leg.amountMinor) {
        throw new LedgerError("insufficient_funds", "Insufficient demo credit balance");
      }
    }
    const sequence = db.chain.ledger_seq + 1;
    const payload = [
      sequence,
      txnId,
      account.id,
      leg.direction,
      leg.amountMinor,
      input.kind,
      input.idempotencyKey,
      createdAt,
    ].join(":");
    const hash = chainHash(db.chain.ledger_hash, payload);
    const entry: LedgerEntry = {
      id: newId("le"),
      txn_id: txnId,
      account_id: account.id,
      direction: leg.direction,
      amount_minor: leg.amountMinor,
      kind: input.kind,
      memo: leg.memo ?? null,
      game_session_id: input.gameSessionId ?? null,
      game_round_id: input.gameRoundId ?? null,
      idempotency_key: input.idempotencyKey,
      sequence,
      prev_hash: db.chain.ledger_hash,
      hash,
      created_at: createdAt,
    };
    db.ledger_entries.push(entry);
    db.chain = { ...db.chain, ledger_seq: sequence, ledger_hash: hash };
    entries.push(entry);
  }

  const result: PostedTransaction = { txnId, entries, idempotentReplay: false };
  db.idempotency.push({
    key: input.idempotencyKey,
    scope: "ledger.post",
    request_fingerprint: input.requestFingerprint ?? null,
    result_json: JSON.stringify(result),
    created_at: createdAt,
  });
  return result;
}

/** Grant the starting demo credit balance (once per user). */
export function grantStartingDemoCredits(
  db: DatabaseFile,
  userId: string,
): PostedTransaction {
  ensureAccount(db, "PLAYER_DEMO", userId);
  ensureAccount(db, "HOUSE_DEMO_POOL", null);
  return postTransaction(db, {
    idempotencyKey: `demo-grant:${userId}`,
    kind: "DEMO_GRANT",
    legs: [
      {
        accountCode: accountCode("HOUSE_DEMO_POOL"),
        direction: "DEBIT",
        amountMinor: DEMO_STARTING_MINOR,
        memo: "Demo float issuance",
      },
      {
        accountCode: accountCode("PLAYER_DEMO", userId),
        direction: "CREDIT",
        amountMinor: DEMO_STARTING_MINOR,
        memo: "Starting demo credits — no cash value",
      },
    ],
    requestFingerprint: `grant:${userId}:${DEMO_STARTING_MINOR}`,
  });
}

/** Debit a stake from the player and park it in the house demo pool. */
export function postStake(
  db: DatabaseFile,
  args: {
    userId: string;
    gameKey: GameKey;
    sessionId: string;
    roundId: string;
    stakeMinor: number;
  },
): PostedTransaction {
  ensureAccount(db, "PLAYER_DEMO", args.userId);
  ensureAccount(db, "HOUSE_DEMO_POOL", null);
  return postTransaction(db, {
    idempotencyKey: `stake:${args.roundId}`,
    kind: "BET",
    gameSessionId: args.sessionId,
    gameRoundId: args.roundId,
    legs: [
      {
        accountCode: accountCode("PLAYER_DEMO", args.userId),
        direction: "DEBIT",
        amountMinor: args.stakeMinor,
        memo: `${args.gameKey} demo stake`,
      },
      {
        accountCode: accountCode("HOUSE_DEMO_POOL"),
        direction: "CREDIT",
        amountMinor: args.stakeMinor,
        memo: `${args.gameKey} demo stake held`,
      },
    ],
    requestFingerprint: `stake:${args.roundId}:${args.stakeMinor}`,
  });
}

/** Pay a settled (already engine-decided) win from the pool back to the player. */
export function postPayout(
  db: DatabaseFile,
  args: {
    userId: string;
    gameKey: GameKey;
    sessionId: string;
    roundId: string;
    payoutMinor: number;
  },
): PostedTransaction | null {
  if (args.payoutMinor <= 0) return null;
  ensureAccount(db, "PLAYER_DEMO", args.userId);
  ensureAccount(db, "HOUSE_DEMO_POOL", null);
  return postTransaction(db, {
    idempotencyKey: `payout:${args.roundId}`,
    kind: "PAYOUT",
    gameSessionId: args.sessionId,
    gameRoundId: args.roundId,
    legs: [
      {
        accountCode: accountCode("HOUSE_DEMO_POOL"),
        direction: "DEBIT",
        amountMinor: args.payoutMinor,
        memo: `${args.gameKey} demo payout`,
      },
      {
        accountCode: accountCode("PLAYER_DEMO", args.userId),
        direction: "CREDIT",
        amountMinor: args.payoutMinor,
        memo: `${args.gameKey} demo win — no cash value`,
      },
    ],
    requestFingerprint: `payout:${args.roundId}:${args.payoutMinor}`,
  });
}

/** Refund a stake when a round is voided (never to hide a loss). */
export function postRefund(
  db: DatabaseFile,
  args: { userId: string; sessionId: string; roundId: string; stakeMinor: number; reason: string },
): PostedTransaction | null {
  if (args.stakeMinor <= 0) return null;
  return postTransaction(db, {
    idempotencyKey: `refund:${args.roundId}`,
    kind: "REFUND",
    gameSessionId: args.sessionId,
    gameRoundId: args.roundId,
    legs: [
      {
        accountCode: accountCode("HOUSE_DEMO_POOL"),
        direction: "DEBIT",
        amountMinor: args.stakeMinor,
        memo: `Refund: ${args.reason}`,
      },
      {
        accountCode: accountCode("PLAYER_DEMO", args.userId),
        direction: "CREDIT",
        amountMinor: args.stakeMinor,
        memo: `Stake refunded — ${args.reason}`,
      },
    ],
    requestFingerprint: `refund:${args.roundId}:${args.stakeMinor}`,
  });
}

/** Deliberate, audited demo top-up granted by an authorised admin role. */
export function postAdminBonus(
  db: DatabaseFile,
  args: { userId: string; amountMinor: number; grantedBy: string; reason: string },
): PostedTransaction {
  if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
    throw new LedgerError("invalid_amount", "Bonus must be a positive integer amount");
  }
  ensureAccount(db, "PLAYER_DEMO", args.userId);
  ensureAccount(db, "BONUS_POOL", null);
  return postTransaction(db, {
    idempotencyKey: `bonus:${args.userId}:${newId("b")}`,
    kind: "BONUS",
    legs: [
      {
        accountCode: accountCode("BONUS_POOL"),
        direction: "DEBIT",
        amountMinor: args.amountMinor,
        memo: `Demo bonus issued by ${args.grantedBy}`,
      },
      {
        accountCode: accountCode("PLAYER_DEMO", args.userId),
        direction: "CREDIT",
        amountMinor: args.amountMinor,
        memo: `Demo bonus — ${args.reason}`,
      },
    ],
  });
}

export interface LedgerLine {
  entry: LedgerEntry;
  accountType: LedgerAccountType;
  gameKey: GameKey | null;
}

export function ledgerLinesForUser(db: DatabaseFile, userId: string, limit = 50): LedgerLine[] {
  const accounts = db.ledger_accounts.filter((account) => account.user_id === userId);
  const ids = new Set(accounts.map((account) => account.id));
  const rounds = new Map(db.game_rounds.map((round) => [round.id, round.game_key]));
  return db.ledger_entries
    .filter((entry) => ids.has(entry.account_id))
    .slice()
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, limit)
    .map((entry) => ({
      entry,
      accountType: accounts.find((account) => account.id === entry.account_id)!.type,
      gameKey: entry.game_round_id ? (rounds.get(entry.game_round_id) ?? null) : null,
    }));
}

export interface LedgerIntegritySummary {
  balanced: boolean;
  totalDebitMinor: number;
  totalCreditMinor: number;
  entries: number;
  accounts: number;
}

export function ledgerIntegrity(db: DatabaseFile): LedgerIntegritySummary {
  let debit = 0;
  let credit = 0;
  for (const entry of db.ledger_entries) {
    if (entry.direction === "DEBIT") debit += entry.amount_minor;
    else credit += entry.amount_minor;
  }
  return {
    balanced: debit === credit,
    totalDebitMinor: debit,
    totalCreditMinor: credit,
    entries: db.ledger_entries.length,
    accounts: db.ledger_accounts.length,
  };
}

export interface SettleRoundInput {
  userId: string;
  gameKey: GameKey;
  sessionId: string;
  roundId: string;
  stakeMinor: number;
  payoutMinor: number;
  resultJson: string;
  drawDigest: string;
  serverSeed: string;
  bets: {
    betType: string;
    selectionJson: string;
    stakeMinor: number;
    oddsMultiplier: number;
    outcome: "WIN" | "LOSS" | "PUSH";
    payoutMinor: number;
  }[];
}

/**
 * Atomically settle a round: record bets/payout rows, post the payout to the
 * ledger and flip the round to SETTLED. All inside one store transaction.
 */
export async function settleRound(input: SettleRoundInput): Promise<{
  balanceMinor: number;
  payoutTxnId: string | null;
}> {
  return withStore((db) => {
    const round = db.game_rounds.find((row) => row.id === input.roundId);
    if (!round) throw new LedgerError("round_not_pending", "Round not found");
    if (round.status !== "PENDING") throw new LedgerError("round_not_pending", "Round already settled");

    const createdAt = nowIso();
    for (const bet of input.bets) {
      const row: BetRow = {
        id: newId("bet"),
        game_round_id: input.roundId,
        user_id: input.userId,
        game_key: input.gameKey,
        bet_type: bet.betType,
        selection_json: bet.selectionJson,
        stake_minor: bet.stakeMinor,
        odds_multiplier: bet.oddsMultiplier,
        outcome: bet.outcome,
        payout_minor: bet.payoutMinor,
        created_at: createdAt,
      };
      db.bets.push(row);
    }

    const payoutTxn = postPayout(db, {
      userId: input.userId,
      gameKey: input.gameKey,
      sessionId: input.sessionId,
      roundId: input.roundId,
      payoutMinor: input.payoutMinor,
    });

    if (payoutTxn) {
      db.payouts.push({
        id: newId("pay"),
        game_round_id: input.roundId,
        user_id: input.userId,
        game_key: input.gameKey,
        amount_minor: input.payoutMinor,
        ledger_txn_id: payoutTxn.txnId,
        created_at: createdAt,
      });
    }

    round.status = "SETTLED";
    round.payout_minor = input.payoutMinor;
    round.result_json = input.resultJson;
    round.draw_digest = input.drawDigest;
    round.server_seed = input.serverSeed;
    round.settled_at = createdAt;

    return {
      balanceMinor: demoBalanceMinor(db, input.userId),
      payoutTxnId: payoutTxn?.txnId ?? null,
    };
  });
}
