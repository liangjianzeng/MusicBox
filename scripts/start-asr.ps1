# Speech recognition worker (:8191) - the third piece next to start-server.ps1 / start-executor.ps1
#
# Why it must stay up: the intent pipeline's verbatim transcript and emotion tag come from
# this process (src/workers/sensevoice). History: nobody started it, so intent_voice jobs still
# reported done/100/"intent card generated" while result.fallback=true was invisible in the DB -
# the user only saw "not understood, then nothing at all" (2026-11-24 post-mortem).
# On-device ASR now covers the offline case, but the authoritative "server re-checks the final
# transcript" path still depends on this process. When it is down, the app's
# Me -> Speech settings page says so honestly (GET /v1/health/speech).
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes BOM-less .ps1 as ANSI,
# so Chinese comments here would break string parsing at runtime.
Set-Location "E:\Work\MusicBox"
$py = "E:\Work\MusicBox\venv-asr\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Host "missing venv-asr: $py (create it and run: pip install -r src/workers/sensevoice/requirements.txt)" -ForegroundColor Red
  exit 1
}
$env:MODELSCOPE_CACHE = "E:\Work\MusicBox\var\models"   # weights dir (SenseVoiceSmall already there, ~896MB)
$env:MB_ASR_DEVICE = "cpu"
$env:MB_ASR_PORT = "8191"
# librosa/funasr decode m4a via ffmpeg, which must be on PATH (otherwise duration comes back 0)
$ff = "E:\Work\X-Theater\runtime\bin"
if (Test-Path $ff) { $env:PATH = "$ff;$env:PATH" }
Write-Host "speech worker -> http://127.0.0.1:$($env:MB_ASR_PORT) (device=$($env:MB_ASR_DEVICE))" -ForegroundColor Green
& $py "src\workers\sensevoice\app.py"
