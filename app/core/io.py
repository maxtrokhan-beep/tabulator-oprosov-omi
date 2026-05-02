from __future__ import annotations

import io
from typing import Tuple

import pandas as pd


def _read_csv_best_effort(buf: bytes) -> pd.DataFrame:
    last_err: Exception | None = None
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return pd.read_csv(io.BytesIO(buf), header=None, encoding=enc)
        except Exception as e:
            last_err = e
    raise last_err or RuntimeError("Не удалось прочитать CSV")


def load_survey_file(raw: bytes, filename: str) -> Tuple[pd.DataFrame, dict[str, str]]:
    """
    Формат входных данных:
    - 1-я строка: технические имена переменных (будут заголовками колонок)
    - 2-я строка: текст вопроса
    - 3-я строка: пустая
    - с 4-й строки: ответы респондентов
    """
    name = (filename or "").lower().strip()
    if name.endswith(".xlsx") or name.endswith(".xlsm") or name.endswith(".xls"):
        raw_df = pd.read_excel(io.BytesIO(raw), header=None, engine="openpyxl")
    elif name.endswith(".csv"):
        raw_df = _read_csv_best_effort(raw)
    else:
        raise ValueError("Поддерживаются только .xlsx/.xlsm/.xls или .csv")

    if raw_df.shape[0] < 4:
        raise ValueError("В файле слишком мало строк. Ожидается минимум 4 строки (2 строки заголовка + пустая + ответы).")

    tech = raw_df.iloc[0].astype(str).tolist()
    qtxt = raw_df.iloc[1].astype(str).tolist()

    # Приводим к безопасным уникальным именам колонок (без NaN/пустых).
    cols: list[str] = []
    seen: dict[str, int] = {}
    for i, v in enumerate(tech):
        base = (v or "").strip()
        if base.lower() in ("nan", ""):
            base = f"VAR_{i+1}"
        if base in seen:
            seen[base] += 1
            base = f"{base}_{seen[base]}"
        else:
            seen[base] = 1
        cols.append(base)

    data = raw_df.iloc[3:].copy()
    data.columns = cols
    data = data.reset_index(drop=True)

    questions: dict[str, str] = {}
    for i, c in enumerate(cols):
        t = qtxt[i] if i < len(qtxt) else ""
        t = "" if t is None else str(t)
        if t.lower() == "nan":
            t = ""
        questions[c] = t.strip()

    return data, questions
