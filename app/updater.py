"""In-app update for the Mac build: download the latest code from GitHub and re-run the installer."""

import io
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import httpx

REPO = "ourgemeniprostudent-png/odooSEO"
BRANCH = "claude/daily-task-management-app-1cq6o6"
COMMIT_URL = f"https://api.github.com/repos/{REPO}/commits/{BRANCH}"
ZIP_URL = f"https://github.com/{REPO}/archive/refs/heads/{BRANCH}.zip"
RESOURCES = Path(__file__).resolve().parents[1]
VERSION_FILE = RESOURCES / "VERSION"


class UpdateError(ValueError):
    pass


def installed_app():
    """Only the installed Mac app (…/کارنامه.app/Contents/Resources) can update itself."""
    return sys.platform == "darwin" and RESOURCES.parent.name == "Contents" and RESOURCES.name == "Resources"


def current_version():
    try:
        return VERSION_FILE.read_text().strip()
    except OSError:
        return ""


def _client():
    return httpx.AsyncClient(timeout=httpx.Timeout(60, connect=15), follow_redirects=True,
                             headers={"User-Agent": "karnama-updater"})


async def check():
    try:
        async with _client() as c:
            r = await c.get(COMMIT_URL, headers={"Accept": "application/vnd.github+json"})
            r.raise_for_status()
            data = r.json()
    except (httpx.HTTPError, ValueError):
        raise UpdateError("ارتباط با گیت‌هاب برقرار نشد؛ اینترنت/VPN را بررسی کنید.") from None
    latest = data.get("sha", "")
    message = (data.get("commit", {}).get("message", "") or "").split("\n")[0]
    current = current_version()
    return {
        "supported": installed_app(),
        "current": current[:7],
        "latest": latest[:7],
        "latest_sha": latest,
        "available": bool(latest) and latest != current,
        "message": message,
        "date": data.get("commit", {}).get("committer", {}).get("date", ""),
    }


async def apply():
    if not installed_app():
        raise UpdateError("به‌روزرسانی خودکار فقط در برنامهٔ نصب‌شدهٔ مک کار می‌کند.")
    info = await check()
    try:
        async with _client() as c:
            r = await c.get(ZIP_URL)
            r.raise_for_status()
    except httpx.HTTPError:
        raise UpdateError("دانلود نسخهٔ جدید ناموفق بود؛ دوباره تلاش کنید.") from None
    folder = Path(tempfile.mkdtemp(prefix="karnama-update-"))
    try:
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            for member in z.namelist():
                target = (folder / member).resolve()
                if not str(target).startswith(str(folder.resolve())):
                    raise UpdateError("فایل دانلودشده معتبر نیست.")
            z.extractall(folder)
    except zipfile.BadZipFile:
        raise UpdateError("فایل دانلودشده معتبر نیست.") from None
    installers = list(folder.glob("*/install-mac.command"))
    if not installers:
        raise UpdateError("نصب‌کننده در نسخهٔ جدید پیدا نشد.")
    support = Path.home() / "Library/Application Support/Karnama"
    log = open(support / "update.log", "w")
    env = {**os.environ, "KARNAMA_VERSION": info["latest_sha"]}
    # The installer closes this app and its server, rebuilds it and opens the new version,
    # so it must outlive us: its own session, no stdin.
    subprocess.Popen(
        ["/bin/zsh", str(installers[0])],
        cwd=installers[0].parent, env=env, stdin=subprocess.DEVNULL,
        stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return {"ok": True}
