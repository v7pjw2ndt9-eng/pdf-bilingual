#!/usr/bin/env python3
"""
本地翻译桥接 —— 把 Claude Code CLI / Codex CLI 包成一个 HTTP 接口，
让浏览器扩展能用上你已经付费的订阅额度，而不是另外买 API。

    python3 bridge/bridge.py                  # 默认 127.0.0.1:8765
    python3 bridge/bridge.py --port 9000
    python3 bridge/bridge.py --claude-bin /path/to/claude

只用标准库，不需要 pip 装任何东西。只监听回环地址，不对外网开放。

接口：
    GET  /health     -> {"ok": true, "cli": {"claude": true, "codex": false}}
    POST /translate  -> {"engine","model","system","prompt"} -> {"text": "..."}
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TIMEOUT = 240

# CLI 不一定在 PATH 上（比如只装了桌面版），这里多找几个常见位置
CANDIDATES = {
    "claude": [
        "~/.claude/local/claude",
        "~/.local/bin/claude",
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ],
    "codex": [
        "~/.local/bin/codex",
        "~/.codex/bin/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
    ],
}

OVERRIDE = {}


def resolve(name):
    if OVERRIDE.get(name):
        return OVERRIDE[name]
    found = shutil.which(name)
    if found:
        return found
    for p in CANDIDATES.get(name, []):
        p = os.path.expanduser(p)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


# 每次调用都要起一个 CLI 进程，开太多会把机器拖垮
GATE = threading.Semaphore(int(os.environ.get("BRIDGE_CONCURRENCY", "2")))

# 在一个空目录里跑，免得 CLI 去扫描、索引你的项目
WORKDIR = tempfile.mkdtemp(prefix="pdf-bilingual-")

SEG_OPEN = re.compile(r"<seg\b")
PREAMBLE = re.compile(
    r"^\s*(?:\[[\d:\-T\.]+\]|OpenAI Codex|-{3,}|workdir:|model:|provider:|approval:|"
    r"sandbox:|reasoning|tokens used:|User instructions:|codex$|thinking$)",
    re.IGNORECASE,
)


def clean(text):
    """
    CLI 会在正文前后掺自己的日志。我们的翻译协议要求输出 <seg id="N">…</seg>，
    所以只要截取第一个 <seg 到最后一个 </seg> 就能干净地拿到正文。
    """
    if SEG_OPEN.search(text):
        start = SEG_OPEN.search(text).start()
        end = text.rfind("</seg>")
        if end > start:
            return text[start : end + 6]
    return "\n".join(l for l in text.splitlines() if not PREAMBLE.match(l)).strip()


def run(cmd, stdin_text):
    proc = subprocess.run(
        cmd,
        input=stdin_text,
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        cwd=WORKDIR,
        env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[:600]
        raise RuntimeError(f"{os.path.basename(cmd[0])} 退出码 {proc.returncode}\n{err}")
    return proc.stdout


def call_claude(system, prompt, model):
    exe = resolve("claude")
    if not exe:
        raise RuntimeError(
            "找不到 claude CLI。安装：curl -fsSL https://claude.ai/install.sh | bash"
            "，然后 claude 登录一次（选订阅账号）。"
        )
    cmd = [exe, "-p", "--output-format", "text"]
    if system:
        cmd += ["--append-system-prompt", system]
    if model:
        cmd += ["--model", model]
    return clean(run(cmd, prompt))


def call_codex(system, prompt, model):
    exe = resolve("codex")
    if not exe:
        raise RuntimeError(
            "找不到 codex CLI。安装：brew install codex（或 npm i -g @openai/codex）"
            "，然后 codex login 用 ChatGPT 账号登录。"
        )
    cmd = [exe, "exec", "--skip-git-repo-check"]
    if model:
        cmd += ["-m", model]
    cmd += ["-"]
    # codex exec 没有独立的 system prompt 参数，拼进正文
    full = f"{system}\n\n---\n\n{prompt}" if system else prompt
    return clean(run(cmd, full))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {
                "ok": True,
                "cli": {"claude": bool(resolve("claude")), "codex": bool(resolve("codex"))},
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/translate"):
            self._json(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            self._json(400, {"error": f"请求体解析失败: {e}"})
            return

        engine = (req.get("engine") or "claude").lower()
        system = req.get("system") or ""
        prompt = req.get("prompt") or ""
        model = req.get("model") or None
        if not prompt:
            self._json(400, {"error": "prompt 为空"})
            return

        with GATE:
            try:
                if engine == "codex":
                    text = call_codex(system, prompt, model)
                elif engine == "claude":
                    text = call_claude(system, prompt, model)
                else:
                    raise RuntimeError(f"未知 engine: {engine}")
            except subprocess.TimeoutExpired:
                self._json(504, {"error": f"{engine} 超过 {TIMEOUT}s 没返回"})
                return
            except Exception as e:
                self._json(500, {"error": str(e)})
                return

        self._json(200, {"text": text})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--claude-bin")
    ap.add_argument("--codex-bin")
    args = ap.parse_args()

    if args.claude_bin:
        OVERRIDE["claude"] = args.claude_bin
    if args.codex_bin:
        OVERRIDE["codex"] = args.codex_bin

    print(f"PDF 双语阅读器 · 本地桥接")
    print(f"  监听   http://{args.host}:{args.port}")
    print(f"  工作目录 {WORKDIR}")
    print(f"  claude {resolve('claude') or '未找到'}")
    print(f"  codex  {resolve('codex') or '未找到'}")
    print("  Ctrl-C 退出\n")

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n再见")


if __name__ == "__main__":
    main()
