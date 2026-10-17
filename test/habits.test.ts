import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTrips, parseCsv, parseRows, detectFormat, CsvError, type Trip } from "../src/parse";
import { bursts, renderMarkdown, weeklyHabitReport } from "../src/habits";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const golden = JSON.parse(fx("golden.json"));
const cases: [string, string, string | undefined][] = [
  ["weekly", "SAMPLE_weekly_habit_fills.csv", undefined],
  ["das", "SAMPLE_das_trader_trades_window.csv", "2026-10-15"],
  ["robinhood", "SAMPLE_robinhood_activity_report.csv", undefined],
];

/** Deep-compare with a small float tolerance (Python vs JS float formatting). */
function close(a: unknown, b: unknown, path = "$"): void {
  if (typeof a === "number" && typeof b === "number") { expect(Math.abs(a - b), path).toBeLessThan(1e-6); return; }
  if (Array.isArray(a) && Array.isArray(b)) { expect(a.length, path).toBe(b.length); a.forEach((x, i) => close(x, b[i], `${path}[${i}]`)); return; }
  if (a && b && typeof a === "object" && typeof b === "object") {
    expect(Object.keys(a as object).sort(), path).toEqual(Object.keys(b as object).sort());
    for (const k of Object.keys(a as object)) close((a as any)[k], (b as any)[k], `${path}.${k}`);
    return;
  }
  expect(a, path).toEqual(b);
}

describe("parity with the Python reference (tapelog-mcp habits.py)", () => {
  for (const [name, file, td] of cases) {
    it(`${name}: same trips, report and markdown`, () => {
      const trips = buildTrips(parseCsv(fx(file), "auto", td));
      expect(trips.length).toBe(golden[name].trips);
      const r = weeklyHabitReport(trips);
      close(JSON.parse(JSON.stringify(r)), golden[name].report);
      expect(renderMarkdown(r)).toBe(golden[name].markdown);
    });
  }

  it("weekly sample: size-up and losers-held-longer appeared, bursts and slump faded", () => {
    const r = weeklyHabitReport(buildTrips(parseCsv(fx("SAMPLE_weekly_habit_fills.csv"))));
    if (!("week_of" in r)) throw new Error("expected a report");
    expect(r.week_of).toBe("2026-10-12");
    expect(r.prior_weeks_compared).toBe(3);
    const app = Object.fromEntries(r.appeared.map(i => [i.habit, i]));
    expect(Object.keys(app)).toEqual(expect.arrayContaining(["size_up_after_loss", "losers_held_longer"]));
    expect(r.faded.map(i => i.habit)).toEqual(expect.arrayContaining(["overtrading_burst", "time_of_day_slump"]));
    expect(app.size_up_after_loss.this_week).toBe(8);
    expect(app.size_up_after_loss.summary).toContain("showed up 8 times");
  });
});

describe("parsing", () => {
  it("detects formats", () => {
    expect(detectFormat(fx("SAMPLE_das_trader_trades_window.csv"))).toBe("das");
    expect(detectFormat(fx("SAMPLE_robinhood_activity_report.csv"))).toBe("robinhood");
    expect(detectFormat(fx("SAMPLE_weekly_habit_fills.csv"))).toBe("generic");
    expect(() => detectFormat("a,b,c\n1,2,3")).toThrow(CsvError);
  });
  it("handles quotes, escaped quotes, commas in fields, CRLF and a BOM", () => {
    expect(parseRows('a,"b,c","d ""q"""\r\n1,2,3\r\n')).toEqual([["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
    const csv = "\ufeffdate,time,symbol,side,qty,price,fees\r\n2026-10-12,09:31:00,xyz,B,\"1,000\",10,0\r\n2026-10-12,09:40:00,XYZ,S,1000,\"$9.50\",0\r\n";
    const t = buildTrips(parseCsv(csv));
    expect(t).toHaveLength(1);
    expect(t[0].symbol).toBe("XYZ");
    expect(t[0].pnl).toBeCloseTo(-500);
  });
  it("rejects bad dates, times and numbers with a CsvError", () => {
    expect(() => parseCsv("date,time,symbol,side,qty,price\n2026-13-01,09:30:00,X,B,1,1")).toThrow(CsvError);
    expect(() => parseCsv("date,time,symbol,side,qty,price\n2026-10-01,25:30:00,X,B,1,1")).toThrow(CsvError);
    expect(() => parseCsv("date,time,symbol,side,qty,price\n2026-10-01,09:30:00,X,B,abc,1")).toThrow(CsvError);
  });
});

describe("habit helpers", () => {
  it("counts bursts and handles empty input", () => {
    const T = (m: number): Trip => ({ symbol: "X", direction: "long", openDt: Date.UTC(2026, 9, 14, 10, m), closeDt: Date.UTC(2026, 9, 14, 10, m + 1), qty: 100, entryValue: 1000, pnl: 1, fees: 0 });
    expect(bursts([T(0), T(5), T(10), T(40)])).toBe(1);
    const e = weeklyHabitReport([]);
    expect("note" in e).toBe(true);
    expect(renderMarkdown(e)).toContain("Educational, not investment advice.");
  });
});
