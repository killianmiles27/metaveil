import argparse, json, os, socket, subprocess, sys, time

def free_port():
    s=socket.socket(); s.bind(("127.0.0.1",0)); p=s.getsockname()[1]; s.close(); return p

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=None)
    ap.add_argument("--max-wait", type=int, default=40)
    ap.add_argument("--out", required=True)
    args=ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    ws=os.path.expanduser("~/metaveil-spike-ws")
    hook={"type":"command","command":"C:/PROGRA~1/nodejs/node.exe C:/Users/devuser/orca/metaveil/spikes/round2/hooks/fail-mode.cjs hang"}
    if args.timeout is not None: hook["timeout"]=args.timeout
    cfg={"hooks":{"PreToolUse":[{"matcher":"powershell","hooks":[hook]}]}}
    open(os.path.join(ws,".muse","hooks.json"),"w").write(json.dumps(cfg))
    port=free_port()
    srv=subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","fake_model.py"),
                          "--port",str(port),"--scenario",os.path.join(os.path.dirname(os.path.abspath(__file__)),"scenario-c.json"),
                          "--out",args.out], stdout=open(os.path.join(args.out,"server.log"),"w"), stderr=subprocess.STDOUT)
    for _ in range(50):
        try: socket.create_connection(("127.0.0.1",port),0.2).close(); break
        except Exception: time.sleep(0.1)
    env=dict(os.environ); env["META_API_KEY"]="dummy"
    cmd=["C:/Users/devuser/AppData/Local/Programs/muse/muse-bin-1.4.14-R7309.1.exe","exec","--provider","meta",
         "--model","muse-spark-1.3","--contributor-mode","off","--reasoning-effort","low",
         "--base-url",f"http://127.0.0.1:{port}/v1","--no-session-log","--approval-mode","never",
         "--approval-judge","off","--trust-workspace","hook timeout probe"]
    outpath=os.path.join(args.out,"muse.out")
    with open(outpath,"w",encoding="utf-8") as f:
        p=subprocess.Popen(cmd,cwd=ws,env=env,stdout=f,stderr=subprocess.STDOUT)
        start=time.time(); elapsed=None
        while time.time()-start < args.max_wait:
            if p.poll() is not None:
                elapsed=time.time()-start; break
            time.sleep(0.5)
        if elapsed is None:
            elapsed=time.time()-start
            subprocess.run(["taskkill","/F","/T","/PID",str(p.pid)],capture_output=True)
            status="STILL_RUNNING_KILLED"
        else:
            status=f"EXIT {p.returncode}"
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    text=open(outpath,encoding="utf-8",errors="replace").read()
    print(json.dumps({"timeout":args.timeout,"max_wait":args.max_wait,"elapsed":round(elapsed,2),"status":status,
                      "tool_allowed":"TOOL-C-ALLOWED" in text,
                      "hook_timed_out":"timed out" in text.lower(),
                      "tail":"\n".join(text.splitlines()[-8:])},indent=1))

if __name__=="__main__":
    main()
