from __future__ import annotations

import io
import uuid
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from app.models import ConfigPayload, ExportPayload, TabulatePayload
from app.core.excel_export import build_excel_bytes
from app.core.io import load_survey_file
from app.core.session_store import SESSION_COOKIE, store
from app.core.tabulator import build_metadata, tabulate

app = FastAPI(title="MVP Табулятор опросов", version="0.1.0")


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


app.mount("/static", StaticFiles(directory="app/static"), name="static")


@app.get("/")
def index():
    return FileResponse("app/static/index.html")


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
    return JSONResponse({"ok": True, "result": result})


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
