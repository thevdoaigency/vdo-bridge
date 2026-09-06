#!/usr/bin/env python3
# tag-shots-r2.py — R2-native per-shot b-roll tagger for AWC Bridge.
import os, sys, json, base64, subprocess, time, tempfile
import boto3
from botocore.config import Config

BUCKET   = os.environ.get("R2_BUCKET", "awc-library")
ENDPOINT = os.environ.get("R2_ENDPOINT") or (
    "https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"]
    if os.environ.get("R2_ACCOUNT_ID") else None)
AK = os.environ.get("R2_ACCESS_KEY_ID")
SK = os.environ.get("R2_SECRET_ACCESS_KEY")
PREFIX = os.environ.get("R2_PREFIX", "")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434") + "/api/generate"
MODEL = "qwen2.5vl:32b"
BROLL_MARKER = "_broll_"
SCENEDETECT = os.path.expanduser("~/.local/bin/scenedetect")

COMPANY_NAMES = {"LE":"Leopardo Efficiency","LC":"Leopardo Construction","GKE":"Grand Kahn Electric",
  "LH":"Laystrom Hardware","EBT":"Enlyt Building Technologies","DFH":"DFH Connect","GP":"GATOR",
  "LCI":"LCI Development Partners","AWC":"Alexander West Capital"}

def log(m):
    print("[%s] %s" % (time.strftime('%H:%M:%S'), m), flush=True)

if not ENDPOINT or not AK or not SK:
    log("ERROR: R2 credentials missing — set R2_ENDPOINT/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY"); sys.exit(1)

import urllib.request
s3 = boto3.client("s3", endpoint_url=ENDPOINT, aws_access_key_id=AK, aws_secret_access_key=SK,
                  region_name="auto", config=Config(signature_version="s3v4"))

def list_keys(prefix=""):
    keys=[]; token=None
    while True:
        kw={"Bucket":BUCKET,"Prefix":prefix} if prefix else {"Bucket":BUCKET}
        if token: kw["ContinuationToken"]=token
        r=s3.list_objects_v2(**kw)
        for o in r.get("Contents",[]): keys.append(o["Key"])
        if r.get("IsTruncated"): token=r.get("NextContinuationToken")
        else: break
    return keys

def key_exists(key):
    try: s3.head_object(Bucket=BUCKET,Key=key); return True
    except Exception: return False

def parse_filename(key):
    parts=os.path.splitext(os.path.basename(key))[0].split("_"); info={"company_id":"","city":"","title":""}
    if len(parts)>=5: info["company_id"]=parts[1]; info["city"]=parts[2]; info["title"]="_".join(parts[4:])
    return info

def build_prompt(info):
    company=COMPANY_NAMES.get(info["company_id"],info["company_id"])
    ctx="This b-roll was shot for %s in %s." % (company, info["city"]) if info["city"] else ("This b-roll was shot for %s." % company)
    return ("You are tagging ONE still frame from a b-roll clip for a searchable media library. "
      "Describe ONLY what is visibly in THIS frame — ignore any assumptions about the filename or the rest of the reel; "
      "different frames from the same clip will show different things, so be specific to what you actually see here. "
      + ctx + " "
      "Return JSON with fields: subject, action, setting, shot_type, equipment_visible, signage_or_branding, time_of_day, keywords. "
      "'subject' = what the main thing in frame IS by function, in plain words (e.g. 'brick building exterior', 'drop-ceiling office interior', 'worker on a ladder', 'rooftop HVAC unit', 'parking lot'). "
      "Do NOT output CamelCase labels, filenames, or the words 'gimbal'/'drone'/'broll'. Write natural descriptive terms. "
      "'keywords' = 8-15 short natural-language search terms a person might type to find THIS specific shot. "
      "Read any visible product names, model numbers, or signage into signage_or_branding. Return only JSON.")

def detect_shots(clip):
    try:
        subprocess.run([SCENEDETECT,"-i",clip,"detect-adaptive","list-scenes","-o","/tmp","-f","/tmp/_scenes.csv","-q"],
                       capture_output=True,text=True,timeout=900)
        p="/tmp/_scenes.csv"; shots=[]
        if os.path.exists(p):
            with open(p) as f: lines=[l for l in f if l.strip()]
            for l in lines:
                c=l.split(",")
                if len(c)>=6 and c[0].strip().isdigit():
                    try: shots.append((int(c[1]),int(c[4]),c[2].strip(),c[5].strip()))
                    except (ValueError,IndexError): continue
            os.remove(p)
        if shots: return shots
    except Exception as e: log("  scenedetect failed (%s)" % e)
    return [(0,0,"00:00:00.000","")]

_FPS_CACHE={}
def _fps(clip):
    if clip in _FPS_CACHE: return _FPS_CACHE[clip]
    fps=23.976
    try:
        r=subprocess.run(["ffprobe","-v","0","-select_streams","v:0","-show_entries","stream=r_frame_rate",
                          "-of","default=nk=1:nw=1",clip],capture_output=True,text=True,timeout=60)
        val=r.stdout.strip()
        if "/" in val:
            n,d=val.split("/"); fps=float(n)/float(d) if float(d) else 23.976
        elif val: fps=float(val)
    except Exception: pass
    _FPS_CACHE[clip]=fps; return fps
def _mid_seconds(clip,sf,ef):
    fps=_fps(clip)
    if ef and ef>sf: return ((sf+ef)/2.0)/fps
    return (sf/fps)+1.0 if sf else 1.0

def extract(clip,seek_sec,out):
    subprocess.run(["ffmpeg","-y","-ss","%.3f"%max(seek_sec,0.0),"-i",clip,"-frames:v","1",out],
                   stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    return os.path.exists(out) and os.path.getsize(out)>0

def tag(jpg,prompt):
    img=base64.b64encode(open(jpg,"rb").read()).decode()
    payload=json.dumps({"model":MODEL,"prompt":prompt,"images":[img],"stream":False,"format":"json"}).encode()
    req=urllib.request.Request(OLLAMA_URL,data=payload,headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=900) as r:
        return json.loads(json.loads(r.read().decode())["response"])

def main():
    all_keys=list_keys(PREFIX)
    broll=[k for k in all_keys if k.lower().endswith(".mp4") and BROLL_MARKER in k.lower()]
    have=set(all_keys)
    log("Found %d b-roll clip(s) in R2%s" % (len(broll), (" under "+PREFIX) if PREFIX else ""))
    tot=done=skip=fail=0
    for ci,key in enumerate(sorted(broll),1):
        info=parse_filename(key); prompt=build_prompt(info)
        stem=os.path.splitext(key)[0]
        with tempfile.TemporaryDirectory() as td:
            local=os.path.join(td, os.path.basename(key))
            log("(%d/%d) pulling %s" % (ci,len(broll),os.path.basename(key)))
            try: s3.download_file(BUCKET,key,local)
            except Exception as e: log("  download FAIL (%s)" % e); continue
            shots=detect_shots(local)
            log("   %d shot(s)" % len(shots))
            for si,(sf,ef,stc,etc) in enumerate(shots,1):
                tot+=1
                sidecar_key="%s.shot%02d.visual.json" % (stem,si)
                if sidecar_key in have or key_exists(sidecar_key): skip+=1; continue
                jpg=os.path.join(td,"shot%02d.jpg"%si)
                try:
                    mid=_mid_seconds(local,sf,ef)
                    if not extract(local,mid,jpg): fail+=1; log("    shot %d: FAIL keyframe"%si); continue
                    t=tag(jpg,prompt)
                    t["_source_clip"]=os.path.basename(key); t["_company"]=info["company_id"]; t["_city"]=info["city"]
                    t["_shot_index"]=si; t["_shot_start_frame"]=sf; t["_shot_end_frame"]=ef
                    t["_shot_start_tc"]=stc; t["_shot_end_tc"]=etc
                    s3.put_object(Bucket=BUCKET,Key=sidecar_key,
                                  Body=json.dumps(t,indent=2).encode(),ContentType="application/json")
                    done+=1; log("    shot %d: tagged [%s] %s" % (si,stc,t.get("subject","?")))
                except Exception as e: fail+=1; log("    shot %d: FAIL (%s)"%(si,e))
    log("DONE. clips=%d shots=%d tagged=%d skipped=%d failed=%d" % (len(broll),tot,done,skip,fail))

if __name__=="__main__": main()
