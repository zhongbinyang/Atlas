$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot

function Build-And-Sync([string]$AppName, [string]$CrateName) {
    $app = Join-Path $root "frontend/$AppName"
    $static = Join-Path $root "crates/$CrateName/static"

    Push-Location $app
    try {
        npm run build
    } finally {
        Pop-Location
    }

    $dist = Join-Path $app 'dist'
    if (-not (Test-Path $dist)) {
        throw "missing dist for $AppName"
    }

    Get-ChildItem $static -Force | Where-Object {
        $_.Name -ne 'favicon.svg'
    } | Remove-Item -Recurse -Force

    Copy-Item -Path (Join-Path $dist '*') -Destination $static -Recurse -Force

    $favSrc = Join-Path $app 'public/favicon.svg'
    if (Test-Path $favSrc) {
        Copy-Item $favSrc (Join-Path $static 'favicon.svg') -Force
    }
}

Build-And-Sync -AppName 'scheduler' -CrateName 'scheduler'
Build-And-Sync -AppName 'agent' -CrateName 'agent'
Write-Host 'Frontend build synced to crates/*/static'
