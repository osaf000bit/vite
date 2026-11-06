/**
 * OSTAD CASINO — RNG service
 *
 * Cryptographic, server-side, provably-fair-compatible random generator.
 * The client NEVER contributes to or determines an outcome. Seeds are combined
 * with HMAC-SHA256 so a published server seed + client seed + nonce can be used
 * to reproduce (and therefore verify) every draw that produced a result.
 *
 * Draw stream contract (stable, do not reorder): every random value consumed is
 * a uint32 read from an HMAC block in sequence, and is recorded in a `proof`.
 * Replaying the same seeds reproduces the same proof and the same result.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const RNG_VERSION = "OSTAD-RNG-1";
const BLOCK_UINTS = 8; // 32 bytes / 4

/** 32 random bytes, hex encoded. Kept secret until the round is settled. */
export function createServerSeed(): string {
  return randomBytes(32).toString("hex");
}

/** Client seed: supplied by the player or generated for them; non-secret. */
export function createClientSeed(): string {
  return randomBytes(16).toString("hex");
}

/** SHA-256 commitment published before the round starts. */
export function hashServerSeed(serverSeed: string): string {
  return createHash("sha256").update(`${RNG_VERSION}:${serverSeed}`).digest("hex");
}

/** Combined commitment shown to the player (hash + client seed + nonce). */
export function roundCommitment(serverSeedHash: string, clientSeed: string, nonce: number): string {
  return createHash("sha256").update(`${serverSeedHash}:${clientSeed}:${nonce}`).digest("hex");
}

/** Constant-time comparison for commitment / hash checks. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class RngStream {
  readonly serverSeedHash: string;
  readonly commitment: string;
  private blockIndex = 0;
  private block: Buffer;
  private slot = 0;
  private readonly proof: string[] = [];

  constructor(
    readonly serverSeed: string,
    readonly clientSeed: string,
    readonly nonce: number,
  ) {
    if (!/^[0-9a-f]{64}$/i.test(serverSeed)) throw new Error("invalid_server_seed");
    if (typeof clientSeed !== "string" || clientSeed.length < 8 || clientSeed.length > 128) {
      throw new Error("invalid_client_seed");
    }
    if (!Number.isInteger(nonce) || nonce < 1) throw new Error("invalid_nonce");
    this.serverSeedHash = hashServerSeed(serverSeed);
    this.commitment = roundCommitment(this.serverSeedHash, clientSeed, nonce);
    this.block = Buffer.alloc(0);
  }

  private nextBlock(): Buffer {
    const digest = createHmac("sha256", this.serverSeed)
      .update(`${RNG_VERSION}:${this.clientSeed}:${this.nonce}:${this.blockIndex}`)
      .digest();
    this.blockIndex += 1;
    this.slot = 0;
    return digest;
  }

  /** Raw 32-bit unsigned draw. Recorded for verification. */
  uint32(): number {
    if (this.slot >= BLOCK_UINTS) this.block = this.nextBlock();
    const value = this.block.readUInt32BE(this.slot * 4);
    this.slot += 1;
    this.proof.push(value.toString(16).padStart(8, "0"));
    return value;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.uint32() / 0x100000000;
  }

  /** Unbiased integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("invalid_range");
    if (maxExclusive === 1) {
      this.uint32(); // keep the draw stream shape stable
      return 0;
    }
    const limit = 0x100000000 - (0x100000000 % maxExclusive);
    for (;;) {
      const value = this.uint32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** Uniform integer in [min, maxInclusive]. */
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }

  /** Deterministic Fisher–Yates shuffle (does not mutate the input). */
  shuffle<T>(input: readonly T[]): T[] {
    const out = input.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** Weighted pick. `weights` must be positive finite numbers. */
  weightedIndex(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw new Error("invalid_weights");
    let ticket = this.float() * total;
    for (let i = 0; i < weights.length; i += 1) {
      ticket -= weights[i];
      if (ticket < 0) return i;
    }
    return weights.length - 1;
  }

  /** Draws consumed so far, hex encoded, in consumption order. */
  get draws(): string[] {
    return this.proof.slice();
  }

  /** Stable digest of every draw consumed by this stream. */
  drawDigest(): string {
    return createHash("sha256").update(this.proof.join(",")).digest("hex");
  }
}

export interface RngCommitment {
  clientSeed: string;
  nonce: number;
  serverSeedHash: string;
  commitment: string;
}

/**
 * Verify a commitment pair: the revealed server seed must hash to the hash that
 * was published before the round.
 */
export function verifyCommitment(input: {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  commitment?: string;
}): { ok: boolean; expectedServerSeedHash: string; expectedCommitment: string } {
  const expectedServerSeedHash = hashServerSeed(input.serverSeed);
  const expectedCommitment = roundCommitment(expectedServerSeedHash, input.clientSeed, input.nonce);
  const seedOk = safeEqualHex(expectedServerSeedHash, input.serverSeedHash);
  const commitOk = input.commitment ? safeEqualHex(expectedCommitment, input.commitment) : true;
  return { ok: seedOk && commitOk, expectedServerSeedHash, expectedCommitment };
}

/** Fresh stream for replay/verification. Identical seeds ⇒ identical draws. */
export function verificationStream(serverSeed: string, clientSeed: string, nonce: number): RngStream {
  return new RngStream(serverSeed, clientSeed, nonce);
}
