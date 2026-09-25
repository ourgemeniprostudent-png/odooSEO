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
    assert s == {"has_avanegar_token": True, "provider_interface": "", "report_name": "من"}
    # empty token does not wipe the saved one
    assert client.put("/api/settings", json={"avanegar_token": ""}).json()["has_avanegar_token"]


def test_rejects_foreign_origin(client):
    r = client.post("/api/tags", json={"name": "x"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_transcribe_without_token(client):
    r = client.post("/api/transcribe", files={"audio": ("v.webm", b"123", "audio/webm")})
    assert r.status_code == 502 and "توکن" in r.json()["detail"]


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
    assert r.json() == {"text": "امروز سایت را به‌روز کردم"}
    assert calls[0][2] == {"gateway-token": "tok"} and calls[1][1].endswith("getResult")


def test_extract_speech_shapes():
    from app.avanegar import extract_speech, ProviderError
    assert extract_speech({"data": {"text": "سلام"}}) == "سلام"
    assert extract_speech([{"text": "الف"}, {"text": "ب"}]) == "الف ب"
    with pytest.raises(ProviderError):
        extract_speech({"data": {"status": "pending"}})
