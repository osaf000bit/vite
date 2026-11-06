/** Polygon adapter — read-only JSON-RPC (no signing, no settlement). */
import {
  evmRpc,
  hexToNumber,
  isoNow,
  withTimeout,
  type BalanceResult,
  type BlockResult,
  type ChainAdapter,
  type NetworkStatus,
  type TransactionResult,
  type VerifyTransactionResult,
} from "@ostad/chain-core";

export const POLYGON_CONFIG = {
  key: "polygon" as const,
  name: "Polygon",
  chainId: 137,
  explorer: "https://polygonscan.com",
  symbol: "POL",
  decimals: 18,
  rpcEnv: "POLYGON_RPC_URL",
  enabledEnv: "POLYGON_ENABLED",
} as const;

export function createPolygonAdapter(config: { rpcUrl?: string; enabled?: boolean } = {}): ChainAdapter {
  const rpcUrl = (config.rpcUrl ?? process.env.POLYGON_RPC_URL ?? "").trim();
  const enabled = config.enabled ?? process.env.POLYGON_ENABLED !== "false";

  const adapter: ChainAdapter = {
    key: "polygon",
    name: POLYGON_CONFIG.name,
    kind: "EVM",
    explorer: POLYGON_CONFIG.explorer,
    isConfigured: enabled && rpcUrl.length > 0,

    async getNetworkStatus(): Promise<NetworkStatus> {
      const base: NetworkStatus = {
        chain: "polygon",
        name: POLYGON_CONFIG.name,
        health: "NOT_CONFIGURED",
        chainId: POLYGON_CONFIG.chainId,
        blockHeight: null,
        latencyMs: null,
        explorer: POLYGON_CONFIG.explorer,
        settlementDisabled: true,
        demoAvailable: enabled,
        detail: rpcUrl
          ? "RPC configured; probing"
          : "POLYGON_RPC_URL is not set — demo play still works, live chain reads are disabled",
        checkedAt: isoNow(),
      };
      if (!enabled) return { ...base, health: "OFFLINE", detail: "POLYGON_ENABLED=false" };
      if (!rpcUrl) return base;
      const started = Date.now();
      try {
        const blockHex = await evmRpc<string>(rpcUrl, "eth_blockNumber");
        return {
          ...base,
          health: "ONLINE",
          blockHeight: hexToNumber(blockHex),
          latencyMs: Date.now() - started,
          detail: "Read-only JSON-RPC reachable",
          checkedAt: isoNow(),
        };
      } catch (error) {
        return {
          ...base,
          health: "DEGRADED",
          latencyMs: Date.now() - started,
          detail: `RPC unreachable: ${(error as Error).message}`,
          checkedAt: isoNow(),
        };
      }
    },

    async getBalance(address: string): Promise<BalanceResult> {
      const base = {
        address,
        symbol: POLYGON_CONFIG.symbol,
        decimals: POLYGON_CONFIG.decimals,
        fetched: false,
      };
      if (!rpcUrl) {
        return { ...base, amountBaseUnits: "0", detail: "No Polygon RPC configured — balance not fetched" };
      }
      try {
        const result = await withTimeout(
          evmRpc<string>(rpcUrl, "eth_getBalance", [address, "latest"]),
        );
        return {
          ...base,
          amountBaseUnits: BigInt(result ?? "0x0").toString(),
          fetched: true,
          detail: "Read from Polygon RPC",
        };
      } catch (error) {
        return { ...base, amountBaseUnits: "0", detail: `Read failed: ${(error as Error).message}` };
      }
    },

    async getTransaction(hash: string): Promise<TransactionResult> {
      if (!rpcUrl) {
        return {
          hash,
          found: false,
          blockNumber: null,
          from: null,
          to: null,
          valueBaseUnits: null,
          confirmed: false,
          detail: "No Polygon RPC configured",
        };
      }
      try {
        const tx = await evmRpc<{
          blockNumber: string | null;
          from: string;
          to: string | null;
          value: string;
        } | null>(rpcUrl, "eth_getTransactionByHash", [hash]);
        if (!tx) {
          return {
            hash,
            found: false,
            blockNumber: null,
            from: null,
            to: null,
            valueBaseUnits: null,
            confirmed: false,
            detail: "Transaction not found",
          };
        }
        return {
          hash,
          found: true,
          blockNumber: hexToNumber(tx.blockNumber),
          from: tx.from,
          to: tx.to,
          valueBaseUnits: BigInt(tx.value ?? "0x0").toString(),
          confirmed: Boolean(tx.blockNumber),
          detail: "Read from Polygon RPC",
        };
      } catch (error) {
        return {
          hash,
          found: false,
          blockNumber: null,
          from: null,
          to: null,
          valueBaseUnits: null,
          confirmed: false,
          detail: `Read failed: ${(error as Error).message}`,
        };
      }
    },

    async getBlock(number: number | "latest" = "latest"): Promise<BlockResult> {
      if (!rpcUrl) return { number: null, hash: null, timestamp: null, fetched: false, detail: "No Polygon RPC configured" };
      try {
        const block = await evmRpc<{ number: string; hash: string; timestamp: string } | null>(
          rpcUrl,
          "eth_getBlockByNumber",
          [number === "latest" ? "latest" : `0x${number.toString(16)}`, false],
        );
        if (!block) return { number: null, hash: null, timestamp: null, fetched: false, detail: "Block not found" };
        return {
          number: hexToNumber(block.number),
          hash: block.hash,
          timestamp: new Date(hexToNumber(block.timestamp)! * 1000).toISOString(),
          fetched: true,
          detail: "Read from Polygon RPC",
        };
      } catch (error) {
        return { number: null, hash: null, timestamp: null, fetched: false, detail: `Read failed: ${(error as Error).message}` };
      }
    },

    async verifyTransaction(hash, expected): Promise<VerifyTransactionResult> {
      // Settlement is disabled by policy: verification here is read-only proof
      // of existence on chain, never an authorisation to credit real value.
      const tx = await adapter.getTransaction(hash);
      if (!tx.found) {
        return { verified: false, confirmations: null, reason: "NOT_FOUND", detail: "Transaction not found on Polygon" };
      }
      if (expected?.to && tx.to && expected.to.toLowerCase() !== tx.to.toLowerCase()) {
        return { verified: false, confirmations: null, reason: "MISMATCH", detail: "Recipient does not match" };
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
