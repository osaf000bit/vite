/** Chain identifiers and address normalisation for the wallet engine. */
export type ChainKey = "bsc" | "polygon" | "tron";
export type WalletKind = "EVM" | "TRON";

export interface ChainDescriptor {
  key: ChainKey;
  name: string;
  shortName: string;
  kind: WalletKind;
  chainId: number | null;
  nativeSymbol: string;
  explorer: string;
  /** Wallet apps that can authenticate on this chain. */
  wallets: { id: string; name: string; installUrl: string }[];
  accent: string;
}

export const CHAINS: readonly ChainDescriptor[] = [
  {
    key: "bsc",
    name: "BNB Smart Chain",
    shortName: "BSC",
    kind: "EVM",
    chainId: 56,
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    wallets: [
      { id: "metamask", name: "MetaMask", installUrl: "https://metamask.io/download/" },
      { id: "trust", name: "Trust Wallet", installUrl: "https://trustwallet.com/browser-extension" },
      { id: "walletconnect", name: "WalletConnect", installUrl: "https://walletconnect.com/" },
    ],
    accent: "#c8a24a",
  },
  {
    key: "polygon",
    name: "Polygon",
    shortName: "POL",
    kind: "EVM",
    chainId: 137,
    nativeSymbol: "POL",
    explorer: "https://polygonscan.com",
    wallets: [
      { id: "metamask", name: "MetaMask", installUrl: "https://metamask.io/download/" },
      { id: "trust", name: "Trust Wallet", installUrl: "https://trustwallet.com/browser-extension" },
      { id: "walletconnect", name: "WalletConnect", installUrl: "https://walletconnect.com/" },
    ],
    accent: "#8f7bd6",
  },
  {
    key: "tron",
    name: "TRON",
    shortName: "TRX",
    kind: "TRON",
    chainId: null,
    nativeSymbol: "TRX",
    explorer: "https://tronscan.org",
    wallets: [{ id: "tronlink", name: "TronLink", installUrl: "https://www.tronlink.org/" }],
    accent: "#b56a3c",
  },
] as const;

export function getChain(key: string): ChainDescriptor | undefined {
  return CHAINS.find((chain) => chain.key === key);
}

export function isChainKey(value: unknown): value is ChainKey {
  return value === "bsc" || value === "polygon" || value === "tron";
}

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * Canonical form used for uniqueness and nonce lookups. EVM addresses are
 * case-insensitive (EIP-55 is a checksum, not an identity), TRON base58 is
 * case-sensitive and therefore preserved.
 */
export function normalizeAddress(chain: ChainKey, address: string): string {
  const trimmed = address.trim();
  if (chain === "tron") {
    if (!TRON_ADDRESS_RE.test(trimmed)) throw new WalletValidationError("invalid_address", "Invalid TRON address");
    return trimmed;
  }
  if (!EVM_ADDRESS_RE.test(trimmed)) throw new WalletValidationError("invalid_address", "Invalid EVM address");
  return trimmed.toLowerCase();
}

export function shortenAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export class WalletValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WalletValidationError";
  }
}
