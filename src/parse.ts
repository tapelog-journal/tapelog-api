/**
 * Parse broker CSV exports (DAS Trader, Robinhood, generic) and rebuild round trips.
 * Port of tapelog-mcp core.py. Pure functions, in memory only: nothing is stored.
 *
 * Datetimes are "naive" wall-clock times as written in the CSV, stored as epoch ms in UTC
 * fields (no timezone conversion), matching the Python reference.
 */
export interface Fill { dt: number; symbol: string; side: "B" | "S"; qty: number; price: number; fees: number; }
export interface Trip {
  symbol: string; direction: "long" | "short"; openDt: number; closeDt: number;
  qty: number; entryValue: number; pnl: number; fees: number;
}
export type Format = "auto" | "das" | "robinhood" | "generic";

export class CsvError extends Error {}

export const holdMinutes = (t: Trip) => (t.closeDt - t.openDt) / 60000;

/** Python-style round(x, n) for display values (avoids -0). */
export function round(x: number, n = 2): number {
  const v = Number(x.toFixed(n));
  return Object.is(v, -0) ? 0 : v;
}

/** RFC 4180-ish CSV parser: quotes, escaped quotes, CRLF. */
export function parseRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ""));
}

function dictRows(text: string): Record<string, string>[] {
  const rows = parseRows(text);
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

export function num(s: string | undefined): number {
  let v = (s ?? "").trim().replace(/\$/g, "").replace(/,/g, "");
  if (!v) return 0;
  const neg = v.startsWith("(") && v.endsWith(")");
  v = v.replace(/^\(+|\)+$/g, "");
  const n = Number(v);
  if (!Number.isFinite(n)) throw new CsvError(`Not a number: ${s}`);
  return neg ? -n : n;
}

export function detectFormat(text: string): Exclude<Format, "auto"> {
  const t = text.replace(/^\ufeff/, "");
  const head = t.trim() ? t.split(/\r?\n/)[0].toLowerCase() : "";
  const cols = head.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
  if (cols.includes("symb") && cols.includes("side")) return "das";
  if (head.includes("trans code") && head.includes("activity date")) return "robinhood";
  if (cols.includes("symbol") && cols.includes("side")) return "generic";
  throw new CsvError("Unrecognized CSV. Supported: DAS Trader Trades window, Robinhood activity report, " +
    "or generic CSV with date,time,symbol,side,qty,price[,fees].");
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseIsoDate(s: string): number {
  const m = ISO_DATE.exec(s.trim());
  if (!m) throw new CsvError(`Bad date (want YYYY-MM-DD): ${s}`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const back = new Date(ms);
  if (back.getUTCDate() !== +m[3] || back.getUTCMonth() !== +m[2] - 1) throw new CsvError(`Bad date: ${s}`);
  return ms;
}
function parseTime(s: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] ?? 0) > 59) throw new CsvError(`Bad time (want HH:MM:SS): ${s}`);
  return ((+m[1] * 60 + +m[2]) * 60 + +(m[3] ?? 0)) * 1000;
}

function get(r: Record<string, string>, k: string): string {
  const v = r[k];
  if (v === undefined) throw new CsvError(`Missing column: ${k}`);
  return v;
}

/**
 * @param tradeDate DAS Trades window exports have no date column; pass YYYY-MM-DD (defaults to today, UTC).
 */
export function parseCsv(text: string, fmt: Format = "auto", tradeDate?: string): Fill[] {
  text = text.replace(/^\ufeff/, "");
  const f = fmt === "auto" ? detectFormat(text) : fmt;
  const rows = dictRows(text);
  const fills: Fill[] = [];
  if (f === "das") {
    const d = tradeDate ? parseIsoDate(tradeDate) : parseIsoDate(new Date().toISOString().slice(0, 10));
    for (const r of rows) {
      const side = get(r, "Side").trim().toUpperCase();
      if (!["B", "S", "SS", "BC"].includes(side)) continue;
      fills.push({ dt: d + parseTime(get(r, "Time")), symbol: get(r, "Symb").trim().toUpperCase(),
        side: side === "B" || side === "BC" ? "B" : "S", qty: num(get(r, "Qty")), price: num(get(r, "Price")), fees: num(r["EcnFees"]) });
    }
  } else if (f === "robinhood") {
    // newest first, no time of day: reverse and space fills 1 second apart from 09:30 to keep order
    [...rows].reverse().forEach((r, i) => {
      const code = get(r, "Trans Code").trim().toLowerCase();
      if ((code !== "buy" && code !== "sell") || !get(r, "Instrument").trim()) return;
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(get(r, "Activity Date").trim());
      if (!m) throw new CsvError(`Bad Activity Date: ${r["Activity Date"]}`);
      const d = Date.UTC(+m[3], +m[1] - 1, +m[2]);
      const qty = num(get(r, "Quantity")), px = num(get(r, "Price")), amt = num(get(r, "Amount"));
      const gross = qty * px;
      const fee = Math.max(0, code === "sell" ? gross - amt : -amt - gross);
      fills.push({ dt: d + (9 * 60 + 30) * 60000 + i * 1000, symbol: get(r, "Instrument").trim().toUpperCase(),
        side: code === "buy" ? "B" : "S", qty, price: px, fees: round(fee, 4) });
    });
  } else {
    for (const raw of rows) {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) r[k.trim().toLowerCase()] = v;
      const side = get(r, "side").trim().toUpperCase();
      const time = (r["time"] ?? "").trim() || "09:30:00";
      fills.push({ dt: parseIsoDate(get(r, "date")) + parseTime(time), symbol: get(r, "symbol").trim().toUpperCase(),
        side: ["B", "BUY", "BC", "BTC"].includes(side) ? "B" : "S", qty: num(get(r, "qty")), price: num(get(r, "price")), fees: num(r["fees"]) });
    }
  }
  return fills.map((x, i) => [x, i] as const).sort((a, b) => a[0].dt - b[0].dt || a[1] - b[1]).map(a => a[0]);
}

/** A round trip starts when a symbol goes from flat to a position and ends when it returns to flat. */
export function buildTrips(fills: Fill[]): Trip[] {
  const trips: Trip[] = [];
  const state = new Map<string, { pos: number; cash: number; fees: number; open: number; maxq: number; maxval: number; dir: "long" | "short" }>();
  const sorted = fills.map((x, i) => [x, i] as const).sort((a, b) => a[0].dt - b[0].dt || a[1] - b[1]).map(a => a[0]);
  for (const f of sorted) {
    let remaining = f.side === "B" ? f.qty : -f.qty;
    while (Math.abs(remaining) > 1e-9) {
      let s = state.get(f.symbol);
      if (!s) { s = { pos: 0, cash: 0, fees: 0, open: f.dt, maxq: 0, maxval: 0, dir: remaining > 0 ? "long" : "short" }; state.set(f.symbol, s); }
      const pos = s.pos;
      const part = pos !== 0 && (pos > 0) !== (remaining > 0) ? (Math.abs(remaining) > Math.abs(pos) ? -pos : remaining) : remaining;
      const frac = f.qty ? Math.abs(part) / f.qty : 0;
      s.pos += part; s.cash -= part * f.price; s.fees += f.fees * frac;
      s.maxq = Math.max(s.maxq, Math.abs(s.pos)); s.maxval = Math.max(s.maxval, Math.abs(s.pos) * f.price);
      remaining -= part;
      if (Math.abs(s.pos) < 1e-9) {
        trips.push({ symbol: f.symbol, direction: s.dir, openDt: s.open, closeDt: f.dt, qty: s.maxq,
          entryValue: round(s.maxval, 2), pnl: s.cash - s.fees, fees: round(s.fees, 4) });
        state.delete(f.symbol);
      }
    }
  }
  return trips.map((x, i) => [x, i] as const).sort((a, b) => a[0].closeDt - b[0].closeDt || a[1] - b[1]).map(a => a[0]);
}

export function timeBucket(t: Trip): string {
  const d = new Date(t.openDt); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m < 9 * 60 + 30) return "pre-market";
  if (m < 10 * 60) return "09:30-10:00";
  if (m < 11 * 60) return "10:00-11:00";
  if (m < 12 * 60) return "11:00-12:00";
  if (m < 14 * 60) return "12:00-14:00";
  if (m < 16 * 60) return "14:00-16:00";
  return "after-hours";
}
