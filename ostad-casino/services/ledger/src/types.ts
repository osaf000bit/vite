/** OSTAD CASINO — shared domain types (demo mode). */

export type ChainKey = "bsc" | "polygon" | "tron";
export type GameKey = "roulette" | "blackjack" | "poker" | "slots";
export type LedgerDirection = "DEBIT" | "CREDIT";

export type LedgerAccountType =
  | "PLAYER_DEMO"
  | "HOUSE_DEMO_POOL"
  | "HOUSE_RAKE"
  | "BONUS_POOL";

export type LedgerTxnKind =
  | "DEMO_GRANT"
  | "BET"
  | "PAYOUT"
  | "REFUND"
  | "BONUS"
  | "ADJUSTMENT";

export type RoundStatus = "PENDING" | "SETTLED" | "VOID";

export type UserRoleName = "SUPER_ADMIN" | "ADMIN" | "AUDITOR" | "SUPPORT" | "VIEWER" | "PLAYER";

export interface User {
  id: string;
  display_name: string | null;
  status: "ACTIVE" | "SUSPENDED" | "SELF_EXCLUDED";
  self_exclusion_until: string | null;
  demo_balance_snapshot_minor: number;
  created_at: string;
  updated_at: string;
}

export interface Wallet {
  id: string;
  user_id: string;
  address: string;
  /** Normalised lowercase EVM address or TRON base58 address. */
  address_normalized: string;
  chain: ChainKey;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  wallet_id: string;
  chain: ChainKey;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  user_agent: string | null;
  ip: string | null;
}

export interface Role {
  id: string;
  name: UserRoleName;
  description: string;
  created_at: string;
}

export interface UserRole {
  id: string;
  user_id: string;
  role: UserRoleName;
  granted_by: string | null;
  created_at: string;
}

export interface LedgerAccount {
  id: string;
  user_id: string | null;
  type: LedgerAccountType;
  currency: "DEMO_CREDIT";
  code: string;
  created_at: string;
}

export interface LedgerEntry {
  id: string;
  txn_id: string;
  account_id: string;
  direction: LedgerDirection;
  /** Integer minor units. 1 demo credit = 100 minor units. */
  amount_minor: number;
  kind: LedgerTxnKind;
  memo: string | null;
  game_session_id: string | null;
  game_round_id: string | null;
  idempotency_key: string;
  sequence: number;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export interface GameSessionRow {
  id: string;
  user_id: string;
  game_key: GameKey;
  status: "OPEN" | "CLOSED";
  client_seed: string;
  nonce: number;
  state_json: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface GameRoundRow {
  id: string;
  game_session_id: string;
  user_id: string;
  game_key: GameKey;
  round_number: number;
  status: RoundStatus;
  stake_minor: number;
  payout_minor: number;
  server_seed: string | null;
  server_seed_hash: string;
  client_seed: string;
  nonce: number;
  commitment: string;
  draw_digest: string | null;
  result_json: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface BetRow {
  id: string;
  game_round_id: string;
  user_id: string;
  game_key: GameKey;
  bet_type: string;
  selection_json: string;
  stake_minor: number;
  odds_multiplier: number;
  outcome: "WIN" | "LOSS" | "PUSH" | "PENDING";
  payout_minor: number;
  created_at: string;
}

export interface PayoutRow {
  id: string;
  game_round_id: string;
  user_id: string;
  game_key: GameKey;
  amount_minor: number;
  ledger_txn_id: string;
  created_at: string;
}

export interface GameTableRow {
  id: string;
  name: string;
  game_key: "poker";
  variant: "TEXAS_HOLD_EM";
  max_seats: number;
  small_blind_minor: number;
  big_blind_minor: number;
  status: "OPEN" | "PAUSED" | "CLOSED";
  created_at: string;
  updated_at: string;
}

export interface PokerPlayerRow {
  id: string;
  game_table_id: string;
  user_id: string | null;
  seat: number;
  display_name: string;
  is_bot: boolean;
  stack_minor: number;
  status: "SEATED" | "FOLDED" | "OUT";
  created_at: string;
  updated_at: string;
}

export interface WalletTransactionRow {
  id: string;
  wallet_id: string;
  chain: ChainKey;
  tx_hash: string;
  direction: LedgerDirection;
  amount_native: string;
  token_symbol: string;
  status: "PENDING" | "CONFIRMED" | "FAILED";
  /** Always false in demo mode: on-chain settlement is disabled. */
  settlement_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_role: UserRoleName | "SYSTEM" | "ANONYMOUS";
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string;
  ip: string | null;
  user_agent: string | null;
  sequence: number;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export interface RiskEventRow {
  id: string;
  user_id: string | null;
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH";
  event_type: string;
  detail_json: string;
  created_at: string;
}

export interface SystemSettingRow {
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: string;
}

export interface AuthNonceRow {
  id: string;
  address_normalized: string;
  chain: ChainKey;
  nonce: string;
  message: string;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface IdempotencyRecord {
  key: string;
  scope: string;
  request_fingerprint: string | null;
  result_json: string;
  created_at: string;
}

export interface DatabaseFile {
  schema_version: number;
  users: User[];
  wallets: Wallet[];
  sessions: SessionRecord[];
  roles: Role[];
  user_roles: UserRole[];
  ledger_accounts: LedgerAccount[];
  ledger_entries: LedgerEntry[];
  game_sessions: GameSessionRow[];
  game_rounds: GameRoundRow[];
  bets: BetRow[];
  payouts: PayoutRow[];
  game_tables: GameTableRow[];
  poker_players: PokerPlayerRow[];
  wallet_transactions: WalletTransactionRow[];
  audit_logs: AuditLogRow[];
  risk_events: RiskEventRow[];
  system_settings: SystemSettingRow[];
  auth_nonces: AuthNonceRow[];
  idempotency: IdempotencyRecord[];
  chain: { ledger_seq: number; ledger_hash: string; audit_seq: number; audit_hash: string };
}
