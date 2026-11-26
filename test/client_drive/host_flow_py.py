#!/usr/bin/env python3
# C4->C7 驱动。复用现有项目。逐镜 shoot→poll→取 clip→抽帧；演唱镜→lipsync→align→compose。
import json, subprocess, time, sys, os, urllib.request, hashlib, glob
BASE="http://192.168.1.10:7900"
PID="mvp_e4b5cdfe75dd0e898bdb"
EV="deploy/spark/evidence/flow-1126-1614"
os.makedirs(EV, exist_ok=True)

def token():
    req=urllib.request.Request(BASE+"/v1/auth/guest",data=json.dumps({"device_key":"host-flow-1612"}).encode(),
        headers={"content-type":"application/json"})
    return json.load(urllib.request.urlopen(req,timeout=10))["access_token"]
AT=token()

def post(path, body):
    req=urllib.request.Request(BASE+path,data=json.dumps(body).encode(),
        headers={"content-type":"application/json","authorization":f"Bearer {AT}"},method="POST")
    return json.load(urllib.request.urlopen(req,timeout=60))

def get(path):
    req=urllib.request.Request(BASE+path,headers={"authorization":f"Bearer {AT}"})
    return json.load(urllib.request.urlopen(req,timeout=30))

def poll(jid,n=150):
    for _ in range(n):
        j=get(f"/v1/jobs/{jid}")
        if j.get("status")=="done": return j
        if j.get("status")=="failed": return j
        time.sleep(3)
    return get(f"/v1/jobs/{jid}")

def dl(url,out):
    urllib.request.retrieve(url,out) if False else None
    with open(out,"wb") as f:
        f.write(urllib.request.urlopen(url,timeout=120).read())
    h=hashlib.sha256(open(out,"rb").read()).hexdigest()[:16]
    return os.path.getsize(out),h

def frames(mp4,d,n=3):
    os.makedirs(d,exist_ok=True)
    out=[]
    for i in range(n):
        t=(i+1)*(float(subprocess.check_output(["ffprobe","-v","error","-select_streams","v:0",
            "-show_entries","format=duration","-of","default=nw=1:np=1",mp4]).decode().strip())/(n+1))
        subprocess.run(["ffmpeg","-y","-v","error","-i",mp4,"-vf",f"fps=fps=1/{int(max(1,t)*n)}",
            f"{d}/f{i}.jpg"],check=True)
        out.append(f"{d}/f{i}.jpg")
    return out

# 直查 DB 取 clip(无 takes 端点)
DB="var/db/musicbox.sqlite"
def clip_url_for(shot_id):
    try:
        q=shot_id.replace("'","''")
        row=subprocess.check_output(["sqlite3",DB,
            f"SELECT video_url FROM mv_takes WHERE shot_id='{q}' ORDER BY rowid DESC LIMIT 1"]).decode().strip()
        if row:
            rel=row.split("\t")[-1] if "\t" in row else row
            return BASE+f"/f/{rel}"
    except Exception as e:
        pass
    time.sleep(1)
    pj=get(f"/v1/mv/projects/{PID}")
    for s in pj["shots"]:
        if s["id"]==shot_id:
            if s.get("best_take_id"):
                cu=clip_url_for(shot_id)
                if cu and str(cu).endswith(".mp4"): return cu
            return s.get("first_frame_url") or s.get("storyboard_url")
    return None

# 1) 取所有 draft 镜
pj=get(f"/v1/mv/projects/{PID}")
shots=[s for s in pj["shots"] if s["status"]=="draft"]
print(f"=== C4 shoot {len(shots)} draft shots ===",flush=True)
for s in shots:
    r=post(f"/v1/mv/projects/{PID}/jobs",{"type":"shoot","params":{"shot_id":s["id"]}})
    jid=r.get("job_id"); j=poll(jid)
    cu=clip_url_for(s["id"])
    if not (cu and str(cu).endswith(".mp4")):
        time.sleep(3); cu=clip_url_for(s["id"])
    st=j.get("status","")
    if cu and str(cu).endswith(".mp4"):
        sz,h=dl(cu,f"{EV}/c4_shot_{s['id']}.mp4")
        fr=frames(f"{EV}/c4_shot_{s['id']}.mp4",f"{EV}/c4_shot_{s['id']}",n=2)
        print(f"  shoot {s['id']} {s['kind']} -> clip {sz}B sha={h} frames={fr}",flush=True)
    else:
        print(f"  shoot {s['id']} {s['kind']} job={jid} status={st} clipUrl={cu}",flush=True)

# 2) 演唱镜口型
singing=[s for s in pj["shots"] if s["kind"]=="singing"]
print(f"=== C5 lipsync {len(singing)} singing shots ===",flush=True)
for s in singing:
    r=post(f"/v1/mv/projects/{PID}/jobs",{"type":"lipsync","params":{"shot_id":s["id"]}})
    jid=r.get("job_id"); j=poll(jid)
    print(f"  lipsync {s['id']} job={jid} status={j.get('status')}",flush=True)

# 3) 对齐
r=post(f"/v1/mv/projects/{PID}/jobs",{"type":"align"})
print("=== C6 align job=",r.get("job_id"),flush=True)

# 4) 合成
r=post(f"/v1/mv/projects/{PID}/jobs",{"type":"compose"})
j=poll(r.get("job_id"))
pj=get(f"/v1/mv/projects/{PID}")
mv=None
for k in ("mv_video_url","video_url","poster_url","cover_url"):
    if isinstance(pj.get("project"),dict) and pj["project"].get(k): mv=pj["project"][k]
print("=== C7 compose job=",r.get("job_id"),"status=",j.get("status"),"mv=",mv,flush=True)
if mv:
    sz,h=dl(mv,f"{EV}/c7_mv_video.mp4")
    print("  mv_video",sz,"B",h,flush=True)
print("ALL-DONE",flush=True)
