param(
  [string]$Root = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg) { Write-Host "[smelt-v7.1] $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "[smelt-v7.1] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "[smelt-v7.1] $msg" -ForegroundColor Yellow }

$publicDir = Join-Path $Root 'public'
$srcDir = Join-Path $Root 'src'
$scriptsDir = Join-Path $Root 'scripts'
$planDir = Join-Path $Root 'plan_detector'

if (!(Test-Path $publicDir)) { throw "Dossier public introuvable. Lance ce script depuis la racine du repo glb2ifc." }
if (!(Test-Path $srcDir)) { throw "Dossier src introuvable. Lance ce script depuis la racine du repo glb2ifc." }

New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
New-Item -ItemType Directory -Path $planDir -Force | Out-Null

# Copy updated files from the package when present.
$packageRoot = Split-Path -Parent $PSScriptRoot
$filesToCopy = @(
  @{ From = 'public/plan-workflow-fix-v7.js'; To = 'public/plan-workflow-fix-v7.js' },
  @{ From = 'public/viewer-init-guard-v7.js'; To = 'public/viewer-init-guard-v7.js' },
  @{ From = 'src/plan2glb_route.js'; To = 'src/plan2glb_route.js' },
  @{ From = 'plan_detector/main.py'; To = 'plan_detector/main.py' },
  @{ From = 'plan_detector/README.md'; To = 'plan_detector/README.md' }
)

foreach ($entry in $filesToCopy) {
  $from = Join-Path $packageRoot $entry.From
  $to = Join-Path $Root $entry.To
  if (Test-Path $from) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
    $fromResolved = (Resolve-Path $from).Path
    $toResolved = if (Test-Path $to) { (Resolve-Path $to).Path } else { $to }

    if ([string]::Equals($fromResolved, $toResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Info "Déjà en place $($entry.To)"
    } else {
      Copy-Item -Path $from -Destination $to -Force
      Write-Info "Copié $($entry.To)"
    }
  } else {
    Write-Warn "Fichier package absent: $($entry.From)"
  }
}

function Ensure-ScriptTag {
  param(
    [string]$HtmlPath,
    [string]$Marker,
    [string]$ScriptSrc,
    [bool]$Module = $false
  )

  if (!(Test-Path $HtmlPath)) { throw "HTML introuvable: $HtmlPath" }
  $content = Get-Content -Path $HtmlPath -Raw -Encoding UTF8

  $pattern = "(?s)<!-- $Marker START -->.*?<!-- $Marker END -->\s*"
  $content = [regex]::Replace($content, $pattern, '')

  $typeAttr = if ($Module) { ' type="module"' } else { '' }
  $block = @"
<!-- $Marker START -->
<script$typeAttr src="$ScriptSrc"></script>
<!-- $Marker END -->
"@

  if ($content -notmatch '</body>') { throw "Balise </body> introuvable dans $HtmlPath" }
  $content = $content -replace '</body>', ($block + "`r`n</body>")
  Set-Content -Path $HtmlPath -Value $content -Encoding UTF8
}

$indexHtml = Join-Path $publicDir 'index.html'
$viewerHtml = Join-Path $publicDir 'viewer.html'

Ensure-ScriptTag -HtmlPath $indexHtml -Marker 'SMELT_PLAN_OUTPUT_FIX_V7' -ScriptSrc '/plan-workflow-fix-v7.js' -Module $true
Write-Ok 'public/index.html patché : Plan detection télécharge maintenant GLB + IFC et ajoute le lien Modeler.'

if (Test-Path $viewerHtml) {
  Ensure-ScriptTag -HtmlPath $viewerHtml -Marker 'SMELT_VIEWER_INIT_GUARD_V7' -ScriptSrc '/viewer-init-guard-v7.js' -Module $false
  Write-Ok 'public/viewer.html patché : plus de blocage silencieux infini sur Initialisation du viewer.'
} else {
  Write-Warn 'public/viewer.html introuvable, viewer guard ignoré.'
}

Write-Ok 'Patch v7.1 appliqué. Relance le serveur puis fais Ctrl+Shift+R dans le navigateur.'
