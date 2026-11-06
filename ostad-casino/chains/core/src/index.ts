/**
 * OSTAD CASINO — chain adapter contract.
 *
 * Every chain exposes the same read-only surface. Chain-specific behaviour
 * (EVM JSON-RPC vs TRON HTTP API, different address/tx formats) stays inside the
 * individual adapters — callers never branch on chain identity.
 *
 * These adapters are READ-ONLY. No signing, no key material and no value
 * movement exists anywhere in the adapter layer; real-money settlement is
 * disabled (REAL_MONEY_ENABLED=false) and refused by the compliance gate.
 */
export type ChainKey = "bsc" | "polygon" | "tron";
export type ChainHealth = "ONLINE" | "DEGRADED" | "OFFLINE" | "NOT_CONFIGURED";

export interface NetworkStatus {
  chain: ChainKey;
  name: string;
  health: ChainHealth;
  chainId: number | null;
  blockHeight: number | null;
  latencyMs: number | null;
  /** Explorer base URL for read-only links. */
  explorer: string | null;
  /** Always true in the shipped build: on-chain settlement is disabled. */
  settlementDisabled: true;
  demoAvailable: boolean;
  detail: string;
  checkedAt: string;
}

export interface BalanceResult {
  address: string;
  symbol: string;
  /** Base-unit string (wei / sun) — never a float, never fabricated. */
  amountBaseUnits: string;
  decimals: number;
  fetched: boolean;
  detail: string;
}

export interface TransactionResult {
  hash: string;
  found: boolean;
  blockNumber: number | null;
  from: string | null;
  to: string | null;
  valueBaseUnits: string | null;
  confirmed: boolean;
  detail: string;
}

export interface BlockResult {
  number: number | null;
  hash: string | null;
  timestamp: string | null;
  fetched: boolean;
  detail: string;
}

export interface VerifyTransactionResult {
  verified: boolean;
  confirmations: number | null;
  reason:
    | "VERIFIED_READ_ONLY"
    | "NOT_FOUND"
    | "SETTLEMENT_DISABLED"
    | "RPC_UNAVAILABLE"
    | "MISMATCH";
  detail: string;
}

export interface ChainAdapter {
  readonly key: ChainKey;
  readonly name: string;
  readonly kind: "EVM" | "TRON";
  readonly explorer: string;
  readonly isConfigured: boolean;
  getNetworkStatus(): Promise<NetworkStatus>;
  getBalance(address: string): Promise<BalanceResult>;
  getTransaction(hash: string): Promise<TransactionResult>;
  getBlock(number?: number | "latest"): Promise<BlockResult>;
  verifyTransaction(hash: string, expected?: { to?: string; minBaseUnits?: string }): Promise<VerifyTransactionResult>;
}

export const CHAIN_TIMEOUT_MS = 4000;

export function withTimeout<T>(promise: Promise<T>, ms = CHAIN_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("rpc_timeout")), ms).unref?.(),
    ),
  ]);
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Shared EVM JSON-RPC helper used by the BSC and Polygon adapters. */
export async function evmRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const response = await withTimeout(
    fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
    }),
  );
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc_error");
  return body.result as T;
}

export function hexToNumber(hex: string | null | undefined): number | null {
  if (!hex || typeof hex !== "string" || !hex.startsWith("0x")) return null;
  const parsed = Number.parseInt(hex, 16);
  return Number.isFinite(parsed) ? parsed : null;
}
