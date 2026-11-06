/**
 * SIWE-style ("Sign-In With Ethereum") authentication message.
 *
 * The exact text signed in the wallet is generated on the server and stored with
 * the nonce. Verification re-uses the stored text, so a client cannot alter the
 * domain, address, nonce or expiry between request and signature.
 */
import type { ChainKey } from "./chains";

export const SIWE_STATEMENT =
  "Sign in to OSTAD CASINO (DEMO MODE). This signature proves wallet ownership only. " +
  "It costs no gas, moves no funds, and never reveals your private key or recovery phrase.";

export interface SiweParams {
  domain: string;
  address: string;
  chain: ChainKey;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  uri?: string;
}

export function buildSiweMessage(params: SiweParams): string {
  const lines = [
    `${params.domain} wants you to sign in with your ${params.chain === "tron" ? "TRON" : "Ethereum"} account:`,
    params.address,
    "",
    SIWE_STATEMENT,
    "",
    `URI: ${params.uri ?? `https://${params.domain}`}`,
    "Version: 1",
    `Chain: ${params.chain}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expirationTime}`,
  ];
  return lines.join("\n");
}

/**
 * Parse a stored message back into structured fields so the verifier can check
 * the nonce/expiry it issued rather than trusting client-submitted values.
 */
export function parseSiweMessage(message: string): Partial<SiweParams> & { statement?: string } {
  const lines = message.split("\n").map((line) => line.trim());
  const out: Partial<SiweParams> & { statement?: string } = {};
  const addressLine = lines[1];
  if (addressLine) out.address = addressLine;
  const get = (prefix: string): string | undefined => {
    const line = lines.find((candidate) => candidate.startsWith(`${prefix}: `));
    return line ? line.slice(prefix.length + 2) : undefined;
  };
  const nonce = get("Nonce");
  const chain = get("Chain");
  const issuedAt = get("Issued At");
  const expirationTime = get("Expiration Time");
  const uri = get("URI");
  if (nonce) out.nonce = nonce;
  if (chain === "bsc" || chain === "polygon" || chain === "tron") out.chain = chain;
  if (issuedAt) out.issuedAt = issuedAt;
  if (expirationTime) out.expirationTime = expirationTime;
  if (uri) out.uri = uri;
  if (lines[0]) out.domain = lines[0].split(" wants you to sign in")[0];
  const statementIndex = lines.indexOf(SIWE_STATEMENT);
  if (statementIndex >= 0) out.statement = lines[statementIndex];
  return out;
}
