"""Summarize actual live JSON results; no target values are substituted."""
import json, sys
from pathlib import Path
r = json.loads(Path(sys.argv[1]).read_text())
b = r['browser']
def dist(values):
    values = sorted(values)
    if not values: return None
    return {"count": len(values), "p50": values[int((len(values)-1)*.5)], "p95": values[int((len(values)-1)*.95)], "max": values[-1]}
phases = []
for p in b['phases']:
    frames = b['frames'][p['first']:p['endIndex']]
    duration = (p['end'] - p['start']) / 1000
    video = [f for f in frames if f['format'] == 'h264']
    wire = [w for w in r['wireTimeline'] if p['wallStart'] <= w['at'] < p['wallEnd'] and w['peerId'] == 'pwr_fixture_viewer']
    phases.append({"name": p['name'], "durationSeconds": duration, "frames": len(frames), "videoFrames": len(video),
       "mediaBytesPerSecond": sum(f['bytes'] for f in frames)/duration,
       "videoBytesPerSecond": sum(f['bytes'] for f in video)/duration,
       "gatewayToViewerBytesPerSecond": sum(w['bytes'] for w in wire if w['direction'] == 'sent')/duration,
       "viewerToGatewayBytesPerSecond": sum(w['bytes'] for w in wire if w['direction'] == 'received')/duration,
       "videoCallbackToCanvasMs": dist([f['callbackToCanvasSameHostMs'] for f in video]),
       "encodeMs": dist([f['encodeMs'] for f in video]),
       "decodeAndPresentationMs": dist([f['decodeAndPresentMs'] for f in video])})
result = {"schema": 1, "measuredAt": r['measuredAt'], "path": r['path'], "crossMachine": r['crossMachine'],
    "requestDelayMs": r['requestDelayMs'], "decoderConfig": b.get('decoderConfig'), "phases": phases,
    "inputToCanvasMs": dist([v['inputToCanvasMs'] for v in b['inputs']]), "rpcPingMs": dist(b['pings']),
    "errors": b['errors'], "cpu": r['cpu'], "nodeMaxRssKiB": r['nodeMaxRssKiB'], "nativeLog": r['nativeLog'],
    "limits": ["Same-host real encrypted Federation, not cross-host/WAN", "Canvas callback and RAF, not photons", "Gateway wire tap excludes WebSocket/TCP headers and handshake", "Request delay is an application perturbation, not packet loss", "Fixture app helper, not OS-wide input"]}
Path(sys.argv[2]).write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps({"phases": phases, "inputToCanvasMs": result['inputToCanvasMs'], "errors": result['errors']},indent=2))
