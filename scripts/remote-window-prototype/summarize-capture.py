#!/usr/bin/env python3
"""Retain numeric observations without private inventory or raw dirty-rect logs."""
import collections, json, pathlib, statistics, sys
root=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2]); reports=[]
for prefix in ['capture-1x','capture-2x','native-final-1x','native-final-2x']:
    rows=[json.loads(x)for x in (root/(prefix+'.jsonl')).read_text().splitlines()]
    if rows[-1]['kind']!='done': raise RuntimeError(prefix+' incomplete')
    phases=[x for x in rows if x['kind']=='phase']; report={'run':prefix,'metadata':[x for x in rows if x['kind']in ['permission','encoder']], 'streamStops':[x for x in rows if x['kind']=='stop'], 'phases':[]}
    for i,p in enumerate(phases):
        name=p['phase'];frames=[x for x in rows if x.get('phase')==name and x['kind']=='frame'];encoded=[x for x in rows if x.get('phase')==name and x['kind']=='encoded']; times=[x['captureCallbackToEncodeMs']for x in encoded]
        end=phases[i+1]['time']if i+1<len(phases)else (frames[-1]['captureTimeMs']/1000 if frames else p['time']+4)
        duration=end-p['time']
        item={'phase':name,'durationSeconds':duration,'callbacks':len(frames),'statuses':dict(collections.Counter(str(x['status'])for x in frames)),'savedPNGs':sum('file'in x for x in frames),'encodedFrames':len(encoded),'encodedBytes':sum(x['bytes']for x in encoded),'encodeErrors':sum(x['status']!=0 for x in encoded),'dropped':sum(x['dropped']for x in encoded)}
        if times:item.update(encodeMsP50=statistics.median(times),encodeMsP95=sorted(times)[int((len(times)-1)*.95)],encodedBytesPerSecond=item['encodedBytes']/duration)
        saved=[x['callbackMs']for x in frames if 'file'in x]
        if saved:item.update(pngCallbackMsP50=statistics.median(saved),pngCallbackMsP95=sorted(saved)[int((len(saved)-1)*.95)])
        report['phases'].append(item)
    resources=('resources-'+prefix.removeprefix('capture-') if prefix.startswith('capture-') else prefix.replace('native-final-','native-final-resources-'))+'.txt'
    lines=(root/resources).read_text().splitlines(); parts=lines[0].split(); report['processResources']={'realSeconds':float(parts[0]),'userCPUSeconds':float(parts[2]),'systemCPUSeconds':float(parts[4]),'maxRSSBytes':int(lines[1].split()[0]),'energyJoules':None,'gpuUtilization':None}
    reports.append(report)
out.write_text(json.dumps({'note':'SCK own-window experiments; native-final runs are sequential. PNG callback includes CPU readback and synchronous disk export. Encoder bytes exclude transport/container. Energy/GPU counters unavailable.', 'runs':reports},indent=2)+'\n')
