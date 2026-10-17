"""Regenerate test/fixtures/golden.json from the Python reference implementation in tapelog-mcp.
Usage: PYTHONPATH=../tapelog-mcp/src python3 scripts/make_golden.py"""
import json, pathlib
from tapelog_mcp import core, habits

FX = pathlib.Path(__file__).resolve().parent.parent / "test" / "fixtures"
cases = {
    "weekly": ("SAMPLE_weekly_habit_fills.csv", None),
    "das": ("SAMPLE_das_trader_trades_window.csv", "2026-10-15"),
    "robinhood": ("SAMPLE_robinhood_activity_report.csv", None),
}
out = {}
for name, (fn, td) in cases.items():
    trips = core.build_trips(core.parse_csv((FX / fn).read_text(), trade_date=td))
    r = habits.weekly_habit_report(trips)
    out[name] = {"trips": len(trips), "report": r, "markdown": habits.render_markdown(r)}
(FX / "golden.json").write_text(json.dumps(out, indent=1, sort_keys=True))
print("wrote", FX / "golden.json")
