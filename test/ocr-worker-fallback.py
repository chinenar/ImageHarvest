"""Protocol fallback regression; no models or CUDA memory are required."""
import importlib.util, pathlib, sys, types
spec=importlib.util.spec_from_file_location('worker',pathlib.Path(__file__).parents[1]/'src/ocr-backend.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
events=[]
worker.models={'detector':types.SimpleNamespace(close=lambda:events.append('closed'))}
worker.devices={'paddle':'gpu:0','manga':'cuda:0'}
sys.modules['torch']=types.SimpleNamespace(cuda=types.SimpleNamespace(empty_cache=lambda:events.append('emptied')))
def dispatch(request):
    events.append(worker.devices['paddle'])
    if worker.devices['paddle']!='cpu': raise RuntimeError('CUDA out of memory')
    return request
worker.dispatch=dispatch
request={'op':'detect','image':'same-image'}
assert worker.dispatch_with_fallback(request) is request
assert events==['gpu:0','closed','emptied','cpu']
assert not worker.models and worker.fallback_reason=='gpu-memory-exhausted'
worker.devices={'paddle':'gpu:0','manga':'cuda:0'}
worker.dispatch=lambda request: (_ for _ in ()).throw(ValueError('Invalid crop'))
try: worker.dispatch_with_fallback(request)
except ValueError: pass
else: raise AssertionError('Non-memory errors must be reported')
assert worker.devices['paddle']=='gpu:0'
print('CPU memory fallback and explicit non-memory errors passed')
