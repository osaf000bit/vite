/**
 * TRON adapter — read-only HTTP API.
 *
 * TRON does not speak JSON-RPC the way EVM chains do, so this adapter uses the
 * TronGrid HTTP endpoints and keeps its own address/transaction shapes. It never
 * signs, never broadcasts and never moves funds.
 */
import {
  CHAIN_TIMEOUT_MS,
  isoNow,
  withTimeout,
  type BalanceResult,
  type BlockResult,
  type ChainAdapter,
  type NetworkStatus,
  type TransactionResult,
  type VerifyTransactionResult,
} from "@ostad/chain-core";

export const TRON_CONFIG = {
  key: "tron" as const,
  name: "TRON",
  explorer: "https://tronscan.org",
  symbol: "TRX",
  decimals: 6,
  defaultEndpoint: "https://api.trongrid.io",
  rpcEnv: "TRON_RPC_URL",
  enabledEnv: "TRON_ENABLED",
} as const;

const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

async function tronGet<T>(endpoint: string, path: string, body?: unknown): Promise<T> {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  const apiKey = process.env.TRONGRID_API_KEY;
  const response = await withTimeout(
    fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "TRON-PRO-API-KEY": apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS),
    }),
  );
  if (!response.ok) throw new Error(`tron_http_${response.status}`);
  return (await response.json()) as T;
}

export function createTronAdapter(config: { endpoint?: string; enabled?: boolean } = {}): ChainAdapter {
  const endpoint = (config.endpoint ?? process.env.TRON_RPC_URL ?? TRON_CONFIG.defaultEndpoint).trim();
  const enabled = config.enabled ?? process.env.TRON_ENABLED !== "false";

  const adapter: ChainAdapter = {
    key: "tron",
    name: TRON_CONFIG.name,
    kind: "TRON",
    explorer: TRON_CONFIG.explorer,
    isConfigured: endpoint.length > 0,

    async getNetworkStatus(): Promise<NetworkStatus> {
      const base: NetworkStatus = {
        chain: "tron",
        name: TRON_CONFIG.name,
        health: "NOT_CONFIGURED",
        chainId: null,
        blockHeight: null,
        latencyMs: null,
        explorer: TRON_CONFIG.explorer,
        settlementDisabled: true,
        demoAvailable: enabled,
        detail: "TRON HTTP endpoint configured; probing",
        checkedAt: isoNow(),
      };
      if (!enabled) return { ...base, health: "OFFLINE", detail: "TRON_ENABLED=false" };
      const started = Date.now();
      try {
        const block = await tronGet<{ block_header?: { raw_data?: { number?: number } } }>(
          endpoint,
          "/wallet/getnowblock",
        );
        return {
          ...base,
          health: "ONLINE",
          blockHeight: block.block_header?.raw_data?.number ?? null,
          latencyMs: Date.now() - started,
          detail: "Read-only TronGrid endpoint reachable",
          checkedAt: isoNow(),
        };
      } catch (error) {
        return {
          ...base,
          health: "DEGRADED",
          latencyMs: Date.now() - started,
          detail: `Endpoint unreachable: ${(error as Error).message}`,
          checkedAt: isoNow(),
        };
      }
    },

    async getBalance(address: string): Promise<BalanceResult> {
      const base = {
        address,
        symbol: TRON_CONFIG.symbol,
        decimals: TRON_CONFIG.decimals,
        fetched: false,
      };
      if (!TRON_ADDRESS_RE.test(address)) {
        return { ...base, amountBaseUnits: "0", detail: "Invalid TRON address — not queried" };
      }
      try {
        const account = await tronGet<{ balance?: number }>(endpoint, "/wallet/getaccount", {
          address,
          visible: true,
        });
        if (!account || typeof account.balance !== "number") {
          return { ...base, amountBaseUnits: "0", fetched: true, detail: "Account not activated on TRON" };
        }
        return {
          ...base,
          amountBaseUnits: String(account.balance),
          fetched: true,
          detail: "Read from TRON HTTP API",
        };
      } catch (error) {
        return { ...base, amountBaseUnits: "0", detail: `Read failed: ${(error as Error).message}` };
      }
    },

    async getTransaction(hash: string): Promise<TransactionResult> {
      const notFound: TransactionResult = {
        hash,
        found: false,
        blockNumber: null,
        from: null,
        to: null,
        valueBaseUnits: null,
        confirmed: false,
        detail: "Transaction not found",
      };
      try {
        const tx = await tronGet<{
          txID?: string;
          blockNumber?: number;
          raw_data?: { contract?: { parameter?: { value?: { owner_address?: string; to_address?: string; amount?: number } } }[] };
          ret?: { contractRet?: string }[];
        }>(endpoint, "/wallet/gettransactionbyid", { value: hash });

        if (!tx || !tx.txID) return notFound;
        const call = tx.raw_data?.contract?.[0]?.parameter?.value;
        return {
          hash,
          found: true,
          blockNumber: tx.blockNumber ?? null,
          from: call?.owner_address ?? null,
          to: call?.to_address ?? null,
          valueBaseUnits: typeof call?.amount === "number" ? String(call.amount) : null,
          confirmed: Boolean(tx.blockNumber) && tx.ret?.[0]?.contractRet === "SUCCESS",
          detail: "Read from TRON HTTP API",
        };
      } catch (error) {
        return { ...notFound, detail: `Read failed: ${(error as Error).message}` };
      }
    },

    async getBlock(number: number | "latest" = "latest"): Promise<BlockResult> {
      try {
        if (number === "latest") {
          const block = await tronGet<{ blockID?: string; block_header?: { raw_data?: { number?: number; timestamp?: number } } }>(
            endpoint,
            "/wallet/getnowblock",
          );
          const raw = block.block_header?.raw_data;
          return {
            number: raw?.number ?? null,
            hash: block.blockID ?? null,
            timestamp: raw?.timestamp ? new Date(raw.timestamp).toISOString() : null,
            fetched: Boolean(raw),
            detail: "Read from TRON HTTP API",
          };
        }
        const block = await tronGet<{ blockID?: string; block_header?: { raw_data?: { number?: number; timestamp?: number } } }>(
          endpoint,
          "/wallet/getblockbynum",
          { num: number },
        );
        const raw = block.block_header?.raw_data;
        return {
          number: raw?.number ?? number,
          hash: block.blockID ?? null,
          timestamp: raw?.timestamp ? new Date(raw.timestamp).toISOString() : null,
          fetched: Boolean(raw),
          detail: "Read from TRON HTTP API",
        };
      } catch (error) {
        return { number: null, hash: null, timestamp: null, fetched: false, detail: `Read failed: ${(error as Error).message}` };
      }
    },

    async verifyTransaction(hash, expected): Promise<VerifyTransactionResult> {
      const tx = await adapter.getTransaction(hash);
      if (!tx.found) {
        return { verified: false, confirmations: null, reason: "NOT_FOUND", detail: "Transaction not found on TRON" };
      }
      if (expected?.to && tx.to) {
        const normalize = (value: string): string => value.replace(/^0x41/i, "").toLowerCase();
        if (normalize(expected.to) !== normalize(tx.to)) {
          return { verified: false, confirmations: null, reason: "MISMATCH", detail: "Recipient does not match" };
        }
      }
      if (expected?.minBaseUnits && tx.valueBaseUnits) {
        if (BigInt(tx.valueBaseUnits) < BigInt(expected.minBaseUnits)) {
          return { verified: false, confirmations: null, reason: "MISMATCH", detail: "Value below expected amount" };
        }
      }
      return {
        verified: tx.confirmed,
        confirmations: null,
        reason: tx.confirmed ? "VERIFIED_READ_ONLY" : "NOT_FOUND",
        detail: tx.confirmed
          ? "Confirmed on chain (read-only). On-chain settlement remains disabled."
          : "Transaction not yet confirmed",
      };
    },
  };

  return adapter;
}
