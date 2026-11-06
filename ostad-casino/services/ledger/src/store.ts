/**
 * OSTAD CASINO — persistence layer.
 *
 * The demo application ships with a durable, atomic file store so it runs with
 * zero external infrastructure. The table shapes mirror the PostgreSQL schema
 * in database/migrations exactly (same columns, same types) so switching to
 * PostgreSQL is a driver swap, not a rewrite — see database/README.md.
 *
 * Writes are serialised through a single async queue and flushed with
 * write-temp + rename, so a crash cannot leave a half-written ledger.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseFile } from "./types";
import { nowIso } from "./ids";

export const SCHEMA_VERSION = 1;

export function dataDirectory(): string {
  return process.env.OSTAD_DATA_DIR || path.join(process.cwd(), ".data");
}

export function dataFile(): string {
  return path.join(dataDirectory(), "ostad-casino.json");
}

function emptyDatabase(): DatabaseFile {
  return {
    schema_version: SCHEMA_VERSION,
    users: [],
    wallets: [],
    sessions: [],
    roles: [],
    user_roles: [],
    ledger_accounts: [],
    ledger_entries: [],
    game_sessions: [],
    game_rounds: [],
    bets: [],
    payouts: [],
    game_tables: [],
    poker_players: [],
    wallet_transactions: [],
    audit_logs: [],
    risk_events: [],
    system_settings: [],
    auth_nonces: [],
    idempotency: [],
    chain: { ledger_seq: 0, ledger_hash: "GENESIS", audit_seq: 0, audit_hash: "GENESIS" },
  };
}

let cache: DatabaseFile | null = null;
let queue: Promise<unknown> = Promise.resolve();
let loading: Promise<DatabaseFile> | null = null;

async function loadFromDisk(): Promise<DatabaseFile> {
  try {
    const raw = await fs.readFile(dataFile(), "utf8");
    const parsed = JSON.parse(raw) as DatabaseFile;
    // Forward-compatible: make sure every known collection exists.
    const base = emptyDatabase();
    for (const key of Object.keys(base) as (keyof DatabaseFile)[]) {
      if (parsed[key] === undefined) {
        (parsed as unknown as Record<string, unknown>)[key] = base[key];
      }
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const fresh = emptyDatabase();
      await persist(fresh);
      return fresh;
    }
    // A corrupt store must not silently reset the ledger.
    throw new Error(`store_unreadable: ${(error as Error).message}`);
  }
}

async function persist(db: DatabaseFile): Promise<void> {
  const dir = dataDirectory();
  await fs.mkdir(dir, { recursive: true });
  const target = dataFile();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(db), "utf8");
  await fs.rename(temp, target);
}

export async function connectStore(): Promise<DatabaseFile> {
  if (cache) return cache;
  if (!loading) {
    loading = loadFromDisk().then((db) => {
      cache = db;
      return db;
    });
  }
  return loading;
}

/**
 * Serialised read-modify-write unit of work. Every mutation in the application
 * goes through here, which is the transactional boundary: if `work` throws, the
 * in-memory copy is discarded and nothing is persisted.
 */
export async function withStore<T>(work: (db: DatabaseFile) => Promise<T> | T): Promise<T> {
  const run = async (): Promise<T> => {
    const current = await connectStore();
    const working = structuredClone(current) as DatabaseFile;
    const result = await work(working);
    cache = working;
    await persist(working);
    return result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Read-only snapshot copy — callers can never mutate the live cache. */
export async function readStore<T>(work: (db: DatabaseFile) => T): Promise<T> {
  const db = await connectStore();
  return work(structuredClone(db) as DatabaseFile);
}

/** Hash-chain link used by ledger entries and audit logs. */
export function chainHash(prevHash: string, payload: string): string {
  return createHash("sha256").update(`${prevHash}|${payload}`).digest("hex");
}

/**
 * Walk the stored hash chain and confirm nothing was altered or removed.
 * Exposed in the admin console as a tamper-evidence check.
 */
export function verifyChain(db: DatabaseFile): {
  ledger: { ok: boolean; entries: number; brokenAt?: number };
  audit: { ok: boolean; entries: number; brokenAt?: number };
} {
  let prev = "GENESIS";
  let ledgerOk = true;
  let brokenAt: number | undefined;
  const ledger = db.ledger_entries.slice().sort((a, b) => a.sequence - b.sequence);
  for (const entry of ledger) {
    const payload = [
      entry.sequence,
      entry.txn_id,
      entry.account_id,
      entry.direction,
      entry.amount_minor,
      entry.kind,
      entry.idempotency_key,
      entry.created_at,
    ].join(":");
    const expected = chainHash(prev, payload);
    if (entry.prev_hash !== prev || entry.hash !== expected) {
      ledgerOk = false;
      brokenAt = entry.sequence;
      break;
    }
    prev = entry.hash;
  }

  let auditPrev = "GENESIS";
  let auditOk = true;
  let auditBrokenAt: number | undefined;
  const audit = db.audit_logs.slice().sort((a, b) => a.sequence - b.sequence);
  for (const row of audit) {
    const payload = [
      row.sequence,
      row.actor_user_id ?? "",
      row.actor_role,
      row.action,
      row.target_type ?? "",
      row.target_id ?? "",
      row.created_at,
    ].join(":");
    const expected = chainHash(auditPrev, payload);
    if (row.prev_hash !== auditPrev || row.hash !== expected) {
      auditOk = false;
      auditBrokenAt = row.sequence;
      break;
    }
    auditPrev = row.hash;
  }

  return {
    ledger: { ok: ledgerOk, entries: ledger.length, brokenAt },
    audit: { ok: auditOk, entries: audit.length, brokenAt: auditBrokenAt },
  };
}

/** Test/ops helper: forget the in-process cache (disk stays authoritative). */
export function resetStoreCache(): void {
  cache = null;
  loading = null;
  queue = Promise.resolve();
}

/** Admin-only retention trimming for demo data (never touches the chain tips). */
export function trimIdempotency(db: DatabaseFile, keep = 5000): void {
  if (db.idempotency.length > keep) {
    db.idempotency = db.idempotency
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-keep);
  }
  const cutoff = Date.now() - 1000 * 60 * 60 * 48;
  db.auth_nonces = db.auth_nonces.filter((n) => new Date(n.expires_at).getTime() > cutoff);
  void nowIso();
}
