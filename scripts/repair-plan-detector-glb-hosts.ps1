param(
  [Parameter(Mandatory=$true)][string]$InputGlb,
  [string]$OutputGlb
)
$ErrorActionPreference = 'Stop'
if (-not $OutputGlb) {
  $dir = Split-Path -Parent $InputGlb
  $base = [System.IO.Path]::GetFileNameWithoutExtension($InputGlb)
  $OutputGlb = Join-Path $dir ($base + '.wall-hosts-fixed.glb')
}
$script = Join-Path $PSScriptRoot 'repair-plan-detector-glb-hosts.py'
if (-not (Test-Path $script)) { throw "Script Python introuvable: $script" }
$py = Get-Command py -ErrorAction SilentlyContinue
if ($py) { & py -3 $script $InputGlb $OutputGlb }
else {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $python) { throw "Python introuvable. Installe Python ou lance le script depuis l'environnement plan_detector." }
  & python $script $InputGlb $OutputGlb
}
Write-Host "GLB réparé: $OutputGlb" -ForegroundColor Green
