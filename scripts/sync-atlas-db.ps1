# Sync atlas DB: remote PostgreSQL -> local Docker (atlas-postgres).
# Usage (from repo root):
#   .\scripts\sync-atlas-db.ps1
# Optional:
#   .\scripts\sync-atlas-db.ps1 -SourceHost 10.102.30.18 -SourcePort 5432

param(
  [string]$SourceHost = "10.102.30.18",
  [int]$SourcePort = 5432,
  [string]$SourceUser = "postgres",
  [string]$SourcePassword = "postgres",
  [string]$SourceDb = "atlas",
  [string]$LocalHost = "127.0.0.1",
  [int]$LocalPort = 5432,
  [string]$LocalUser = "postgres",
  [string]$LocalPassword = "postgres",
  [string]$LocalDb = "atlas",
  [string]$PgImage = "postgres:16-alpine"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$dumpDir = Join-Path $root ".tmp"
New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null
$dumpFile = Join-Path $dumpDir "atlas.dump"

Write-Host "==> Ensure local Docker Postgres is up"
docker compose up -d postgres

Write-Host "==> Wait for local Postgres healthy"
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  docker compose exec -T postgres pg_isready -U $LocalUser -d $LocalDb 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw "Local Postgres did not become ready in time" }

Write-Host "==> Dump ${SourceHost}:${SourcePort}/${SourceDb} -> .tmp/atlas.dump"
docker run --rm `
  -e "PGPASSWORD=$SourcePassword" `
  -v "${dumpDir}:/out" `
  $PgImage `
  pg_dump -h $SourceHost -p $SourcePort -U $SourceUser -d $SourceDb `
    --no-owner --no-acl -F c -f /out/atlas.dump
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }

Write-Host "==> Restore into local ${LocalHost}:${LocalPort}/${LocalDb}"
# Use host gateway so the one-off client can reach published port 5432 on the host.
docker run --rm `
  -e "PGPASSWORD=$LocalPassword" `
  -v "${dumpDir}:/out" `
  --add-host=host.docker.internal:host-gateway `
  $PgImage `
  pg_restore -h host.docker.internal -p $LocalPort -U $LocalUser -d $LocalDb `
    --clean --if-exists --no-owner --no-acl /out/atlas.dump
# pg_restore returns 1 when some objects warn; treat as soft failure unless empty DB
if ($LASTEXITCODE -gt 1) { throw "pg_restore failed with exit $LASTEXITCODE" }

Write-Host ""
Write-Host "Done. Point Center at local DB:"
Write-Host '  $env:SCHEDULER_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/atlas?sslmode=disable"'
Write-Host "Dump kept at: $dumpFile"
