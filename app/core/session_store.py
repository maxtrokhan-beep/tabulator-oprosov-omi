from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

SESSION_COOKIE = "mvp_tabulator_sid"


@dataclass
class _SessionStore:
    """
    Простейшее хранилище "в памяти процесса".
    Для MVP этого достаточно: файл живет в рамках одной сессии браузера.
    """

    ttl_seconds: int = 60 * 60 * 6  # 6 часов
    _data: dict[str, dict[str, Any]] = field(default_factory=dict)
    _updated_at: dict[str, float] = field(default_factory=dict)

    def get(self, sid: str) -> Optional[dict[str, Any]]:
        self._gc()
        return self._data.get(sid)

    def set(self, sid: str, value: dict[str, Any]) -> None:
        self._data[sid] = value
        self._updated_at[sid] = time.time()

    def patch(self, sid: str, patch: dict[str, Any]) -> None:
        cur = self._data.get(sid)
        if not cur:
            self.set(sid, patch)
            return
        cur.update(patch)
        self._updated_at[sid] = time.time()

    def _gc(self) -> None:
        now = time.time()
        dead = [sid for sid, ts in self._updated_at.items() if now - ts > self.ttl_seconds]
        for sid in dead:
            self._data.pop(sid, None)
            self._updated_at.pop(sid, None)


store = _SessionStore()
