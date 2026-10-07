param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$taskRuntime = Join-Path $env:LOCALAPPDATA 'ImageHarvest\ocr-runtime'
if (!(Test-Path -LiteralPath (Join-Path $taskRuntime 'Scripts\python.exe'))) {
  & $Python -m venv $taskRuntime
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required to create the OCR runtime.' }
}
& (Join-Path $taskRuntime 'Scripts\python.exe') -m pip install --disable-pip-version-check 'manga-ocr==0.1.16' 'paddleocr==3.7.0' 'paddlepaddle==3.3.1'
if ($LASTEXITCODE -ne 0) { throw 'OCR dependency installation failed.' }
$taskAccelerator = Join-Path $taskRuntime 'accelerators\paddle-3.2.2'
if (Test-Path -LiteralPath $taskAccelerator) { & icacls.exe $taskAccelerator /reset /T /C | Out-Null }
& (Join-Path $taskRuntime 'Scripts\python.exe') -m pip install --disable-pip-version-check --no-deps --target $taskAccelerator 'paddlepaddle==3.2.2'
if ($LASTEXITCODE -ne 0) { throw 'OCR CPU accelerator installation failed.' }
& icacls.exe $taskAccelerator /reset /T /C | Out-Null
Set-Content -LiteralPath (Join-Path $taskAccelerator 'ready.json') -Encoding utf8 -Value '{"version":"3.2.2","engine":"onednn"}'
Write-Output "OCR runtime installed at $taskRuntime. Models download on first use. Images are processed locally."
