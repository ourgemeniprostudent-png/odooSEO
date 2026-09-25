"""Copy the Avanegar token from payamyar / faragharardad's data folder into Karnama.

Usage:  .venv/bin/python scripts/import_avanegar_token.py /path/to/payamyar/data
Needs `pip install cryptography` (only for this one-off import).
"""

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db  # noqa: E402

try:
    from cryptography.fernet import Fernet
except ImportError:
    sys.exit("ابتدا اجرا کنید:  .venv/bin/pip install cryptography")

source = Path(sys.argv[1]).expanduser()
cipher = Fernet((source / "encryption.key").read_bytes())
c = sqlite3.connect("file:" + str(source / "app.sqlite") + "?mode=ro", uri=True)
values = {k: json.loads(v) for k, v in c.execute("SELECT key,value FROM settings")}
c.close()
token = values.get("vira_token")
if not token:
    sys.exit("توکن آوانگار در این پوشه پیدا نشد.")
db.init()
db.set_setting("avanegar_token", cipher.decrypt(token.encode()).decode())
print("توکن آوانگار منتقل شد.")
