"""Validate isolated GPU packages before enabling them for production workers."""
import sys, os, pathlib, time, json
runtime=pathlib.Path(os.environ['LOCALAPPDATA'])/'ImageHarvest/ocr-runtime'
sys.path.insert(0,str(runtime/'accelerators/torch-cu128'))
os.environ['HF_HOME']=str(runtime.parent/'ocr-models/huggingface')
os.environ['PADDLE_PDX_CACHE_HOME']=str(runtime.parent/'ocr-models/paddle')
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK']='True'
os.environ['OMP_NUM_THREADS']='4'
import torch
print(json.dumps({'torch':torch.__version__,'cuda':torch.cuda.is_available(),'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}),flush=True)
assert torch.cuda.is_available()
from PIL import Image
from manga_ocr import MangaOcr
from manga_ocr.ocr import post_process
model=MangaOcr()
image=Image.open('test/fixtures/ocr-layout.png').crop((700,50,820,225))
at=time.perf_counter();text=model(image);print(json.dumps({'mangaText':text,'device':str(model.model.device),'ms':round((time.perf_counter()-at)*1000)}),flush=True)
assert text=='こんにちは世界です'
xs=torch.stack([model._preprocess(image.convert('L').convert('RGB')) for _ in range(2)]).to(model.model.device)
at=time.perf_counter();outputs=model.model.generate(xs,max_length=300);texts=[post_process(model.tokenizer.decode(x,skip_special_tokens=True)) for x in outputs.cpu()]
print(json.dumps({'mangaBatch':texts,'ms':round((time.perf_counter()-at)*1000)}),flush=True)
assert texts==[text,text]
assert (runtime/'accelerators/paddle-cu126/paddle').exists()
if (runtime/'accelerators/paddle-cu126/paddle').exists():
    handles=[os.add_dll_directory(str(runtime/'accelerators/torch-cu128/torch/lib'))]
    sys.path.insert(0,str(runtime/'accelerators/paddle-cu126'))
    import paddle
    assert paddle.is_compiled_with_cuda() and paddle.device.cuda.device_count()>0
    print(json.dumps({'paddle':paddle.__version__,'cuda':paddle.is_compiled_with_cuda()}),flush=True)
    from paddleocr import TextDetection, PaddleOCR
    import cv2
    det=TextDetection(model_name='PP-OCRv5_server_det',device='gpu:0',enable_mkldnn=False,limit_side_len=1024,limit_type='max',box_thresh=.6)
    at=time.perf_counter();result=list(det.predict(cv2.imread('test/fixtures/ocr-thai-bubble.png')))[0]
    print(json.dumps({'detPolys':result['dt_polys'].tolist(),'ms':round((time.perf_counter()-at)*1000)}),flush=True)
    rec=PaddleOCR(lang='th',ocr_version='PP-OCRv5',device='gpu:0',enable_mkldnn=False,use_doc_orientation_classify=False,use_doc_unwarping=False,use_textline_orientation=False,text_rec_score_thresh=0,text_det_limit_side_len=960,text_det_limit_type='max')
    at=time.perf_counter();result=list(rec.predict(cv2.imread('test/fixtures/ocr-thai-bubble.png')))[0]
    print(json.dumps({'paddleText':result['rec_texts'],'ms':round((time.perf_counter()-at)*1000)}),flush=True)
