"""Exact pixel reuse boundaries without loading OCR models."""
import base64, importlib.util, io, pathlib
from PIL import Image

spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).parents[1] / 'src/ocr-backend.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.devices = {'paddle': 'cpu', 'manga': 'cpu'}
calls = []

def request(color=0, **kwargs):
    output = io.BytesIO()
    Image.new('RGB', (16, 12), (color, color, color)).save(output, format='PNG')
    return {'image': base64.b64encode(output.getvalue()).decode(), **kwargs}

def recognize(requests, images):
    calls.append(len(requests))
    return [{'text': 'source', 'lines': [{'bbox': {'x0': 1}}]} for _ in images]

worker._recognize_batch_uncached = recognize
first, alias = worker.recognize_batch([request(), request(variant='grayscale')])
assert calls == [1] and not first['inferenceReused'] and alias['inferenceReused']
assert alias['variant'] == 'grayscale' and alias['batchSize'] == 2
first['lines'][0]['bbox']['x0'] = 100
assert worker.recognize(request())['lines'][0]['bbox']['x0'] == 1
assert alias['lines'][0]['bbox']['x0'] == 1
for changed in [request(1), request(language='japan'), request(recognizeOnly=True), request(engine='manga'), request(variant='wide')]:
    assert not worker.recognize(changed)['inferenceReused']
worker.devices['paddle'] = 'gpu:0'
assert not worker.recognize(request())['inferenceReused']
assert worker.recognize(request(reuse=False))['inferenceReused'] is False

def fail(*args):
    raise RuntimeError('model failed')

worker._recognize_batch_uncached = fail
before = len(worker.recognition_cache)
try:
    worker.recognize(request(23))
except RuntimeError:
    pass
else:
    raise AssertionError('Model error swallowed')
assert len(worker.recognition_cache) == before
worker._recognize_batch_uncached = recognize
for value in range(65):
    worker.recognize(request(value))
assert len(worker.recognition_cache) == 64
assert not worker.recognize(request())['inferenceReused'], 'LRU must evict oldest result'
print('Exact pixels, language, engine, device, geometry, mutation isolation, failures and bounded LRU passed')
