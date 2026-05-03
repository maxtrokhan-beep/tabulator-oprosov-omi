from __future__ import annotations

import math
from typing import Any, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats


SIG_LEVEL = 0.10  # 90% уровень значимости
MIN_BASE_FOR_TEST = 30


def build_metadata(df: pd.DataFrame, questions: dict[str, str]) -> dict[str, Any]:
    variables: list[dict[str, Any]] = []
    has_weight = False
    for col in df.columns:
        if str(col).strip().lower() == "weight":
            has_weight = True
        ser = df[col]
        uniq = ser.dropna().unique().tolist()
        uniq = [x for x in uniq if str(x).strip().lower() != "nan"]
        # ограничиваем, чтобы UI не "взрывался"
        uniq_preview = uniq[:50]
        variables.append(
            {
                "name": col,
                "question": questions.get(col, ""),
                "unique_values": uniq_preview,
                "unique_count": int(len(uniq)),
            }
        )
    return {"variables": variables, "has_weight": has_weight}


def _normalize_value(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, str):
        s = v.strip()
        if s == "" or s.lower() == "nan":
            return None
        return s
    return v


def _is_selected_mc(v: Any) -> bool:
    """
    Для множественного выбора (несколько колонок-вариантов).
    Считаем "выбрано", если значение не пустое и не является явным "0/Нет/No/False".
    """
    v = _normalize_value(v)
    if v is None:
        return False
    if isinstance(v, (int, np.integer)):
        return int(v) != 0
    if isinstance(v, (float, np.floating)):
        return float(v) != 0.0
    s = str(v).strip().lower()
    if s in ("0", "нет", "no", "false", "f", "n"):
        return False
    return True


def _kish_effective_n(w: np.ndarray) -> float:
    """
    Эффективная база при весах (Kish):
    n_eff = (sum w)^2 / sum(w^2)
    Используем ее в статтестах как аккуратное приближение вместо "сырой" базы.
    """
    sw = float(np.sum(w))
    sw2 = float(np.sum(np.square(w)))
    if sw2 <= 0:
        return 0.0
    return (sw * sw) / sw2


def _slice_mask(df: pd.DataFrame, slice_pairs: list[tuple[str, Any]]) -> pd.Series:
    """Срез по одной или нескольким парам (переменная, значение). Пустой список = вся база."""
    mask = pd.Series(True, index=df.index)
    for var, val in slice_pairs:
        mask &= df[var].apply(_normalize_value) == _normalize_value(val)
    return mask


def _apply_filters(df: pd.DataFrame, filters: list[dict[str, Any]]) -> pd.DataFrame:
    out = df
    for f in filters or []:
        var = f.get("var")
        include = f.get("include", [])
        if not var or var not in out.columns:
            continue
        include_norm = {_normalize_value(x) for x in include}
        out = out[out[var].apply(_normalize_value).isin(include_norm)]
    return out


def _banner_categories(df: pd.DataFrame, var: str) -> list[Any]:
    ser = df[var].apply(_normalize_value)
    cats = ser.dropna().unique().tolist()
    # стабильная сортировка: числа сортируем как числа, остальное как строки
    def key(x: Any):
        if isinstance(x, (int, float, np.integer, np.floating)):
            return (0, float(x))
        return (1, str(x))

    return sorted(cats, key=key)


def _make_segments(df: pd.DataFrame, banner_vars: list[str]) -> list[dict[str, Any]]:
    """
    Колонки баннеров — не вложенные (без декартова произведения):
    сначала «Итого», затем по порядку переменных все категории каждой переменной.
    Каждая такая колонка — срез только по одной баннер‑переменной (и глобальным фильтрам).
    """
    segments: list[dict[str, Any]] = [{"key": "Итого", "label": "Итого", "slice": []}]
    if not banner_vars:
        return segments

    col_idx = 0
    for bvar in banner_vars:
        if bvar not in df.columns:
            continue
        for cat in _banner_categories(df, bvar):
            key = f"col{col_idx}"
            col_idx += 1
            label = f"{bvar}={cat}"
            segments.append({"key": key, "label": label, "slice": [(bvar, cat)]})
    return segments


def _col_letter(i: int) -> str:
    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    if i < len(letters):
        return letters[i]
    # если вдруг колонок больше 26
    return f"X{i+1}"


def _ztest_two_proportions(p1: float, n1: float, p2: float, n2: float) -> float:
    if n1 <= 0 or n2 <= 0:
        return 1.0
    x1 = p1 * n1
    x2 = p2 * n2
    p = (x1 + x2) / (n1 + n2)
    se = math.sqrt(max(p * (1 - p) * (1 / n1 + 1 / n2), 1e-12))
    z = (p1 - p2) / se
    return float(2 * (1 - stats.norm.cdf(abs(z))))


def _ttest_means(m1: float, s1: float, n1: float, m2: float, s2: float, n2: float) -> float:
    if n1 <= 1 or n2 <= 1:
        return 1.0
    res = stats.ttest_ind_from_stats(mean1=m1, std1=s1, nobs1=n1, mean2=m2, std2=s2, nobs2=n2, equal_var=False)
    return float(res.pvalue) if res.pvalue is not None else 1.0


def _weighted_mean_and_std(x: np.ndarray, w: np.ndarray) -> tuple[float, float]:
    if x.size == 0:
        return (float("nan"), float("nan"))
    wsum = float(np.sum(w))
    if wsum <= 0:
        return (float("nan"), float("nan"))
    m = float(np.average(x, weights=w))
    # дисперсия с весами (приближение). Для t-test мы используем n_eff (Kish),
    # поэтому точная формула "unbiased" тут не критична — цель MVP и аккуратное приближение.
    v = float(np.average((x - m) ** 2, weights=w))
    return m, math.sqrt(max(v, 0.0))


def _format_pct(x: float) -> float:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return float("nan")
    return float(x)


def _format_mean(x: float) -> float:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return float("nan")
    return float(x)


def tabulate(
    df: pd.DataFrame,
    questions: dict[str, str],
    config: dict[str, Any],
    row_vars: list[str],
    banner_vars: list[str],
    filters: list[dict[str, Any]],
    weighted: bool,
    show_sig: bool,
) -> dict[str, Any]:
    df0 = _apply_filters(df, filters)

    var_types: dict[str, str] = config.get("var_types", {}) or {}
    scale_maps: dict[str, dict[str, float]] = config.get("scale_maps", {}) or {}
    top2: dict[str, Any] = config.get("top2", {}) or {}
    multi_groups: list[dict[str, Any]] = config.get("multi_groups", []) or []

    weight_var = None
    if "weight" in df0.columns:
        weight_var = "weight"

    if weighted and not weight_var:
        raise ValueError("Взвешивание недоступно: переменная weight не найдена.")

    segments = _make_segments(df0, banner_vars)
    # буквы только для "реальных" баннер-колонок (без Итого)
    seg_letters: dict[str, str] = {}
    letter_idx = 0
    for seg in segments:
        if seg["key"] == "Итого":
            continue
        seg_letters[seg["key"]] = _col_letter(letter_idx)
        letter_idx += 1

    # helper: подвыборка по slice сегмента
    def get_seg_df(seg: dict[str, Any]) -> pd.DataFrame:
        slice_pairs: list[tuple[str, Any]] = seg.get("slice") or []
        if not slice_pairs:
            return df0
        return df0[_slice_mask(df0, slice_pairs)]

    # готовим "вопросы-строки": обычные переменные + группы множественного выбора как псевдо-переменные
    mc_by_name: dict[str, dict[str, Any]] = {g["name"]: g for g in multi_groups if g.get("name")}

    output_rows: list[dict[str, Any]] = []

    def add_row(row: dict[str, Any]) -> None:
        output_rows.append(row)

    for rv in row_vars:
        if rv in mc_by_name:
            g = mc_by_name[rv]
            q = g.get("question") or questions.get(rv, "") or f"Множественный выбор: {rv}"
            cols = [c for c in g.get("columns", []) if c in df0.columns]
            if not cols:
                continue

            # варианты = названия колонок (для MVP)
            options = cols
            # base по сегменту: все респонденты в сегменте (после фильтров)
            base_by_seg: dict[str, float] = {}
            val_by_opt: dict[str, dict[str, Any]] = {opt: {} for opt in options}

            for seg in segments:
                sdf = get_seg_df(seg)
                if weighted:
                    w = sdf[weight_var].fillna(0).to_numpy(dtype=float)
                    base = float(np.sum(w))
                    # для доли выбранных: sum(w * selected) / sum(w)
                    denom = base if base > 0 else float("nan")
                    for opt in options:
                        sel = sdf[opt].apply(_is_selected_mc).to_numpy(dtype=float)
                        num = float(np.sum(w * sel))
                        p = (num / denom) if denom and denom > 0 else float("nan")
                        val_by_opt[opt][seg["key"]] = {"value": _format_pct(p), "sig": ""}
                else:
                    base = float(len(sdf))
                    denom = base if base > 0 else float("nan")
                    for opt in options:
                        sel = sdf[opt].apply(_is_selected_mc).to_numpy(dtype=float)
                        num = float(np.sum(sel))
                        p = (num / denom) if denom and denom > 0 else float("nan")
                        val_by_opt[opt][seg["key"]] = {"value": _format_pct(p), "sig": ""}
                base_by_seg[seg["key"]] = base

            add_row({"kind": "header", "label": f"{rv}. {q}"})
            for opt in options:
                add_row(
                    {
                        "kind": "pct",
                        "label": f"— {opt}",
                        "cells": {k: val_by_opt[opt][k] for k in val_by_opt[opt].keys()},
                    }
                )
            add_row({"kind": "base", "label": "База (респондентов)", "base": base_by_seg})
            continue

        if rv not in df0.columns:
            continue

        vtype = var_types.get(rv)
        if not vtype:
            # дефолт: categorical
            vtype = "categorical"

        if vtype == "service":
            continue

        q = questions.get(rv, "")
        add_row({"kind": "header", "label": f"{rv}. {q}" if q else rv})

        if vtype == "categorical":
            # варианты = уникальные значения
            levels = df0[rv].apply(_normalize_value).dropna().unique().tolist()
            # стабильная сортировка
            def key(x: Any):
                if isinstance(x, (int, float, np.integer, np.floating)):
                    return (0, float(x))
                return (1, str(x))

            levels = sorted(levels, key=key)

            # база ответивших = non-missing по вопросу
            base_by_seg: dict[str, float] = {}
            # соберем counts/props по уровню
            props: dict[Any, dict[str, Any]] = {lvl: {} for lvl in levels}
            effn_by_seg: dict[str, float] = {}

            for seg in segments:
                sdf = get_seg_df(seg)
                ser = sdf[rv].apply(_normalize_value)
                answered = ser.notna()
                sdf_a = sdf[answered]
                ser_a = ser[answered]

                if weighted:
                    w = sdf_a[weight_var].fillna(0).to_numpy(dtype=float)
                    denom = float(np.sum(w))
                    base = denom
                    effn = _kish_effective_n(w)
                    effn_by_seg[seg["key"]] = effn
                    for lvl in levels:
                        m = (ser_a == lvl).to_numpy(dtype=bool)
                        num = float(np.sum(w[m]))
                        p = (num / denom) if denom > 0 else float("nan")
                        props[lvl][seg["key"]] = {"value": _format_pct(p), "sig": ""}
                else:
                    base = float(len(sdf_a))
                    effn = base
                    effn_by_seg[seg["key"]] = effn
                    denom = base
                    for lvl in levels:
                        num = float(np.sum((ser_a == lvl).to_numpy(dtype=float)))
                        p = (num / denom) if denom > 0 else float("nan")
                        props[lvl][seg["key"]] = {"value": _format_pct(p), "sig": ""}

                base_by_seg[seg["key"]] = base

            # статзначимость: z-test по каждому уровню (процент) между баннер-колонками
            if show_sig and len(segments) > 2:
                real_seg_keys = [s["key"] for s in segments if s["key"] != "Итого"]
                for lvl in levels:
                    # сравниваем p_i vs p_j, если база (эффективная) >= 30
                    for i, ki in enumerate(real_seg_keys):
                        pi = props[lvl][ki]["value"]
                        ni = effn_by_seg.get(ki, 0.0)
                        if not (isinstance(pi, float) and not math.isnan(pi)) or ni < MIN_BASE_FOR_TEST:
                            continue
                        sig_letters: list[str] = []
                        for j, kj in enumerate(real_seg_keys):
                            if i == j:
                                continue
                            pj = props[lvl][kj]["value"]
                            nj = effn_by_seg.get(kj, 0.0)
                            if not (isinstance(pj, float) and not math.isnan(pj)) or nj < MIN_BASE_FOR_TEST:
                                continue
                            pval = _ztest_two_proportions(pi, ni, pj, nj)
                            # индекс показываем на "более высоком" значении
                            if pval < SIG_LEVEL and pi > pj:
                                sig_letters.append(seg_letters.get(kj, "?"))
                        props[lvl][ki]["sig"] = "".join(sorted(set(sig_letters)))

            for lvl in levels:
                add_row(
                    {
                        "kind": "pct",
                        "label": f"— {lvl}",
                        "cells": {k: props[lvl][k] for k in props[lvl].keys()},
                    }
                )
            add_row({"kind": "base", "label": "База ответивших", "base": base_by_seg})

        elif vtype == "scale":
            # MVP-упрощение по запросу:
            # - модального окна "Шкала" нет
            # - Top-2 box всегда считаем как коды 4 и 5
            #
            # Дополнительно: если в данных шкала хранится текстовыми лейблами,
            # автоматически кодируем их в 1..K по сортированному списку уникальных лейблов.
            #
            # Важно: если в шкале меньше 5 пунктов, Top-2 по (4,5) может быть пустым — это ожидаемо.

            # Маппинг лейбл->код из UI игнорируем (окно убрали), но оставляем обратную совместимость:
            smap = scale_maps.get(rv, {}) or {}

            # Подготовим авто-маппинг для строковых значений
            ser_norm = df0[rv].apply(_normalize_value)
            labels = [x for x in ser_norm.dropna().unique().tolist() if not isinstance(x, (int, float, np.integer, np.floating))]

            def _label_key(x: Any):
                return str(x)

            labels_sorted = sorted([str(x) for x in labels], key=_label_key)
            auto_map = {lab: float(i + 1) for i, lab in enumerate(labels_sorted)}

            def to_code(v: Any) -> Optional[float]:
                v = _normalize_value(v)
                if v is None:
                    return None
                if isinstance(v, (int, float, np.integer, np.floating)):
                    return float(v)
                s = str(v).strip()
                if s in smap:
                    return float(smap[s])
                if s in auto_map:
                    return float(auto_map[s])
                # если маппинг не задан, пробуем парсить число
                try:
                    return float(s.replace(",", "."))
                except Exception:
                    return None

            # уровни распределения берем по коду, но подпись — исходный лейбл, если есть
            codes_series = df0[rv].apply(to_code)
            codes = codes_series.dropna().unique().tolist()
            codes = sorted([float(x) for x in codes])

            # для распределения делаем строки по каждому коду
            base_by_seg: dict[str, float] = {}
            effn_by_seg: dict[str, float] = {}
            dist: dict[float, dict[str, Any]] = {c: {} for c in codes}
            top2_row: dict[str, Any] = {}
            mean_row: dict[str, Any] = {}
            mean_stats: dict[str, tuple[float, float, float]] = {}  # key -> (mean, std, n_eff)

            for seg in segments:
                sdf = get_seg_df(seg)
                sc = sdf[rv].apply(to_code)
                answered = sc.notna()
                sdf_a = sdf[answered]
                sc_a = sc[answered].astype(float)

                if weighted:
                    w = sdf_a[weight_var].fillna(0).to_numpy(dtype=float)
                    denom = float(np.sum(w))
                    base = denom
                    effn = _kish_effective_n(w)
                    effn_by_seg[seg["key"]] = effn
                    for c in codes:
                        m = (sc_a == c).to_numpy(dtype=bool)
                        num = float(np.sum(w[m]))
                        p = (num / denom) if denom > 0 else float("nan")
                        dist[c][seg["key"]] = {"value": _format_pct(p), "sig": ""}

                    x = sc_a.to_numpy(dtype=float)
                    m, sd = _weighted_mean_and_std(x, w)
                    mean_row[seg["key"]] = {"value": _format_mean(m), "sig": ""}
                    mean_stats[seg["key"]] = (m, sd, effn)

                    # Top-2 = коды 4 и 5 (по запросу)
                    top_set = {4.0, 5.0}
                    sel = np.isin(x, list(top_set)).astype(float)
                    num = float(np.sum(w * sel))
                    p_top = (num / denom) if denom > 0 else float("nan")
                    top2_row[seg["key"]] = {"value": _format_pct(p_top), "sig": ""}
                else:
                    base = float(len(sdf_a))
                    effn = base
                    effn_by_seg[seg["key"]] = effn
                    denom = base
                    for c in codes:
                        num = float(np.sum((sc_a == c).to_numpy(dtype=float)))
                        p = (num / denom) if denom > 0 else float("nan")
                        dist[c][seg["key"]] = {"value": _format_pct(p), "sig": ""}

                    x = sc_a.to_numpy(dtype=float)
                    m = float(np.mean(x)) if x.size else float("nan")
                    sd = float(np.std(x, ddof=1)) if x.size > 1 else float("nan")
                    mean_row[seg["key"]] = {"value": _format_mean(m), "sig": ""}
                    mean_stats[seg["key"]] = (m, sd, effn)

                    top_set = {4.0, 5.0}
                    sel = np.isin(x, list(top_set)).astype(float)
                    p_top = float(np.mean(sel)) if sel.size else float("nan")
                    top2_row[seg["key"]] = {"value": _format_pct(p_top), "sig": ""}

                base_by_seg[seg["key"]] = base

            # сиги:
            if show_sig and len(segments) > 2:
                real_seg_keys = [s["key"] for s in segments if s["key"] != "Итого"]

                # распределение (проценты)
                for c in codes:
                    for i, ki in enumerate(real_seg_keys):
                        pi = dist[c][ki]["value"]
                        ni = effn_by_seg.get(ki, 0.0)
                        if not (isinstance(pi, float) and not math.isnan(pi)) or ni < MIN_BASE_FOR_TEST:
                            continue
                        sig_letters: list[str] = []
                        for j, kj in enumerate(real_seg_keys):
                            if i == j:
                                continue
                            pj = dist[c][kj]["value"]
                            nj = effn_by_seg.get(kj, 0.0)
                            if not (isinstance(pj, float) and not math.isnan(pj)) or nj < MIN_BASE_FOR_TEST:
                                continue
                            pval = _ztest_two_proportions(pi, ni, pj, nj)
                            if pval < SIG_LEVEL and pi > pj:
                                sig_letters.append(seg_letters.get(kj, "?"))
                        dist[c][ki]["sig"] = "".join(sorted(set(sig_letters)))

                # Top-2 (проценты)
                for i, ki in enumerate(real_seg_keys):
                    pi = top2_row[ki]["value"]
                    ni = effn_by_seg.get(ki, 0.0)
                    if not (isinstance(pi, float) and not math.isnan(pi)) or ni < MIN_BASE_FOR_TEST:
                        continue
                    sig_letters: list[str] = []
                    for j, kj in enumerate(real_seg_keys):
                        if i == j:
                            continue
                        pj = top2_row[kj]["value"]
                        nj = effn_by_seg.get(kj, 0.0)
                        if not (isinstance(pj, float) and not math.isnan(pj)) or nj < MIN_BASE_FOR_TEST:
                            continue
                        pval = _ztest_two_proportions(pi, ni, pj, nj)
                        if pval < SIG_LEVEL and pi > pj:
                            sig_letters.append(seg_letters.get(kj, "?"))
                    top2_row[ki]["sig"] = "".join(sorted(set(sig_letters)))

                # средние (t-test)
                for i, ki in enumerate(real_seg_keys):
                    m1, s1, n1 = mean_stats.get(ki, (float("nan"), float("nan"), 0.0))
                    if n1 < MIN_BASE_FOR_TEST or math.isnan(m1) or math.isnan(s1):
                        continue
                    sig_letters: list[str] = []
                    for j, kj in enumerate(real_seg_keys):
                        if i == j:
                            continue
                        m2, s2, n2 = mean_stats.get(kj, (float("nan"), float("nan"), 0.0))
                        if n2 < MIN_BASE_FOR_TEST or math.isnan(m2) or math.isnan(s2):
                            continue
                        pval = _ttest_means(m1, s1, n1, m2, s2, n2)
                        if pval < SIG_LEVEL and m1 > m2:
                            sig_letters.append(seg_letters.get(kj, "?"))
                    mean_row[ki]["sig"] = "".join(sorted(set(sig_letters)))

            # вывод
            for c in codes:
                add_row(
                    {
                        "kind": "pct",
                        "label": f"— {int(c) if float(c).is_integer() else c}",
                        "cells": {k: dist[c][k] for k in dist[c].keys()},
                    }
                )
            add_row({"kind": "pct", "label": "Top-2 box", "cells": top2_row})
            add_row({"kind": "mean", "label": "Среднее", "cells": mean_row})
            add_row({"kind": "base", "label": "База ответивших", "base": base_by_seg})

        else:
            # неизвестный тип — игнор
            continue

    return {
        "meta": {
            "weighted": weighted,
            "show_sig": show_sig,
            "banner_vars": banner_vars,
            "row_vars": row_vars,
            "filters": filters,
            "sig_level": SIG_LEVEL,
            "min_base_for_test": MIN_BASE_FOR_TEST,
            "note": (
                "Для взвешенных статтестов используется эффективная база Kish: n_eff=(sum w)^2/sum(w^2) "
                "как аккуратное приближение. При базе < 30 тесты не считаются."
            ),
        },
        "columns": [
            {
                "key": s["key"],
                "label": s["label"],
                "letter": seg_letters.get(s["key"], ""),
            }
            for s in segments
        ],
        "rows": output_rows,
    }

