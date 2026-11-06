#!/usr/bin/env python3
"""Scripted loopback Responses-API server for Muse Code sandbox spikes.

Never forwards anywhere. Logs method/path/body only (no headers).
Usage:
  python fake_model.py --port 8801 --scenario spikes/round2/scenario.json
"""
import argparse, json, os, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = None
LOCK = threading.Lock()
SCENARIO = {}

def log_event(ev):
    os.makedirs(ARGS.out, exist_ok=True)
    with LOCK:
        with open(os.path.join(ARGS.out, "requests.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(ev, ensure_ascii=False) + "\n")

def sse(wfile, event, data, seq=None):
    if seq is not None:
        data = dict(data)
        data["sequence_number"] = seq
    payload = json.dumps(data, ensure_ascii=False)
    frame = f"event: {event}\ndata: {payload}\n\n".encode()
    wfile.write(frame)
    wfile.flush()

def response_obj(resp_id, status, output):
    now = int(time.time())
    return {
        "id": resp_id, "object": "response", "model": "muse-spark-1.3",
        "status": status, "created_at": now, "completed_at": now if status == "completed" else None,
        "output": output,
        "usage": {
            "input_tokens": 1, "output_tokens": 1, "total_tokens": 2,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0},
        },
        "error": None, "previous_response_id": None, "metadata": {},
        "incomplete_details": None, "status_details": None,
    }

def function_call_item(call_id, name, args):
    return {
        "id": "fc_" + call_id, "type": "function_call", "status": "completed",
        "name": name, "arguments": args, "call_id": call_id,
    }

def output_part(text):
    return {"type": "output_text", "text": text, "refusal": None, "annotations": [], "logprobs": []}

def message_item(text):
    return {
        "id": "msg_" + uuid.uuid4().hex[:12], "type": "message", "status": "completed",
        "role": "assistant", "content": [output_part(text)],
    }

def tool_names(body):
    names = []
    for t in body.get("tools", []) or []:
        if not isinstance(t, dict):
            continue
        if t.get("type") == "namespace":
            names += [x.get("name") for x in t.get("tools", []) if isinstance(x, dict)]
        elif t.get("name"):
            names.append(t.get("name"))
    return names

def is_main_session(body):
    names = tool_names(body)
    return any(n in ("powershell", "read_file", "search", "write_file", "edit_file") for n in names)

def count_tool_outputs(body):
    n = 0
    for item in body.get("input", []) or []:
        if isinstance(item, dict) and item.get("type") == "function_call_output":
            n += 1
    return n

def input_text(body):
    try:
        return json.dumps(body.get("input", []), ensure_ascii=False)
    except Exception:
        return ""

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *a):
        pass

    def do_GET(self):
        log_event({"ts": time.time(), "method": "GET", "path": self.path, "body": None})
        if self.path.startswith("/muse-code/models"):
            data = json.dumps({"data": [
                {"id": "muse-spark-1.3", "object": "model", "created": int(time.time()), "owned_by": "meta"},
                {"id": "muse-spark-1.3-contributor", "object": "model", "created": int(time.time()), "owned_by": "meta"}
            ]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            body = raw.decode("utf-8", "replace")
        log_event({"ts": time.time(), "method": "POST", "path": self.path, "contributor": self.headers.get("x-tbh-contributor-mode"), "body": body})
        if not isinstance(body, dict):
            self.send_response(400); self.send_header("Content-Length", "0"); self.end_headers(); return
        text = input_text(body)
        child = "Subagent workspace:" in text
        if child:
            scenario = SCENARIO.get("child", [])
        elif is_main_session(body):
            scenario = SCENARIO.get("main", [])
        else:
            scenario = SCENARIO.get("reminder", [{
                "tool": "submit_reminder_decision",
                "args": {"decision": "none", "advisory_text": None, "confidence": "high",
                         "priority": "low", "reason": "spike fake model", "skill_id": None,
                         "visible_for_steps": 1},
            }])
        step = count_tool_outputs(body)
        resp_id = "resp_fake_" + uuid.uuid4().hex[:12]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        try:
            if step < len(scenario):
                call = scenario[step]
                name = call["tool"]
                # Real models call namespaced tools as muse.<tool>.
                if "." not in name and not name.startswith("mcp__"):
                    name = "muse." + name
                args = json.dumps(call.get("args", {}), ensure_ascii=False)
                call_id = "call_fake_" + uuid.uuid4().hex[:12]
                item = function_call_item(call_id, name, args)
                sse(self.wfile, "response.created", {"response": response_obj(resp_id, "in_progress", [])}, 0)
                sse(self.wfile, "response.in_progress", {"response": response_obj(resp_id, "in_progress", [])}, 1)
                sse(self.wfile, "response.output_item.added", {"output_index": 0, "item": item}, 2)
                sse(self.wfile, "response.function_call_arguments.delta", {"item_id": item["id"], "output_index": 0, "delta": args}, 3)
                sse(self.wfile, "response.function_call_arguments.done", {"item_id": item["id"], "output_index": 0, "arguments": args}, 4)
                sse(self.wfile, "response.output_item.done", {"output_index": 0, "item": item}, 5)
                sse(self.wfile, "response.completed", {"response": response_obj(resp_id, "completed", [item])}, 6)
            else:
                text_out = SCENARIO.get("final", "fake model done")
                item = message_item(text_out)
                sse(self.wfile, "response.created", {"response": response_obj(resp_id, "in_progress", [])}, 0)
                sse(self.wfile, "response.in_progress", {"response": response_obj(resp_id, "in_progress", [])}, 1)
                sse(self.wfile, "response.output_item.added", {"output_index": 0, "item": {"id": item["id"], "type": "message", "status": "in_progress", "role": "assistant", "content": []}}, 2)
                sse(self.wfile, "response.content_part.added", {"item_id": item["id"], "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": "", "refusal": None, "annotations": [], "logprobs": []}}, 3)
                sse(self.wfile, "response.output_text.delta", {"item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text_out}, 4)
                sse(self.wfile, "response.output_text.done", {"item_id": item["id"], "output_index": 0, "content_index": 0, "text": text_out}, 5)
                sse(self.wfile, "response.content_part.done", {"item_id": item["id"], "output_index": 0, "content_index": 0, "part": {"type": "output_text", "text": text_out, "refusal": None, "annotations": [], "logprobs": []}}, 6)
                sse(self.wfile, "response.output_item.done", {"output_index": 0, "item": item}, 7)
                sse(self.wfile, "response.completed", {"response": response_obj(resp_id, "completed", [item])}, 8)
        except Exception as e:
            log_event({"ts": time.time(), "error": type(e).__name__ + ": " + str(e)})
        try:
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        except Exception:
            pass

def main():
    global ARGS, SCENARIO
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8801)
    p.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "round2", "capture"))
    p.add_argument("--scenario", required=True)
    ARGS = p.parse_args()
    SCENARIO = json.load(open(ARGS.scenario, encoding="utf-8"))
    os.makedirs(ARGS.out, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), H)
    print(f"listening 127.0.0.1:{ARGS.port} scenario={ARGS.scenario} out={ARGS.out}", flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    main()
