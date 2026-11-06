#!/usr/bin/env python3
"""Run one fake-model scenario against Muse and summarize the main session's tool outputs."""
import argparse, json, os, socket, subprocess, sys, time

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def tool_names(body):
    names = []
    for t in body.get("tools", []) or []:
        if not isinstance(t, dict): continue
        if t.get("type") == "namespace":
            names += [x.get("name") for x in t.get("tools", []) if isinstance(x, dict)]
        elif t.get("name"):
            names.append(t.get("name"))
    return names

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--workspace", default=os.path.expanduser("~/metaveil-spike-ws"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--extra", action="append", default=[])
    ap.add_argument("--timeout", type=int, default=120)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    port = free_port()
    req = os.path.join(args.out, "requests.jsonl")
    if os.path.exists(req): os.remove(req)
    srv = subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fake_model.py"),
                            "--port", str(port), "--scenario", args.scenario, "--out", args.out],
                           stdout=open(os.path.join(args.out, "server.log"), "w"), stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close(); break
        except Exception:
            time.sleep(0.1)
    env = dict(os.environ); env["META_API_KEY"] = "dummy"
    cmd = ["C:/Users/devuser/AppData/Local/Programs/muse/muse-bin-1.4.14-R7309.1.exe", "exec",
           "--provider", "meta", "--model", "muse-spark-1.3", "--contributor-mode", "off",
           "--reasoning-effort", "low", "--base-url", f"http://127.0.0.1:{port}/v1",
           "--no-session-log"] + args.extra + [args.prompt]
    proc = subprocess.Popen(cmd, cwd=args.workspace, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        out, _ = proc.communicate(timeout=args.timeout)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
        out = (out or "") + "\n[TIMEOUT]"
        code = -1
    finally:
        srv.terminate()
        try: srv.wait(timeout=5)
        except Exception: srv.kill()
    open(os.path.join(args.out, "muse.log"), "w", encoding="utf-8").write(out)
    print("EXIT", code)
    print("--- muse tail ---")
    print("\n".join(out.splitlines()[-20:]))
    print("--- main tool outputs ---")
    if os.path.exists(req):
        for line in open(req, encoding="utf-8"):
            e = json.loads(line)
            if e.get("method") != "POST" or not isinstance(e.get("body"), dict): continue
            b = e["body"]; names = tool_names(b)
            if not any(n in ("powershell", "read_file", "search", "write_file", "edit_file") for n in names): continue
            for it in b.get("input", []):
                if isinstance(it, dict) and it.get("type") == "function_call_output":
                    print("OUTPUT:", str(it.get("output"))[:1200])
    print("--- requests:", req)

if __name__ == "__main__":
    main()
