#!/usr/bin/env python3
"""Reconstruct each lossless delta and compare every RGB pixel to captured source."""
import base64, io, json, pathlib, sys
from PIL import Image, ImageChops
capture, batches, output = map(pathlib.Path, sys.argv[1:4])
rows=[json.loads(s) for s in capture.with_suffix('.jsonl').read_text().splitlines()]
results=[]
for path in sorted(batches.glob('pwrwin-*.json')):
    b=json.loads(path.read_text()); phase=b['frames'][0]['phase']
    source=[r for r in rows if r.get('phase')==phase and r.get('file')]
    canvas=Image.new('RGB',(b['width'],b['height'])); count=0
    for frame,row in zip(b['frames'],source,strict=True):
        for tile in frame['tiles']:
            im=Image.open(io.BytesIO(base64.b64decode(tile['base64']))).convert('RGB')
            canvas.paste(im,(tile['x'],tile['y']))
        expected=Image.open(capture/row['file']).convert('RGB')
        assert ImageChops.difference(canvas,expected).getbbox() is None,(phase,frame['seq'])
        count+=1
    results.append(dict(phase=phase,frames=count,rgbPixelExact=True))
output.write_text(json.dumps(results,indent=2)+'\n')
print(sum(x['frames']for x in results),'frames match captured RGB exactly')
