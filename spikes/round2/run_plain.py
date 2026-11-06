import argparse, json, os, socket, subprocess, sys, time

def free_port():
    s=socket.socket(); s.bind(("127.0.0.1",0)); p=s.getsockname()[1]; s.close(); return p

def devlines(body):
    out=[]
    for it in body.get("input",[]) or []:
        if isinstance(it,dict) and it.get("role")=="developer":
            c=it.get("content")
            text=c if isinstance(c,str) else json.dumps(c)
            for line in text.splitlines():
                if line.startswith("- Approval:") or line.startswith("- Shell sandbox:") or line.startswith("- Workspace trust:"):
                    out.append(line.strip())
    return out

def tool_names(body):
    names=[]
    for t in body.get("tools",[]) or []:
        if not isinstance(t,dict): continue
        if t.get("type")=="namespace": names += [x.get("name") for x in t.get("tools",[]) if isinstance(x,dict)]
        elif t.get("name"): names.append(t.get("name"))
    return names

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--home", required=True)
    ap.add_argument("--prompt", default="run the scripted test")
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--base-url", action="store_true")
    ap.add_argument("--model", action="store_true")
    ap.add_argument("--profile", default=None)
    ap.add_argument("--no-permissions", action="store_true")
    args=ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    args.home = os.path.abspath(args.home)
    os.makedirs(os.path.join(args.home,"muse"), exist_ok=True)
    port=free_port()
    srv=subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","fake_model.py"),
                          "--port",str(port),"--scenario",args.scenario,"--out",args.out],
                         stdout=open(os.path.join(args.out,"server.log"),"w"), stderr=subprocess.STDOUT)
    for _ in range(50):
        try: socket.create_connection(("127.0.0.1",port),0.2).close(); break
        except Exception: time.sleep(0.1)
    settings={
      "schema_version":1, "provider":"meta", "model":"muse-spark-1.3",
      "contributor_mode_enabled":False,
      "telemetry":{"enabled":False},
      "endpoint_transport":{"base_url":f"http://127.0.0.1:{port}/v1"},
      "permissions":{"schema_version":1,"default_profile":"unattended","profiles":{
        "unattended":{"extends":":auto-review","approval":"allow_all","reviewer":"none","network":{"mode":"restricted"}}
      }}
    }
    if args.no_permissions:
        settings.pop("permissions", None)
    open(os.path.join(args.home,"muse","settings.json"),"w").write(json.dumps(settings,indent=1))
    env=dict(os.environ)
    env["XDG_CONFIG_HOME"]=args.home
    env["XDG_DATA_HOME"]=os.path.join(args.home,"data")
    env["META_API_KEY"]="dummy"
    ws=os.path.expanduser("~/metaveil-spike-ws")
    cmd=["C:/Users/devuser/AppData/Local/Programs/muse/muse-bin-1.4.14-R7309.1.exe","exec"]
    if args.base_url:
        cmd += ["--base-url", f"http://127.0.0.1:{port}/v1"]
    if args.model:
        cmd += ["--model", "muse-spark-1.3"]
    if args.profile:
        cmd += ["--permission-profile", args.profile]
    cmd.append(args.prompt)
    p=subprocess.Popen(cmd,cwd=ws,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    try:
        out,_=p.communicate(timeout=args.timeout); code=p.returncode
    except subprocess.TimeoutExpired:
        p.kill(); out,_=p.communicate(); out=(out or "")+"\n[TIMEOUT]"; code=-1
    srv.terminate()
    try: srv.wait(timeout=5)
    except Exception: srv.kill()
    open(os.path.join(args.out,"muse.log"),"w",encoding="utf-8").write(out)
    print("EXIT",code)
    print("--- muse tail ---")
    print("\n".join(out.splitlines()[-12:]))
    req=os.path.join(args.out,"requests.jsonl")
    if os.path.exists(req):
        posts=[json.loads(l) for l in open(req,encoding="utf-8") if '"POST"' in l]
        for i,pst in enumerate(posts):
            b=pst["body"]
            if not any(n in ("powershell","read_file","search") for n in tool_names(b)): continue
            print("--- developer lines (main post",i,") ---")
            for line in devlines(b): print(line)
            for it in b.get("input",[]):
                if isinstance(it,dict) and it.get("type")=="function_call_output":
                    print("OUTPUT:",str(it.get("output"))[:600])
            break
    print("--- requests:",req)

if __name__=="__main__":
    main()
