/**
 * Chain registry — single place that builds adapters from environment config.
 * Missing RPC URLs never break demo play: adapters report NOT_CONFIGURED and
 * every on-chain write stays disabled.
 */
import { createBscAdapter } from "@ostad/chain-bsc";
import { createPolygonAdapter } from "@ostad/chain-polygon";
import { createTronAdapter } from "@ostad/chain-tron";
import type { ChainAdapter, ChainKey, NetworkStatus } from "@ostad/chain-core";

export type { ChainAdapter, ChainKey, NetworkStatus } from "@ostad/chain-core";

let cache: Map<ChainKey, ChainAdapter> | null = null;

export function chainAdapters(): Map<ChainKey, ChainAdapter> {
  if (!cache) {
    const map = new Map<ChainKey, ChainAdapter>();
    map.set("bsc", createBscAdapter());
    map.set("polygon", createPolygonAdapter());
    map.set("tron", createTronAdapter());
    cache = map;
  }
  return map;
}

/** Reset cached adapters (used by tests and by config changes). */
export function resetChainAdapters(): void {
  cache = null;
}

export function getAdapter(key: ChainKey): ChainAdapter {
  const adapter = chainAdapters().get(key);
  if (!adapter) throw new Error(`Unknown chain: ${key}`);
  return adapter;
}

export async function allNetworkStatuses(): Promise<NetworkStatus[]> {
  const adapters = Array.from(chainAdapters().values());
  return Promise.all(
    adapters.map((adapter) =>
      adapter.getNetworkStatus().catch<NetworkStatus>(() => ({
        chain: adapter.key,
        name: adapter.name,
        health: "OFFLINE",
        chainId: null,
        blockHeight: null,
        latencyMs: null,
        explorer: adapter.explorer,
        settlementDisabled: true,
        demoAvailable: true,
        detail: "Status probe failed",
        checkedAt: new Date().toISOString(),
      })),
    ),
  );
}
