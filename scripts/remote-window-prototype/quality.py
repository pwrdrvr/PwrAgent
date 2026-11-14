#!/usr/bin/env python3
"""Decode measured videos and compare aligned RGB frames; no claim of OCR quality."""
import json, math, pathlib, subprocess, sys
from PIL import Image, ImageChops, ImageStat
root=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2]); rows=[]
for phase in ['idle','typing','scroll','motion']:
    source=Image.open(root/('sequence-'+phase)/'0000.png').convert('RGB')
    for name,ext in [('h264-videotoolbox','mp4'),('h264-software','mp4'),('vp9-realtime','webm'),('av1-svt','mp4')]:
        frame=root/(phase+'-'+name+'-decoded.png')
        subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(root/(phase+'-'+name+'.'+ext)),'-frames:v','1',str(frame)],check=True,capture_output=True)
        decoded=Image.open(frame).convert('RGB')
        diff=ImageChops.difference(source,decoded)
        rms=ImageStat.Stat(diff).rms; mse=sum(v*v for v in rms)/3
        text=ImageStat.Stat(diff.crop((20,70,640,450))).rms
        rows.append(dict(phase=phase,codec=name,firstFrameRGBPSNR=10*math.log10(255*255/mse),textRegionRGBRMSE=math.sqrt(sum(x*x for x in text)/3)))
output.write_text(json.dumps({'note':'First decoded frame comparison only; text-region RMSE is not a readability or motion score. Color conversion affects this number.', 'results':rows},indent=2)+'\n')
