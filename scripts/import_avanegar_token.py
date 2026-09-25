"""Copy the Avanegar token and GapGPT key from payamyar / faragharardad's data folder.

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
db.init()
copied = []
for src, dst in (("vira_token", "avanegar_token"), ("gapgpt_key", "gapgpt_key")):
    if values.get(src):
        db.set_setting(dst, cipher.decrypt(values[src].encode()).decode())
        copied.append(dst)
model = values.get("text_model") or values.get("glm_model")
if model:
    db.set_setting("text_model", model)
if not copied:
    sys.exit("کلیدی در این پوشه پیدا نشد.")
print("منتقل شد:", "، ".join(copied))
