/**
 * End-to-end paywall tests. No network: a mock facilitator stands in for x402.org and checks the
 * buyer's EIP-3009 signature locally. Both addresses are throwaway keys generated in memory per run,
 * never written to disk, and only valid for these tests (Base Sepolia testnet config).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp, TESTNET, ConfigError, validateConfig } from "../src/app";
import { SHORT_DISCLAIMER, DISCLAIMER } from "../src/disclaimer";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const CSV = fx("SAMPLE_weekly_habit_fills.csv");
// Throwaway, in-memory, testnet-only. Not persisted anywhere.
const SELLER = privateKeyToAccount(generatePrivateKey()).address;
const buyer = privateKeyToAccount(generatePrivateKey());

class MockFacilitator implements FacilitatorClient {
  calls = { verify: 0, settle: 0 };
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET }], extensions: [], signers: {} } as any; }
  async verify(p: any, req: any) {
    this.calls.verify++;
    const a = p.payload.authorization;
    const ok = a.to.toLowerCase() === req.payTo.toLowerCase() && BigInt(a.value) >= BigInt(req.amount) &&
      await verifyTypedData({
        address: a.from,
        domain: { name: req.extra.name, version: req.extra.version, chainId: 84532, verifyingContract: req.asset },
        types: { TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "TransferWithAuthorization",
        message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) },
        signature: p.payload.signature,
      });
    return ok ? { isValid: true, payer: a.from } : { isValid: false, invalidReason: "invalid_signature" };
  }
  async settle(p: any) { this.calls.settle++; return { success: true, transaction: "0x" + "ab".repeat(32), network: TESTNET, payer: p.payload.authorization.from } as any; }
}

const header = (r: Response, n: string) => r.headers.get(n);
let fac: MockFacilitator;
let app: ReturnType<typeof createApp>;
beforeEach(() => { fac = new MockFacilitator(); app = createApp({ payTo: SELLER, facilitator: fac, today: "2026-10-15" }); });

function payer() {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: buyer });
  return new x402HTTPClient(client);
}
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", body, headers: { "content-type": "text/csv", ...headers } });

describe("free routes", () => {
  it("GET / describes price, network and storage, with the disclaimer", async () => {
    const r = await app.request("/");
    expect(r.status).toBe(200);
    expect(header(r, "x-tapelog-disclaimer")).toBe(SHORT_DISCLAIMER);
    const b: any = await r.json();
    expect(b).toMatchObject({ price: "$0.10", network: "eip155:84532", asset: "USDC", configured: true, disclaimer: DISCLAIMER, short_disclaimer: SHORT_DISCLAIMER });
  });
  it("404s carry the disclaimer too", async () => {
    const r = await app.request("/nope");
    expect(r.status).toBe(404);
    expect(header(r, "x-tapelog-disclaimer")).toBe(SHORT_DISCLAIMER);
    expect(((await r.json()) as any).short_disclaimer).toBe(SHORT_DISCLAIMER);
  });
});

describe("POST /habit-report paywall", () => {
  it("returns 402 with x402 v2 requirements: $0.10 USDC (100000 units) on Base Sepolia to PAY_TO", async () => {
    const r = await post("/habit-report", CSV);
    expect(r.status).toBe(402);
    expect(header(r, "x-tapelog-disclaimer")).toBe(SHORT_DISCLAIMER);
    const body: any = await r.json();
    expect(body.short_disclaimer).toBe(SHORT_DISCLAIMER);
    const pr = payer().getPaymentRequiredResponse(n => r.headers.get(n), body);
    expect(pr.x402Version).toBe(2);
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "100000", payTo: SELLER });
    expect(pr.accepts[0].asset.toLowerCase()).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e"); // USDC on Base Sepolia
    expect(fac.calls).toEqual({ verify: 0, settle: 0 });
  });

  it("pays, gets the report, and settles once", async () => {
    const http = payer();
    const first = await post("/habit-report", CSV);
    const pr = http.getPaymentRequiredResponse(n => first.headers.get(n), await first.json());
    const payload = await http.createPaymentPayload(pr);
    const r = await post("/habit-report", CSV, http.encodePaymentSignatureHeader(payload));
    expect(r.status).toBe(200);
    expect(header(r, "x-tapelog-disclaimer")).toBe(SHORT_DISCLAIMER);
    const b: any = await r.json();
    expect(b.report.week_of).toBe("2026-10-12");
    expect(b.report.appeared.map((i: any) => i.habit)).toContain("size_up_after_loss");
    expect(b.markdown).toContain(SHORT_DISCLAIMER);
    expect(b.disclaimer).toBe(DISCLAIMER);
    expect(fac.calls).toEqual({ verify: 1, settle: 1 });
    const settle = http.getPaymentSettleResponse(n => r.headers.get(n));
    expect(settle.success).toBe(true);
    expect(settle.payer?.toLowerCase()).toBe(buyer.address.toLowerCase());
  });

  it("asks the facilitator for /supported once, then reuses it across requests", async () => {
    let n = 0; const f = new MockFacilitator(); const orig = f.getSupported.bind(f);
    f.getSupported = async () => { n++; return orig(); };
    const a = createApp({ payTo: SELLER, facilitator: f });
    for (let i = 0; i < 3; i++) expect((await a.request("/habit-report", { method: "POST", body: CSV })).status).toBe(402);
    expect(n).toBe(1);
  });

  it("markdown format works after payment and still carries the disclaimer", async () => {
    const http = payer();
    const first = await post("/habit-report?format=markdown", CSV);
    const payload = await http.createPaymentPayload(http.getPaymentRequiredResponse(n => first.headers.get(n), await first.json()));
    const r = await post("/habit-report?format=markdown", CSV, http.encodePaymentSignatureHeader(payload));
    expect(r.status).toBe(200);
    expect(header(r, "content-type")).toContain("text/markdown");
    expect(await r.text()).toContain("**Educational, not investment advice.**");
    expect(header(r, "x-tapelog-disclaimer")).toBe(SHORT_DISCLAIMER);
  });

  it("rejects a payment signed for a different recipient", async () => {
    const http = payer();
    const first = await post("/habit-report", CSV);
    const pr = http.getPaymentRequiredResponse(n => first.headers.get(n), await first.json());
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const payload = await http.createPaymentPayload({ ...pr, accepts: [{ ...pr.accepts[0], payTo: other }] });
    const r = await post("/habit-report", CSV, http.encodePaymentSignatureHeader(payload));
    expect(r.status).toBe(402);
    expect(fac.calls.settle).toBe(0);
  });

  it("validates the CSV before asking for payment (bad file -> 400, nobody pays)", async () => {
    for (const [body, q] of [["", ""], ["foo,bar\n1,2", ""], [CSV, "?as_of=yesterday"], [CSV, "?prior_weeks=99"], [CSV, "?broker=etrade"],
      ["date,time,symbol,side,qty,price\n2026-10-12,09:30:00,X,B,10,5", ""]] as const) {
      const r = await post("/habit-report" + q, body);
      expect(r.status, body.slice(0, 20) + q).toBe(400);
      expect(header(r, "payment-required")).toBeNull();
      const b: any = await r.json();
      expect(b.disclaimer).toBe(DISCLAIMER);
      expect(b.short_disclaimer).toBe(SHORT_DISCLAIMER);
    }
    expect(fac.calls).toEqual({ verify: 0, settle: 0 });
  });

  it("rejects oversized bodies with 413", async () => {
    const r = await post("/habit-report", "date,time,symbol,side,qty,price\n" + "x".repeat(300 * 1024));
    expect(r.status).toBe(413);
  });

  it("DAS files use trade_date", async () => {
    const r = await post("/habit-report?trade_date=2026-10-15", fx("SAMPLE_das_trader_trades_window.csv"));
    expect(r.status).toBe(402); // valid file, payment requested
  });
});

describe("configuration guardrails", () => {
  it("refuses mainnet and any non-testnet network", () => {
    expect(() => validateConfig({ payTo: SELLER, network: "eip155:8453" })).toThrow(ConfigError);
    expect(() => validateConfig({ payTo: SELLER, network: "solana:mainnet" })).toThrow(ConfigError);
    expect(validateConfig({ payTo: SELLER }).network).toBe("eip155:84532");
  });
  it("rejects missing, malformed and all-zero placeholder PAY_TO; paid route answers 503", async () => {
    for (const payTo of ["", "0x123", "0x0000000000000000000000000000000000000000"]) {
      expect(() => validateConfig({ payTo })).toThrow(ConfigError);
      const a = createApp({ payTo, facilitator: new MockFacilitator() });
      const r = await a.request("/habit-report", { method: "POST", body: CSV });
      expect(r.status).toBe(503);
      expect(header(r, "x-tapelog-disclaimer")).toBe(SHORT_DISCLAIMER);
    }
  });
});

describe("stateless", () => {
  it("source has no storage APIs (no fs, KV, D1, R2, Cache API, Durable Objects) and never logs the body", () => {
    for (const f of ["app.ts", "parse.ts", "habits.ts", "index.ts"]) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/node:fs|from "fs"|\bKVNamespace\b|\bD1Database\b|\bR2Bucket\b|caches\.default|DurableObject|localStorage|console\.log\(/);
    }
  });
});
