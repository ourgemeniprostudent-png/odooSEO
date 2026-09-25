#!/bin/zsh
# دوبار کلیک روی این فایل در مک: برنامه اجرا و مرورگر باز می‌شود.
set -eu
cd -- "${0:A:h}"
if [[ ! -x .venv/bin/python ]]; then
  echo "نصب اولیه…"
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
(sleep 1.5 && open "http://127.0.0.1:8770") &
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8770
