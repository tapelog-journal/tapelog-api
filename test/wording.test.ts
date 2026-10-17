/** Guardrail: the API only describes the caller's own past behavior. No picks, targets, signals or "you should". */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { buildTrips, parseCsv } from "../src/parse";
import { renderMarkdown, weeklyHabitReport } from "../src/habits";
import { DISCLAIMER, SHORT_DISCLAIMER } from "../src/disclaimer";
import { createApp } from "../src/app";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
// Advice-like wording that must never appear outside the disclaimer itself.
export const BANNED = /\b(you should|should (buy|sell|hold)|buy|sell|price target|target price|recommend(s|ed|ation)?|signal to|entry point|exit point|go long|go short|will (rise|fall|go up|go down)|predict(s|ion|ed)?|forecast|guarantee(d)?|outperform|undervalued|overvalued)\b/i;

function strip(s: string) { return s.split(DISCLAIMER).join("").split(SHORT_DISCLAIMER).join(""); }
function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === "string") out.push(x);
  else if (Array.isArray(x)) x.forEach(v => allStrings(v, out));
  else if (x && typeof x === "object") Object.values(x).forEach(v => allStrings(v, out));
  return out;
}

describe("no investment-advice wording", () => {
  const inputs: [string, string | undefined][] = [
    ["SAMPLE_weekly_habit_fills.csv", undefined], ["SAMPLE_das_trader_trades_window.csv", "2026-10-15"], ["SAMPLE_robinhood_activity_report.csv", undefined],
  ];
  for (const [f, td] of inputs) {
    it(`report and markdown for ${f} contain no advice phrases and carry the disclaimer`, () => {
      const r = weeklyHabitReport(buildTrips(parseCsv(fx(f), "auto", td)));
      const md = renderMarkdown(r);
      expect(md).toContain(SHORT_DISCLAIMER);
      for (const s of [...allStrings(r), md]) expect(strip(s)).not.toMatch(BANNED);
    });
  }

  it("the API description (GET /) contains no advice phrases", async () => {
    const app = createApp({ payTo: "0x1111111111111111111111111111111111111111" });
    const body = await (await app.request("/")).json();
    for (const s of allStrings(body)) expect(strip(s)).not.toMatch(BANNED);
  });

  it("the Bazaar discovery metadata contains no advice phrases", async () => {
    const { DISCOVERY, DISCOVERY_DESCRIPTION } = await import("../src/app");
    for (const s of [...allStrings(DISCOVERY), DISCOVERY_DESCRIPTION]) expect(strip(s)).not.toMatch(BANNED);
  });

  it("source strings shown to users contain no advice phrases", () => {
    const dir = new URL("../src/", import.meta.url);
    for (const f of readdirSync(dir).filter(f => f !== "disclaimer.ts")) { // disclaimer.ts is the disclaimer itself
      const src = readFileSync(new URL(f, dir), "utf8");
      // user-facing string literals only (skip comments)
      const literals = [...src.matchAll(/(["`])((?:\\.|(?!\1).)*)\1/g)].map(m => m[2]).filter(s => s.includes(" ")); // sentences, not parser tokens like "buy"
      for (const s of literals) expect(strip(s), `${f}: ${s}`).not.toMatch(BANNED);
    }
  });

  it("the guard itself catches advice wording", () => {
    for (const s of ["You should cut this position", "Buy the dip", "price target of $50", "This is a signal to enter", "We recommend selling"]) expect(s).toMatch(BANNED);
  });
});
