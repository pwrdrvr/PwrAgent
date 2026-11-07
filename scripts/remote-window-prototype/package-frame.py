#!/usr/bin/env python3
"""Package a single explicitly selected captured fixture PNG for the viewer."""
import base64, io, json, pathlib, sys, uuid
from PIL import Image
source, output = map(pathlib.Path, sys.argv[1:3])
im = Image.open(source).convert('RGB')
tiles = []
for y in range(0,im.height,128):
    for x in range(0,im.width,128):
        tile=im.crop((x,y,min(x+128,im.width),min(y+128,im.height)))
        b=io.BytesIO();tile.save(b,format='WEBP',lossless=True,method=1)
        tiles.append(dict(x=x,y=y,width=tile.width,height=tile.height,mime='image/webp',base64=base64.b64encode(b.getvalue()).decode()))
batch=dict(version=1,sessionId=str(uuid.uuid4()),epoch=1,ownerInstanceId='pwr_490f7727-674e-43d9-b9ee-be8387f39819',sceneId='synthetic-app-window',width=im.width,height=im.height,fps=1,frames=[dict(seq=0,baseSeq=-1,keyframe=True,captureTimeMs=float(sys.argv[3]) if len(sys.argv)>3 else None,phase='input-ack',tiles=tiles)])
output.write_text(json.dumps(batch,separators=(',',':')))
