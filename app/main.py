from __future__ import annotations

import io
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.models import ConfigPayload, ExportPayload, TabulatePayload
from app.core.excel_export import build_excel_bytes
from app.core.io import load_survey_file
from app.core.session_store import SESSION_COOKIE, store
from app.core.tabulator import build_metadata, tabulate

app = FastAPI(title="MVP Табулятор опросов", version="0.1.0")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def _json_sanitize(obj: Any) -> Any:
    """
    JSON не допускает NaN/Inf. В расчётах numpy/pandas часто появляется float('nan'),
    поэтому перед JSONResponse приводим такие значения к null (None).
    """
    if obj is None:
        return None
    if isinstance(obj, float):
        if obj != obj:  # NaN
            return None
        if obj == float("inf") or obj == float("-inf"):
            return None
        return obj
    if isinstance(obj, dict):
        return {str(k): _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_sanitize(v) for v in obj]
    return obj


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"ok": False, "detail": str(exc)})


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    # Гарантируем единый JSON-формат ошибок для фронтенда
    detail = exc.detail if isinstance(exc.detail, str) else "Ошибка запроса"
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "detail": detail})


@app.exception_handler(Exception)
async def any_error_handler(request: Request, exc: Exception):
    # Не светим traceback пользователю, но даем понятную ошибку
    return JSONResponse(status_code=500, content={"ok": False, "detail": f'Внутренняя ошибка сервера: {type(exc).__name__}'})


@app.middleware("http")
async def ensure_session(request: Request, call_next):
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        sid = str(uuid.uuid4())
        response: Response = await call_next(request)
        response.set_cookie(
            key=SESSION_COOKIE,
            value=sid,
            httponly=True,
            samesite="lax",
        )
        return response
    return await call_next(request)


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


def _sid(request: Request) -> str:
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        raise HTTPException(status_code=400, detail="Нет сессии. Обновите страницу.")
    return sid


@app.post("/api/upload")
async def upload(request: Request, file: UploadFile = File(...)):
    sid = _sid(request)
    try:
        raw = await file.read()
        df, questions = load_survey_file(raw, file.filename or "upload")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Ошибка чтения файла: {e}") from e

    meta = build_metadata(df=df, questions=questions)
    store.set(sid, {"df": df, "questions": questions, "meta": meta, "config": None})
    return JSONResponse(
        {
            "ok": True,
            "filename": file.filename,
            "has_weight": meta["has_weight"],
            "variables": meta["variables"],
        }
    )


@app.get("/api/metadata")
def metadata(request: Request):
    sid = _sid(request)
    s = store.get(sid)
    if not s:
        raise HTTPException(status_code=400, detail="Сначала загрузите файл.")
    return JSONResponse({"ok": True, "meta": s["meta"], "config": s.get("config")})


@app.post("/api/config")
def save_config(request: Request, payload: ConfigPayload):
    sid = _sid(request)
    s = store.get(sid)
    if not s:
        raise HTTPException(status_code=400, detail="Сначала загрузите файл.")
    store.patch(sid, {"config": payload.model_dump()})
    return JSONResponse({"ok": True})


@app.post("/api/tabulate")
def api_tabulate(request: Request, payload: TabulatePayload):
    sid = _sid(request)
    s = store.get(sid)
    if not s:
        raise HTTPException(status_code=400, detail="Сначала загрузите файл.")
    if not s.get("config"):
        raise HTTPException(status_code=400, detail="Сначала сохраните настройки переменных.")

    result = tabulate(
        df=s["df"],
        questions=s["questions"],
        config=s["config"],
        row_vars=payload.row_vars,
        banner_vars=payload.banner_vars,
        filters=[f.model_dump() for f in (payload.filters or [])],
        weighted=payload.weighted,
        show_sig=payload.show_sig,
    )
    return JSONResponse({"ok": True, "result": _json_sanitize(result)})


@app.post("/api/export")
def api_export(request: Request, payload: ExportPayload):
    sid = _sid(request)
    s = store.get(sid)
    if not s:
        raise HTTPException(status_code=400, detail="Сначала загрузите файл.")
    if not s.get("config"):
        raise HTTPException(status_code=400, detail="Сначала сохраните настройки переменных.")

    result = tabulate(
        df=s["df"],
        questions=s["questions"],
        config=s["config"],
        row_vars=payload.row_vars,
        banner_vars=payload.banner_vars,
        filters=[f.model_dump() for f in (payload.filters or [])],
        weighted=payload.weighted,
        show_sig=payload.show_sig,
    )

    xlsx = build_excel_bytes(result=result, title=payload.title or "Табуляция")
    out = io.BytesIO(xlsx)
    fname = "tabulation.xlsx"
    headers: dict[str, Any] = {
        "Content-Disposition": f'attachment; filename="{fname}"'
    }
    return StreamingResponse(
        out,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )
