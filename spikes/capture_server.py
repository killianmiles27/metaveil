#!/usr/bin/env python3
"""Loopback capture server for Muse Code spike.

Logs method + path + body only. NEVER logs header names or values.
Returns 400 for POSTs so no model turn completes (capture runs are free).
Optionally forwards GET /muse-code/models to https://api.meta.ai.

Usage: python capture_server.py --port 8791 [--out DIR] [--forward-models]
"""
import argparse, json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest, error as urlerror

ARGS = None
LOCK = threading.Lock()

def log_event(ev):
    path = os.path.join(ARGS.out, "requests.jsonl")
    with LOCK:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *a):
        pass
    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        log_event({"ts": time.time(), "method": "GET", "path": self.path, "body": None})
        if self.path.startswith("/muse-code/models") and ARGS.forward_models:
            try:
                req = urlrequest.Request("https://api.meta.ai" + self.path)
                for k, v in self.headers.items():
                    if k.lower() in ("host", "content-length", "connection"):
                        continue
                    req.add_header(k, v)
                with urlrequest.urlopen(req, timeout=30) as r:
                    data = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                self._send(502, {"error": {"message": "forward failed: %s" % type(e).__name__}})
                return
        if self.path.startswith("/muse-code/models") or self.path.startswith("/v1/models"):
            self._send(200, {"data": [{"id": "muse-spark-1.3", "object": "model"}]})
            return
        self._send(404, {"error": {"message": "not found"}})
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            body = raw.decode("utf-8", "replace")
        log_event({"ts": time.time(), "method": "POST", "path": self.path, "body": body})
        self._send(400, {"error": {"message": "spike capture server: POST refused", "type": "invalid_request_error"}})

def main():
    global ARGS
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8791)
    p.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "capture"))
    p.add_argument("--forward-models", action="store_true")
    ARGS = p.parse_args()
    os.makedirs(ARGS.out, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), H)
    print("listening on 127.0.0.1:%d out=%s" % (ARGS.port, ARGS.out), flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
