param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$taskRuntime = Join-Path $env:LOCALAPPDATA 'ImageHarvest\ocr-runtime'
$taskPython = Join-Path $taskRuntime 'Scripts\python.exe'
function Repair-AcceleratorAcl([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  & icacls.exe $Path /reset /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Warning "Could not fully normalize OCR accelerator permissions: $Path" }
}
if (!(Test-Path -LiteralPath $taskPython)) { throw 'Install the base runtime first with scripts/setup-ocr-runtime.ps1 (Python 3.12).' }
Repair-AcceleratorAcl (Join-Path $taskRuntime 'accelerators\torch-cu128')
Repair-AcceleratorAcl (Join-Path $taskRuntime 'accelerators\paddle-cu126')
if (!$ValidateOnly) {
  & $taskPython -m pip install --disable-pip-version-check --no-deps --upgrade --target (Join-Path $taskRuntime 'accelerators\torch-cu128') 'torch==2.11.0+cu128' --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw 'PyTorch GPU installation failed; GPU mode has not been enabled.' }
  & $taskPython -m pip install --disable-pip-version-check --no-deps --upgrade --target (Join-Path $taskRuntime 'accelerators\paddle-cu126') 'paddlepaddle-gpu==3.2.2' --index-url https://www.paddlepaddle.org.cn/packages/stable/cu126/
  if ($LASTEXITCODE -ne 0) { throw 'Paddle GPU installation failed; GPU mode has not been enabled.' }
  Repair-AcceleratorAcl (Join-Path $taskRuntime 'accelerators\torch-cu128')
  Repair-AcceleratorAcl (Join-Path $taskRuntime 'accelerators\paddle-cu126')
}
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  & $taskPython scripts/probe-ocr-gpu.py
  if ($LASTEXITCODE -ne 0) { throw 'GPU inference validation failed; GPU mode has not been enabled.' }
} finally { Pop-Location }
Set-Content -LiteralPath (Join-Path $taskRuntime 'accelerators\gpu-ready.json') -Encoding utf8 -Value '{"paddle":"3.2.2-cu126","torch":"2.11.0-cu128","validated":"local-inference"}'
Write-Output 'GPU OCR validated and enabled. Restart ImageHarvest to use the new worker.'
