"""Avanegar (Part AI) speech-to-text, adapted from payamyar's providers.transcribe."""

import asyncio
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import httpx

from . import db, service_network

REQUEST_URL = "https://partai.gw.isahab.ir/avanegar/v2/avanegar/request"
RESULT_URL = "https://partai.gw.isahab.ir/avanegar/v2/avanegar-large/getResult"


class ProviderError(ValueError):
    pass


class ProviderHTTPError(ProviderError):
    def __init__(self, status):
        self.status_code = status
        super().__init__(
            {
                401: "کلید/توکن سرویس معتبر نیست.",
                402: "اعتبار سرویس کافی نیست.",
                403: "دسترسی سرویس رد شد.",
                429: "سرویس موقتاً به محدودیت درخواست رسیده است.",
            }.get(status, f"سرویس پاسخ موفق نداد (HTTP {status}).")
        )


class AudioDurationError(ProviderHTTPError):
    def __init__(self):
        super().__init__(400)
        self.args = ("آوانگار مدت این صوت را نپذیرفت؛ باید به بخش‌های کوتاه‌تر تقسیم شود.",)


def duration_rejected(response):
    try:
        checks = response.json()["data"]["additionalInfo"]["additionalInfo"]["validationResults"]
        return any(x.get("field") == "duration" and x.get("passed") is False for x in checks)
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


async def request(method, url, **kwargs):
    for attempt in range(3):
        try:
            interface = service_network.interface_for(url)
            if interface:
                r = await service_network.direct_request(method, url, interface, **kwargs)
            else:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(180, connect=15), follow_redirects=False
                ) as c:
                    r = await c.request(method, url, **kwargs)
            if r.status_code >= 300:
                if r.status_code == 400 and "avanegar" in url and duration_rejected(r):
                    raise AudioDurationError()
                if r.status_code in (408, 429, 500, 502, 503, 504) and attempt < 2:
                    await asyncio.sleep(2**attempt)
                    continue
                raise ProviderHTTPError(r.status_code)
            return r.json()
        except (httpx.HTTPError, json.JSONDecodeError, OSError, asyncio.TimeoutError):
            if attempt == 2:
                raise ProviderError("ارتباط با سرویس برقرار نشد؛ اینترنت/VPN را بررسی کنید.") from None
            await asyncio.sleep(2**attempt)


def _ffmpeg(data, args, timeout=90):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return None
    with tempfile.TemporaryDirectory(prefix="karnama-audio-") as folder:
        source = Path(folder) / "source"
        source.write_bytes(data)
        try:
            result = subprocess.run(
                [ffmpeg, "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe",
                 "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", *args],
                capture_output=True, timeout=timeout, cwd=folder,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if result.returncode:
            return None
        return [p.read_bytes() for p in sorted(Path(folder).glob("out*.mp3"))] or None


def to_mp3(data):
    """Browser recordings are webm/ogg/mp4; Avanegar is most reliable with mp3."""
    out = _ffmpeg(data, ["out.mp3"])
    return out[0] if out else None


def split_audio(data):
    parts = _ffmpeg(data, ["-f", "segment", "-segment_time", "50", "-reset_timestamps", "1", "out-%03d.mp3"])
    if not parts or len(parts) < 2:
        raise AudioDurationError()
    return parts


async def transcribe(data, mime, filename, _submission=0, _split_retry=False):
    key = db.avanegar_token()
    if not key:
        raise ProviderError("توکن آوانگار را در تنظیمات وارد کنید.")
    if not _split_retry and not mime.startswith("audio/mpeg"):
        converted = await asyncio.to_thread(to_mp3, data)
        if converted:
            data, mime, filename = converted, "audio/mpeg", "audio.mp3"
    try:
        d = await request(
            "POST",
            REQUEST_URL,
            headers={"gateway-token": key},
            files={"audio": (filename, data, mime)},
            data={
                "language": "fa",
                "model": "default",
                "punctuation": "true",
                "inverseNormalizer": "true",
            },
        )
    except AudioDurationError:
        if _split_retry:
            raise
        chunks = await asyncio.to_thread(split_audio, data)
        texts = []
        for chunk in chunks:
            texts.append(await transcribe(chunk, "audio/mpeg", "audio.mp3", _split_retry=True))
        return "\n".join(texts)
    try:
        return extract_speech(d)
    except ProviderError:
        pass

    def find_id(obj):
        if isinstance(obj, dict):
            for k in ["id", "request_id", "requestId", "tracking_id"]:
                if isinstance(obj.get(k), (str, int)):
                    return str(obj[k])
            for v in obj.values():
                found = find_id(v)
                if found:
                    return found
        return None

    envelope = d.get("data", {}) if isinstance(d, dict) else {}
    if not isinstance(envelope, dict) or envelope.get("status") not in ("pending", "processing", "queued"):
        raise ProviderError("آوانگار متن برنگرداند؛ دوباره تلاش کنید.")
    job = find_id(envelope.get("data", {}))
    if not job:
        raise ProviderError("آوانگار متن یا شناسه پیگیری برنگرداند.")
    for attempt in range(20):
        await asyncio.sleep(min(2 + attempt, 6))
        try:
            d = await request("GET", RESULT_URL, headers={"gateway-token": key}, params={"id": job})
        except ProviderHTTPError as e:
            if e.status_code == 404 and _submission < 2:
                # Short audio sometimes finishes without a getResult route; re-submitting returns it.
                await asyncio.sleep(3)
                return await transcribe(data, mime, filename, _submission + 1, _split_retry)
            raise
        try:
            return extract_speech(d)
        except ProviderError:
            pass
    raise ProviderError("نتیجهٔ آوانگار در زمان مجاز آماده نشد؛ دوباره تلاش کنید.")


def extract_speech(d):
    if isinstance(d, list):
        texts = []
        for item in d:
            try:
                texts.append(extract_speech(item))
            except ProviderError:
                pass
        if texts:
            return " ".join(texts)
    if isinstance(d, dict):
        for k in ["text", "transcript", "transcription", "sentence"]:
            if isinstance(d.get(k), str) and d[k].strip():
                return d[k]
        for k in ["data", "aiResponse", "result", "response", "segments"]:
            if isinstance(d.get(k), (dict, list)):
                try:
                    return extract_speech(d[k])
                except ProviderError:
                    pass
    raise ProviderError("پاسخ آوانگار هنوز متن نهایی ندارد.")
