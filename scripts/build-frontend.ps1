$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'frontend'
$static = Join-Path $root 'static'

Push-Location $app
try {
    npm run build
} finally {
    Pop-Location
}

Get-ChildItem $static -Force | Where-Object { $_.Name -ne 'favicon.svg' } | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $app 'dist\*') -Destination $static -Recurse -Force
$favSrc = Join-Path $app 'public/favicon.svg'
if (Test-Path $favSrc) {
    Copy-Item $favSrc (Join-Path $static 'favicon.svg') -Force
}
Write-Host 'Frontend build synced to static/'
