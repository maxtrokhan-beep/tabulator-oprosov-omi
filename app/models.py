from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


VarType = Literal["categorical", "scale", "multi", "service"]


class FilterItem(BaseModel):
    var: str
    include: list[Any] = Field(default_factory=list)


class MultiGroup(BaseModel):
    name: str
    question: str = ""
    columns: list[str]


class Top2Rule(BaseModel):
    mode: Literal["top_n", "manual"] = "top_n"
    n: int = 2
    values: list[float] = Field(default_factory=list)


class ConfigPayload(BaseModel):
    var_types: dict[str, VarType] = Field(default_factory=dict)
    scale_maps: dict[str, dict[str, float]] = Field(default_factory=dict)
    top2: dict[str, Top2Rule] = Field(default_factory=dict)
    multi_groups: list[MultiGroup] = Field(default_factory=list)


class TabulatePayload(BaseModel):
    row_vars: list[str] = Field(default_factory=list)
    banner_vars: list[str] = Field(default_factory=list)
    filters: list[FilterItem] = Field(default_factory=list)
    weighted: bool = False
    show_sig: bool = False


class ExportPayload(TabulatePayload):
    title: Optional[str] = None


class ScaleEffectivePayload(BaseModel):
    """Текущие ручные коды шкалы с клиента — вернуть полную карту с автодополнением."""

    var: str
    manual: dict[str, float] = Field(default_factory=dict)
