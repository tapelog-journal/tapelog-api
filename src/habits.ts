/**
 * Weekly habit report: compares the latest week's behavior with prior weeks, using only the
 * fills the caller sends. Descriptive counts only. No market data, no signals, no advice.
 * Port of tapelog-mcp habits.py.
 */
import { DISCLAIMER, SHORT_DISCLAIMER } from "./disclaimer";
import { Trip, holdMinutes, parseIsoDate, round, timeBucket } from "./parse";

export const BURST_WINDOW_MIN = 15, BURST_MIN_TRADES = 3, SIZE_UP_RATIO = 1.2;
const DAY = 86400000, WEEK = 7 * DAY;

export const HABITS = {
  size_up_after_loss: "Size-up after a loss",
  losers_held_longer: "Losers held longer than winners",
  overtrading_burst: "Overtrading bursts",
  time_of_day_slump: "Time-of-day slump",
} as const;
export type HabitKey = keyof typeof HABITS;

export interface WeekCounts {
  trades: number; net_pnl: number; size_up_after_loss: number; losers_held_longer: number;
  overtrading_burst: number; time_of_day_slump: number; slump_window: string | null;
}
export interface HabitItem { habit: HabitKey; label: string; this_week: number; prior_weekly_avg: number; detail: string; summary?: string; }
export interface HabitReport {
  week_of: string; as_of: string; prior_weeks_compared: number; this_week: WeekCounts;
  prior_weeks: Record<string, WeekCounts>; appeared: HabitItem[]; faded: HabitItem[]; steady: HabitItem[];
  framing: string; disclaimer: string;
}
export type HabitReportResult = HabitReport | { note: string; disclaimer: string };

const dayOf = (ms: number) => Math.floor(ms / DAY) * DAY;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Monday of the week containing day ms. */
export const weekStart = (ms: number) => { const d = dayOf(ms); return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b), n = s.length, h = Math.floor(n / 2);
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

function sizeUp(trips: Trip[], base: number) {
  let n = 0;
  for (let i = 0; i + 1 < trips.length; i++) {
    const prev = trips[i], nxt = trips[i + 1];
    if (prev.pnl < 0 && dayOf(nxt.openDt) === dayOf(prev.closeDt) && nxt.openDt >= prev.closeDt && base && nxt.entryValue > SIZE_UP_RATIO * base) n++;
  }
  return n;
}
function losersLonger(trips: Trip[], refWinHold: number) {
  const w = trips.filter(t => t.pnl > 0).map(holdMinutes);
  const ref = w.length ? mean(w) : refWinHold;
  if (!ref) return 0;
  return trips.filter(t => t.pnl < 0 && holdMinutes(t) > ref).length;
}
export function bursts(trips: Trip[]) {
  const opens = trips.map(t => t.openDt).sort((a, b) => a - b);
  let n = 0, i = 0;
  while (i < opens.length) {
    let j = i;
    while (j + 1 < opens.length && opens[j + 1] - opens[i] <= BURST_WINDOW_MIN * 60000) j++;
    if (j - i + 1 >= BURST_MIN_TRADES) { n++; i = j + 1; } else i++;
  }
  return n;
}
function slump(trips: Trip[]): [number, string | null] {
  const g = new Map<string, Trip[]>();
  for (const t of trips) { const b = timeBucket(t); g.set(b, [...(g.get(b) ?? []), t]); }
  let worst: [string, number] | null = null, cnt = 0;
  for (const [b, ts] of g) {
    const losers = ts.filter(t => t.pnl < 0).length, net = ts.reduce((a, t) => a + t.pnl, 0);
    if (ts.length >= 3 && net < 0 && losers >= 2 && (worst === null || net < worst[1])) { worst = [b, net]; cnt = losers; }
  }
  return [cnt, worst ? worst[0] : null];
}
export function weekCounts(trips: Trip[], base: number, refWinHold: number): WeekCounts {
  const s = trips.map((x, i) => [x, i] as const).sort((a, b) => a[0].openDt - b[0].openDt || a[1] - b[1]).map(a => a[0]);
  const [sl, bucket] = slump(s);
  return { trades: s.length, net_pnl: round(s.reduce((a, t) => a + t.pnl, 0), 2),
    size_up_after_loss: sizeUp(s, base), losers_held_longer: losersLonger(s, refWinHold),
    overtrading_burst: bursts(s), time_of_day_slump: sl, slump_window: bucket };
}
function detail(key: HabitKey, wk: WeekCounts) {
  return {
    size_up_after_loss: `next trade after a same-day loss was over ${SIZE_UP_RATIO}x the usual position size`,
    losers_held_longer: "losing trade held longer than the average winning trade",
    overtrading_burst: `${BURST_MIN_TRADES}+ trades opened within ${BURST_WINDOW_MIN} minutes`,
    time_of_day_slump: `losing trades in the weakest entry window (${wk.slump_window || "n/a"})`,
  }[key];
}
const times = (n: number) => (n === 1 ? "1 time" : `${n} times`);

export function weeklyHabitReport(trips: Trip[], asOf?: string, priorWeeks = 4): HabitReportResult {
  if (!trips.length) return { note: "No closed round trips stored yet.", disclaimer: DISCLAIMER };
  const end = asOf ? parseIsoDate(asOf) : Math.max(...trips.map(t => dayOf(t.closeDt)));
  const thisWs = weekStart(end);
  const weeks = new Map<number, Trip[]>();
  for (const t of trips) {
    const ws = weekStart(t.closeDt);
    if (thisWs - priorWeeks * WEEK <= ws && ws <= thisWs && dayOf(t.closeDt) <= end) weeks.set(ws, [...(weeks.get(ws) ?? []), t]);
  }
  const cur = weeks.get(thisWs) ?? [];
  const priorKeys = [...weeks.keys()].filter(k => k < thisWs).sort((a, b) => a - b);
  const priorTrips = priorKeys.flatMap(k => weeks.get(k)!);
  const basePool = priorTrips.length ? priorTrips : cur;
  const base = basePool.length ? median(basePool.map(t => t.entryValue)) : 0;
  const pw = priorTrips.filter(t => t.pnl > 0).map(holdMinutes);
  const ref = pw.length ? mean(pw) : 0;
  const thisWeek = weekCounts(cur, base, ref);
  const prior: Record<string, WeekCounts> = {};
  for (const k of priorKeys) prior[iso(k)] = weekCounts(weeks.get(k)!, base, ref);
  const pv = Object.values(prior);
  const appeared: HabitItem[] = [], faded: HabitItem[] = [], steady: HabitItem[] = [];
  for (const key of Object.keys(HABITS) as HabitKey[]) {
    const label = HABITS[key], now = thisWeek[key];
    const avg = pv.length ? round(mean(pv.map(p => p[key])), 1) : 0;
    const item: HabitItem = { habit: key, label, this_week: now, prior_weekly_avg: avg, detail: detail(key, thisWeek) };
    if (!pv.length) {
      if (now) { item.summary = `${label}: this showed up ${times(now)} this week (${item.detail}).`; appeared.push(item); }
      continue;
    }
    if (now >= 1 && now >= Math.max(1, 1.5 * avg) && now > avg) {
      item.summary = `${label}: this showed up ${times(now)} this week vs ${avg} per week before (${item.detail}).`; appeared.push(item);
    } else if (avg >= 1 && now <= avg / 2) {
      item.summary = `${label}: showed up ${times(now)} this week vs ${avg} per week before.`; faded.push(item);
    } else if (now || avg) {
      item.summary = `${label}: ${times(now)} this week vs ${avg} per week before (about the same).`; steady.push(item);
    }
  }
  return { week_of: iso(thisWs), as_of: iso(end), prior_weeks_compared: pv.length, this_week: thisWeek, prior_weeks: prior,
    appeared, faded, steady,
    framing: "Counts of your own past behavior only. Small samples can be noise. Use them as prompts for reflection, not as trading signals.",
    disclaimer: DISCLAIMER };
}

const money = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function renderMarkdown(r: HabitReportResult, title = "TapeLog weekly habit report"): string {
  if (!("week_of" in r)) return `# ${title}\n\n${r.note}\n\n*${SHORT_DISCLAIMER}*\n`;
  const t = r.this_week;
  const L = [`# ${title}`, "", `**Week of ${r.week_of}** (data through ${r.as_of}), compared with ${r.prior_weeks_compared} prior week(s).`, "",
    `This week: ${t.trades} closed trades, net $${money(t.net_pnl)}.`, ""];
  for (const [head, key, empty] of [["Habits that appeared", "appeared", "None this week."],
    ["Habits that faded", "faded", "None this week."], ["About the same", "steady", "Nothing else to note."]] as const) {
    const items = r[key].map(i => `- ${i.summary}`);
    L.push(`## ${head}`, "", ...(items.length ? items : [empty]), "");
  }
  L.push("## Week by week", "", "| Week of | Trades | Size-up after loss | Losers held longer | Overtrading bursts | Time-of-day slump |", "|---|---|---|---|---|---|");
  for (const [wk, c] of [...Object.entries(r.prior_weeks), [`${r.week_of} (this week)`, t] as const]) {
    L.push(`| ${wk} | ${c.trades} | ${c.size_up_after_loss} | ${c.losers_held_longer} | ${c.overtrading_burst} | ${c.time_of_day_slump} |`);
  }
  L.push("", `_${r.framing}_`, "", `**${SHORT_DISCLAIMER}** ${r.disclaimer}`, "");
  return L.join("\n");
}
