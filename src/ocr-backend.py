"""Local JSON-lines OCR worker. Images stay on this computer; models download once."""
import os
import sys
import json
import base64
import io
import contextlib
import traceback
import time
import hashlib
import copy
from collections import OrderedDict

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Small OCR crops do not benefit from spawning a thread per logical CPU.
CPU_THREADS = max(1, min(4, os.cpu_count() or 1))
os.environ.setdefault("MKL_NUM_THREADS", str(CPU_THREADS))
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
root = os.environ.get("IMAGEHARVEST_OCR_CACHE", os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ImageHarvest", "ocr-models"))
runtime = os.path.dirname(os.path.dirname(sys.executable))
accelerator = os.path.join(runtime, "accelerators", "paddle-3.2.2")
gpu_ready = os.path.isfile(os.path.join(runtime, "accelerators", "gpu-ready.json")) and os.environ.get("IMAGEHARVEST_OCR_DEVICE", "auto") != "cpu" and os.environ.get("IMAGEHARVEST_OCR_SAFE_CPU") != "1"
_dll_handles = []
startup_fallback_reason = None

def readable_dir(value):
    try:
        os.listdir(value)
        return True
    except OSError:
        return False

if gpu_ready:
    torch_root = os.path.join(runtime, "accelerators", "torch-cu128")
    paddle_root = os.path.join(runtime, "accelerators", "paddle-cu126")
    torch_lib = os.path.join(torch_root, "torch", "lib")
    paddle_pkg = os.path.join(paddle_root, "paddle")
    if not all(os.path.isdir(p) for p in (torch_root, paddle_root)) or not readable_dir(torch_lib) or not readable_dir(paddle_pkg):
        gpu_ready = False
        startup_fallback_reason = "accelerator-permission-or-files-missing"
    else:
        try:
            sys.path[:0] = [paddle_root, torch_root]
            if sys.platform == "win32":
                _dll_handles.append(os.add_dll_directory(torch_lib))
        except OSError:
            gpu_ready = False
            startup_fallback_reason = "accelerator-dll-path-unavailable"
            sys.path[:] = [p for p in sys.path if p not in (paddle_root, torch_root)]
# Keep the tested oneDNN runtime isolated from existing workers and dependencies.
accelerated = os.path.isfile(os.path.join(accelerator, "ready.json")) and os.environ.get("IMAGEHARVEST_OCR_SAFE_CPU") != "1" and readable_dir(os.path.join(accelerator, "paddle"))
if accelerated and not gpu_ready:
    sys.path.insert(0, accelerator)
PADDLE_THREADS = CPU_THREADS if accelerated else min(10, os.cpu_count() or 1)
os.environ.setdefault("OMP_NUM_THREADS", str(CPU_THREADS) if accelerated else "1")
os.environ.setdefault("HF_HOME", os.path.join(root, "huggingface"))
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", os.path.join(root, "paddle"))
models = {}
recognition_cache = OrderedDict()
recognition_cache_stats = {"hits": 0, "misses": 0}
devices = None
fallback_reason = startup_fallback_reason

def device_config():
    global devices, gpu_ready, fallback_reason
    if devices is None:
        devices = {"paddle": "cpu", "manga": "cpu"}
        if gpu_ready:
            try:
                import torch, paddle
                if torch.cuda.is_available() and paddle.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
                    devices = {"paddle": "gpu:0", "manga": "cuda:0"}
                else:
                    fallback_reason = fallback_reason or "gpu-runtime-unavailable"
            except Exception as error:
                gpu_ready = False
                fallback_reason = fallback_reason or ("gpu-init-failed:" + type(error).__name__)
    return devices

def dispatch_with_fallback(request):
    global devices, fallback_reason
    try:
        return dispatch(request)
    except Exception as error:
        message = str(error).lower()
        exhausted = any(s in message for s in ("cuda out of memory", "out of memory error on gpu", "resourceexhausted", "cuda_error_out_of_memory", "cudaerrormemoryallocation"))
        if not exhausted or not devices or devices["paddle"] == "cpu":
            raise
        fallback_reason = "gpu-memory-exhausted"
        devices = {"paddle":"cpu", "manga":"cpu"}
        for model in list(models.values()):
            if hasattr(model, "close"):
                model.close()
        models.clear()
        recognition_cache.clear()
        error.__traceback__ = None
    # Retry once on CPU, keeping the same image, model and scan coverage.
    import gc
    gc.collect()
    for name in ("torch", "paddle"):
        module = sys.modules.get(name)
        if module is not None:
            module.cuda.empty_cache() if name=="torch" else module.device.cuda.empty_cache()
    return dispatch(request)

def detector():
    from paddleocr import TextDetection
    key = "text-detector"
    if key not in models:
        device = device_config()["paddle"]
        models[key] = TextDetection(model_name="PP-OCRv5_server_det", device=device, enable_mkldnn=accelerated and device=="cpu", cpu_threads=PADDLE_THREADS,
            limit_side_len=1024, limit_type="max", box_thresh=0.6)
    return models[key]

def manga_model():
    if "manga" not in models:
        import torch
        from manga_ocr import MangaOcr
        torch.set_num_threads(CPU_THREADS)
        models["manga"] = MangaOcr(force_cpu=device_config()["manga"]=="cpu")
    return models["manga"]

def prepare_image(request):
    from PIL import Image, ImageOps, ImageEnhance
    image = Image.open(io.BytesIO(base64.b64decode(request["image"]))).convert("RGB")
    variant = request.get("variant", "original")
    if variant in ("wide", "wide-contrast", "wide-line", "wide-line-contrast"):
        # Recovery for tall, squeezed display fonts. Preserve source geometry
        # when returning polygons; this transform is never used on CJK text.
        image = image.resize((image.width * 2, image.height), Image.Resampling.LANCZOS)
        if variant in ("wide-contrast", "wide-line-contrast"):
            image = ImageOps.autocontrast(ImageOps.grayscale(image)).convert("RGB")
    elif variant == "grayscale":
        image = ImageOps.grayscale(image).convert("RGB")
    elif variant == "contrast":
        image = ImageOps.autocontrast(ImageOps.grayscale(image)).convert("RGB")
        image = ImageEnhance.Contrast(image).enhance(1.5)
    elif variant == "invert":
        image = ImageOps.invert(ImageOps.grayscale(image)).convert("RGB")
    elif variant in ("clahe", "adaptive", "otsu"):
        import cv2
        import numpy as np
        gray = np.array(ImageOps.grayscale(image))
        if variant == "clahe":
            gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        elif variant == "adaptive":
            block = max(3, min(51, min(gray.shape) // 8)) | 1
            block = min(block, (min(gray.shape) - 1) | 1)
            if block >= 3:
                gray = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 7)
        else:
            _, gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        image = Image.fromarray(gray).convert("RGB")
    elif variant != "original":
        raise ValueError("Unsupported preprocessing variant")
    return image

def recognize(request):
    return recognize_batch([request])[0]

def recognize_batch(requests):
    if not isinstance(requests, list) or not 1 <= len(requests) <= 8:
        raise ValueError("OCR batch must contain 1-8 crops")
    engine = requests[0].get("engine", "paddle")
    language = requests[0].get("language", "en")
    if any(r.get("engine", "paddle") != engine or r.get("language", "en") != language for r in requests):
        raise ValueError("OCR batch must use one engine and language")
    images = [prepare_image(r) for r in requests]
    keys = []
    for request,image in zip(requests,images):
        # Exact prepared pixels only. Language, device and coordinate transform
        # are part of identity; similar-looking crops are never substituted.
        wide = request.get("variant") in ("wide", "wide-contrast", "wide-line", "wide-line-contrast")
        identity = (engine,language,device_config().get(engine),bool(request.get("recognizeOnly")),wide,image.mode,image.size)
        keys.append(hashlib.sha256(repr(identity).encode()+image.tobytes()).hexdigest())
    if os.environ.get("IMAGEHARVEST_OCR_CACHE_READS") == "0" or any(r.get("reuse") is False for r in requests):
        values = _recognize_batch_uncached(requests, images)
        if len(values) != len(requests):
            raise ValueError("Incomplete recognition batch")
        recognition_cache_stats["misses"] += len(values)
        return [{**value,"inferenceReused":False,"inferenceFingerprint":key} for value,key in zip(values,keys)]
    missing = {}
    for index,key in enumerate(keys):
        if key not in recognition_cache and key not in missing:
            missing[key] = index
    if missing:
        indices = list(missing.values())
        values = _recognize_batch_uncached([requests[i] for i in indices], [images[i] for i in indices])
        if len(values) != len(indices):
            raise ValueError("Incomplete cached recognition batch")
        for key,value in zip(missing,values):
            recognition_cache[key] = copy.deepcopy(value)
        recognition_cache_stats["misses"] += len(values)
    output,seen = [],set()
    for request,key in zip(requests,keys):
        reused = key not in missing or key in seen
        seen.add(key)
        row = copy.deepcopy(recognition_cache[key])
        row.update(variant=request.get("variant","original"),batchSize=len(requests),inferenceReused=reused,inferenceFingerprint=key)
        output.append(row)
        recognition_cache.move_to_end(key)
        recognition_cache_stats["hits"] += int(reused)
    # Store text and coordinates only, never source image buffers or tensors.
    while len(recognition_cache) > 64:
        recognition_cache.popitem(last=False)
    return output


def _recognize_batch_uncached(requests, images=None):
    if not isinstance(requests, list) or not 1 <= len(requests) <= 8:
        raise ValueError("OCR batch must contain 1-8 crops")
    engine = requests[0].get("engine", "paddle")
    language = requests[0].get("language", "en")
    if any(r.get("engine", "paddle") != engine or r.get("language", "en") != language for r in requests):
        raise ValueError("OCR batch must use one engine and language")
    if images is None:
        images = [prepare_image(r) for r in requests]
    if engine == "manga":
        import torch
        from manga_ocr.ocr import post_process
        model = manga_model()
        with torch.inference_mode():
            pixels = torch.stack([model._preprocess(im.convert("L").convert("RGB")) for im in images]).to(model.model.device)
            predictions = model.model.generate(pixels, max_length=300).cpu()
        return [{"engine":"manga-ocr", "model":"kha-white/manga-ocr-base", "text":post_process(model.tokenizer.decode(p, skip_special_tokens=True)), "confidence":None, "lines":[], "variant":r.get("variant","original"), "device":str(model.model.device), "batchSize":len(images)} for r,p in zip(requests,predictions)]
    if engine != "paddle" or language not in ("en", "fr", "th", "japan", "zh"):
        raise ValueError("Unsupported OCR engine or language")
    from paddleocr import TextRecognition
    from paddlex.inference.pipelines.components import CropByPolys, SortQuadBoxes
    import numpy as np
    device = device_config()["paddle"]
    model_name = {"en":"en_PP-OCRv5_mobile_rec", "fr":"latin_PP-OCRv5_mobile_rec", "th":"th_PP-OCRv5_mobile_rec", "japan":"PP-OCRv5_server_rec", "zh":"PP-OCRv5_server_rec"}[language]
    key = "recognizer/" + model_name
    if key not in models:
        models[key] = TextRecognition(model_name=model_name, device=device, enable_mkldnn=accelerated and device=="cpu", cpu_threads=PADDLE_THREADS)
    cropper, sorter = CropByPolys(det_box_type="quad"), SortQuadBoxes()
    crops, owners = [], []
    output = [{"engine":"paddleocr", "model":"PP-OCRv5/"+language, "text":"", "confidence":0, "lines":[], "variant":r.get("variant","original"), "device":device, "batchSize":len(images)} for r in requests]
    # One shared detector, followed by recognition-only batching across crops.
    # Preserve per-version detection: threshold/contrast can reveal missing ink.
    for i,image in enumerate(images):
        bgr = np.array(image)[:,:,::-1]
        if requests[i].get("recognizeOnly"):
            h, w = bgr.shape[:2]
            crops.append(bgr)
            owners.append((i, [[0,0], [w,0], [w,h], [0,h]]))
            continue
        result = list(detector().predict(bgr, limit_side_len=960, limit_type="max", box_thresh=0.6))[0]
        polys = sorter(result["dt_polys"])
        for crop,poly in zip(cropper(bgr,polys),polys):
            if crop.size and crop.shape[0] and crop.shape[1]:
                crops.append(crop); owners.append((i,np.asarray(poly).tolist()))
    if crops:
        order = sorted(range(len(crops)), key=lambda i:crops[i].shape[1]/crops[i].shape[0])
        results = list(models[key].predict([crops[i] for i in order], batch_size=4 if device!="cpu" else 1))
        if len(results) != len(order):
            raise ValueError("Recognition batch returned an incomplete result")
        for index,result in zip(order,results):
            owner,points = owners[index]
            scale_x = 2 if requests[owner].get("variant") in ("wide", "wide-contrast", "wide-line", "wide-line-contrast") else 1
            points = [[x / scale_x, y] for x, y in points]
            output[owner]["lines"].append({"text":str(result["rec_text"]), "confidence":float(result["rec_score"])*100, "polygon":points,
                "bbox":{"x0":min(p[0] for p in points),"y0":min(p[1] for p in points),"x1":max(p[0] for p in points),"y1":max(p[1] for p in points)}})
    for row in output:
        vertical = bool(row["lines"]) and sum(
            l["bbox"]["y1"]-l["bbox"]["y0"] > 1.8*(l["bbox"]["x1"]-l["bbox"]["x0"])
            for l in row["lines"]) > len(row["lines"])/2
        row["orientation"] = "vertical" if vertical else "horizontal"
        row["lines"].sort(key=(lambda l:(-l["bbox"]["x0"],l["bbox"]["y0"])) if vertical
                          else (lambda l:(round(l["bbox"]["y0"]/8),l["bbox"]["x0"])))
        row["text"] = "\n".join(l["text"] for l in row["lines"])
        row["confidence"] = sum(l["confidence"] for l in row["lines"])/len(row["lines"]) if row["lines"] else 0
    return output

def recognize_legacy(request):
    image = prepare_image(request)
    variant = request.get("variant", "original")
    engine = request.get("engine", "paddle")
    language = request.get("language", "en")
    if engine == "manga":
        from manga_ocr import MangaOcr
        if "manga" not in models:
            import torch
            torch.set_num_threads(CPU_THREADS)
            models["manga"] = MangaOcr()
        return {"engine": "manga-ocr", "model": "kha-white/manga-ocr-base", "text": models["manga"](image), "confidence": None, "lines": [], "variant": variant}
    if engine != "paddle" or language not in ("en", "fr", "th", "japan", "zh"):
        raise ValueError("Unsupported OCR engine or language")
    from paddleocr import PaddleOCR
    import numpy as np
    if language not in models:
        models[language] = PaddleOCR(lang=language, ocr_version="PP-OCRv5", device="cpu", enable_mkldnn=accelerated, cpu_threads=PADDLE_THREADS,
            use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False,
            text_rec_score_thresh=0.0, text_det_limit_side_len=960, text_det_limit_type="max")
    result = list(models[language].predict(np.array(image)[:, :, ::-1]))[0]
    lines = []
    for text, score, poly in zip(result["rec_texts"], result["rec_scores"], result["rec_polys"]):
        points = np.asarray(poly).tolist()
        lines.append({"text": str(text), "confidence": float(score) * 100, "polygon": points,
            "bbox": {"x0": min(p[0] for p in points), "y0": min(p[1] for p in points), "x1": max(p[0] for p in points), "y1": max(p[1] for p in points)}})
    lines.sort(key=lambda l: (round(l["bbox"]["y0"] / 8), l["bbox"]["x0"]))
    return {"engine": "paddleocr", "model": "PP-OCRv5/" + language, "text": "\n".join(l["text"] for l in lines),
        "confidence": sum(l["confidence"] for l in lines) / len(lines) if lines else 0, "lines": lines, "variant": variant}

def display_font_proposals(image):
    """Conservative, review-only proposals for repeated tall Latin glyphs."""
    import cv2
    import numpy as np
    gray = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2GRAY)
    _, _, stats, _ = cv2.connectedComponentsWithStats((gray < 100).astype("uint8"), 8)
    glyphs = [(int(x),int(y),int(w),int(h)) for x,y,w,h,ink in stats[1:]
              if h >= 25 and w >= 3 and h > w*2.2 and ink >= 50 and .08 < ink/(w*h) < .85]
    groups = []
    for glyph in sorted(glyphs):
        x,y,w,h = glyph
        group = next((g for g in groups if
            -.5*min(w,g[-1][2]) <= x-(g[-1][0]+g[-1][2]) <= min(h,g[-1][3])*.6 and
            .6 <= h/g[-1][3] <= 1.7 and
            abs(y+h/2-g[-1][1]-g[-1][3]/2) < min(h,g[-1][3])*.45), None)
        if group is None: groups.append([glyph])
        else: group.append(glyph)
    lines = []
    for group in groups:
        if len(group) < 5: continue
        x0,y0 = min(g[0] for g in group),min(g[1] for g in group)
        x1,y1 = max(g[0]+g[2] for g in group),max(g[1]+g[3] for g in group)
        if x1-x0 < (y1-y0)*1.5: continue
        box = {"x0":x0,"y0":y0,"x1":x1,"y1":y1}
        lines.append({"bbox":box,"polygon":[[x0,y0],[x1,y0],[x1,y1],[x0,y1]],
                      "detectionConfidence":.5,"displayFont":True,"reviewRequired":True,
                      "observedBy":["glyph-components"]})
    return lines


def detect(request):
    import numpy as np
    image = prepare_image(request)
    result = list(detector().predict(np.array(image)[:, :, ::-1], limit_side_len=1024, limit_type="max", box_thresh=0.6))[0]
    lines = []
    for poly, score in zip(result["dt_polys"], result["dt_scores"]):
        points = np.asarray(poly).tolist()
        lines.append({"polygon": points, "detectionConfidence": float(score),
            "bbox": {"x0": min(p[0] for p in points), "y0": min(p[1] for p in points), "x1": max(p[0] for p in points), "y1": max(p[1] for p in points)}})
    if request.get("variant", "original") == "original":
        lines.extend(display_font_proposals(image))
    return {"engine": "paddleocr", "model": "PP-OCRv5_server_det", "variant": request.get("variant", "original"), "lines": lines}


def _clip_box(box, width, height):
    x0 = max(0, min(width - 1, int(round(float(box.get("x0", 0))))))
    y0 = max(0, min(height - 1, int(round(float(box.get("y0", 0))))))
    x1 = max(x0 + 1, min(width, int(round(float(box.get("x1", x0 + 1))))))
    y1 = max(y0 + 1, min(height, int(round(float(box.get("y1", y0 + 1))))))
    return x0, y0, x1, y1

def _candidate_component(binary, text_rect):
    import cv2
    import numpy as np
    h, w = binary.shape
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary.astype(np.uint8), 8)
    tx0, ty0, tx1, ty1 = text_rect
    roi = labels[ty0:ty1, tx0:tx1]
    if roi.size == 0:
        return None
    ids, counts = np.unique(roi, return_counts=True)
    text_area = max(1, (tx1 - tx0) * (ty1 - ty0))
    best = None
    for label, inside in zip(ids.tolist(), counts.tolist()):
        if label == 0:
            continue
        x, y, cw, ch, size = [int(v) for v in stats[label]]
        if size < max(80, text_area * 0.65):
            continue
        seed_ratio = inside / text_area
        area_ratio = size / text_area
        if seed_ratio < 0.22 or area_ratio < 1.0:
            continue
        touches = int(x <= 1) + int(y <= 1) + int(x + cw >= w - 1) + int(y + ch >= h - 1)
        crop_ratio = size / max(1, w * h)
        extent = size / max(1, cw * ch)
        component = (labels == label).astype(np.uint8)
        contours, _ = cv2.findContours(component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        contour = max(contours, key=cv2.contourArea)
        area = max(1.0, cv2.contourArea(contour))
        hull = cv2.convexHull(contour)
        solidity = area / max(1.0, cv2.contourArea(hull))
        score = (
            min(1.0, seed_ratio / 0.65) * 0.34 +
            min(1.0, max(0.0, area_ratio - 1.0) / 3.0) * 0.22 +
            min(1.0, extent / 0.72) * 0.12 +
            min(1.0, solidity / 0.82) * 0.12 +
            (0.20 if touches == 0 else 0.0)
        )
        if crop_ratio > 0.88:
            score -= 0.35
        if touches >= 2:
            score -= 0.35
        candidate = {
            "label": label,
            "score": float(score),
            "seedRatio": float(seed_ratio),
            "areaRatio": float(area_ratio),
            "touches": touches,
            "cropRatio": float(crop_ratio),
            "extent": float(extent),
            "solidity": float(solidity),
            "component": component,
            "contour": contour,
        }
        if best is None or candidate["score"] > best["score"]:
            best = candidate
    return best

def _surface_for_region(rgb, region, all_regions):
    import cv2
    import numpy as np
    height, width = rgb.shape[:2]
    x0, y0, x1, y1 = _clip_box(region.get("bbox") or {}, width, height)
    tw, th = max(1, x1 - x0), max(1, y1 - y0)
    container = region.get("containerBBox") or region.get("detectorBBox") or region.get("bbox") or {}
    cx0, cy0, cx1, cy1 = _clip_box(container, width, height)
    # Bubble outlines often sit much farther from the glyphs than OCR boxes imply,
    # especially for spiky/thought balloons. Search broadly; closed-surface scoring
    # prevents the expanded crop from turning open artwork into a balloon.
    pad_x = max(42, int(tw * 1.25), int((cx1 - cx0) * 0.55))
    pad_y = max(52, int(th * 1.55), int((cy1 - cy0) * 0.55))
    if th < tw * 0.35:
        pad_y = max(pad_y, 120, int(tw * 1.20))
    sx0 = max(0, min(x0, cx0) - pad_x)
    sy0 = max(0, min(y0, cy0) - pad_y)
    sx1 = min(width, max(x1, cx1) + pad_x)
    sy1 = min(height, max(y1, cy1) + pad_y)
    local = rgb[sy0:sy1, sx0:sx1]
    gray = cv2.cvtColor(local, cv2.COLOR_RGB2GRAY)
    lx0, ly0, lx1, ly1 = x0 - sx0, y0 - sy0, x1 - sx0, y1 - sy0

    otsu, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    light_threshold = int(max(135, min(220, otsu + 28)))
    dark = (gray < light_threshold).astype(np.uint8) * 255
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    light_free = (dark == 0).astype(np.uint8)

    edges = cv2.Canny(gray, 42, 118)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    edge_free = (edges == 0).astype(np.uint8)

    candidates = []
    a = _candidate_component(light_free, (lx0, ly0, lx1, ly1))
    if a:
        a["mode"] = "light-interior"
        candidates.append(a)
    b = _candidate_component(edge_free, (lx0, ly0, lx1, ly1))
    if b:
        b["mode"] = "edge-enclosed"
        b["score"] -= 0.04
        candidates.append(b)
    best = max(candidates, key=lambda row: row["score"], default=None)
    if best:
        component_gray = gray[best["component"] > 0]
        best["surfaceMedian"] = float(np.median(component_gray)) if len(component_gray) else 0.0
        stable = component_gray[component_gray >= np.percentile(component_gray, 35)] if len(component_gray) else component_gray
        best["surfaceVariation"] = float(np.std(stable if len(stable) else component_gray)) if len(component_gray) else 999.0

    normal_surface = bool(
        best and best["score"] >= 0.58 and best["seedRatio"] >= 0.30 and
        best["areaRatio"] >= 1.15 and best["cropRatio"] <= 0.86 and best["touches"] <= 1 and
        (best["mode"] != "edge-enclosed" or best["surfaceMedian"] >= 165)
    )
    # Very short utterances such as "EH?" occupy only a sliver of an otherwise
    # clean balloon, so seed coverage is naturally low. Admit only pristine,
    # fully enclosed light surfaces here; this avoids promoting open page
    # backgrounds and dark artwork.
    sparse_clean_surface = bool(
        best and best["mode"] == "light-interior" and best["touches"] == 0 and
        best["seedRatio"] >= 0.18 and 2.0 <= best["areaRatio"] <= 24.0 and
        best["cropRatio"] <= 0.78 and best["surfaceMedian"] >= 238 and
        best["surfaceVariation"] <= 10
    )
    strong = normal_surface or sparse_clean_surface

    if strong:
        contour = best["contour"]
        mask = np.zeros(gray.shape, np.uint8)
        cv2.drawContours(mask, [contour], -1, 255, -1)
        keep = max(1, min(5, int(round(min(tw, th) * 0.025))))
        if keep > 0:
            mask = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (keep * 2 + 1, keep * 2 + 1)))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if contours:
            contour = max(contours, key=cv2.contourArea)
        perimeter = max(1.0, cv2.arcLength(contour, True))
        epsilon = max(1.0, perimeter * 0.003)
        polygon = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if len(polygon) > 96:
            polygon = cv2.approxPolyDP(contour, perimeter * 0.006, True).reshape(-1, 2)
        points = [[int(p[0] + sx0), int(p[1] + sy0)] for p in polygon.tolist()]

        inner = mask.copy()
        inset = max(2, min(12, int(round(min(tw, th) * 0.07))))
        inner = cv2.erode(inner, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (inset * 2 + 1, inset * 2 + 1)))

        rx0, ry0, rx1, ry1 = lx0, ly0, lx1, ly1
        rx0 = max(0, min(inner.shape[1] - 1, rx0))
        ry0 = max(0, min(inner.shape[0] - 1, ry0))
        rx1 = max(rx0 + 1, min(inner.shape[1], rx1))
        ry1 = max(ry0 + 1, min(inner.shape[0], ry1))

        integral = cv2.integral((inner == 0).astype(np.uint8))
        def invalid_ratio(ax0, ay0, ax1, ay1):
            bad = integral[ay1, ax1] - integral[ay0, ax1] - integral[ay1, ax0] + integral[ay0, ax0]
            return float(bad) / max(1, (ax1 - ax0) * (ay1 - ay0))

        step = max(2, int(round(min(tw, th) * 0.06)))
        for _ in range(80):
            choices = []
            for name, box in (
                ("left", (max(0, rx0 - step), ry0, rx1, ry1)),
                ("right", (rx0, ry0, min(inner.shape[1], rx1 + step), ry1)),
                ("top", (rx0, max(0, ry0 - step), rx1, ry1)),
                ("bottom", (rx0, ry0, rx1, min(inner.shape[0], ry1 + step))),
            ):
                ax0, ay0, ax1, ay1 = box
                if (ax0, ay0, ax1, ay1) == (rx0, ry0, rx1, ry1):
                    continue
                ratio = invalid_ratio(ax0, ay0, ax1, ay1)
                if ratio <= 0.015:
                    gain = (ax1 - ax0) * (ay1 - ay0) - (rx1 - rx0) * (ry1 - ry0)
                    choices.append((ratio, -gain, name, box))
            if not choices:
                break
            _, _, _, box = min(choices)
            rx0, ry0, rx1, ry1 = box

        pixels = local[mask > 0]
        gray_pixels = gray[mask > 0]
        if len(pixels):
            keep_pixels = pixels[gray_pixels >= np.percentile(gray_pixels, 20)]
            if not len(keep_pixels):
                keep_pixels = pixels
            fill = np.median(keep_pixels, axis=0)
            fill_color = "#%02x%02x%02x" % tuple(int(max(0, min(255, v))) for v in fill)
            stable_gray = gray_pixels[gray_pixels >= np.percentile(gray_pixels, 35)]
            variation = float(np.std(stable_gray if len(stable_gray) else gray_pixels))
        else:
            fill_color, variation = "#ffffff", 0.0

        confidence = max(0.0, min(1.0, best["score"]))
        polygon_x = [p[0] for p in points]
        polygon_y = [p[1] for p in points]
        erase_box = {
            "x0": max(0, min(polygon_x)),
            "y0": max(0, min(polygon_y)),
            "x1": min(width, max(polygon_x) + 1),
            "y1": min(height, max(polygon_y) + 1)
        }
        flat_fill_safe = bool(variation <= 34)
        return {
            "surfaceType": "bubble",
            "shape": "polygon",
            "polygon": points,
            "eraseBox": erase_box,
            "safeBox": {"x0": int(rx0 + sx0), "y0": int(ry0 + sy0), "x1": int(rx1 + sx0), "y1": int(ry1 + sy0)},
            "fillColor": fill_color,
            "surfaceVariation": round(variation, 2),
            "flatFillSafe": flat_fill_safe,
            "requiresInpaint": bool(not flat_fill_safe),
            "paintMode": "flat-fill-polygon" if flat_fill_safe else "inpaint-polygon",
            "confidence": round(confidence, 4),
            "reviewRequired": bool(confidence < 0.72 or variation > 50),
            "detectionMode": best["mode"],
            "metrics": {
                "seedRatio": round(best["seedRatio"], 4),
                "areaRatio": round(best["areaRatio"], 4),
                "extent": round(best["extent"], 4),
                "solidity": round(best["solidity"], 4),
                "touches": int(best["touches"]),
            },
        }

    pad_x = max(6, int(round(tw * 0.10)))
    pad_y = max(5, int(round(th * 0.14)))
    if region.get("orientation") == "vertical":
        pad_x = max(pad_x, int(round(tw * 0.16)))
        pad_y = max(pad_y, int(round(th * 0.08)))
    bx0, by0 = max(0, x0 - pad_x), max(0, y0 - pad_y)
    bx1, by1 = min(width, x1 + pad_x), min(height, y1 + pad_y)

    for other in all_regions:
        if other is region:
            continue
        ob = other.get("bbox") or {}
        ox0, oy0, ox1, oy1 = _clip_box(ob, width, height)
        if bx1 <= ox0 or ox1 <= bx0 or by1 <= oy0 or oy1 <= by0:
            continue
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        ocx, ocy = (ox0 + ox1) / 2, (oy0 + oy1) / 2
        if abs(cx - ocx) >= abs(cy - ocy):
            cut = int(round((x1 + ox0) / 2)) if ocx > cx else int(round((ox1 + x0) / 2))
            if ocx > cx:
                bx1 = min(bx1, max(x1, cut))
            else:
                bx0 = max(bx0, min(x0, cut))
        else:
            cut = int(round((y1 + oy0) / 2)) if ocy > cy else int(round((oy1 + y0) / 2))
            if ocy > cy:
                by1 = min(by1, max(y1, cut))
            else:
                by0 = max(by0, min(y0, cut))

    ring = rgb[max(0, by0 - 3):min(height, by1 + 3), max(0, bx0 - 3):min(width, bx1 + 3)]
    fill_color = "#ffffff"
    if ring.size:
        sample = ring.reshape(-1, 3)
        fill = np.median(sample, axis=0)
        fill_color = "#%02x%02x%02x" % tuple(int(max(0, min(255, v))) for v in fill)

    return {
        "surfaceType": "scene",
        "shape": "rect",
        "eraseBox": {"x0": bx0, "y0": by0, "x1": bx1, "y1": by1},
        "safeBox": {"x0": bx0, "y0": by0, "x1": bx1, "y1": by1},
        "fillColor": fill_color,
        "surfaceVariation": None,
        "flatFillSafe": False,
        "requiresInpaint": True,
        "paintMode": "inpaint-rect",
        "confidence": 0.86,
        "reviewRequired": False,
        "detectionMode": "unboxed-rectangle",
        "metrics": ({
            "candidateScore": round(best["score"], 4),
            "seedRatio": round(best["seedRatio"], 4),
            "areaRatio": round(best["areaRatio"], 4),
            "surfaceMedian": round(best.get("surfaceMedian", 0.0), 2),
            "surfaceVariation": round(best.get("surfaceVariation", 0.0), 2),
            "touches": int(best.get("touches", 0)),
            "cropRatio": round(best.get("cropRatio", 0.0), 4),
            "mode": best.get("mode", "")
        } if best else {}),
    }

def layout_regions(request):
    import numpy as np
    from PIL import Image
    image = np.array(Image.open(io.BytesIO(base64.b64decode(request["image"]))).convert("RGB"))
    regions = request.get("regions") or []
    if len(regions) > 500:
        raise ValueError("Too many text regions")
    rows = []
    for region in regions:
        bbox = region.get("bbox")
        if not bbox:
            continue
        placement = _surface_for_region(image, region, regions)
        rows.append({"id": str(region.get("id", "")), "placement": placement})
    return {"width": int(image.shape[1]), "height": int(image.shape[0]), "regions": rows}


def dispatch(request):
    if request.get("op") == "status":
        from importlib.metadata import version
        active = device_config()
        versions = {p: version(p) for p in ("manga-ocr", "paddleocr", "paddlepaddle", "torch", "transformers")}
        if gpu_ready: versions["paddlepaddle"] = version("paddlepaddle-gpu")
        return {"ready": True, "versions": versions, "acceleration": {"engine": "cuda" if active["paddle"]!="cpu" else "onednn" if accelerated else "paddle-cpu", "devices":active,"fallbackReason":fallback_reason,"paddleThreads": PADDLE_THREADS, "torchThreads": CPU_THREADS}, "capabilities":{"batch":active["paddle"]!="cpu"}, "loaded": list(models), "inferenceCache": {**recognition_cache_stats,"entries":len(recognition_cache)}}
    if request.get("op") == "recognize-batch":
        return recognize_batch(request["items"])
    if request.get("op") == "layout-safe":
        from reader_surface import layout_safe
        return layout_safe(request)
    if request.get("op") == "layout":
        return layout_regions(request)
    if request.get("op") == "segment":
        return segment(request)
    if request.get("op") == "detect":
        return detect(request)
    if request.get("op") == "preview":
        image = prepare_image(request)
        output = io.BytesIO()
        image.save(output, format="PNG")
        return {"variant": request.get("variant", "original"), "width": image.width, "height": image.height,
            "dataUrl": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")}
    return recognize(request)

def segment(request):
    """Separate text by enclosed white areas; retain original grouping otherwise."""
    import cv2
    import numpy as np
    from PIL import Image
    image = np.array(Image.open(io.BytesIO(base64.b64decode(request["image"]))).convert("RGB"))
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    # Closing the dark outline seals compression pinholes before flood filling.
    dark = (gray < 210).astype(np.uint8) * 255
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    labels = np.zeros(gray.shape, np.int32)
    count, components, stats, _ = cv2.connectedComponentsWithStats((dark == 0).astype(np.uint8), 8)
    for index in range(1, count):
        x, y, w, h, size = stats[index]
        if size < 100 or x == 0 or y == 0 or x+w == gray.shape[1] or y+h == gray.shape[0]:
            continue
        contours, _ = cv2.findContours((components == index).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(labels, contours, -1, index, -1)
    result = segment_surface(request, gray, labels)
    if result["groups"]:
        return {**result, "surfaceMode": "white-interior"}
    if request.get('writingDirection') == 'vertical':
        # White lettering in connected black balloons needs the same enclosed
        # surface evidence; the exterior must not become a text surface.
        inverse = 255 - gray
        light = cv2.morphologyEx((inverse < 210).astype(np.uint8)*255, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        count, components, stats, _ = cv2.connectedComponentsWithStats((light == 0).astype(np.uint8), 8)
        dark_labels = np.zeros(gray.shape, np.int32)
        for index in range(1, count):
            x, y, w, h, size = stats[index]
            if size < 100 or x == 0 or y == 0 or x+w == gray.shape[1] or y+h == gray.shape[0]:
                continue
            contours, _ = cv2.findContours((components == index).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(dark_labels, contours, -1, index, -1)
        refined = segment_surface(request, inverse, dark_labels)
        if refined['groups']:
            return {**refined, 'surfaceMode': 'dark-interior'}
    # Colored and gradient balloons still have an outline even when their
    # interiors fail the white threshold. Discard the outside of open crops.
    edges = cv2.Canny(gray, 45, 120)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    count, components, stats, _ = cv2.connectedComponentsWithStats((edges == 0).astype(np.uint8), 8)
    labels = np.zeros(gray.shape, np.int32)
    for i in range(1, count):
        x, y, w, h, size = stats[i]
        if size < 400 or w < 20 or h < 20 or x == 0 or y == 0 or x+w == gray.shape[1] or y+h == gray.shape[0]:
            continue
        outline, _ = cv2.findContours((components == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(labels, outline, -1, i, -1)
    refined = segment_surface(request, gray, labels)
    return {**refined, "surfaceMode": "edge-outline"}

def staggered_text_groups(lines, gray, vertical=False):
    """Separate a shared row only with two stable, offset text alignments.

    Both sides must have several complete rows and the shared row must contain
    an actual ink-free gap. A normal centered paragraph is left untouched.
    """
    import numpy as np
    ordered = sorted(lines, key=lambda l: l.get("coreBbox", l["bbox"])["y0"])
    boxes = [l.get("coreBbox", l["bbox"]) for l in ordered]
    minimum = 4 if vertical else 7
    if len(boxes) < minimum:
        return None
    thickness = max(4, float(np.median([b["y1"]-b["y0"] for b in boxes])))
    flank = 1 if vertical else 3
    for index in range(flank, len(boxes)-flank):
        upper, lower = boxes[:index], boxes[index+1:]
        centers = lambda group: np.array([(b["x0"]+b["x1"])/2 for b in group])
        a, b = float(np.median(centers(upper))), float(np.median(centers(lower)))
        if abs(a-b) < thickness*3 or max(np.max(np.abs(centers(upper)-a)), np.max(np.abs(centers(lower)-b))) > thickness*2:
            continue
        shared = boxes[index]
        cut = (a+b)/2
        if not shared["x0"]+thickness < cut < shared["x1"]-thickness:
            continue
        x0, x1 = max(0,int(shared["x0"])), min(gray.shape[1],int(np.ceil(shared["x1"])))
        y0, y1 = max(0,int(shared["y0"]-thickness*.4)), min(gray.shape[0],int(np.ceil(shared["y1"]+thickness*.4)))
        patch = gray[y0:y1,x0:x1]
        ink = (patch > 180 if np.median(patch) < 110 else patch < 180).sum(axis=0)
        gaps = np.flatnonzero((ink == 0) & (np.abs(np.arange(x0,x1)-cut) < thickness*2))
        if not len(gaps):
            continue
        runs = np.split(gaps,np.where(np.diff(gaps)>1)[0]+1)
        gap = max(runs,key=len)
        if len(gap) < max(3,thickness*.4):
            continue
        cut = float(x0+gap.mean())
        left = {**shared,"x1":cut}; right = {**shared,"x0":cut}
        first, second = (right,left) if a>b else (left,right)
        edge_a, edge_b = ("x0","x1") if a>b else ("x1","x0")
        return [ordered[:index]+[{**ordered[index],"bbox":first,"coreBbox":first,"cutEdge":edge_a}],
                [{**ordered[index],"bbox":second,"coreBbox":second,"cutEdge":edge_b}]+ordered[index+1:]]
    return None

def contrast_text_groups(lines, gray):
    """Split a shared row only with aligned companion rows and opposite backgrounds."""
    import numpy as np
    if len(lines) < 3:
        return None
    ordered = sorted(lines, key=lambda l: l.get('coreBbox', l['bbox'])['y0'])
    boxes = [l.get('coreBbox', l['bbox']) for l in ordered]
    h = max(4, float(np.median([b['y1']-b['y0'] for b in boxes])))
    for index in (0, len(boxes)-1):
        shared = boxes[index]
        others = boxes[:index]+boxes[index+1:]
        centers = [(b['x0']+b['x1'])/2 for b in others]
        if max(centers)-min(centers) > h or any(b['x1']-b['x0'] > h*7 for b in others):
            continue
        anchor = min(b['x0'] for b in others)
        if anchor-shared['x0'] < h*5 or shared['x1'] < max(b['x1'] for b in others)-h:
            continue
        y0,y1 = max(0,int(shared['y0']-h*.4)),min(gray.shape[0],int(shared['y1']+h*.4))
        lo,hi = max(8,int(shared['x0']+h*2)),min(gray.shape[1]-8,int(anchor-h*.5))
        if hi<=lo:
            continue
        profile = np.median(gray[y0:y1],axis=0)
        candidates = [(float(np.median(profile[x-8:x])-np.median(profile[x:x+8])),x) for x in range(lo,hi)]
        strength,cut = max(candidates)
        if strength < 130 or np.median(profile[int(shared['x0']):cut]) < 190 or np.median(profile[cut:int(shared['x1'])]) > 100:
            continue
        # Companion rows must share the dark background, not merely alignment.
        if any(np.median(gray[max(0,int(b['y0']-h*.4)):min(gray.shape[0],int(b['y1']+h*.4)),max(0,int(b['x0']-h)):min(gray.shape[1],int(b['x1']+h))]) > 110 for b in others):
            continue
        left={**shared,'x1':float(cut)};right={**shared,'x0':float(cut)}
        return [[{**ordered[index],'bbox':left,'coreBbox':left,'cutEdge':'x1'}],
                ordered[:index]+[{**ordered[index],'bbox':right,'coreBbox':right,'cutEdge':'x0'}]+ordered[index+1:]]
    return None

def offset_vertical_groups(lines):
    """Two offset vertical text runs, after rotation, with an unusually wide gutter.

    A lone short column may form the second lobe. At least two other columns
    must agree on their alignment; ordinary unequal-length columns stay whole.
    """
    import numpy as np
    ordered = sorted(lines, key=lambda l: l.get('coreBbox', l['bbox'])['y0'])
    boxes = [l.get('coreBbox', l['bbox']) for l in ordered]
    if len(boxes) < 3:
        return None
    h = max(4, float(np.median([b['y1']-b['y0'] for b in boxes])))
    for index in range(1, len(boxes)):
        a, b = boxes[:index], boxes[index:]
        if min(p['y0'] for p in b)-max(p['y1'] for p in a) < h*1.2:
            continue
        centers = lambda rows: np.array([(p['x0']+p['x1'])/2 for p in rows])
        ac, bc = centers(a), centers(b)
        if max(float(np.ptp(ac)), float(np.ptp(bc))) > h*1.2 or abs(float(np.median(ac)-np.median(bc))) < h*3:
            continue
        starts = [float(np.median([p['x0'] for p in rows])) for rows in (a,b)]
        ends = [float(np.median([p['x1'] for p in rows])) for rows in (a,b)]
        overlap = max(0, min(ends)-max(starts))/max(1, min(ends[i]-starts[i] for i in (0,1)))
        if overlap >= .65 or max(abs(starts[0]-starts[1]),abs(ends[0]-ends[1])) < h*3:
            continue
        return [ordered[:index], ordered[index:]]
    return None

def segment_surface(request, gray, labels):
    import cv2
    import numpy as np
    contrast = contrast_text_groups(request.get('lines', []), gray)
    if contrast:
        return {'groups':contrast,'reason':'aligned-text-on-opposite-backgrounds'}
    staggered = staggered_text_groups(request.get("lines", []), gray, request.get('writingDirection') == 'vertical')
    if staggered:
        return {"groups": staggered, "reason": "staggered-alignment-with-source-gap"}
    if request.get('writingDirection') == 'vertical':
        offset = offset_vertical_groups(request.get('lines', []))
        if offset:
            return {'groups': offset, 'reason': 'offset-vertical-columns-with-gutter'}
    # Connected balloons can have two lobes joined by a narrow neck. Partition
    # that white area only when its distance field contains a real bottleneck.
    sizes = [l.get("coreBbox", l["bbox"])["y1"] - l.get("coreBbox", l["bbox"])["y0"] for l in request.get("lines", [])]
    line_height = max(4, float(np.median(sizes))) if sizes else 10
    next_label = int(labels.max()) + 1
    partitions = []
    widths = [l.get("coreBbox", l["bbox"])["x1"] - l.get("coreBbox", l["bbox"])["x0"] for l in request.get("lines", [])]
    median_width = float(np.median(widths)) if widths else 100
    for label in np.unique(labels):
        if not label:
            continue
        mask = (labels == label).astype(np.uint8)
        # A broad connection can erase one of the distance-field peaks. Two
        # visible inward bends on opposite balloon edges still define lobes.
        # Cut only through a real gap between complete text rows, with at
        # least two rows on each side; an ordinary ellipse has no such pinch.
        members = []
        for line in request.get("lines", []):
            b = line.get("coreBbox", line["bbox"])
            roi = mask[max(0,int(b["y0"])):min(mask.shape[0],int(np.ceil(b["y1"]))),max(0,int(b["x0"])):min(mask.shape[1],int(np.ceil(b["x1"])))]
            if roi.size and roi.mean() > .5:
                members.append(b)
        if len(members) >= 4:
            members.sort(key=lambda b: b["y0"])
            profile = {}
            for y in range(mask.shape[0]):
                xs = np.flatnonzero(mask[y])
                if len(xs):
                    profile[y] = (int(xs[0]), int(xs[-1]))
            choices = []
            for split in range(2, len(members)-1):
                end = max(b["y1"] for b in members[:split])
                start = min(b["y0"] for b in members[split:])
                if start-end < line_height*.6:
                    continue
                gap = [y for y in range(int(np.ceil(end)),int(start)) if y in profile]
                if not gap:
                    continue
                left_y = max(gap, key=lambda y: profile[y][0])
                right_y = min(gap, key=lambda y: profile[y][1])
                cut = int((left_y+right_y)/2)
                above = [profile[y] for y in range(max(0,int(cut-line_height*6)),int(cut-line_height)) if y in profile]
                below = [profile[y] for y in range(int(cut+line_height),min(mask.shape[0],int(cut+line_height*6))) if y in profile]
                if not above or not below:
                    continue
                a = max(above,key=lambda p:p[1]-p[0]);b = max(below,key=lambda p:p[1]-p[0])
                left = profile[left_y][0]-max(a[0],b[0]);right = min(a[1],b[1])-profile[right_y][1]
                if min(left,right) >= max(3,line_height*.6) and left+right >= line_height*1.5:
                    choices.append((left+right,cut))
            if choices:
                cut = max(choices)[1]
                yy = np.indices(mask.shape)[0]
                labels[(mask>0)&(yy<cut)] = next_label
                labels[(mask>0)&(yy>=cut)] = next_label+1
                next_label += 2
                continue
        distance = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
        radius = max(9, int(line_height * 3))
        peaks = (distance >= cv2.dilate(distance, np.ones((radius * 2 + 1, radius * 2 + 1), np.uint8)) - .01) & (distance > line_height * 2)
        count, components = cv2.connectedComponents(peaks.astype(np.uint8))
        centers = []
        for i in range(1, count):
            ys, xs = np.where(components == i)
            best = np.argmax(distance[ys, xs])
            centers.append((int(xs[best]), int(ys[best]), float(distance[ys[best], xs[best]])))
        centers.sort(key=lambda p: -p[2])
        selected = []
        for center in centers:
            if all(np.hypot(center[0] - p[0], center[1] - p[1]) > max(center[2], p[2]) * 1.3 for p in selected):
                selected.append(center)
        if len(selected) != 2:
            continue
        a, b = selected
        xs = np.linspace(a[0], b[0], 60).astype(int)
        ys = np.linspace(a[1], b[1], 60).astype(int)
        if distance[ys[8:-8], xs[8:-8]].min() >= min(a[2], b[2]) * .8:
            continue
        yy, xx = np.indices(gray.shape)
        nearest = np.argmin(np.stack([(xx-p[0])**2 + (yy-p[1])**2 for p in selected]), axis=0)
        for i in range(2):
            labels[(mask > 0) & (nearest == i)] = next_label + i
        left, right = sorted(range(2), key=lambda i: selected[i][0])
        if selected[right][0] - selected[left][0] > line_height * 3:
            partitions.append((next_label + left, next_label + right, (selected[left][0] + selected[right][0]) / 2, min(a[1], b[1]), max(a[1], b[1])))
        next_label += 2
    groups = {}
    for line in request.get("lines", []):
        b = line.get("coreBbox", line["bbox"])
        x0, y0 = max(0, int(b["x0"])), max(0, int(b["y0"]))
        x1, y1 = min(gray.shape[1], int(np.ceil(b["x1"]))), min(gray.shape[0], int(np.ceil(b["y1"])))
        if x1 <= x0 or y1 <= y0:
            continue
        roi = labels[y0:y1, x0:x1]
        ids, counts = np.unique(roi, return_counts=True)
        eligible = [(int(i), int(n)) for i, n in zip(ids, counts) if i and n / roi.size > .22]
        if not eligible:
            return {"groups": [], "reason": "no-enclosed-white-area"}
        bridge = None
        for left, right, cut, top, bottom in partitions:
            coverage = np.count_nonzero((roi == left) | (roi == right)) / roi.size
            if coverage > .5 and x1-x0 > median_width*1.25 and x0+line_height < cut < x1-line_height and top < (y0+y1)/2 < bottom:
                # Place the cut in the actual whitespace between the two words.
                ink = (gray[y0:y1, x0:x1] < 180).sum(axis=0)
                gaps = np.flatnonzero((ink == 0) & (np.abs(np.arange(x0, x1)-cut) < line_height*1.5))
                if len(gaps):
                    runs = np.split(gaps, np.where(np.diff(gaps) > 1)[0] + 1)
                    gap = max(runs, key=lambda values: (len(values), -abs(values.mean()+x0-cut)))
                    cut = x0 + float(gap.mean())
                    if len(gap) < max(2, line_height * .25):
                        continue
                else:
                    continue
                bridge = [(left, {**b, "x1": float(cut)}), (right, {**b, "x0": float(cut)})]
                break
        if bridge:
            for label, box in bridge:
                edge = "x1" if label == bridge[0][0] else "x0"
                groups.setdefault(label, []).append({**line, "coreBbox": box, "bbox": box, "cutEdge": edge})
            continue
        # A curved balloon border may cross a word rectangle. Its dominant
        # white area owns the complete line, avoiding clipped characters.
        eligible = [max(eligible, key=lambda pair: pair[1])]
        for label, count in eligible:
            box = {key: float(b[key]) for key in ("x0", "y0", "x1", "y1")}
            groups.setdefault(label, []).append({**line, "coreBbox": box, "bbox": box})
    values = list(groups.values())
    # Do not split off an isolated character hole or a tiny whitespace island.
    if len(values) < 2 or any(len(g) < (1 if request.get('writingDirection') == 'vertical' else 2) for g in values):
        return {"groups": [], "reason": "single-area"}
    # Several continuous rows crossing the proposed boundary indicate one
    # paragraph. A staggered balloon pair can share one detector row.
    crossing = 0
    for line in request.get("lines", []):
        b = line.get("coreBbox", line["bbox"])
        roi = labels[max(0,int(b["y0"])):min(gray.shape[0],int(np.ceil(b["y1"]))),max(0,int(b["x0"])):min(gray.shape[1],int(np.ceil(b["x1"])))]
        if roi.size:
            ids, counts = np.unique(roi, return_counts=True)
            crossing += sum(1 for i,n in zip(ids,counts) if i and n/roi.size > .25) > 1
    if crossing > 1:
        return {"groups": [], "reason": "continuous-text-crosses-boundary"}
    return {"groups": values, "reason": "balloon-boundaries"}

if __name__ == "__main__":
    for line in sys.stdin:
        try:
            request = json.loads(line)
            started = time.perf_counter()
            # Keep dependency progress, warnings and model logs off the protocol.
            with contextlib.redirect_stdout(sys.stderr):
                result = dispatch_with_fallback(request)
            response = {"id": request.get("id"), "result": result, "workerMs": round((time.perf_counter()-started)*1000)}
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            response = {"id": request.get("id") if "request" in locals() else None, "error": str(error)}
        print(json.dumps(response, ensure_ascii=True), flush=True)
