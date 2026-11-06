import json, os, subprocess, sys, time, hashlib
out = sys.argv[1]
dur = float(sys.argv[2]) if len(sys.argv) > 2 else 180.0
targets = [r"C:\Users\devuser\metaveil-canary-home", r"C:\Users\devuser\metaveil-canary-home\secret.txt"]
state = r"C:\Users\devuser\.codex\.sandbox\deny_read_acl_state.json"
last = None
end = time.time() + dur
with open(out, "w", encoding="utf-8") as f:
    while time.time() < end:
        rec = {"ts": time.time()}
        for t in targets:
            try:
                p = subprocess.run(["icacls", t], capture_output=True, text=True, timeout=10)
                rec[t] = p.stdout.strip().splitlines()
            except Exception as e:
                rec[t] = ["ERR " + type(e).__name__]
        try:
            rec["state"] = open(state, encoding="utf-8").read()
        except Exception as e:
            rec["state"] = "ERR " + type(e).__name__
        sig = json.dumps(rec, sort_keys=True)
        if sig != last:
            f.write(sig + "\n"); f.flush()
            last = sig
        time.sleep(0.25)
print("done")
