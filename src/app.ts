/**
 * TapeLog habit-report API: POST /habit-report behind an x402 paywall ($0.10 USDC on Base, or Base Sepolia for testing).
 * Stateless: the CSV is processed in memory for the request and never stored or logged.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { DISCLAIMER, SHORT_DISCLAIMER } from "./disclaimer";
import { CsvError, buildTrips, parseCsv, type Format, type Trip } from "./parse";
import { renderMarkdown, weeklyHabitReport } from "./habits";

export const PRICE = "$0.10";
export const TESTNET = "eip155:84532" as const; // Base Sepolia
export const MAINNET = "eip155:8453" as const; // Base
export const DEFAULT_FACILITATOR = "https://x402.org/facilitator"; // testnet-only, no signup
export const PAYAI_FACILITATOR = "https://facilitator.payai.network"; // Base mainnet, no API key

/**
 * The only networks this API will ever charge on. Anything else is refused at startup.
 * USDC addresses are pinned here and checked in tests against @x402/evm's default assets.
 */
export const NETWORKS = {
  [MAINNET]: { name: "Base (mainnet)", facilitator: PAYAI_FACILITATOR, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", testnet: false },
  [TESTNET]: { name: "Base Sepolia (testnet)", facilitator: DEFAULT_FACILITATOR, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", testnet: true },
} as const;
export type AllowedNetwork = keyof typeof NETWORKS;
const isAllowedNetwork = (n: string): n is AllowedNetwork => Object.prototype.hasOwnProperty.call(NETWORKS, n);
export const MAX_BODY_BYTES = 256 * 1024;
export const ROUTE = "POST /habit-report";
const DISCLAIMER_HEADER = "X-TapeLog-Disclaimer";

export interface AppConfig {
  /** Receiving address (from env PAY_TO). */
  payTo: string;
  /** eip155:8453 (Base) or eip155:84532 (Base Sepolia, the default). Nothing else is accepted. */
  network?: string;
  facilitatorUrl?: string;
  /** Inject a facilitator (tests). */
  facilitator?: FacilitatorClient;
  /** Fixed "today" for DAS files without a trade_date (tests). */
  today?: string;
}

export class ConfigError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function validateConfig(cfg: AppConfig): { payTo: string; network: AllowedNetwork; facilitatorUrl: string } {
  const network = (cfg.network || TESTNET).trim();
  if (!isAllowedNetwork(network)) throw new ConfigError(`Only ${MAINNET} (Base) and ${TESTNET} (Base Sepolia) are allowed; got ${network}.`);
  const facilitatorUrl = (cfg.facilitatorUrl || NETWORKS[network].facilitator).trim();
  if (!/^https:\/\//.test(facilitatorUrl)) throw new ConfigError("FACILITATOR_URL must be an https URL.");
  if (network === MAINNET && facilitatorUrl.replace(/\/+$/, "") === DEFAULT_FACILITATOR) throw new ConfigError("x402.org/facilitator is testnet-only; use a mainnet facilitator for Base.");
  const payTo = (cfg.payTo || "").trim();
  if (!ADDRESS.test(payTo)) throw new ConfigError("PAY_TO must be a 0x-prefixed 40-hex-char EVM address.");
  if (/^0x0{40}$/i.test(payTo)) throw new ConfigError("PAY_TO is still the all-zero placeholder; set a real receiving address.");
  return { payTo, network, facilitatorUrl };
}

/** Outermost middleware: every response carries the disclaimer (header always; JSON bodies get a field). */
const disclaimerEverywhere = (network: AllowedNetwork): MiddlewareHandler => async (c, next) => {
  await next();
  const res = c.res;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    let body: unknown;
    try { body = await res.clone().json(); } catch { body = undefined; }
    const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (res.status === 402 && !("error" in obj)) {
      obj.error = "payment_required";
      obj.price = PRICE; obj.network = network;
      obj.how_to_pay = "Read the PAYMENT-REQUIRED header (x402 v2), sign the USDC transfer, and retry with a PAYMENT-SIGNATURE header.";
    }
    if (obj.short_disclaimer !== SHORT_DISCLAIMER) obj.short_disclaimer = SHORT_DISCLAIMER;
    const headers = new Headers(res.headers); headers.delete("content-length");
    c.res = new Response(JSON.stringify(obj), { status: res.status, headers });
  }
  c.res.headers.set(DISCLAIMER_HEADER, SHORT_DISCLAIMER);
};

type Vars = { trips: Trip[] };

/** Wraps a facilitator and caches its resolved /supported answer (a value, never a pending promise). */
class SupportedCache implements FacilitatorClient {
  private supported: Awaited<ReturnType<FacilitatorClient["getSupported"]>> | null = null;
  constructor(private readonly inner: FacilitatorClient) {}
  verify(...a: Parameters<FacilitatorClient["verify"]>) { return this.inner.verify(...a); }
  settle(...a: Parameters<FacilitatorClient["settle"]>) { return this.inner.settle(...a); }
  async getSupported() { return (this.supported ??= await this.inner.getSupported()); }
}

function err(c: any, status: number, message: string) {
  return c.json({ error: message, disclaimer: DISCLAIMER }, status);
}

/** Bazaar discovery metadata, so x402 facilitators can list the endpoint for agents. Behavior-only wording. */
export const DISCOVERY_DESCRIPTION =
  "TapeLog weekly habit report: behavior-only trade habit report from your own broker CSV. " +
  "Counts size-ups after a loss, losers held longer than winners, overtrading bursts and time-of-day slumps, " +
  "this week versus prior weeks. Educational, not investment advice.";
export const DISCOVERY = declareDiscoveryExtension({
  bodyType: "text",
  input: "date,time,symbol,side,qty,price,fees\n2026-10-12,09:31:05,ABC,B,100,10.00,0.50\n2026-10-12,09:40:12,ABC,S,100,9.80,0.50\n" as unknown as Record<string, unknown>,
  inputSchema: {
    type: "string", contentMediaType: "text/csv", maxLength: MAX_BODY_BYTES,
    description: "Raw broker CSV of your own fills (DAS Trader Trades window, Robinhood activity report, or generic date,time,symbol,side,qty,price[,fees]). Optional query: format=json|markdown, trade_date, as_of, prior_weeks, broker.",
  },
  output: {
    example: {
      report: { week_of: "2026-10-12", as_of: "2026-10-15", prior_weeks_compared: 3, this_week: { trades: 24, size_up_after_loss: 8 }, appeared: [{ habit: "size_up_after_loss" }], faded: [] },
      markdown: "# TapeLog weekly habit report ...", trips_analyzed: 24,
      disclaimer: DISCLAIMER, short_disclaimer: SHORT_DISCLAIMER,
    },
    schema: {
      type: "object",
      properties: {
        report: { type: "object", description: "Counts of your own past behavior, this week versus prior weeks." },
        markdown: { type: "string" }, trips_analyzed: { type: "integer" },
        disclaimer: { type: "string" }, short_disclaimer: { type: "string" },
      },
      required: ["report", "markdown", "disclaimer"],
    },
  },
});

export function createApp(cfg: AppConfig) {
  const app = new Hono<{ Variables: Vars }>();

  let config: ReturnType<typeof validateConfig> | null = null, configError: string | null = null;
  try { config = validateConfig(cfg); } catch (e) { configError = (e as Error).message; }
  const network: AllowedNetwork = config?.network ?? TESTNET;
  app.use("*", disclaimerEverywhere(network));

  const info = {
    name: "TapeLog habit-report API",
    what: "Weekly habit report from your own trade fills: size-up after a loss, losers held longer than winners, overtrading bursts, time-of-day slump. Counts of your own past behavior only.",
    endpoint: ROUTE, price: PRICE, asset: "USDC", asset_address: NETWORKS[network].usdc, network, network_name: NETWORKS[network].name,
    testnet: NETWORKS[network].testnet, protocol: "x402 v2", facilitator: config?.facilitatorUrl ?? NETWORKS[network].facilitator,
    discovery: "The 402 response declares x402 Bazaar discovery metadata (bazaar extension), so facilitators can catalog this endpoint for agents.",
    input: "Raw CSV in the request body (DAS Trader Trades window, Robinhood activity report, or generic date,time,symbol,side,qty,price[,fees]). Max 256 KB.",
    query: { format: "json (default) | markdown", trade_date: "YYYY-MM-DD, DAS files only", as_of: "YYYY-MM-DD", prior_weeks: "1-12, default 4", broker: "auto | das | robinhood | generic" },
    storage: "None. Processed in memory for the request only.",
    free_validation: "Invalid CSVs are rejected with 400 before any payment is requested.",
    source: "https://github.com/tapelog-journal/tapelog-api",
    disclaimer: DISCLAIMER,
  };
  app.get("/", c => c.json({ ...info, configured: !configError }));
  app.get("/health", c => c.json({ ok: !configError }));

  // 1) Validate the CSV before asking for payment, so nobody pays for a bad file.
  app.post("/habit-report", async (c, next) => {
    if (configError) return err(c, 503, "Paid endpoint not configured: " + configError);
    const len = Number(c.req.header("content-length") || 0);
    if (len > MAX_BODY_BYTES) return err(c, 413, `CSV too large (max ${MAX_BODY_BYTES} bytes).`);
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return err(c, 413, `CSV too large (max ${MAX_BODY_BYTES} bytes).`);
    if (!text.trim()) return err(c, 400, "Empty body. Send the broker CSV as the raw request body.");
    const fmt = (c.req.query("broker") || "auto") as Format;
    if (!["auto", "das", "robinhood", "generic"].includes(fmt)) return err(c, 400, "broker must be auto, das, robinhood or generic.");
    for (const k of ["as_of", "trade_date"]) { const v = c.req.query(k); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return err(c, 400, `${k} must be YYYY-MM-DD.`); }
    const pw = c.req.query("prior_weeks");
    if (pw && !(/^\d+$/.test(pw) && +pw >= 1 && +pw <= 12)) return err(c, 400, "prior_weeks must be an integer from 1 to 12.");
    let trips: Trip[];
    try { trips = buildTrips(parseCsv(text, fmt, c.req.query("trade_date") || cfg.today)); }
    catch (e) { if (e instanceof CsvError) return err(c, 400, e.message); throw e; }
    if (!trips.length) return err(c, 400, "No closed round trips found in this CSV (every position must open and return to flat).");
    c.set("trips", trips);
    await next();
  });

  // 2) x402 paywall. Settles only if the handler below returns < 400.
  // Workers forbid awaiting I/O started by a different request, so the middleware is built per
  // request; only the facilitator's resolved /supported answer is cached between requests.
  if (config) {
    const facilitator = new SupportedCache(cfg.facilitator ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
    const routes: RoutesConfig = {
      [ROUTE]: {
        accepts: { scheme: "exact", price: PRICE, network: config.network, payTo: config.payTo, maxTimeoutSeconds: 120 },
        description: DISCOVERY_DESCRIPTION,
        mimeType: "application/json",
        serviceName: "TapeLog",
        tags: ["trading-journal", "habit-report", "behavior-only", "educational"],
        extensions: { ...DISCOVERY },
      },
    };
    app.use("/habit-report", (c, next) =>
      paymentMiddleware(routes, new x402ResourceServer(facilitator)
        .register(config!.network, new ExactEvmScheme())
        .registerExtension(bazaarResourceServerExtension))(c, next));
  }

  // 3) Paid handler: compute the report in memory and return it.
  app.post("/habit-report", c => {
    const trips = c.get("trips");
    const pw = c.req.query("prior_weeks");
    const report = weeklyHabitReport(trips, c.req.query("as_of") || undefined, pw ? +pw : 4);
    const markdown = renderMarkdown(report);
    if (c.req.query("format") === "markdown") return c.body(markdown, 200, { "content-type": "text/markdown; charset=utf-8" });
    return c.json({ report, markdown, trips_analyzed: trips.length, disclaimer: DISCLAIMER });
  });

  app.notFound(c => err(c, 404, "Not found. See GET / for the API description."));
  app.onError((e, c) => { console.error("internal error:", (e as Error).name); return err(c, 500, "Internal error."); });
  return app;
}
