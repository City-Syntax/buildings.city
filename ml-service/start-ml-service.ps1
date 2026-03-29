$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupScript = Join-Path $scriptDir 'setup-venv.ps1'
$pythonExe = Join-Path $scriptDir '.venv\Scripts\python.exe'

& $setupScript

Push-Location $scriptDir
try {
    & $pythonExe -m uvicorn app.main:app --port 8000
}
finally {
    Pop-Location
}