import json, sys
mode = sys.argv[1]
timeout = sys.argv[2] if len(sys.argv) > 2 else None
cmd = f"C:/PROGRA~1/nodejs/node.exe C:/Users/devuser/orca/metaveil/spikes/round2/hooks/fail-mode.cjs {mode}"
h = {"type": "command", "command": cmd}
if timeout:
    h["timeoutMs"] = int(timeout)
cfg = {"hooks": {"PreToolUse": [{"hooks": [h]}]}}
open(r"C:\Users\devuser\metaveil-spike-ws\.muse\hooks.json", "w").write(json.dumps(cfg))
print(json.dumps(cfg))
