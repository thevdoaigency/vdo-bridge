#!/usr/bin/env python3
# backfill-frames.py — extract & upload a mid-shot keyframe JPG for every existing
# shot sidecar in R2, so the UI can show per-shot thumbnails. No Qwen calls.
# Frame key mirrors the sidecar: <stem>.shotNN.visual.json -> <stem>.shotNN.frame.jpg
import os, sys, json, subprocess, tempfile
import boto3
from botocore.config import Config

BUCKET   = os.environ.get("R2_BUCKET", "vdo-library")
ENDPOINT = os.environ.get("R2_ENDPOINT") or (
    "https://%s.r2.cloudflarestorage.com" % os.environ["R2_ACCOUNT_ID"] if os.environ.get("R2_ACCOUNT_ID") else None)
AK = os.environ.get("R2_ACCESS_KEY_ID"); SK = os.environ.get("R2_SECRET_ACCESS_KEY")
PREFIX = os.environ.get("R2_PREFIX", "")
if not ENDPOINT or not AK or not SK:
    print("ERROR: R2 creds missing"); sys.exit(1)
s3 = boto3.client("s3", endpoint_url=ENDPOINT, aws_access_key_id=AK, aws_secret_access_key=SK,
                  region_name="auto", config=Config(signature_version="s3v4"))

def list_keys(prefix=""):
    keys=[]; tok=None
    while True:
        kw={"Bucket":BUCKET,"Prefix":prefix} if prefix else {"Bucket":BUCKET}
        if tok: kw["ContinuationToken"]=tok
        r=s3.list_objects_v2(**kw)
        for o in r.get("Contents",[]): keys.append(o["Key"])
        if r.get("IsTruncated"): tok=r.get("NextContinuationToken")
        else: break
    return keys

def exists(k):
    try: s3.head_object(Bucket=BUCKET,Key=k); return True
    except Exception: return False

def tc_to_sec(tc):
    try:
        p=[float(x) for x in str(tc).split(":")]; s=0.0
        for n in p: s=s*60+n
        return s
    except Exception: return None

all_keys = list_keys(PREFIX)
sidecars = [k for k in all_keys if k.endswith(".visual.json") and ".shot" in k]
have = set(all_keys)
print("shot sidecars:", len(sidecars))

# group by source clip so we pull each mp4 only once
by_clip = {}
for sc in sidecars:
    try:
        obj=s3.get_object(Bucket=BUCKET,Key=sc); tags=json.loads(obj["Body"].read())
    except Exception as e: print("  skip (read)",sc,e); continue
    clip = tags.get("_source_clip")
    prefix = sc[:sc.rfind("/")+1]
    mp4_key = prefix + clip if clip else None
    frame_key = sc.replace(".visual.json",".frame.jpg")
    mid = None
    a=tc_to_sec(tags.get("_shot_start_tc")); b=tc_to_sec(tags.get("_shot_end_tc"))
    if a is not None and b is not None and b>a: mid=(a+b)/2.0
    elif a is not None: mid=a+1.0
    else: mid=1.0
    by_clip.setdefault(mp4_key, []).append((frame_key, mid))

done=skip=fail=0
for mp4_key, shots in by_clip.items():
    if not mp4_key or not exists(mp4_key): 
        print("  mp4 missing:", mp4_key); fail+=len(shots); continue
    todo=[(fk,mid) for (fk,mid) in shots if fk not in have]
    skip+=len(shots)-len(todo)
    if not todo: 
        print("  all frames present for", mp4_key.split('/')[-1]); continue
    with tempfile.TemporaryDirectory() as td:
        local=os.path.join(td, os.path.basename(mp4_key))
        print("pulling", mp4_key.split('/')[-1], "for", len(todo), "frame(s)")
        try: s3.download_file(BUCKET, mp4_key, local)
        except Exception as e: print("   download FAIL", e); fail+=len(todo); continue
        for fk, mid in todo:
            out=os.path.join(td, os.path.basename(fk))
            subprocess.run(["ffmpeg","-y","-ss","%.3f"%mid,"-i",local,"-frames:v","1",
                            "-vf","scale=480:-2","-q:v","4",out],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.exists(out) and os.path.getsize(out)>0:
                s3.put_object(Bucket=BUCKET, Key=fk, Body=open(out,"rb").read(), ContentType="image/jpeg")
                done+=1; print("   +", fk.split('/')[-1])
            else: fail+=1; print("   FAIL", fk.split('/')[-1])
print("DONE. uploaded=%d skipped=%d failed=%d" % (done,skip,fail))
