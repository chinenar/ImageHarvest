"""Offline diagnostic scoring; references never enter candidate mask creation."""
import json
import sys
from pathlib import Path
import cv2
import numpy as np
from reader_mask_candidates import supported_components
from reader_cleanup_candidates import fill_supported_mask


def score(source, mask, truth, ignore, cleaned=None):
    dark=cv2.cvtColor(source,cv2.COLOR_BGR2GRAY)<150
    known=ignore==0
    text=(truth>0)&known
    artwork=dark&(truth==0)&known
    active=mask>0
    if cleaned is None:cleaned=cv2.inpaint(source,mask,3,cv2.INPAINT_TELEA)
    changed=np.max(np.abs(cleaned.astype(np.int16)-source.astype(np.int16)),axis=2)>10
    n=int(text.sum());art=int(artwork.sum())
    return cleaned,{'referenceTextPixels':n,'coveredTextPixels':int((active&text).sum()),
        'textCoverage':float((active&text).sum()/max(1,n)),
        'protectedInkPixels':art,'protectedInkMasked':int((active&artwork).sum()),
        'protectedInkChanged':int((changed&artwork).sum()),
        'darkTextPixelsRemaining':int(((cv2.cvtColor(cleaned,cv2.COLOR_BGR2GRAY)<150)&text).sum())}


def main(root):
    root=Path(root)
    cases=json.loads((root/'inputs.json').read_text(encoding='utf-8'))
    results=[]
    for case in cases:
        folder=root/case['id'];source=cv2.imread(str(folder/'source.png'))
        gray=cv2.cvtColor(source,cv2.COLOR_BGR2GRAY)
        zones=np.zeros(gray.shape,np.uint8)
        for poly in case['textPolygons']:cv2.fillPoly(zones,[np.array(poly,np.int32)],255)
        truth=((zones>0)&(gray<150)).astype(np.uint8)*255
        # The uncertain antialiased fringe is excluded, not marked non-text.
        ignore=((zones>0)&(gray>=150)&(gray<235)).astype(np.uint8)*255
        for x0,y0,x1,y1 in case['ignoreBoxes']:ignore[y0:y1,x0:x1]=255
        cv2.imwrite(str(folder/'reference.png'),truth)
        view=source.copy();view[truth>0]=(60,190,40);view[ignore>0]=(210,100,160)
        cv2.imwrite(str(folder/'reference-view.png'),view)
        variants={}
        learned=cv2.imread(str(folder/'segmentation-mask.png'),0)
        allowed=cv2.imread(str(folder/'allowed.png'),0)
        expanded=cv2.bitwise_and(cv2.dilate(learned,np.ones((3,3),np.uint8)),allowed)
        cv2.imwrite(str(folder/'segmentation-expanded-mask.png'),expanded)
        # Black-on-light experiment only: let the model select complete dark
        # components instead of treating its soft boundary as an erase mask.
        # This assigns no per-word ownership to a shared component.
        foreground=(gray<150).astype(np.uint8)
        count,labels,stats,_=cv2.connectedComponentsWithStats(foreground,8)
        probability=cv2.imread(str(folder/'probability.png'),0)/255.0
        weights=np.bincount(labels.ravel(),weights=probability.ravel(),minlength=count)
        selected=weights/np.maximum(1,stats[:,cv2.CC_STAT_AREA])>=.3
        selected[0]=False
        components=selected[labels].astype(np.uint8)*255
        components=cv2.bitwise_and(cv2.dilate(components,np.ones((3,3),np.uint8)),allowed)
        cv2.imwrite(str(folder/'segmentation-components-mask.png'),components)
        lines=json.loads((folder/'reading-lines.json').read_text(encoding='utf-8'))
        supported=supported_components(gray,probability,allowed,lines)
        cv2.imwrite(str(folder/'segmentation-supported-mask.png'),supported)
        # Follow-up development candidate after the frozen-page failure: line
        # support selects components; do not clip their strokes to an OCR box.
        complete=supported_components(gray,probability,np.full_like(allowed,255),lines)
        cv2.imwrite(str(folder/'supported-complete-mask.png'),complete)
        for name in ['current-proposal','current-applied','segmentation','segmentation-expanded','segmentation-components','segmentation-supported','supported-complete']:
            mask=cv2.imread(str(folder/(name+'-mask.png')),0)
            cleaned,metrics=score(source,mask,truth,ignore)
            cv2.imwrite(str(folder/(name+'-clean.png')),cleaned)
            view=source.copy();active=mask>0
            view[active]=(view[active]*.3+np.array([0,0,178])).clip(0,255).astype(np.uint8)
            cv2.imwrite(str(folder/(name+'-view.png')),view)
            variants[name]=metrics
        cleaned,fill_info=fill_supported_mask(source,supported)
        cleaned,metrics=score(source,supported,truth,ignore,cleaned)
        cv2.imwrite(str(folder/'supported-flat-clean.png'),cleaned)
        variants['supported-flat']={**metrics,**fill_info}
        cleaned,fill_info=fill_supported_mask(source,complete)
        cleaned,metrics=score(source,complete,truth,ignore,cleaned)
        cv2.imwrite(str(folder/'complete-flat-clean.png'),cleaned)
        variants['complete-flat']={**metrics,**fill_info}
        results.append({**case,'metrics':variants})
    (root/'metrics.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':main(sys.argv[1])
