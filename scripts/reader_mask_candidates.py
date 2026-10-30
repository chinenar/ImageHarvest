"""Experimental black-on-light masks. No reference annotations are inputs."""
import cv2
import numpy as np


def supported_components(gray, probability, allowed, lines):
    count,labels,stats,centers=cv2.connectedComponentsWithStats((gray<150).astype(np.uint8),8)
    zones=np.zeros_like(gray,np.uint8)
    for line in lines:
        b=line['bbox'];points=line.get('polygon') or [[b['x0'],b['y0']],[b['x1'],b['y0']],[b['x1'],b['y1']],[b['x0'],b['y1']]]
        cv2.fillPoly(zones,[np.rint(points).astype(np.int32)],255)
    sizes=np.maximum(1,stats[:,cv2.CC_STAT_AREA])
    confidence=np.bincount(labels.ravel(),weights=probability.ravel(),minlength=count)/sizes
    support=np.bincount(labels[zones>0],minlength=count)/sizes
    selected=(confidence>=.3)&(support>=.65);selected[0]=False
    # A low-confidence small dot is not automatically punctuation. Require a
    # read terminal punctuation mark, a supported host line, and its end zone.
    for line in lines:
        if not str(line.get('text','')).rstrip().endswith(('!','?','.','。','！','？')):continue
        b=line['bbox'];w=b['x1']-b['x0'];h=b['y1']-b['y0']
        if w<h*1.5:continue
        host=selected&(centers[:,0]>=b['x0'])&(centers[:,0]<=b['x1'])&(centers[:,1]>=b['y0'])&(centers[:,1]<=b['y1'])
        if not np.any(host):continue
        terminal=(confidence>=.1)&(support>=.65)&(sizes<=h*h*.04)&(centers[:,0]>=b['x0']+w*.8)&(centers[:,0]<=b['x1'])&(centers[:,1]>=b['y0']+h*.4)&(centers[:,1]<=b['y1'])
        selected|=terminal;selected[0]=False
    mask=cv2.dilate(selected[labels].astype(np.uint8)*255,np.ones((3,3),np.uint8))
    # Expansion must not consume adjacent ink rejected by model/line support.
    mask[(labels>0)&(~selected[labels])]=0
    return cv2.bitwise_and(mask,allowed)
