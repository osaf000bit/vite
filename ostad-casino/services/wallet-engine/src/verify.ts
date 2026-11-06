/**
 * OSTAD CASINO — wallet signature verification.
 *
 * Two independent verifiers, because EVM and TRON sign different envelopes:
 *  • EVM: EIP-191 personal_sign (`ethers.verifyMessage`), recovery compared to
 *    the claimed address case-insensitively.
 *  • TRON: the TRON envelope `"\x19TRON Signed Message:\n" + len + message`
 *    hashed with keccak256, signature recovered and encoded back to base58 with
 *    the 0x41 network prefix.
 *
 * Only public information is used. No private key or recovery phrase is ever
 * requested, transmitted or stored.
 */
import { getAddress, keccak256, recoverAddress, Signature, toUtf8Bytes, verifyMessage } from "ethers";
import { base58Decode, base58Encode } from "./base58";
import { normalizeAddress, type ChainKey } from "./chains";

export interface SignatureCheck {
  ok: boolean;
  recovered: string | null;
  reason?: "bad_signature" | "address_mismatch" | "unsupported_chain" | "recovery_failed";
}

const TRON_PREFIX = "\x19TRON Signed Message:\n";

/** Recover the EVM address that produced `signature` over `message`. */
export function recoverEvmAddress(message: string, signature: string): string | null {
  try {
    return getAddress(verifyMessage(message, signature));
  } catch {
    return null;
  }
}

/** Deterministic TRON digest for a signed message. */
export function tronMessageDigest(message: string): string {
  const body = message;
  return keccak256(toUtf8Bytes(`${TRON_PREFIX}${toUtf8Bytes(body).length}${body}`));
}

/** Encode a 20-byte EVM address as a TRON base58check address. */
export function evmToTronAddress(evmAddress: string): string {
  const body = base58Decode56Fix(evmAddress);
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(body, 1);
  const checksum = base58Decode(keccak256(payload).slice(2)).subarray(0, 4);
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum, 21);
  return base58Encode(full);
}

function base58Decode56Fix(evmAddress: string): Uint8Array {
  const hex = evmAddress.replace(/^0x/i, "");
  if (hex.length !== 40) throw new Error("invalid_evm_address");
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Recover the TRON base58 address for a TRON-signed message. */
export function recoverTronAddress(message: string, signature: string): string | null {
  try {
    const digest = tronMessageDigest(message);
    const recoveredEvm = recoverAddress(digest, Signature.from(signature).serialized);
    return evmToTronAddress(recoveredEvm);
  } catch {
    return null;
  }
}

/** Verify a signature against the claimed address for a given chain. */
export function verifyWalletSignature(input: {
  chain: ChainKey;
  address: string;
  message: string;
  signature: string;
}): SignatureCheck {
  if (!input.signature || !/^0x[0-9a-fA-F]{130}$/.test(input.signature.trim())) {
    return { ok: false, recovered: null, reason: "bad_signature" };
  }
  let claimed: string;
  try {
    claimed = normalizeAddress(input.chain, input.address);
  } catch {
    return { ok: false, recovered: null, reason: "address_mismatch" };
  }

  if (input.chain === "tron") {
    const recovered = recoverTronAddress(input.message, input.signature.trim());
    if (!recovered) return { ok: false, recovered: null, reason: "recovery_failed" };
    return { ok: recovered === claimed, recovered, reason: recovered === claimed ? undefined : "address_mismatch" };
  }

  const recovered = recoverEvmAddress(input.message, input.signature.trim());
  if (!recovered) return { ok: false, recovered: null, reason: "recovery_failed" };
  return {
    ok: recovered.toLowerCase() === claimed,
    recovered,
    reason: recovered.toLowerCase() === claimed ? undefined : "address_mismatch",
  };
}
