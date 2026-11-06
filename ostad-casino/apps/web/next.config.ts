import type { NextConfig } from "next";

/**
 * Security headers are applied centrally. CSP keeps the app first-party only:
 * no third-party scripts, and `connect-src` limited to self plus the public RPC
 * endpoints the read-only chain adapters probe.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js injects inline bootstrap scripts; styles are inlined by Tailwind v4.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.trongrid.io https://bsc-dataseed.binance.org https://polygon-rpc.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source, so Next must transpile them.
  transpilePackages: [
    "@ostad/rng",
    "@ostad/ledger",
    "@ostad/game-engine",
    "@ostad/wallet-engine",
    "@ostad/risk-engine",
    "@ostad/compliance",
    "@ostad/chain-core",
    "@ostad/chain-bsc",
    "@ostad/chain-polygon",
    "@ostad/chain-tron",
    "@ostad/chain-registry",
  ],
  experimental: {
    // Chain adapters and the ledger store are Node-only.
    serverActions: { bodySizeLimit: "1mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
