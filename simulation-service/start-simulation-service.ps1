$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupScript = Join-Path $scriptDir 'setup-venv.ps1'
$pythonExe = Join-Path $scriptDir '.venv\Scripts\python.exe'
$repoRoot = Split-Path -Parent $scriptDir
$configPath = Join-Path $repoRoot 'user-data\config.json'

& $setupScript

if (Test-Path $configPath) {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    $dataPath = [string]($config.buildings_source.data)
    $energyplusExe = [string]($config.energyplus_executable_path)
    $energyplusIdd = [string]($config.energyplus_idd_path)

    if ($dataPath) {
        if ($dataPath -match '^[A-Za-z]:[\\/]') {
            $env:BUILDING_LIBRARY_GEOJSON = $dataPath
        }
        else {
            $relativePath = $dataPath.TrimStart('/', '\')
            $env:BUILDING_LIBRARY_GEOJSON = Join-Path $repoRoot $relativePath.Replace('/', '\')
        }

        Write-Host "BUILDING_LIBRARY_GEOJSON=$env:BUILDING_LIBRARY_GEOJSON"
    }

    if ($energyplusExe) {
        $env:ENERGYPLUS_EXE = $energyplusExe
        Write-Host "ENERGYPLUS_EXE=$env:ENERGYPLUS_EXE"
    }

    if ($energyplusIdd) {
        $env:ENERGYPLUS_IDD = $energyplusIdd
        Write-Host "ENERGYPLUS_IDD=$env:ENERGYPLUS_IDD"
    }
}

# EnergyPlus timeout in seconds. Default: 3600 seconds (1 hour).
$env:ENERGYPLUS_TIMEOUT_SECONDS = '3600'
Write-Host "ENERGYPLUS_TIMEOUT_SECONDS=$env:ENERGYPLUS_TIMEOUT_SECONDS"

Push-Location $scriptDir
try {
    Write-Host "Regenerating generated IDF templates from templates.json..."
    & $pythonExe .\app\generate_idfs.py --no-zone-json
    & $pythonExe -m uvicorn app.main:app --host 127.0.0.1 --port 8010
}
finally {
    Pop-Location
}
