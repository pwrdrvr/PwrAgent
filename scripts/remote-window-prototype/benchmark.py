#!/usr/bin/env python3
"""Offline codec/damage experiment over real SCK frames; never desktop capture."""
import argparse, base64, collections, hashlib, io, json, pathlib, statistics, subprocess, time, uuid
from PIL import Image

p = argparse.ArgumentParser()
p.add_argument('capture', type=pathlib.Path)
p.add_argument('--out', type=pathlib.Path, required=True)
p.add_argument('--video', action='store_true')
a = p.parse_args()
a.out.mkdir(parents=True, exist_ok=True)
rows = [json.loads(s) for s in a.capture.with_suffix('.jsonl').read_text().splitlines()]
report = {'schema': 1, 'method': 'offline encode of real SCK PNG callbacks; sequential 30fps replay; not live latency', 'phases': []}
for phase in ['idle', 'typing', 'scroll', 'motion', 'obscured', 'offscreen', 'minimized', 'restored', 'resized']:
    frames = [r for r in rows if r.get('phase') == phase and r.get('file')]
    if not frames: continue
    decoded = [Image.open(a.capture / r['file']).convert('RGB') for r in frames]
    w, h = decoded[0].size
    stats = {'phase': phase, 'width': w, 'height': h, 'frames': len(frames), 'uniquePixels': len(set(hashlib.sha256(im.tobytes()).hexdigest() for im in decoded)), 'statuses': dict(collections.Counter(str(r.get('status')) for r in rows if r.get('phase') == phase and r['kind'] == 'frame'))}
    callbacks = [r['callbackMs'] for r in frames]
    stats['captureCallbackWithPNGMsP50'] = statistics.median(callbacks)
    stats['captureCallbackWithPNGMsP95'] = sorted(callbacks)[int((len(callbacks)-1)*.95)]
    stats['encodings'] = []
    for codec, options in [('PNG', {'compress_level': 3}), ('WEBP', {'lossless': True, 'method': 1}), ('WEBP', {'quality': 85, 'method': 0})]:
        previous = {}
        total, full, times, full_times, tile_times, packets = 0, 0, [], [], [], []
        for seq, (im, r) in enumerate(zip(decoded, frames)):
            started = time.perf_counter()
            buf = io.BytesIO(); im.save(buf, format=codec, **options); full += len(buf.getvalue())
            full_done = time.perf_counter()
            full_times.append((full_done-started)*1000)
            tiles = []
            for y in range(0, h, 128):
                for x in range(0, w, 128):
                    tile = im.crop((x,y,min(w,x+128),min(h,y+128)))
                    digest = hashlib.sha256(tile.tobytes()).digest()
                    if previous.get((x,y)) == digest: continue
                    previous[x,y] = digest
                    b = io.BytesIO(); tile.save(b, format=codec, **options); raw = b.getvalue()
                    total += len(raw)
                    tiles.append({'x': x, 'y': y, 'width': tile.width, 'height': tile.height, 'mime': 'image/'+codec.lower(), 'base64': base64.b64encode(raw).decode()})
            tile_times.append((time.perf_counter()-full_done)*1000)
            times.append((time.perf_counter()-started)*1000)
            packets.append({'seq': seq, 'baseSeq': seq-1, 'keyframe': seq==0, 'captureTimeMs': r['captureTimeMs'], 'phase': phase, 'tiles': tiles})
        duration = len(frames)/30
        stats['encodings'].append({'codec': codec, 'options': options, 'fullFrameBytes': full, 'tileBytes': total, 'tileBytesPerReplaySecond': total/duration, 'steadyBytesPerReplaySecond': sum(sum(len(base64.b64decode(t['base64'])) for t in f['tiles']) for f in packets[5:])/max(1,(len(frames)-5)/30), 'fullFrameBytesPerReplaySecond': full/duration, 'fullEncodeMsP50': statistics.median(full_times), 'tileHashAndEncodeMsP50': statistics.median(tile_times), 'encodeFullPlusTilesMsP50': statistics.median(times), 'encodeFullPlusTilesMsP95': sorted(times)[int((len(times)-1)*.95)]})
        if codec == 'WEBP' and options.get('lossless'):
            batch = {'version': 1, 'sessionId': str(uuid.uuid4()), 'epoch': 1, 'ownerInstanceId': 'pwr_490f7727-674e-43d9-b9ee-be8387f39819', 'sceneId': 'synthetic-app-window', 'width': w, 'height': h, 'fps': 30, 'frames': packets}
            (a.out / f'pwrwin-{phase}-{w}.json').write_text(json.dumps(batch, separators=(',',':')))
    if a.video and phase in ['idle', 'typing', 'scroll', 'motion']:
        seqdir = a.out / ('sequence-'+phase); seqdir.mkdir(exist_ok=True)
        for i,r in enumerate(frames):
            target = seqdir / f'{i:04d}.png'
            if not target.exists(): target.symlink_to((a.capture/r['file']).resolve())
        stats['video'] = []
        for name, args, ext in [
            ('h264-videotoolbox', ['-c:v','h264_videotoolbox','-realtime','1','-allow_sw','0','-b:v','1500k','-bf','0','-g','60','-pix_fmt','yuv420p'], 'mp4'),
            ('h264-software', ['-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-crf','23','-g','60','-pix_fmt','yuv420p'], 'mp4'),
            ('vp9-realtime', ['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-row-mt','1','-lag-in-frames','0','-crf','32','-b:v','0','-pix_fmt','yuv420p'], 'webm'),
            ('av1-svt', ['-c:v','libsvtav1','-preset','12','-crf','35','-svtav1-params','lp=2:scm=1','-pix_fmt','yuv420p'], 'mp4'),
        ]:
            dest = a.out / f'{phase}-{name}.{ext}'
            cmd = ['ffmpeg','-y','-hide_banner','-loglevel','error','-framerate','30','-i',str(seqdir/'%04d.png'),*args,str(dest)]
            start=time.perf_counter(); result=subprocess.run(cmd, capture_output=True); elapsed=time.perf_counter()-start
            stats['video'].append({'name':name,'command':cmd,'exitCode':result.returncode,'bytes':dest.stat().st_size if dest.exists() else 0,'wallSeconds':elapsed,'framesPerWallSecond':len(frames)/elapsed,'error':result.stderr.decode()[-1500:] if result.returncode else None})
    report['phases'].append(stats)
    print(phase, 'complete', flush=True)
(a.out/'benchmark.json').write_text(json.dumps(report,indent=2)+'\n')
