# TapeLog habit-report API (x402, testnet)

A pay-per-call HTTP API that turns a trader's own broker CSV into the **TapeLog weekly habit report**. It compares the latest week with the prior weeks and counts four habits:

- **Size-up after a loss:** the next trade after a same-day loss was over 1.2x the usual position size.
- **Losers held longer than winners:** losing trades held longer than the average winning trade.
- **Overtrading bursts:** 3 or more trades opened within 15 minutes.
- **Time-of-day slump:** losing trades in the weakest entry window.

Payment uses [x402](https://docs.cdp.coinbase.com/x402/welcome), the HTTP 402 protocol: USDC, no account, no API key. Any agent with an x402 client can call it.

> **Educational, not investment advice.** The report describes the caller's own past behavior only. It never gives picks, price targets, signals, predictions or "you should". Every response carries this disclaimer, in an `X-TapeLog-Disclaimer` header, a `short_disclaimer` field in every JSON body, and the full disclaimer text on reports.

**Status: testnet only.** This build is locked to **Base Sepolia** (`eip155:84532`) and refuses any other network. It is not deployed yet.

## Pricing

| Endpoint | Price | Asset | Network | Facilitator |
|---|---|---|---|---|
| `POST /habit-report` | **$0.10 per report** (100000 base units) | USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) | Base Sepolia testnet | `https://x402.org/facilitator` |
| `GET /`, `GET /health` | free | | | |

- **You pay only for a report.** Invalid CSVs, bad query parameters and files with no closed trades are rejected with `400` *before* any payment is requested.
- **No charge on failure.** If the report step fails after a payment is verified, settlement is cancelled and nothing is charged.

## How agents call it

1. `POST /habit-report` with the raw CSV as the body. Use `Content-Type: text/csv`, max 256 KB.
2. The server answers `402 Payment Required` with a base64 `PAYMENT-REQUIRED` header (x402 v2): scheme `exact`, network `eip155:84532`, amount `100000`, payTo, asset.
3. Your x402 client signs an EIP-3009 USDC `transferWithAuthorization` and retries the same request with a `PAYMENT-SIGNATURE` header.
4. You get `200` with the report. The `PAYMENT-RESPONSE` header carries the settlement receipt.

With the official TypeScript client:

```ts
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const client = new x402Client();
registerExactEvmScheme(client, { signer: account }); // a viem account holding Base Sepolia test USDC
const http = new x402HTTPClient(client);

const url = "https://<worker-host>/habit-report?format=json";
const init = { method: "POST", body: csvText, headers: { "content-type": "text/csv" } };
const first = await fetch(url, init);                               // 402
const required = http.getPaymentRequiredResponse(h => first.headers.get(h), await first.json());
const payment = await http.createPaymentPayload(required);
const res = await fetch(url, { ...init, headers: { ...init.headers, ...http.encodePaymentSignatureHeader(payment) } });
const { report, markdown } = await res.json();
```

`@x402/fetch` (`wrapFetchWithPayment`) and the Python `x402` package do the same in one call.

### Input

The broker is auto-detected from the CSV header row:

| Broker | Export | Notes |
|---|---|---|
| DAS Trader | Trades window export (`Time,Symb,Side,Price,Qty,...,EcnFees`) | No date column, so pass `?trade_date=YYYY-MM-DD` (default: today, UTC) |
| Robinhood | Account activity report (`Activity Date,...,Trans Code,Quantity,Price,Amount`) | No time of day; fills are ordered within each day |
| Generic | `date,time,symbol,side,qty,price[,fees]` | `side` is B/BUY/BC/BTC or S/SELL/SS |

Query parameters:

| Parameter | Values |
|---|---|
| `format` | `json` (default) or `markdown` |
| `as_of` | `YYYY-MM-DD`, the last day to include |
| `prior_weeks` | 1–12, default 4 |
| `broker` | `auto`, `das`, `robinhood` or `generic` |

### Output (`format=json`)

```json
{
  "report": {
    "week_of": "2026-10-12", "as_of": "2026-10-15", "prior_weeks_compared": 3,
    "this_week": { "trades": 24, "net_pnl": -287.0, "size_up_after_loss": 8, "...": "..." },
    "prior_weeks": { "2026-09-21": { "...": "..." } },
    "appeared": [{ "habit": "size_up_after_loss", "this_week": 8, "prior_weekly_avg": 0, "summary": "..." }],
    "faded": [], "steady": [],
    "framing": "Counts of your own past behavior only. ...",
    "disclaimer": "TapeLog is an educational, record-keeping tool. ..."
  },
  "markdown": "# TapeLog weekly habit report ...",
  "trips_analyzed": 96,
  "disclaimer": "...",
  "short_disclaimer": "Educational, not investment advice."
}
```

## Privacy

The service is stateless. The CSV is parsed in memory for that one request and then discarded. There is no database, KV, cache or log of the body, and a test enforces that the source uses no storage APIs.

## Develop

```bash
npm ci
npm test           # vitest: parity with the Python reference, paywall flow, no-advice wording guard
npx tsc            # typecheck
cp .dev.vars.example .dev.vars   # then put a Base Sepolia receiving address in PAY_TO
npm run dev        # local Workers runtime on :8787
```

Configuration comes from environment variables:

| Variable | Required | Notes |
|---|---|---|
| `PAY_TO` | yes | Receiving address. Set it with `wrangler secret put PAY_TO`. The all-zero placeholder is rejected. |
| `NETWORK` | no | Defaults to `eip155:84532`. Anything else is refused in this build. |
| `FACILITATOR_URL` | no | Defaults to `https://x402.org/facilitator`. |

The habit logic is a TypeScript port of [`tapelog-mcp`](https://github.com/tapelog-journal/tapelog-mcp) (`habits.py`). `test/fixtures/golden.json` holds the Python output, and the tests check that this port matches it exactly. Regenerate it with:

```bash
PYTHONPATH=../tapelog-mcp/src python3 scripts/make_golden.py
```

All sample CSVs are synthetic.

## License

MIT © TapeLog
