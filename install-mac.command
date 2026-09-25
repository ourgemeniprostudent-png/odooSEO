#!/bin/zsh
# نصب «کارنامه» به صورت برنامهٔ مک. یک بار روی این فایل دوبار کلیک کنید.
# برنامه در پوشهٔ Applications ساخته می‌شود و داده‌ها در
# ~/Library/Application Support/Karnama می‌مانند. نصب دوباره داده‌ها را پاک نمی‌کند.
set -eu
SRC="${0:A:h}"
NAME="کارنامه"
SUPPORT="$HOME/Library/Application Support/Karnama"

step() { print -P "%F{green}●%f $1"; }
fail() { print -P "%F{red}✗ $1%f"; if [[ -t 0 ]]; then print "برای بستن Enter بزنید."; read; fi; exit 1; }

cd "$SRC"
step "شروع نصب کارنامه…"

if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  fail "ابزارهای خط فرمان اپل (Command Line Tools) نصب نیست. پنجرهٔ نصب باز شد؛ بعد از پایان نصب، دوباره همین فایل را اجرا کنید."
fi
command -v python3 >/dev/null || fail "python3 پیدا نشد."
command -v swiftc >/dev/null || fail "swiftc پیدا نشد؛ Command Line Tools را به‌روز کنید: xcode-select --install"

# Apps can live in /Applications, or in ~/Applications when the user is not an admin.
if [[ -w /Applications ]]; then APPS=/Applications; else APPS="$HOME/Applications"; mkdir -p "$APPS"; fi
APP="$APPS/$NAME.app"

mkdir -p "$SUPPORT/data"
step "آماده‌سازی محیط Python (بار اول چند دقیقه طول می‌کشد)…"
[[ -x "$SUPPORT/venv/bin/python" ]] || python3 -m venv "$SUPPORT/venv"
"$SUPPORT/venv/bin/pip" install -q --upgrade pip >/dev/null 2>&1 || true
"$SUPPORT/venv/bin/pip" install -q -r requirements.txt || fail "نصب کتابخانه‌های Python ناموفق بود؛ اینترنت/VPN را بررسی کنید."

# Data from the earlier start.command version (stored next to the code) moves over once.
if [[ -f "$SRC/data/karnama.sqlite" && ! -f "$SUPPORT/data/karnama.sqlite" ]]; then
  step "انتقال داده‌های قبلی…"
  cp -R "$SRC/data/." "$SUPPORT/data/"
fi

step "ساخت برنامه…"
BUILD="$(mktemp -d)"
swiftc -O -o "$BUILD/Karnama" mac/Karnama.swift || fail "ساخت برنامه ناموفق بود."

# Close a running copy (and its server) so the new version starts cleanly.
pkill -f "/Contents/MacOS/Karnama$" 2>/dev/null || true
pkill -f "uvicorn app.main:app --host 127.0.0.1 --port 8770" 2>/dev/null || true
sleep 1
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/Karnama" "$APP/Contents/MacOS/Karnama"
cp mac/Info.plist "$APP/Contents/Info.plist"
cp mac/Karnama.icns "$APP/Contents/Resources/Karnama.icns"
cp -R app static "$APP/Contents/Resources/"
# Version marker for the in-app updater (set by the updater; otherwise asked from GitHub).
VERSION="${KARNAMA_VERSION:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(curl -fsS -m 10 "https://api.github.com/repos/ourgemeniprostudent-png/odooSEO/commits/claude/daily-task-management-app-1cq6o6" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])' 2>/dev/null || true)"
fi
print -r -- "$VERSION" > "$APP/Contents/Resources/VERSION"
find "$APP/Contents/Resources" -name "__pycache__" -prune -exec rm -rf {} +
rm -rf "$BUILD"

xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

step "نصب شد: $APP"
step "برای ماندن در Dock: وقتی برنامه باز است، روی آیکنش در Dock کلیک راست ← Options ← Keep in Dock"
open "$APP"
