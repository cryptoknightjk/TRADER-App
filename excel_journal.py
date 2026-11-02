"""
Import CK Trading Journal Excel workbooks into the app's CSV journal format.

The source .xlsx is read only — never modified. Output is a new .csv file.
"""
from __future__ import annotations

import csv
import re
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Any


HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "entry_date": ("entry date", "entrydate", "date"),
    "pair": ("trading pair", "pair", "symbol"),
    "direction": ("direction", "dir", "side"),
    "entry_price": ("entry price", "entry"),
    "stop_loss": ("stop loss", "sl", "stop"),
    "take_profit": ("take profit", "tp", "target"),
    "strategy": ("strategy type", "strategy"),
    "setup_idea": ("setup idea", "idea", "setup"),
    "quality": ("quality of setup", "quality", "grade"),
    "exit_reason": ("exit reason", "exit"),
    "exit_date": ("exit date (close)", "exit date", "close date"),
    "exit_price": ("exit price", "close price"),
    "notes": ("post-trade improvement", "notes", "post trade", "comment"),
}

CSV_COLUMNS = [
    "id",
    "entry_date",
    "pair",
    "direction",
    "entry_price",
    "stop_loss",
    "take_profit",
    "strategy",
    "setup_idea",
    "quality",
    "exit_reason",
    "exit_date",
    "exit_price",
    "notes",
    "archived",
    "created_at",
]

def _norm_header(value: Any) -> str:
    s = "" if value is None else str(value).strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s


def _map_headers(row: tuple[Any, ...]) -> dict[str, int]:
    found: dict[str, int] = {}
    for idx, cell in enumerate(row):
        h = _norm_header(cell)
        if not h:
            continue
        for field, aliases in HEADER_ALIASES.items():
            if field in found:
                continue
            if h in aliases or any(a in h for a in aliases if len(a) > 4):
                found[field] = idx
                break
    return found


def _cell(row: tuple[Any, ...], mapping: dict[str, int], key: str) -> Any:
    idx = mapping.get(key)
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def _as_date_text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    s = str(value).strip()
    if not s:
        return None
    upper = s.upper()
    if upper in {"N.A.", "N/A", "NA", "NIL", "NONE", "-", "—", "."}:
        return None
    # Excel serial sometimes arrives as float when data_only is off; try parse
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(s[:10], fmt).date().isoformat()
        except ValueError:
            pass
    # "2026-01-05 00:00:00"
    try:
        return datetime.fromisoformat(s.replace("Z", "")).date().isoformat()
    except ValueError:
        return None


def _norm_status_marker(value: Any) -> str:
    """Normalize free-text entry-date markers from Excel journals."""
    if value is None or isinstance(value, (datetime, date)):
        return ""
    s = re.sub(r"[\s_\-]+", " ", str(value).strip().lower())
    return s


def _entry_date_and_archived(value: Any) -> tuple[str, int]:
    """
    Map Excel Entry Date cell → (entry_date, archived).

    Special markers used in CK Trading Journals:
      - "not triggered" → Trades cancelled (archived=1, blank entry date)
      - "pending"       → Trades Pending (archived=0, blank entry date)
    Real dates stay in the main journal; blank/junk dates go to Pending.
    """
    marker = _norm_status_marker(value)
    if marker in {"not triggered", "nottriggered"}:
        return "", 1
    if marker == "pending":
        return "", 0
    return (_as_date_text(value) or ""), 0


def _as_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    s = str(value).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s or s.upper() == "NIL":
        return None
    return s


def _direction(value: Any) -> str | None:
    s = _as_text(value)
    if not s:
        return None
    u = s.upper()
    if u.startswith("L") and "SHORT" not in u:
        return "LONG"
    if u.startswith("S"):
        return "SHORT"
    return u


def _quality(value: Any) -> str:
    s = (_as_text(value) or "B").upper().replace(" ", "")
    if s in ("A+", "A", "B", "C"):
        return s
    if s.startswith("A+"):
        return "A+"
    if s.startswith("A"):
        return "A"
    if s.startswith("C"):
        return "C"
    return "B"


def _exit_reason(value: Any) -> str | None:
    s = _as_text(value)
    if not s:
        return None
    known = {"TP", "SL", "Trailing stop", "Manual Exit"}
    for k in known:
        if s.lower() == k.lower():
            return k
    # normalize common variants
    low = s.lower()
    if low in ("tp", "take profit", "take-profit"):
        return "TP"
    if low in ("sl", "stop", "stop loss", "stop-loss"):
        return "SL"
    if "trail" in low:
        return "Trailing stop"
    if "manual" in low:
        return "Manual Exit"
    return s


def _pick_journal_sheet(wb) -> Any:
    names = list(wb.sheetnames)
    for name in names:
        if "journal" in name.lower():
            return wb[name]
    return wb[names[0]]


def read_excel_trades(excel_path: str | Path) -> list[dict[str, Any]]:
    from openpyxl import load_workbook

    path = Path(excel_path)
    if not path.is_file():
        raise FileNotFoundError(f"Excel file not found: {path}")

    wb = load_workbook(path, data_only=True, read_only=True)
    try:
        ws = _pick_journal_sheet(wb)
        rows_iter = ws.iter_rows(values_only=True)
        try:
            header_row = next(rows_iter)
        except StopIteration:
            return []

        mapping = _map_headers(tuple(header_row))
        required = ("pair", "direction", "entry_price", "stop_loss", "take_profit")
        if not all(k in mapping for k in required):
            # try next few rows as header (title rows above)
            for extra in range(4):
                try:
                    header_row = next(rows_iter)
                except StopIteration:
                    break
                mapping = _map_headers(tuple(header_row))
                if all(k in mapping for k in required):
                    break
            if not all(k in mapping for k in required):
                missing = [k for k in required if k not in mapping]
                raise ValueError(
                    "Could not find journal columns in Excel "
                    f"(missing: {', '.join(missing)}). "
                    "Expected a CK Trading Journal sheet."
                )

        trades: list[dict[str, Any]] = []
        for row in rows_iter:
            if not row or all(c is None or str(c).strip() == "" for c in row):
                continue
            pair = _as_text(_cell(row, mapping, "pair"))
            direction = _direction(_cell(row, mapping, "direction"))
            entry = _as_float(_cell(row, mapping, "entry_price"))
            sl = _as_float(_cell(row, mapping, "stop_loss"))
            tp = _as_float(_cell(row, mapping, "take_profit"))
            if not pair or not direction or entry is None or sl is None or tp is None:
                continue

            notes = _as_text(_cell(row, mapping, "notes"))
            entry_date, archived = _entry_date_and_archived(_cell(row, mapping, "entry_date"))
            trades.append({
                "entry_date": entry_date,
                "pair": pair.upper(),
                "direction": direction,
                "entry_price": entry,
                "stop_loss": sl,
                "take_profit": tp,
                "strategy": _as_text(_cell(row, mapping, "strategy")),
                "setup_idea": _as_text(_cell(row, mapping, "setup_idea")),
                "quality": _quality(_cell(row, mapping, "quality")),
                "exit_reason": _exit_reason(_cell(row, mapping, "exit_reason")),
                "exit_date": _as_date_text(_cell(row, mapping, "exit_date")),
                "exit_price": _as_float(_cell(row, mapping, "exit_price")),
                "notes": notes,
                "archived": archived,
            })
        return trades
    finally:
        wb.close()


def write_trades_csv(csv_path: str | Path, trades: list[dict[str, Any]]) -> int:
    path = Path(csv_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for i, trade in enumerate(trades, start=1):
        row = {k: "" for k in CSV_COLUMNS}
        row.update({k: ("" if trade.get(k) is None else trade.get(k)) for k in trade})
        row["id"] = trade.get("id") or i
        row["archived"] = 1 if int(trade.get("archived") or 0) else 0
        if not row.get("created_at"):
            row["created_at"] = datetime.now().isoformat(timespec="seconds")
        rows.append(row)

    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def sqlite_to_csv(sqlite_path: str | Path, csv_path: str | Path) -> dict[str, Any]:
    """One-time helper: convert a legacy .sqlite journal into .csv."""
    src = Path(sqlite_path)
    con = sqlite3.connect(str(src))
    con.row_factory = sqlite3.Row
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(trades)").fetchall()}
        has_archived = "archived" in cols
        has_created = "created_at" in cols
        select_archived = "COALESCE(archived, 0) AS archived" if has_archived else "0 AS archived"
        select_created = "created_at" if has_created else "NULL AS created_at"
        cur = con.execute(
            f"""
            SELECT id, entry_date, pair, direction, entry_price, stop_loss, take_profit,
                   strategy, setup_idea, quality, exit_reason, exit_date, exit_price, notes,
                   {select_archived}, {select_created}
            FROM trades
            ORDER BY id ASC
            """
        )
        trades = [dict(row) for row in cur.fetchall()]
    finally:
        con.close()
    count = write_trades_csv(csv_path, trades)
    return {
        "csv_path": str(Path(csv_path).resolve()),
        "sqlite_path": str(src.resolve()),
        "trade_count": count,
    }


def excel_to_csv(excel_path: str | Path, csv_path: str | Path) -> dict[str, Any]:
    """Convert Excel journal → new CSV file. Source Excel is never written."""
    trades = read_excel_trades(excel_path)
    count = write_trades_csv(csv_path, trades)
    return {
        "csv_path": str(Path(csv_path).resolve()),
        "excel_path": str(Path(excel_path).resolve()),
        "trade_count": count,
    }


# Back-compat aliases used by older wrappers
def write_trades_sqlite(sqlite_path: str | Path, trades: list[dict[str, Any]]) -> int:
    path = Path(sqlite_path)
    if path.suffix.lower() != ".csv":
        path = path.with_suffix(".csv")
    return write_trades_csv(path, trades)


def excel_to_sqlite(excel_path: str | Path, sqlite_path: str | Path) -> dict[str, Any]:
    path = Path(sqlite_path)
    if path.suffix.lower() != ".csv":
        path = path.with_suffix(".csv")
    info = excel_to_csv(excel_path, path)
    info["sqlite_path"] = info["csv_path"]
    return info
