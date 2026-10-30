"""Geometry-only source-gap checks, without loading OCR models."""
import importlib.util, pathlib
import numpy as np
spec=importlib.util.spec_from_file_location('worker',pathlib.Path(__file__).parents[1]/'src/ocr-backend.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
def line(x,y,w):
    b=dict(x0=x,y0=y,x1=x+w,y1=y+16)
    return dict(bbox=b,coreBbox=b)
lines=[line(140,y,80) for y in [10,40,70]]+[line(50,100,150)]+[line(50,y,80) for y in [130,160,190,220]]
gray=np.full((260,250),255,np.uint8)
for l in lines:
    b=l['bbox'];gray[b['y0']:b['y1'],b['x0']:b['x1']]=0
gray[95:122,132:143]=255
groups=worker.staggered_text_groups(lines,gray)
assert groups and list(map(len,groups))==[4,5]
assert groups[0][-1]['cutEdge']=='x0' and groups[1][0]['cutEdge']=='x1'
assert lines[3]['bbox']['x1']==200, 'source observation must not mutate'
gray[100:116,132:143]=0
assert worker.staggered_text_groups(lines,gray) is None, 'never cut connected ink'
centered=[line(80,y,80) for y in range(10,230,30)]
assert worker.staggered_text_groups(centered,gray) is None, 'ordinary paragraph stays whole'
print('Staggered source gap and negative controls passed')

mixed=[line(200,20,50),line(205,50,40),line(40,80,220)]
background=np.full((130,300),255,np.uint8);background[:,170:]=0
groups=worker.contrast_text_groups(mixed,background)
assert groups and list(map(len,groups))==[1,3]
assert 165<=groups[0][0]['bbox']['x1']<=175
assert worker.contrast_text_groups(mixed,np.full_like(background,255)) is None
assert worker.contrast_text_groups(mixed,np.zeros_like(background)) is None
assert worker.contrast_text_groups(mixed[:2],background) is None
assert worker.contrast_text_groups([line(200,20,50),line(140,50,40),mixed[-1]],background) is None
print('Opposite background grouping and negative controls passed')
