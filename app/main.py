"""کارنامه — ثبت کارهای روزانه با تگ و تایپ صوتی آوانگار، و خروجی گزارش هر تگ."""

import re
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import avanegar, db

STATIC = Path(__file__).resolve().parents[1] / "static"
DAY = r"^\d{4}-\d{2}-\d{2}$"
MAX_AUDIO = 30 * 1024 * 1024

app = FastAPI(title="کارنامه")
db.init()


@app.middleware("http")
async def local_only(request: Request, call_next):
    # The app has no login; refuse anything that is not this machine.
    host = request.client.host if request.client else ""
    if host not in ("127.0.0.1", "::1", "testclient"):
        return JSONResponse({"detail": "فقط از همین دستگاه"}, status_code=403)
    if request.method not in ("GET", "HEAD"):
        origin = request.headers.get("origin")
        if origin and not re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin):
            return JSONResponse({"detail": "مبدأ نامعتبر"}, status_code=403)
    return await call_next(request)


# ---------- tags ----------

class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = Field(default="#1d6d5a", pattern=r"^#[0-9a-fA-F]{6}$")


class TagPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    archived: Optional[bool] = None


def tag_rows(c):
    return [
        dict(r)
        for r in c.execute(
            "SELECT t.*, (SELECT COUNT(*) FROM entry_tags et WHERE et.tag_id=t.id) AS uses "
            "FROM tags t ORDER BY t.archived, t.name"
        )
    ]


@app.get("/api/tags")
def list_tags():
    with db.conn() as c:
        return tag_rows(c)


@app.post("/api/tags")
def create_tag(tag: TagIn):
    name = tag.name.strip()
    if not name:
        raise HTTPException(422, "نام تگ خالی است")
    with db.conn() as c:
        if c.execute("SELECT 1 FROM tags WHERE name=?", (name,)).fetchone():
            raise HTTPException(409, "این تگ از قبل وجود دارد")
        cur = c.execute(
            "INSERT INTO tags(name,color,created_at) VALUES(?,?,?)", (name, tag.color, db.now())
        )
        return dict(c.execute("SELECT * FROM tags WHERE id=?", (cur.lastrowid,)).fetchone())


@app.patch("/api/tags/{tag_id}")
def update_tag(tag_id: int, patch: TagPatch):
    with db.conn() as c:
        if not c.execute("SELECT 1 FROM tags WHERE id=?", (tag_id,)).fetchone():
            raise HTTPException(404, "تگ پیدا نشد")
        if patch.name is not None:
            name = patch.name.strip()
            if c.execute("SELECT 1 FROM tags WHERE name=? AND id<>?", (name, tag_id)).fetchone():
                raise HTTPException(409, "این نام تکراری است")
            c.execute("UPDATE tags SET name=? WHERE id=?", (name, tag_id))
        if patch.color is not None:
            c.execute("UPDATE tags SET color=? WHERE id=?", (patch.color, tag_id))
        if patch.archived is not None:
            c.execute("UPDATE tags SET archived=? WHERE id=?", (int(patch.archived), tag_id))
        return dict(c.execute("SELECT * FROM tags WHERE id=?", (tag_id,)).fetchone())


@app.delete("/api/tags/{tag_id}")
def delete_tag(tag_id: int):
    with db.conn() as c:
        c.execute("DELETE FROM tags WHERE id=?", (tag_id,))
    return {"ok": True}


# ---------- entries ----------

class EntryIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    day: Optional[str] = Field(default=None, pattern=DAY)
    minutes: Optional[int] = Field(default=None, ge=0, le=24 * 60)
    tag_ids: list[int] = []
    source: str = Field(default="text", pattern=r"^(text|voice)$")


class EntryPatch(BaseModel):
    text: Optional[str] = Field(default=None, min_length=1, max_length=20000)
    day: Optional[str] = Field(default=None, pattern=DAY)
    minutes: Optional[int] = Field(default=None, ge=0, le=24 * 60)
    clear_minutes: bool = False
    tag_ids: Optional[list[int]] = None


def set_tags(c, entry_id, tag_ids):
    valid = {r["id"] for r in c.execute("SELECT id FROM tags")}
    c.execute("DELETE FROM entry_tags WHERE entry_id=?", (entry_id,))
    c.executemany(
        "INSERT INTO entry_tags(entry_id,tag_id) VALUES(?,?)",
        [(entry_id, t) for t in dict.fromkeys(tag_ids) if t in valid],
    )


def entry_rows(c, where="", args=()):
    rows = [dict(r) for r in c.execute(f"SELECT * FROM entries {where} ORDER BY day, created_at, id", args)]
    tags = {}
    for r in c.execute("SELECT entry_id, tag_id FROM entry_tags"):
        tags.setdefault(r["entry_id"], []).append(r["tag_id"])
    for r in rows:
        r["tag_ids"] = tags.get(r["id"], [])
    return rows


@app.get("/api/entries")
def list_entries(start: str, end: Optional[str] = None):
    for d in (start, end or start):
        if not re.match(DAY, d):
            raise HTTPException(422, "تاریخ نامعتبر")
    with db.conn() as c:
        return entry_rows(c, "WHERE day BETWEEN ? AND ?", (start, end or start))


@app.post("/api/entries")
def create_entry(entry: EntryIn):
    text = entry.text.strip()
    if not text:
        raise HTTPException(422, "متن خالی است")
    stamp = db.now()
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO entries(text,day,minutes,source,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (text, entry.day or date.today().isoformat(), entry.minutes, entry.source, stamp, stamp),
        )
        set_tags(c, cur.lastrowid, entry.tag_ids)
        return entry_rows(c, "WHERE id=?", (cur.lastrowid,))[0]


@app.patch("/api/entries/{entry_id}")
def update_entry(entry_id: int, patch: EntryPatch):
    with db.conn() as c:
        if not c.execute("SELECT 1 FROM entries WHERE id=?", (entry_id,)).fetchone():
            raise HTTPException(404, "کار پیدا نشد")
        if patch.text is not None:
            if not patch.text.strip():
                raise HTTPException(422, "متن خالی است")
            c.execute("UPDATE entries SET text=? WHERE id=?", (patch.text.strip(), entry_id))
        if patch.day is not None:
            c.execute("UPDATE entries SET day=? WHERE id=?", (patch.day, entry_id))
        if patch.clear_minutes:
            c.execute("UPDATE entries SET minutes=NULL WHERE id=?", (entry_id,))
        elif patch.minutes is not None:
            c.execute("UPDATE entries SET minutes=? WHERE id=?", (patch.minutes, entry_id))
        if patch.tag_ids is not None:
            set_tags(c, entry_id, patch.tag_ids)
        c.execute("UPDATE entries SET updated_at=? WHERE id=?", (db.now(), entry_id))
        return entry_rows(c, "WHERE id=?", (entry_id,))[0]


@app.delete("/api/entries/{entry_id}")
def delete_entry(entry_id: int):
    with db.conn() as c:
        c.execute("DELETE FROM entries WHERE id=?", (entry_id,))
    return {"ok": True}


# ---------- voice ----------

@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    data = await audio.read(MAX_AUDIO + 1)
    if not data:
        raise HTTPException(422, "صوتی ضبط نشد")
    if len(data) > MAX_AUDIO:
        raise HTTPException(413, "فایل صوتی بیش از حد بزرگ است")
    mime = (audio.content_type or "audio/webm").split(";")[0]
    try:
        text = await avanegar.transcribe(data, mime, audio.filename or "voice.webm")
    except avanegar.ProviderError as e:
        raise HTTPException(502, str(e)) from None
    return {"text": text.strip()}


# ---------- settings ----------

class SettingsIn(BaseModel):
    avanegar_token: Optional[str] = Field(default=None, max_length=4000)
    provider_interface: Optional[str] = Field(default=None, pattern=r"^(en[0-9]+)?$")
    report_name: Optional[str] = Field(default=None, max_length=120)


@app.get("/api/settings")
def get_settings():
    return {
        "has_avanegar_token": bool(db.avanegar_token()),
        "provider_interface": db.setting("provider_interface", ""),
        "report_name": db.setting("report_name", ""),
    }


@app.put("/api/settings")
def put_settings(data: SettingsIn):
    if data.avanegar_token is not None and data.avanegar_token.strip():
        db.set_setting("avanegar_token", data.avanegar_token.strip())
    if data.provider_interface is not None:
        db.set_setting("provider_interface", data.provider_interface)
    if data.report_name is not None:
        db.set_setting("report_name", data.report_name.strip())
    return get_settings()


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
