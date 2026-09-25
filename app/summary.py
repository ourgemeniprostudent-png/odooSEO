"""Day summary written by GapGPT (same OpenAI-compatible endpoint payamyar uses)."""

import hashlib
import json

from . import avanegar, db

URL = "https://api.gapgpt.app/v1/chat/completions"
DEFAULT_MODEL = "glm-5.3"

SYSTEM = """تو دستیار نوشتن گزارش کار روزانه هستی. فهرست کارهای یک روز به تو داده می‌شود؛ \
کارها ممکن است از روی صدا تایپ شده باشند و غلط تایپی یا محاوره‌ای باشند.
یک خلاصهٔ کوتاه فارسی رسمی و روان بنویس:
- اول یک جملهٔ کلی دربارهٔ اینکه آن روز بیشتر روی چه چیزهایی کار شده.
- بعد برای هر تگ (پروژه) یک خط که با «نام تگ:» شروع شود و کارهای آن را فشرده بگوید.
- اگر تسک باز (انجام‌نشده) هست، در یک خط آخر با «مانده:» بگو.
هیچ کار، عدد، نام یا نتیجه‌ای که در فهرست نیست اضافه نکن. فقط متن خلاصه را برگردان، بدون مقدمه و بدون Markdown."""


def fingerprint(done, todo):
    raw = json.dumps(
        [[e["id"], e["text"], e["tag_ids"], e["minutes"]] for e in done]
        + [[e["id"], e["text"]] for e in todo],
        ensure_ascii=False,
    )
    return hashlib.sha1(raw.encode()).hexdigest()


def prompt_payload(day, done, todo, tags):
    names = {t["id"]: t["name"] for t in tags}

    def line(e):
        t = "، ".join(names[i] for i in e["tag_ids"] if i in names) or "بدون تگ"
        extra = f" ({e['minutes']} دقیقه)" if e.get("minutes") else ""
        return f"- [{t}] {e['text']}{extra}"

    parts = [f"تاریخ: {day}", "", "کارهای انجام‌شده:"]
    parts += [line(e) for e in done] or ["(هیچ)"]
    parts += ["", "تسک‌های انجام‌نشده:"]
    parts += [line(e) for e in todo] or ["(هیچ)"]
    return "\n".join(parts)


async def generate(day, done, todo, tags):
    key = db.gapgpt_key()
    if not key:
        raise avanegar.ProviderError("کلید گپ‌جی‌پی‌تی را در تنظیمات وارد کنید.")
    if not done and not todo:
        raise avanegar.ProviderError("برای این روز کاری ثبت نشده که خلاصه شود.")
    model = db.setting("text_model", "") or DEFAULT_MODEL
    options = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt_payload(day, done, todo, tags)},
        ],
        "max_tokens": 4000,
    }
    if "glm-5.3" in model.lower():
        options["reasoning_effort"] = "low"
    d = await avanegar.request("POST", URL, headers={"Authorization": "Bearer " + key}, json=options)
    try:
        text = d["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, AttributeError):
        text = ""
    if not text:
        raise avanegar.ProviderError("پاسخ مدل خالی بود؛ دوباره تلاش کنید.")
    return text
