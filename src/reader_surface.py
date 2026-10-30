"""Geometry and glyph-mask cleanup. No OCR/model inference occurs in this module."""
import base64
import hashlib
import io
import math
import cv2
import numpy as np
from PIL import Image
from reader_learned_mask import supported_components, fill_supported_mask


def bbox(value, width, height):
    x0=max(0,min(width-1,int(math.floor(value.get('x0',0)))))
    y0=max(0,min(height-1,int(math.floor(value.get('y0',0)))))
    x1=max(x0+1,min(width,int(math.ceil(value.get('x1',x0+1)))))
    y1=max(y0+1,min(height,int(math.ceil(value.get('y1',y0+1)))))
    return x0,y0,x1,y1


def as_box(b):
    return dict(zip(('x0','y0','x1','y1'),map(int,b)))


def png64(image):
    ok,encoded=cv2.imencode('.png',image)
    if not ok: raise ValueError('Cannot encode cleanup patch')
    return base64.b64encode(encoded).decode('ascii')


def largest_rectangle(mask, anchor):
    # Keep text centered on its source anchor; all rectangle pixels must be safe.
    ay,ax=map(int,anchor);height,width=mask.shape
    if not mask[ay,ax]:return None
    limits=[]
    for row in mask:
        if not row[ax]:limits.append(0);continue
        left=np.where(row[:ax+1]==0)[0];right=np.where(row[ax:]==0)[0]
        lo=int(left[-1]+1) if len(left) else 0
        hi=int(ax+right[0]) if len(right) else width
        limits.append(min(ax-lo+1,hi-ax))
    best=None;best_area=0
    for half in range(1,min(ay+1,height-ay)+1):
        radius=min(limits[ay-half+1:ay+half])
        if radius<1:break
        box=(ax-radius+1,ay-half+1,ax+radius,ay+half)
        area=(box[2]-box[0])*(box[3]-box[1])
        if area>best_area:best,best_area=box,area
    return best


def build_surfaces(gray):
    height,width=gray.shape;surfaces=[]
    for threshold,dark in [(242,False),(250,False),(225,False),(205,False),(30,True)]:
        binary=(gray<=threshold if dark else gray>=threshold).astype(np.uint8)
        count,labels,stats,_=cv2.connectedComponentsWithStats(binary,8)
        for k in range(1,count):
            x,y,w,h,size=map(int,stats[k])
            if size<400 or w<20 or h<20 or x==0 or y==0 or x+w>=width or y+h>=height or w*h>width*height*.24: continue
            local=(labels[y:y+h,x:x+w]==k).astype(np.uint8)
            contours,_=cv2.findContours(local,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
            if not contours: continue
            contour=max(contours,key=cv2.contourArea);filled=np.zeros_like(local)
            cv2.drawContours(filled,[contour],-1,1,-1)
            filled_area=int(filled.sum())
            if filled_area<600 or size/max(1,filled_area)<.38: continue
            # Repair character-sized inward dents, never dilate into neighboring art.
            filled=cv2.morphologyEx(filled,cv2.MORPH_CLOSE,np.ones((5,5),np.uint8))
            surfaces.append({'x':x,'y':y,'w':w,'h':h,'mask':filled,'area':filled_area,'threshold':threshold,'dark':dark})
    return surfaces


def coverage(surface, box):
    x0,y0,x1,y1=map(int,box);x=surface['x'];y=surface['y']
    ax0=max(0,x0-x);ay0=max(0,y0-y);ax1=min(surface['w'],x1-x);ay1=min(surface['h'],y1-y)
    if ax1<=ax0 or ay1<=ay0: return 0
    return float(surface['mask'][ay0:ay1,ax0:ax1].sum())/max(1,(x1-x0)*(y1-y0))


def rectangle_for_region(gray, box):
    height,width=gray.shape;x0,y0,x1,y1=box;tw=x1-x0;th=y1-y0
    if tw<55 or th<65:return None
    px=max(25,int(tw*.90));py=max(25,int(th*.90))
    sx=max(0,x0-px);sy=max(0,y0-py);ex=min(width,x1+px);ey=min(height,y1+py)
    dark=(gray[sy:ey,sx:ex]<115).astype(np.uint8)
    vertical=cv2.morphologyEx(dark,cv2.MORPH_OPEN,np.ones((max(35,int(th*.52)),1),np.uint8))
    horizontal=cv2.morphologyEx(dark,cv2.MORPH_OPEN,np.ones((1,max(40,int(tw*.58))),np.uint8))
    def components(mask,vertical_axis):
        _,_,stats,_=cv2.connectedComponentsWithStats(mask,8);out=[]
        for x,y,w,h,size in stats[1:]:
            if (vertical_axis and w<=max(5,tw*.07) and h>=th*.52) or (not vertical_axis and h<=max(5,th*.07) and w>=tw*.58):out.append((int(x+sx),int(y+sy),int(x+w+sx),int(y+h+sy)))
        return out
    vs=components(vertical,True);hs=components(horizontal,False)
    left=sorted([v for v in vs if v[0]<(x0+x1)/2 and abs(v[0]-x0)<=px],key=lambda v:abs(v[0]-x0))[:3]
    right=sorted([v for v in vs if v[2]>(x0+x1)/2 and abs(v[2]-x1)<=px],key=lambda v:abs(v[2]-x1))[:3]
    best=None;cost=1e9
    for l in left:
        for r in right:
            lx=l[2]+1;rx=r[0]-1
            if rx-lx<tw*.65 or rx-lx>tw*2.7:continue
            spans=[h for h in hs if min(h[2],r[2])-max(h[0],l[0])>(rx-lx)*.80]
            tops=[h for h in spans if h[1]<(y0+y1)/2 and abs(h[1]-y0)<=py]
            bottoms=[h for h in spans if h[3]>(y0+y1)/2 and abs(h[3]-y1)<=py]
            if not tops and not bottoms:continue
            top=min(tops,key=lambda h:abs(h[3]-y0))[3]+1 if tops else max(l[1],r[1])+1
            bottom=min(bottoms,key=lambda h:abs(h[1]-y1))[1]-1 if bottoms else min(l[3],r[3])-1
            if bottom-top<th*.70 or bottom-top>th*2.8:continue
            if min(l[3],r[3])<bottom-8 or max(l[1],r[1])>top+8:continue
            cover=max(0,min(rx,x1)-max(lx,x0))*max(0,min(bottom,y1)-max(top,y0))/max(1,tw*th)
            if cover<.70:continue
            score=(abs(lx-x0)+abs(rx-x1))/tw+(abs(top-y0)+abs(bottom-y1))/th+(.15 if not tops or not bottoms else 0)
            light=float(np.mean(gray[top:bottom,lx:rx]>180))
            if light<.65 or score>1.75:continue
            if score<cost:
                cost=score;w=rx-lx;h=bottom-top
                best={'x':lx,'y':top,'w':w,'h':h,'mask':np.ones((h,w),np.uint8),'area':w*h,'threshold':242,'dark':False,'outlineRectangle':True}
    return best


def select_surface(surfaces, region, width, height, gray=None):
    b=bbox(region['bbox'],width,height);cx=(b[0]+b[2])//2;cy=(b[1]+b[3])//2
    framed=rectangle_for_region(gray,b) if gray is not None else None
    candidates=surfaces+([framed] if framed else [])
    lines=[bbox(l.get('bbox',{}),width,height) for l in region.get('recognitionLines',[]) if l.get('bbox')]
    best=None;best_score=-1
    for s in candidates:
        lx=cx-s['x'];ly=cy-s['y']
        if not (0<=lx<s['w'] and 0<=ly<s['h'] and s['mask'][ly,lx]): continue
        cover=coverage(s,b);ratio=s['area']/max(1,(b[2]-b[0])*(b[3]-b[1]))
        if cover<.48 or not .5<=ratio<=9: continue
        support=sum(coverage(s,l)>.5 for l in lines)/max(1,len(lines)) if lines else cover
        if lines and support<.7: continue
        score=min(cover,.8)*.5+support*.9-math.sqrt(ratio)*.65+(s['threshold']/1000 if not s['dark'] else 0)+(.10 if s.get('outlineRectangle') else 0)
        if score>best_score:best=s;best_score=score
    return best


def polygon(mask,x,y):
    contours,_=cv2.findContours(mask.astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    if not contours:return []
    c=max(contours,key=cv2.contourArea)
    points=cv2.approxPolyDP(c,max(.65,cv2.arcLength(c,True)*.0015),True).reshape(-1,2)
    return [[int(px+x),int(py+y)] for px,py in points]


def safe_geometry(surface, region, image_width, image_height, custom_mask=None):
    mask=(custom_mask if custom_mask is not None else surface['mask']).astype(np.uint8)
    mask=cv2.erode(np.pad(mask,2),np.ones((3,3),np.uint8))[2:-2,2:-2]
    x,y=surface['x'],surface['y'];b=bbox(region['bbox'],image_width,image_height)
    cx=min(mask.shape[1]-1,max(0,(b[0]+b[2])//2-x));cy=min(mask.shape[0]-1,max(0,(b[1]+b[3])//2-y))
    if not mask[cy,cx]:
        yy,xx=np.where(mask>0)
        if not len(xx):return None
        i=np.argmin((xx-cx)**2+(yy-cy)**2);cx=int(xx[i]);cy=int(yy[i])
    inner=cv2.erode(np.pad(mask,4),np.ones((7,7),np.uint8))[4:-4,4:-4]
    usable=inner if inner[cy,cx] else mask
    distance=cv2.distanceTransform(np.pad(usable,1),cv2.DIST_L2,5)[1:-1,1:-1]
    ax0=max(0,b[0]-x);ay0=max(0,b[1]-y);ax1=min(mask.shape[1],b[2]-x);ay1=min(mask.shape[0],b[3]-y)
    if ax1>ax0 and ay1>ay0:
        search=distance[ay0:ay1,ax0:ax1];maximum=float(search.max())
        if maximum>2:
            py,px=np.where(search>=maximum*.985)
            if len(px):cx=int(np.median(px))+ax0;cy=int(np.median(py))+ay0
    safe=largest_rectangle(usable,(cy,cx))
    if not safe:return None
    points=polygon(mask,x,y)
    ys,xs=np.where(mask>0)
    return {'polygon':points,'eraseBox':as_box((x+xs.min(),y+ys.min(),x+xs.max()+1,y+ys.max()+1)),
        'safeBox':as_box((safe[0]+x,safe[1]+y,safe[2]+x,safe[3]+y)),'mask':mask}


def split_hints(surface, region, rgb):
    if surface['dark'] or region.get('layoutSplit') or len(region.get('recognitionLines',[]))<4:return []
    m=surface['mask'];contours,_=cv2.findContours(m,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    contour=max(contours,key=cv2.contourArea)
    solidity=cv2.contourArea(contour)/max(1,cv2.contourArea(cv2.convexHull(contour)))
    if solidity>.965 or region.get('segmentationLocked'):return []
    d=cv2.distanceTransform(np.pad(m,1),cv2.DIST_L2,5)[1:-1,1:-1];radius=max(12,int(min(m.shape)*.13))
    peaks=((d>=cv2.dilate(d,np.ones((2*radius+1,2*radius+1),np.uint8))-.01)&(d>min(m.shape)*.12)).astype(np.uint8)
    n,ls=cv2.connectedComponents(peaks);centers=[]
    for k in range(1,n):
        yy,xx=np.where(ls==k);i=np.argmax(d[yy,xx]);centers.append((int(xx[i]),int(yy[i]),float(d[yy[i],xx[i]])))
    selected=[]
    for p in sorted(centers,key=lambda p:-p[2]):
        if all(math.hypot(p[0]-q[0],p[1]-q[1])>max(p[2],q[2])*1.30 for q in selected):selected.append(p)
    if len(selected)!=2:return []
    a,b=selected;xx=np.linspace(a[0],b[0],80).astype(int);yy=np.linspace(a[1],b[1],80).astype(int)
    bottleneck=float(d[yy[10:-10],xx[10:-10]].min())/max(1,min(a[2],b[2]))
    if bottleneck>=.89:return []
    # Both lobes must actually be covered by this reading, not a neighbor's text.
    rb=region['bbox'];sx,sy=surface['x'],surface['y']
    for px,py,_ in selected:
        if not rb['x0']-12<=sx+px<=rb['x1']+12 or not rb['y0']-25<=sy+py<=rb['y1']+25:return []
    yy,xx=np.indices(m.shape);ownership=np.argmin(np.stack([(xx-p[0])**2+(yy-p[1])**2 for p in selected]),axis=0)
    hints=[];height,width=rgb.shape[:2]
    for i,p in enumerate(selected):
        part=((m>0)&(ownership==i)).astype(np.uint8)
        gy,gx=np.where(part>0)
        if not len(gx):return []
        x0,y0,x1,y1=int(gx.min()),int(gy.min()),int(gx.max()+1),int(gy.max()+1)
        image=rgb[sy+y0:sy+y1,sx+x0:sx+x1].copy();image[part[y0:y1,x0:x1]==0]=255
        hints.append({'bbox':as_box((sx+x0,sy+y0,sx+x1,sy+y1)),
            'polygon':polygon(part,sx,sy),'image':png64(cv2.cvtColor(image,cv2.COLOR_RGB2BGR)),
            'reason':'two-lobes-with-measured-neck','bottleneck':round(bottleneck,4)})
    return sorted(hints,key=lambda a:(a['bbox']['y0'], -a['bbox']['x0']))


def foreign_reading_lines(region, peer):
    lines=peer.get('recognitionLines') or [{'bbox':peer['bbox']}]
    if not peer.get('excludeFromLayoutCompetition'):return lines
    own=region.get('recognitionLines',[])
    def covered(line):
        b=line['bbox'];area=max(1,(b['x1']-b['x0'])*(b['y1']-b['y0']))
        for host in own:
            a=host['bbox']
            overlap=max(0,min(a['x1'],b['x1'])-max(a['x0'],b['x0']))*max(0,min(a['y1'],b['y1'])-max(a['y0'],b['y0']))
            if overlap/area>=.90 and host.get('confidence',0)>=95 and len(str(host.get('text','')))>=len(str(line.get('text','')))*1.5:return True
        return False
    # A rejected crop can re-read a fragment of an accepted complete line.
    # Keep its independent lines protected, but do not give the duplicate
    # fragment ownership over the longer high-confidence reading.
    return [line for line in lines if not covered(line)]


def protect_neighbor_ink(ink, structural, region, peers, origin):
    """Preserve whole connected strokes touching another reading's source zone."""
    x0,y0=origin
    foreign=np.zeros_like(ink)
    foreign_evidence=np.zeros_like(ink)
    zones=list(region.get('protectedLines',[]))
    for peer in peers:
        if peer is region:continue
        zones.extend(foreign_reading_lines(region,peer))
    used=0
    for line in zones:
        b=line.get('bbox')
        if not b:continue
        ax=max(0,int(math.floor(b['x0']))-x0);ay=max(0,int(math.floor(b['y0']))-y0)
        bx=min(ink.shape[1],int(math.ceil(b['x1']))-x0);by=min(ink.shape[0],int(math.ceil(b['y1']))-y0)
        if bx<=ax or by<=ay:continue
        points=line.get('polygon')
        if points and len(points)>=3:
            cv2.fillPoly(foreign,[np.rint(np.asarray(points)-[x0,y0]).astype(np.int32)],255)
            if str(line.get('text','')).strip():
                cv2.fillPoly(foreign_evidence,[np.rint(np.asarray(points)-[x0,y0]).astype(np.int32)],255)
        else:foreign[ay:by,ax:bx]=255
        used+=1
    if not used:return ink,{'neighborZones':0,'protectedPixels':0,'ambiguousPixels':0}
    # Do not assign a stroke by centroid or cut it at the rectangle midpoint.
    # A touching N/W, for example, is one unresolved connected component.
    count,labels,_,_=cv2.connectedComponentsWithStats(structural,8)
    ids=np.unique(labels[(foreign>0)&(structural>0)])
    ids=ids[ids!=0]
    own=np.zeros_like(ink)
    own_evidence=np.zeros_like(ink)
    for line in region.get('recognitionLines') or [{'bbox':region['bbox']}]:
        b=line['bbox'];ax=max(0,int(math.floor(b['x0']))-x0);ay=max(0,int(math.floor(b['y0']))-y0)
        bx=min(ink.shape[1],int(math.ceil(b['x1']))-x0);by=min(ink.shape[0],int(math.ceil(b['y1']))-y0)
        if bx>ax and by>ay:
            points=line.get('polygon')
            if points and len(points)>=3:
                cv2.fillPoly(own,[np.rint(np.asarray(points)-[x0,y0]).astype(np.int32)],255)
                if str(line.get('text','')).strip():
                    cv2.fillPoly(own_evidence,[np.rint(np.asarray(points)-[x0,y0]).astype(np.int32)],255)
            else:own[ay:by,ax:bx]=255
    # Padded line quadrilaterals can graze a neighboring complete glyph.
    # Assign only whole, fully contained components, never a centroid or a cut.
    # Components shared in full, crossing both zones, or clipped at the patch
    # edge retain the conservative ambiguity gate.
    sizes=np.bincount(labels.ravel(),minlength=count)
    own_counts=np.bincount(labels[own>0],minlength=count)
    foreign_counts=np.bincount(labels[foreign>0],minlength=count)
    own_evidence_counts=np.bincount(labels[own_evidence>0],minlength=count)
    foreign_evidence_counts=np.bincount(labels[foreign_evidence>0],minlength=count)
    edge_ids=np.unique(np.concatenate((labels[0],labels[-1],labels[:,0],labels[:,-1])))
    complete_own=(own_counts==sizes)&(sizes>0)
    complete_foreign=(foreign_counts==sizes)&(sizes>0)
    complete_own[edge_ids]=False;complete_foreign[edge_ids]=False
    # A fallback region rectangle is not positioned recognition evidence.
    owned_ids=np.flatnonzero(complete_own&~complete_foreign&(own_evidence_counts==sizes))
    foreign_only_ids=np.flatnonzero(complete_foreign&~complete_own&(foreign_evidence_counts==sizes))
    ids=ids[~np.isin(ids,owned_ids)]
    connected=np.isin(labels,ids).astype(np.uint8)*255
    protected=cv2.bitwise_or(foreign,cv2.dilate(connected,np.ones((3,3),np.uint8)))
    protected[np.isin(labels,owned_ids)]=0
    removed=(ink>0)&(protected>0)
    ambiguous=removed&(own>0)&(structural>0)&~np.isin(labels,foreign_only_ids)
    evidence={'neighborZones':used,'protectedPixels':int(removed.sum()),'ambiguousPixels':int(ambiguous.sum())}
    return cv2.bitwise_and(ink,cv2.bitwise_not(protected)),evidence


def protect_unread_shapes(ink, structural, region, origin, diagnostic=False):
    """Reject foreground shapes mostly outside the measured reading lines.

    A paragraph rectangle is not evidence that the artwork between lines is
    text. Keep connected shapes intact, including shapes crossing a crop edge.
    """
    lines=region.get('recognitionLines',[])
    if not lines:return ink,{'unreadShapePixels':0,'uncertainSourcePixels':0}
    x0,y0=origin;source=np.zeros_like(ink)
    for line in lines:
        b=line.get('bbox')
        if not b:continue
        points=line.get('polygon')
        if not points or len(points)<3:
            points=[[b['x0'],b['y0']],[b['x1'],b['y0']],[b['x1'],b['y1']],[b['x0'],b['y1']]]
        cv2.fillPoly(source,[np.rint(np.asarray(points)-[x0,y0]).astype(np.int32)],255)
    # Allow small detector clipping errors; do not grow to paragraph bounds.
    support=cv2.dilate(source,np.ones((3,3),np.uint8))
    count,labels,stats,_=cv2.connectedComponentsWithStats(structural,8)
    supported=np.bincount(labels[support>0],minlength=count)
    # Partly supported components are uncertain, not proven artwork. Only an
    # already blocked diagnostic may try the stricter majority-support filter.
    reject=(supported/np.maximum(1,stats[:,cv2.CC_STAT_AREA])<.65) if diagnostic else supported==0
    reject[0]=False
    rejected=reject[labels].astype(np.uint8)*255
    rejected=cv2.dilate(rejected,np.ones((5,5),np.uint8))
    retained=(~reject)[labels]&(labels>0)
    rejected[cv2.dilate(retained.astype(np.uint8),np.ones((3,3),np.uint8))>0]=0
    removed=(ink>0)&(rejected>0)
    evidence={'unreadShapePixels':int(removed.sum()),
              'uncertainSourcePixels':int((removed&(source>0)&(structural>0)).sum())}
    return cv2.bitwise_and(ink,cv2.bitwise_not(rejected)),evidence


def cleanup_patch(rgb, region, surface, geometry, peers=()):
    height,width=rgb.shape[:2]
    rows=[l['bbox'] for l in region.get('recognitionLines',[]) if l.get('bbox')]
    if not rows:rows=[region['bbox']]
    # Cover detector margins only when the independently read lines span the
    # region. Do not erase unread lines just to make an incomplete result look clean.
    rb=region['bbox']
    extent=(min(r['x0'] for r in rows),min(r['y0'] for r in rows),max(r['x1'] for r in rows),max(r['y1'] for r in rows))
    complete_bounds=(extent[2]-extent[0])/max(1,rb['x1']-rb['x0'])>=.55 and (extent[3]-extent[1])/max(1,rb['y1']-rb['y0'])>=.65
    if surface and geometry and complete_bounds:rows=rows+[rb]
    text_heights=[l['bbox']['y1']-l['bbox']['y0'] for l in region.get('recognitionLines',[]) if l.get('bbox')]
    padding=max(6,min(16,int((float(np.median(text_heights)) if text_heights else 24)*.25)))
    crop_padding=max(24,padding+8)
    b=bbox({'x0':min(r['x0'] for r in rows)-crop_padding,'y0':min(r['y0'] for r in rows)-crop_padding,
            'x1':max(r['x1'] for r in rows)+crop_padding,'y1':max(r['y1'] for r in rows)+crop_padding},width,height)
    x0,y0,x1,y1=b;local=rgb[y0:y1,x0:x1].copy();gray=cv2.cvtColor(local,cv2.COLOR_RGB2GRAY)
    allow=np.zeros(gray.shape,np.uint8)
    for row in rows:
        a=bbox({'x0':row['x0']-padding,'y0':row['y0']-padding,'x1':row['x1']+padding,'y1':row['y1']+padding},width,height)
        cv2.rectangle(allow,(a[0]-x0,a[1]-y0),(a[2]-x0-1,a[3]-y0-1),255,-1)
    border=np.concatenate((local[0],local[-1],local[:,0],local[:,-1]));background=np.median(border,axis=0)
    if surface:
        pixels=rgb[surface['y']:surface['y']+surface['h'],surface['x']:surface['x']+surface['w']][surface['mask']>0]
        light=pixels.mean(axis=1);pixels=pixels[light<=np.percentile(light,55)] if surface['dark'] else pixels[light>=np.percentile(light,40)]
        if len(pixels):background=np.median(pixels,axis=0)
    luminance=float(background.mean())
    line_heights=[l['bbox']['y1']-l['bbox']['y0'] for l in region.get('recognitionLines',[]) if l.get('bbox')]
    glyph_height=float(np.median(line_heights)) if line_heights else min(64,rb['y1']-rb['y0'])
    kernel_size=max(21,min(101,int(glyph_height*.9)))|1
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(kernel_size,kernel_size))
    estimate=cv2.morphologyEx(gray,cv2.MORPH_OPEN if luminance<110 else cv2.MORPH_CLOSE,kernel)
    contrast=cv2.subtract(gray,estimate) if luminance<110 else cv2.subtract(estimate,gray)
    ink=(contrast>25).astype(np.uint8)*255
    structural=(gray>max(190,luminance+70) if luminance<110 else gray<min(105,luminance-65)).astype(np.uint8)*255
    horizontal=cv2.morphologyEx(structural,cv2.MORPH_OPEN,np.ones((1,max(40,int(local.shape[1]*.70))),np.uint8))
    vertical=cv2.morphologyEx(structural,cv2.MORPH_OPEN,np.ones((max(40,int(local.shape[0]*.80)),1),np.uint8))
    # A tall I, a question mark, or an underline inside a text crop is not a
    # panel border. Protect only long structures continuing out of the crop.
    structures=cv2.bitwise_or(horizontal,vertical)
    count,labels,stats,_=cv2.connectedComponentsWithStats(structures,8)
    protect=np.zeros_like(structures)
    for k in range(1,count):
        px,py,pw,ph,_=map(int,stats[k])
        if px<=1 or py<=1 or px+pw>=local.shape[1]-1 or py+ph>=local.shape[0]-1:protect[labels==k]=255
    protect=cv2.dilate(protect,np.ones((3,3),np.uint8))
    ink=cv2.dilate(ink,np.ones((3,3),np.uint8));ink=cv2.bitwise_and(ink,allow)
    ink=cv2.bitwise_and(ink,cv2.bitwise_not(protect))
    # Measure text spilling across a detected white region. Outside pixels use
    # glyph-only inpainting, never a white bounding rectangle. Long frame lines
    # are protected above even if an OCR crop accidentally includes them.
    spill=False
    if geometry and geometry.get('polygon'):
        inside=np.zeros_like(ink);pts=np.asarray(geometry['polygon'],np.int32)-[x0,y0];cv2.fillPoly(inside,[pts],255)
        boundary=cv2.subtract(cv2.dilate(inside,np.ones((5,5),np.uint8)),cv2.erode(inside,np.ones((3,3),np.uint8)))
        outline=cv2.bitwise_and(boundary,structural)
        if surface is not None:
            # On a confirmed flat interior, thick glyphs need an absolute ink
            # threshold too; a fixed top-hat kernel misses the middle of strokes.
            direct=(gray>min(220,luminance+28) if surface['dark'] else gray<max(50,luminance-28)).astype(np.uint8)*255
            direct=cv2.bitwise_and(cv2.dilate(direct,np.ones((3,3),np.uint8)),allow)
            direct=cv2.bitwise_and(direct,inside)
            ink=cv2.bitwise_or(ink,direct)
            ink=cv2.bitwise_and(ink,cv2.bitwise_not(protect))
        ink=cv2.bitwise_and(ink,cv2.bitwise_not(outline))
        spill=bool(np.any((ink>0)&(inside==0)))
    learned=False
    probability=region.get('cleanupProbability')
    if probability and luminance>190:
        pb=probability['bbox'];decoded=cv2.imdecode(np.frombuffer(base64.b64decode(probability['png']),np.uint8),cv2.IMREAD_GRAYSCALE)
        if decoded is not None and decoded.shape==(pb['y1']-pb['y0'],pb['x1']-pb['x0']):
            local_probability=np.zeros(gray.shape,np.float32)
            ax=max(x0,pb['x0']);ay=max(y0,pb['y0']);bx=min(x1,pb['x1']);by=min(y1,pb['y1'])
            if bx>ax and by>ay:local_probability[ay-y0:by-y0,ax-x0:bx-x0]=decoded[ay-pb['y0']:by-pb['y0'],ax-pb['x0']:bx-pb['x0']]/255.0
            lines=[]
            for line in region.get('recognitionLines') or [{'bbox':rb,'text':region.get('text','')}]:
                bline=line['bbox'];shifted={**line,'bbox':{k:v-(x0 if k[0]=='x' else y0) for k,v in bline.items()}}
                if line.get('polygon'):shifted['polygon']=[[x-x0,y-y0] for x,y in line['polygon']]
                lines.append(shifted)
            candidate=supported_components(gray,local_probability,np.full_like(ink,255),lines)
            if np.any(candidate):ink=candidate;learned=True
    if not np.any(ink):return None
    ink,ownership=protect_neighbor_ink(ink,structural,region,peers,(x0,y0))
    ink,source_support=protect_unread_shapes(ink,structural,region,(x0,y0),ownership.get('ambiguousPixels',0)>2)
    ownership.update(source_support)
    # Only glyph-shaped pixels are changed. Textured scenes use local inpainting,
    # never a solid rectangle masquerading as a cleaned background.
    uniform=surface is not None and not spill and float(np.std(border.mean(axis=1)))<14
    result=local.copy()
    if learned:result,_=fill_supported_mask(local,ink)
    elif uniform:result[ink>0]=np.clip(background,0,255).astype(np.uint8)
    else:
        result=cv2.inpaint(local,ink,3,cv2.INPAINT_TELEA)
        if surface is not None and geometry and geometry.get('polygon'):
            result[(ink>0)&(inside>0)]=np.clip(background,0,255).astype(np.uint8)
    # Give the resampler an opaque copy of unchanged bright pixels around the
    # erased ink. Otherwise independently downscaled transparent patch edges
    # blend with the still-dark original glyph underneath and create ghosts.
    # This changes coverage, not cleanup: result outside ink is the source.
    alpha=ink.copy()
    background_pixels=(gray>=245)|((gray>180)&(np.abs(gray.astype(np.float32)-luminance)<12))
    rim=(cv2.dilate(ink,np.ones((5,5),np.uint8))>0)&background_pixels
    alpha[rim]=255
    bgra=cv2.cvtColor(result,cv2.COLOR_RGB2BGRA);bgra[:,:,3]=alpha
    return {'bbox':as_box(b),'png':png64(bgra),'pixels':int(np.count_nonzero(alpha)),
            'cleanupPixels':int(np.count_nonzero(ink)),
            'backgroundColor':'#%02x%02x%02x' % tuple(int(v) for v in np.clip(background,0,255)),
            'method':'model-supported-glyph-fill' if learned else 'glyph-flat-fill' if uniform else 'glyph-inpaint',
            'sourceBoundsCovered':bool(complete_bounds),'maskVersion':5,'ownership':ownership}


def text_area(rgb, region, placement, peers):
    """Place text near its source, excluding remaining ink and other readings.

    Cleanup permission is independent: a diagnostic patch does not authorize
    painting. Filled residual contours also protect the inside of line art.
    """
    height,width=rgb.shape[:2];rb=bbox(region['bbox'],width,height)
    x0=max(0,rb[0]-24);y0=max(0,rb[1]-24);x1=min(width,rb[2]+24);y1=min(height,rb[3]+24)
    gray=cv2.cvtColor(rgb[y0:y1,x0:x1],cv2.COLOR_RGB2GRAY)
    color=placement.get('fillColor','#ffffff').lstrip('#')
    dark=sum(int(color[i:i+2],16) for i in (0,2,4))/3<125
    ink=(gray>190 if dark else gray<105).astype(np.uint8)*255
    patch=placement.get('erasePatch')
    if patch:
        decoded=cv2.imdecode(np.frombuffer(base64.b64decode(patch['png']),np.uint8),cv2.IMREAD_UNCHANGED)
        pb=patch['bbox'];ax=max(x0,pb['x0']);ay=max(y0,pb['y0']);bx=min(x1,pb['x1']);by=min(y1,pb['y1'])
        if bx>ax and by>ay:
            erased=decoded[ay-pb['y0']:by-pb['y0'],ax-pb['x0']:bx-pb['x0'],3]>0
            ink[ay-y0:by-y0,ax-x0:bx-x0][erased]=0
    interior=None
    if placement.get('surfaceValidated') and placement.get('polygon'):
        interior=np.zeros_like(ink)
        cv2.fillPoly(interior,[np.asarray(placement['polygon'],np.int32)-[x0,y0]],1)
        # A closed balloon border surrounds usable space, unlike an interior
        # drawing such as a bottle. Do not fill that border as an art obstacle.
        ink[cv2.erode(interior,np.ones((3,3),np.uint8))==0]=0
    remaining=cv2.morphologyEx(ink,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))
    contours,_=cv2.findContours(remaining,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    obstacles=np.zeros_like(ink)
    for contour in contours:
        if cv2.contourArea(contour)>=4:cv2.drawContours(obstacles,[contour],-1,255,-1)
    obstacles=cv2.dilate(obstacles,np.ones((7,7),np.uint8))
    allowed=np.zeros_like(ink);allowed[rb[1]-y0:rb[3]-y0,rb[0]-x0:rb[2]-x0]=1
    if placement.get('polygon'):
        interior=np.zeros_like(ink);cv2.fillPoly(interior,[np.asarray(placement['polygon'],np.int32)-[x0,y0]],1)
        allowed&=interior
    for peer in peers:
        if peer is region:continue
        for line in foreign_reading_lines(region,peer):
            b=line['bbox'];ax=max(0,int(b['x0'])-x0-2);ay=max(0,int(b['y0'])-y0-2)
            bx=min(allowed.shape[1],int(math.ceil(b['x1']))-x0+2);by=min(allowed.shape[0],int(math.ceil(b['y1']))-y0+2)
            if bx>ax and by>ay:
                points=line.get('polygon')
                if points and len(points)>=3:
                    foreign=np.zeros_like(allowed)
                    cv2.fillPoly(foreign,[np.rint(np.asarray(points)-[x0,y0]).astype(np.int32)],1)
                    allowed[cv2.dilate(foreign,np.ones((5,5),np.uint8))>0]=0
                else:allowed[ay:by,ax:bx]=0
    allowed[obstacles>0]=0
    lines=region.get('recognitionLines',[])
    if len(lines)==1 and not lines[0].get('polygon') and region.get('textRotation') in (90,270):
        line=lines[0];b=line['bbox']
        points=[[b['x0'],b['y1']],[b['x0'],b['y0']],[b['x1'],b['y0']],[b['x1'],b['y1']]] if region['textRotation']==90 else [[b['x1'],b['y0']],[b['x1'],b['y1']],[b['x0'],b['y1']],[b['x0'],b['y0']]]
        lines=[{**line,'polygon':points}]
    if len(lines)==1 and lines[0].get('polygon') and any(ch.isascii() and ch.isalpha() for ch in str(region.get('text',''))):
        points=np.asarray(lines[0]['polygon'],np.float32)
        if len(points)==4:
            delta=points[1]-points[0];angle=math.degrees(math.atan2(float(delta[1]),float(delta[0])))
            long=min(np.linalg.norm(points[1]-points[0]),np.linalg.norm(points[2]-points[3]))*.92
            short=min(np.linalg.norm(points[3]-points[0]),np.linalg.norm(points[2]-points[1]))*.85
            if 20<=abs(angle)<=100 and long>short*2 and short>=8:
                center=points.mean(axis=0);quad=cv2.boxPoints((tuple(center),(float(long),float(short)),angle))
                footprint=np.zeros_like(allowed);cv2.fillPoly(footprint,[np.rint(quad-[x0,y0]).astype(np.int32)],1)
                if footprint.sum()>0 and np.count_nonzero((footprint>0)&(allowed==0))/footprint.sum()<.01:
                    placement['rotatedTextBox']={'cx':float(center[0]),'cy':float(center[1]),'width':float(long),'height':float(short),'angle':angle,'polygon':quad.tolist()}
                    return as_box((quad[:,0].min(),quad[:,1].min(),quad[:,0].max(),quad[:,1].max()))
    # Largest empty rectangle, with source-center distance as a tie breaker.
    heights=np.zeros(allowed.shape[1],np.int32);best=None;best_score=(-1,-1)
    cx=(rb[0]+rb[2])/2-x0;cy=(rb[1]+rb[3])/2-y0
    for y,row in enumerate(allowed):
        heights=np.where(row>0,heights+1,0);stack=[]
        for x in range(len(heights)+1):
            h=int(heights[x]) if x<len(heights) else 0;start=x
            while stack and stack[-1][1]>h:
                start,hh=stack.pop();w=x-start
                if w>=8 and hh>=8:
                    score=(w*hh,-((start+x)/2-cx)**2-((2*y-hh+1)/2-cy)**2)
                    if score>best_score:best_score=score;best=(start,y-hh+1,x,y+1)
            if not stack or stack[-1][1]<h:stack.append((start,h))
    if not best:return None
    if region.get('textRotation') in (90,270) and len(lines)==1 and best[3]-best[1]>(best[2]-best[0])*2:
        box=as_box((best[0]+x0,best[1]+y0,best[2]+x0,best[3]+y0))
        placement['rotatedTextBox']={'cx':(box['x0']+box['x1'])/2,'cy':(box['y0']+box['y1'])/2,'width':box['y1']-box['y0'],'height':box['x1']-box['x0'],'angle':-90 if region['textRotation']==90 else 90,'polygon':[[box['x0'],box['y0']],[box['x1'],box['y0']],[box['x1'],box['y1']],[box['x0'],box['y1']]]}
    return as_box((best[0]+x0,best[1]+y0,best[2]+x0,best[3]+y0))


def layout_safe(request):
    rgb=np.asarray(Image.open(io.BytesIO(base64.b64decode(request['image']))).convert('RGB'))
    height,width=rgb.shape[:2];gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    regions=request.get('regions',[])
    if len(regions)>500:raise ValueError('Too many regions')
    surfaces=build_surfaces(gray);results=[]
    selected={str(r.get('id','')):select_surface(surfaces,r,width,height,gray) for r in regions if r.get('bbox')}
    for r in regions:
        if not r.get('bbox'):continue
        b=bbox(r['bbox'],width,height);s=selected.get(str(r.get('id','')))
        # Child zones must keep the measured partition, rather than reacquiring
        # their parent's entire connected surface.
        if r.get('zonePolygon'):
            points=np.asarray(r['zonePolygon'],np.int32);x0,y0=points.min(axis=0);x1,y1=points.max(axis=0)+1
            mask=np.zeros((y1-y0,x1-x0),np.uint8);cv2.fillPoly(mask,[points-[x0,y0]],1)
            s={'x':int(x0),'y':int(y0),'w':int(x1-x0),'h':int(y1-y0),'mask':mask,'dark':False,'threshold':242,'area':int(mask.sum())}
        cell=None
        if s and not request.get('includeSplitHints',True) and not r.get('zonePolygon'):
            peers=[]
            for other in regions:
                os=selected.get(str(other.get('id','')))
                if os is not None and not other.get('excludeFromLayoutCompetition') and (os['x'],os['y'],os['w'],os['h'])==(s['x'],s['y'],s['w'],s['h']): peers.append(other)
            if len(peers)>1:
                yy,xx=np.indices(s['mask'].shape);xx=xx+s['x'];yy=yy+s['y']
                cx=(r['bbox']['x0']+r['bbox']['x1'])/2;cy=(r['bbox']['y0']+r['bbox']['y1'])/2
                own=(xx-cx)**2+(yy-cy)**2;cell=s['mask'].copy()
                for other in peers:
                    if other is r:continue
                    ocx=(other['bbox']['x0']+other['bbox']['x1'])/2;ocy=(other['bbox']['y0']+other['bbox']['y1'])/2
                    cell[own>(xx-ocx)**2+(yy-ocy)**2]=0
        geometry=safe_geometry(s,r,width,height,cell) if s else None
        if geometry:
            stable_key=hashlib.sha256(str((s['x'],s['y'],s['w'],s['h'])).encode()+s['mask'].tobytes()).hexdigest()[:16]
            background='#080808' if s['dark'] else '#ffffff'
            p={k:v for k,v in geometry.items() if k!='mask'}
            p.update({'surfaceType':'bubble','shape':'polygon','surfaceKey':stable_key,'surfaceValidated':True,
                'fillColor':background,'confidence':.92,'reviewRequired':False,'paintMode':'glyph-patch','flatFillSafe':True,'requiresInpaint':False,'detectionMode':'closed-pixel-surface-v2'})
            if request.get('includeSplitHints',True):p['splitHints']=split_hints(s,r,rgb)
        else:
            p={'surfaceType':'scene','shape':'rect','polygon':[],'eraseBox':as_box(b),'safeBox':as_box(b),
               'fillColor':'#ffffff','confidence':0,'surfaceValidated':False,'reviewRequired':True,
               'paintMode':'glyph-patch','flatFillSafe':False,'requiresInpaint':True,'detectionMode':'source-glyph-mask-only'}
        p['erasePatch']=cleanup_patch(rgb,r,s,geometry,regions)
        if r.get('cleanupModelError'):p['cleanupModelError']=r['cleanupModelError']
        ownership=(p['erasePatch'] or {}).get('ownership',{})
        if ownership.get('ambiguousPixels',0)>2:
            p.update(paintMode='none',reviewRequired=True,cleanupReview='shared-ink-needs-review')
        elif ownership.get('uncertainSourcePixels',0)>2:
            p.update(paintMode='none',reviewRequired=True,cleanupReview='source-shape-needs-review')
        elif r.get('excludeFromLayoutCompetition'):
            p.update(paintMode='none',reviewRequired=True)
        if p['erasePatch']:
            p['fillColor']=p['erasePatch']['backgroundColor']
        safe=text_area(rgb,r,p,regions)
        if safe:
            p['safeBox']=safe;p['textAreaMethod']='source-local-residual-ink-v1'
        else:
            p.update(paintMode='none',reviewRequired=True,layoutReview='no-safe-text-area')
        p['referenceLineHeight']=float(np.median([l['bbox']['y1']-l['bbox']['y0'] for l in r.get('recognitionLines',[]) if l.get('bbox')])) if r.get('recognitionLines') else max(12,(b[3]-b[1])/max(1,len(str(r.get('text','')).split('\n'))))
        if (b[2]<width*.10 or b[0]>width*.90) and (b[3]-b[1])>30 and ((b[3]-b[1])>(b[2]-b[0])*1.2 or r.get('orientation')=='vertical'):
            crop=rgb[b[1]:b[3],b[0]:b[2]].astype(np.int16)
            if float(np.mean(crop.max(axis=2)-crop.min(axis=2)>60))>.08:p['visualRole']='decorative-margin'
        results.append({'id':str(r.get('id','')),'placement':p})
    return {'width':width,'height':height,'regions':results,'engine':'closed-pixel-surface-v2'}
