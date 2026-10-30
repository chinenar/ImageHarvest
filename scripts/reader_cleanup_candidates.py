"""Offline fill experiment for a verified black-on-light candidate mask."""
import cv2
import numpy as np


def fill_supported_mask(source, mask):
    result=cv2.inpaint(source,mask,3,cv2.INPAINT_TELEA)
    count,labels,stats,_=cv2.connectedComponentsWithStats((mask>0).astype(np.uint8),8)
    flat=0
    for k in range(1,count):
        x,y,w,h,_=map(int,stats[k]);x0=max(0,x-5);y0=max(0,y-5);x1=min(mask.shape[1],x+w+5);y1=min(mask.shape[0],y+h+5)
        component=(labels[y0:y1,x0:x1]==k).astype(np.uint8)
        ring=(cv2.dilate(component,np.ones((9,9),np.uint8))>0)&(mask[y0:y1,x0:x1]==0)
        pixels=source[y0:y1,x0:x1][ring]
        if len(pixels)<12:continue
        bright=np.min(pixels,axis=1)>=245
        if float(bright.mean())<.75:continue
        samples=pixels[bright]
        if float(np.max(np.std(samples,axis=0)))>2.5:continue
        color=np.median(samples,axis=0).astype(np.uint8)
        result[y0:y1,x0:x1][component>0]=color;flat+=1
    return result,{'flatComponents':flat,'totalComponents':count-1}
