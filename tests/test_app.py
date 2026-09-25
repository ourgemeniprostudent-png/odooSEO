import asyncio
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("KARNAMA_DATA", str(tmp_path))
    monkeypatch.delenv("AVANEGAR_TOKEN", raising=False)
    from app import db, main
    importlib.reload(db)
    importlib.reload(main)
    return TestClient(main.app)


def test_tags_and_entries_flow(client):
    t1 = client.post("/api/tags", json={"name": "فراتر"}).json()
    t2 = client.post("/api/tags", json={"name": "شخصی", "color": "#2f5fb3"}).json()
    assert client.post("/api/tags", json={"name": "فراتر"}).status_code == 409

    e = client.post("/api/entries", json={"text": " جلسه با مشتری ", "day": "2026-09-25",
                                          "minutes": 45, "tag_ids": [t1["id"], 999]}).json()
    assert e["text"] == "جلسه با مشتری" and e["tag_ids"] == [t1["id"]]
    client.post("/api/entries", json={"text": "بدون تگ", "day": "2026-09-25"})
    client.post("/api/entries", json={"text": "روز بعد", "day": "2026-09-26", "tag_ids": [t2["id"]]})

    day = client.get("/api/entries", params={"start": "2026-09-25"}).json()
    assert [x["text"] for x in day] == ["جلسه با مشتری", "بدون تگ"]
    both = client.get("/api/entries", params={"start": "2026-09-25", "end": "2026-09-26"}).json()
    assert len(both) == 3

    # tag later, clear duration, edit text
    untagged = day[1]
    r = client.patch(f"/api/entries/{untagged['id']}", json={"tag_ids": [t2["id"]], "text": "ویرایش"}).json()
    assert r["tag_ids"] == [t2["id"]] and r["text"] == "ویرایش"
    r = client.patch(f"/api/entries/{e['id']}", json={"clear_minutes": True}).json()
    assert r["minutes"] is None

    # deleting a tag keeps entries
    client.delete(f"/api/tags/{t1['id']}")
    after = client.get("/api/entries", params={"start": "2026-09-25"}).json()
    assert after[0]["tag_ids"] == []
    assert client.get("/api/entries", params={"start": "bad"}).status_code == 422


def test_settings_hide_token(client):
    assert client.get("/api/settings").json()["has_avanegar_token"] is False
    s = client.put("/api/settings", json={"avanegar_token": "abc", "report_name": "من"}).json()
    assert s["has_avanegar_token"] is True and s["report_name"] == "من" and s["has_gapgpt_key"] is False
    # empty token does not wipe the saved one
    assert client.put("/api/settings", json={"avanegar_token": ""}).json()["has_avanegar_token"]


def test_rejects_foreign_origin(client):
    r = client.post("/api/tags", json={"name": "x"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_transcribe_without_token(client):
    r = client.post("/api/transcribe", files={"audio": ("v.webm", b"123", "audio/webm")})
    detail = r.json()["detail"]
    assert r.status_code == 502 and "توکن" in detail["message"]
    # the recording is kept so it can be retried or played back
    assert (db_module().audio_dir() / detail["audio"]).is_file()


def test_transcribe_polls_avanegar(client, monkeypatch):
    from app import avanegar, db
    db.set_setting("avanegar_token", "tok")
    calls = []

    async def fake_request(method, url, **kw):
        calls.append((method, url, kw.get("headers")))
        if method == "POST":
            return {"data": {"status": "processing", "data": {"id": "j1"}}}
        return {"data": {"aiResponse": {"result": {"text": "امروز سایت را به‌روز کردم"}}}}

    async def no_sleep(_):
        return None

    monkeypatch.setattr(avanegar, "request", fake_request)
    monkeypatch.setattr(avanegar, "to_mp3", lambda d: None)
    monkeypatch.setattr(avanegar.asyncio, "sleep", no_sleep)
    r = client.post("/api/transcribe", files={"audio": ("v.webm", b"123", "audio/webm")})
    body = r.json()
    assert body["text"] == "امروز سایت را به‌روز کردم"
    assert client.get(f"/api/audio/{body['audio']}").content == b"123"
    e = client.post("/api/entries", json={"text": body["text"], "audio": [body["audio"], "../x.webm"]}).json()
    assert e["audio"] == [body["audio"]]
    client.delete(f"/api/entries/{e['id']}")
    assert client.get(f"/api/audio/{body['audio']}").status_code == 404
    assert calls[0][2] == {"gateway-token": "tok"} and calls[1][1].endswith("getResult")


def db_module():
    from app import db
    return db


def test_todo_lifecycle_and_day_view(client):
    from datetime import date, timedelta
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    t = client.post("/api/tags", json={"name": "فراتر"}).json()
    old = client.post("/api/entries", json={"text": "تسک دیروز", "kind": "todo", "day": yesterday}).json()
    new = client.post("/api/entries", json={"text": "تسک امروز", "kind": "todo", "day": today,
                                            "tag_ids": [t["id"]]}).json()
    client.post("/api/entries", json={"text": "کار انجام‌شده", "day": today})

    d = client.get(f"/api/day/{today}").json()
    assert [e["text"] for e in d["done"]] == ["کار انجام‌شده"]
    assert [e["text"] for e in d["todo"]] == ["تسک امروز"]
    assert [e["text"] for e in d["carried"]] == ["تسک دیروز"]
    # past days do not carry anything
    assert client.get(f"/api/day/{yesterday}").json()["carried"] == []

    done = client.patch(f"/api/entries/{old['id']}", json={"kind": "done", "day": today}).json()
    assert done["kind"] == "done" and done["day"] == today and done["planned_day"] == yesterday
    d = client.get(f"/api/day/{today}").json()
    assert len(d["done"]) == 2 and d["carried"] == []

    back = client.patch(f"/api/entries/{old['id']}", json={"kind": "todo"}).json()
    assert back["kind"] == "todo" and back["day"] == yesterday

    cal = client.get("/api/calendar", params={"start": yesterday, "end": today}).json()
    assert cal[today] == {"done": 1, "todo": 1} and cal[yesterday] == {"done": 0, "todo": 1}
    assert len(client.get("/api/entries", params={"start": yesterday, "end": today, "kind": "todo"}).json()) == 2
    assert new["planned_day"] == today


def test_day_summary(client, monkeypatch):
    from app import avanegar, db
    today = "2026-09-25"
    client.post("/api/entries", json={"text": "طراحی صفحه", "day": today, "minutes": 30})
    assert client.post(f"/api/day/{today}/summary").status_code == 502  # no key yet
    db.set_setting("gapgpt_key", "k")
    seen = {}

    async def fake_request(method, url, **kw):
        seen.update(url=url, body=kw["json"])
        return {"choices": [{"message": {"content": "امروز روی طراحی صفحه کار شد."}}]}

    monkeypatch.setattr(avanegar, "request", fake_request)
    s = client.post(f"/api/day/{today}/summary").json()
    assert s["text"] == "امروز روی طراحی صفحه کار شد." and s["stale"] is False
    assert "طراحی صفحه" in seen["body"]["messages"][1]["content"]
    client.post("/api/entries", json={"text": "کار دیگر", "day": today})
    assert client.get(f"/api/day/{today}").json()["summary"]["stale"] is True


def test_migrates_old_database(tmp_path, monkeypatch):
    import sqlite3
    old = sqlite3.connect(tmp_path / "karnama.sqlite")
    old.executescript("""CREATE TABLE entries (id INTEGER PRIMARY KEY, text TEXT NOT NULL, day TEXT NOT NULL,
        minutes INTEGER, source TEXT NOT NULL DEFAULT 'text', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        INSERT INTO entries(text,day,created_at,updated_at) VALUES('قدیمی','2026-09-25','2026-09-25T10:00:00','x');""")
    old.commit(); old.close()
    monkeypatch.setenv("KARNAMA_DATA", str(tmp_path))
    from app import db, main
    importlib.reload(db)
    importlib.reload(main)
    c = TestClient(main.app)
    d = c.get("/api/day/2026-09-25").json()
    assert d["done"][0]["text"] == "قدیمی" and d["done"][0]["audio"] == []


def test_extract_speech_shapes():
    from app.avanegar import extract_speech, ProviderError
    assert extract_speech({"data": {"text": "سلام"}}) == "سلام"
    assert extract_speech([{"text": "الف"}, {"text": "ب"}]) == "الف ب"
    with pytest.raises(ProviderError):
        extract_speech({"data": {"status": "pending"}})
