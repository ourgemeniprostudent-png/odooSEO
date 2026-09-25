"""Optional macOS interface binding so Avanegar is reached directly while a VPN is on.

Copied from payamyar (سیستم یکپارچه‌سازی اطلاعات)."""

import asyncio
import os
import socket
import sys
import tempfile
from pathlib import Path
import httpx
from . import db


def interface_for(url):
    interface = os.environ.get(
        "KARNAMA_SERVICE_INTERFACE", db.setting("provider_interface", "")
    )
    if sys.platform != "darwin" or httpx.URL(url).host != "partai.gw.isahab.ir":
        return ""
    return interface


def quoted(value):
    if any(c in str(value) for c in ("\r", "\n", "\x00")):
        raise ValueError("Invalid network option")
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


async def direct_request(method, url, interface, **kwargs):
    # curl binds the socket before connecting; httpcore's socket_options run after connect.
    # Credentials go through stdin, never the process arguments or diagnostic output.
    socket.if_nametoindex(interface)
    request = httpx.Request(method, url, **kwargs)
    body = request.read()
    with tempfile.TemporaryDirectory(prefix="karnama-request-") as folder:
        body_path = Path(folder) / "body"
        body_path.write_bytes(body)
        body_path.chmod(0o600)
        config = [
            "silent",
            "show-error",
            "connect-timeout = 15",
            "max-time = 180",
            "max-filesize = 16777216",
            'proxy = ""',
            "interface = " + quoted(interface),
            "request = " + quoted(method),
            "url = " + quoted(str(request.url)),
            'write-out = "\\n%{http_code}"',
        ]
        config += ["header = " + quoted(k + ": " + v) for k, v in request.headers.items()]
        if body:
            config.append("data-binary = " + quoted("@" + str(body_path)))
        process = await asyncio.create_subprocess_exec(
            "/usr/bin/curl",
            "--disable",
            "--config",
            "-",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate("\n".join(config).encode()), 190)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        if process.returncode:
            raise httpx.ConnectError("Service connection failed on selected interface")
        content, status = output.rsplit(b"\n", 1)
        return httpx.Response(int(status), content=content, request=request)
