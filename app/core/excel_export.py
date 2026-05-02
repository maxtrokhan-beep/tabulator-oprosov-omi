from __future__ import annotations

import io
import math
from typing import Any

import xlsxwriter


def _fmt_cell(kind: str, cell: dict[str, Any]) -> str:
    v = cell.get("value")
    sig = cell.get("sig") or ""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    if kind == "mean":
        s = f"{float(v):.2f}".rstrip("0").rstrip(".")
    else:
        # проценты храним как долю (0..1)
        s = f"{float(v)*100:.0f}%"
    return (s + (f" {sig}" if sig else "")).strip()


def build_excel_bytes(result: dict[str, Any], title: str = "Табуляция") -> bytes:
    output = io.BytesIO()
    wb = xlsxwriter.Workbook(output, {"in_memory": True})
    ws = wb.add_worksheet("Таблица")

    fmt_title = wb.add_format({"bold": True, "font_size": 14})
    fmt_hdr = wb.add_format({"bold": True, "bg_color": "#F0F0F0", "border": 1})
    fmt_text = wb.add_format({"text_wrap": True, "border": 1})
    fmt_sub = wb.add_format({"italic": True, "border": 1})
    fmt_base = wb.add_format({"border": 1, "num_format": "0"})

    cols = result.get("columns", [])
    rows = result.get("rows", [])
    meta = result.get("meta", {})

    ws.write(0, 0, title, fmt_title)
    ws.write(2, 0, "Примечание:", wb.add_format({"bold": True}))
    ws.write(3, 0, meta.get("note", ""), wb.add_format({"text_wrap": True}))

    start_row = 5
    ws.write(start_row, 0, "Показатель", fmt_hdr)
    for j, c in enumerate(cols):
        label = c.get("label", "")
        letter = c.get("letter", "")
        ws.write(start_row, 1 + j, f"{label}\n{letter}".strip(), fmt_hdr)

    r = start_row + 1
    for row in rows:
        kind = row.get("kind")
        if kind == "header":
            ws.write(r, 0, row.get("label", ""), wb.add_format({"bold": True}))
            # пустые по колонкам
            for j in range(len(cols)):
                ws.write(r, 1 + j, "", wb.add_format({}))
            r += 1
            continue

        if kind == "base":
            ws.write(r, 0, row.get("label", "База"), fmt_sub)
            base = row.get("base", {}) or {}
            for j, c in enumerate(cols):
                v = base.get(c.get("key", ""), "")
                ws.write(r, 1 + j, v if v != "" else "", fmt_base)
            r += 1
            continue

        ws.write(r, 0, row.get("label", ""), fmt_text)
        cells = row.get("cells", {}) or {}
        for j, c in enumerate(cols):
            ck = c.get("key", "")
            cell = cells.get(ck) or {"value": float("nan"), "sig": ""}
            ws.write(r, 1 + j, _fmt_cell(kind, cell), fmt_text)
        r += 1

    ws.set_column(0, 0, 48)
    ws.set_column(1, 1 + len(cols), 18)
    ws.freeze_panes(start_row + 1, 1)
    wb.close()
    return output.getvalue()

