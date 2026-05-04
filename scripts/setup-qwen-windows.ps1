param(
  [switch]$Cuda,
  [switch]$Vulkan,
  [switch]$SkipBuild,
  [switch]$FindOnly,
  [switch]$PrereqsOnly,
  [switch]$NoAutoInstallPrereqs,
  [string]$LlamaServerBin = "",
  [string]$LlamaCppDir = ".tools\llama.cpp",
  [string]$BuildDir = "",
  [string]$ModelPath = "models\Qwen3-Reranker-0.6B-Q4_K_M.gguf"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

function Resolve-ProjectPath([string]$Value) {
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $Root $Value))
}

function Find-PortableCMake {
  $cmakeToolsDir = Join-Path $Root ".tools\cmake"
  if (-not (Test-Path $cmakeToolsDir)) { return $null }

  $found = Get-ChildItem -Path $cmakeToolsDir -Recurse -Filter "cmake.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\bin\\cmake\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($found) { return $found.FullName }
  return $null
}

function Add-CommandDirToPath([string]$CommandPath) {
  if ([string]::IsNullOrWhiteSpace($CommandPath)) { return }
  $dir = Split-Path $CommandPath -Parent
  if ([string]::IsNullOrWhiteSpace($dir)) { return }
  $parts = @($env:Path -split ";") | Where-Object { $_ }
  $already = $false
  foreach ($part in $parts) {
    if ($part.TrimEnd("\") -ieq $dir.TrimEnd("\")) { $already = $true; break }
  }
  if (-not $already) { $env:Path = "$dir;$env:Path" }
}

function Test-Command([string]$Name) {
  if ($Name -ieq "cmake") {
    $portableCMake = Find-PortableCMake
    if ($portableCMake) {
      Add-CommandDirToPath $portableCMake
      return $portableCMake
    }
  }

  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Install-PortableCMake {
  $existing = Find-PortableCMake
  if ($existing) {
    Add-CommandDirToPath $existing
    return $existing
  }

  $cmakeToolsDir = Join-Path $Root ".tools\cmake"
  $downloadsDir = Join-Path $cmakeToolsDir "downloads"
  New-Item -ItemType Directory -Force -Path $downloadsDir | Out-Null

  Write-Host "Installing portable CMake under .tools\cmake..." -ForegroundColor Cyan

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  } catch {}

  $asset = $null
  try {
    $headers = @{ "User-Agent" = "glb2ifc-qwen-setup" }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/Kitware/CMake/releases/latest" -Headers $headers -ErrorAction Stop
    $asset = $release.assets |
      Where-Object { $_.name -match "^cmake-.*-windows-x86_64\.zip$" } |
      Select-Object -First 1
  } catch {
    Write-Host "Could not query the latest CMake release from GitHub." -ForegroundColor Yellow
    Write-Host "Reason: $($_.Exception.Message)" -ForegroundColor DarkYellow
  }

  if (-not $asset) {
    Write-Host "Portable CMake auto-download could not find a Windows x86_64 ZIP asset." -ForegroundColor Yellow
    return $null
  }

  $zipPath = Join-Path $downloadsDir $asset.name
  Write-Host "Downloading $($asset.name)..." -ForegroundColor Cyan
  try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
  } catch {
    Write-Host "Could not download portable CMake." -ForegroundColor Yellow
    Write-Host "Reason: $($_.Exception.Message)" -ForegroundColor DarkYellow
    return $null
  }

  $extractDir = Join-Path $cmakeToolsDir ([System.IO.Path]::GetFileNameWithoutExtension($asset.name))
  if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }

  Write-Host "Extracting CMake..." -ForegroundColor Cyan
  try {
    Expand-Archive -LiteralPath $zipPath -DestinationPath $cmakeToolsDir -Force
  } catch {
    Write-Host "Could not extract portable CMake." -ForegroundColor Yellow
    Write-Host "Reason: $($_.Exception.Message)" -ForegroundColor DarkYellow
    return $null
  }

  $installed = Find-PortableCMake
  if ($installed) {
    Add-CommandDirToPath $installed
    Write-Host "Portable CMake ready: $installed" -ForegroundColor Green
    return $installed
  }

  Write-Host "Portable CMake was downloaded but cmake.exe was not found after extraction." -ForegroundColor Yellow
  return $null
}

function Update-SessionPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $paths = @($machinePath, $userPath, $env:Path) | Where-Object { $_ }
  $env:Path = $paths -join ";"
}

function Install-WithWinget([string]$Id, [string]$DisplayName) {
  $winget = Test-Command winget
  if (-not $winget) { return $false }

  Write-Host "Installing $DisplayName with winget..." -ForegroundColor Cyan
  & winget install --exact --id $Id --source winget --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Host "winget could not install $DisplayName automatically." -ForegroundColor Yellow
    return $false
  }

  Update-SessionPath
  return $true
}

function Require-Command([string]$Name, [string]$WingetId = "", [string]$ManualHint = "") {
  $found = Test-Command $Name
  if ($found) { return $found }

  if ((-not $NoAutoInstallPrereqs) -and (-not [string]::IsNullOrWhiteSpace($WingetId))) {
    Install-WithWinget -Id $WingetId -DisplayName $Name | Out-Null
    $found = Test-Command $Name
    if ($found) { return $found }
  }

  if ((-not $NoAutoInstallPrereqs) -and ($Name -ieq "cmake")) {
    $portable = Install-PortableCMake
    if ($portable) { return $portable }
  }

  Write-Host ""
  Write-Host "Missing command '$Name'." -ForegroundColor Red
  if (-not [string]::IsNullOrWhiteSpace($ManualHint)) {
    Write-Host $ManualHint -ForegroundColor Yellow
  } elseif ($Name -ieq "cmake") {
    Write-Host "Install CMake manually, then restart PowerShell:" -ForegroundColor Yellow
    Write-Host "  winget install --exact --id Kitware.CMake --source winget" -ForegroundColor Yellow
    Write-Host "or download the Windows x64 ZIP from Kitware/CMake GitHub releases and add its bin folder to PATH." -ForegroundColor Yellow
  } elseif (-not [string]::IsNullOrWhiteSpace($WingetId)) {
    Write-Host "Install it with:" -ForegroundColor Yellow
    Write-Host "  winget install --exact --id $WingetId --source winget" -ForegroundColor Yellow
  }
  Write-Host "Then rerun:" -ForegroundColor Yellow
  Write-Host "  bun run qwen:setup:windows" -ForegroundColor Yellow
  throw "Missing command '$Name'."
}

function Test-VSNativeBuildTools {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Workload.NativeDesktop -property installationPath 2>$null
    if (-not [string]::IsNullOrWhiteSpace($installation)) { return $true }
  }

  if (Test-Command cl.exe) { return $true }
  if (Test-Command clang.exe) { return $true }
  if (Test-Command gcc.exe) { return $true }
  return $false
}

function Write-BuildToolsHint {
  Write-Host ""
  Write-Host "C++ build tools were not detected." -ForegroundColor Yellow
  Write-Host "llama.cpp on Windows needs a C++ toolchain. The simplest option is Visual Studio Build Tools with the Native Desktop workload:" -ForegroundColor Yellow
  Write-Host '  winget install --exact --id Microsoft.VisualStudio.2022.BuildTools --source winget --override "--add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --passive --wait"' -ForegroundColor Yellow
  Write-Host "After installation, restart PowerShell and rerun:" -ForegroundColor Yellow
  Write-Host "  bun run qwen:setup:windows" -ForegroundColor Yellow
}

function Repair-QwenEnvNewlines([string]$Content) {
  if ([string]::IsNullOrEmpty($Content)) { return $Content }

  $knownKeys = @(
    "QWEN_LLAMA_SERVER_BIN",
    "QWEN_MODEL_PATH",
    "QWEN_LLAMA_HOST",
    "QWEN_LLAMA_PORT",
    "QWEN_LLAMA_CONTEXT",
    "QWEN_LLAMA_BATCH",
    "QWEN_AUTO_START",
    "QWEN_RERANKER_URL"
  )

  $fixed = $Content
  foreach ($knownKey in $knownKeys) {
    $escaped = [regex]::Escape($knownKey)
    $fixed = [regex]::Replace($fixed, "([^`r`n])(?=$escaped=)", '$1' + "`r`n")
  }
  return $fixed
}

function Upsert-EnvValue([string]$EnvFile, [string]$Key, [string]$Value) {
  $line = "$Key=$Value"
  if (Test-Path $EnvFile) {
    $raw = Get-Content -Path $EnvFile -Raw
    $repaired = Repair-QwenEnvNewlines $raw
    if ($repaired -ne $raw) {
      Set-Content -Path $EnvFile -Value $repaired -Encoding UTF8 -NoNewline
    }

    $lines = @(Get-Content -Path $EnvFile)
    $found = $false
    $next = @(foreach ($existing in $lines) {
      if ($existing -match "^$([regex]::Escape($Key))=") {
        $found = $true
        $line
      } else {
        $existing
      }
    })
    if (-not $found) { $next = @($next) + $line }
    Set-Content -Path $EnvFile -Value $next -Encoding UTF8
  } else {
    Set-Content -Path $EnvFile -Value @($line) -Encoding UTF8
  }
}

function Find-LlamaServerExe([string[]]$SearchRoots, [string]$ExplicitBin = "") {
  if (-not [string]::IsNullOrWhiteSpace($ExplicitBin)) {
    $explicit = Resolve-ProjectPath $ExplicitBin
    if (Test-Path $explicit) { return (Resolve-Path $explicit).Path }
    throw "LlamaServerBin was provided but does not exist: $explicit"
  }

  if ($env:QWEN_LLAMA_SERVER_BIN) {
    $fromEnv = Resolve-ProjectPath $env:QWEN_LLAMA_SERVER_BIN
    if (Test-Path $fromEnv) { return (Resolve-Path $fromEnv).Path }
  }

  $pathServer = Get-Command llama-server.exe -ErrorAction SilentlyContinue
  if ($pathServer) { return $pathServer.Source }

  $candidateSuffixes = @(
    "build\bin\Release\llama-server.exe",
    "build\bin\RelWithDebInfo\llama-server.exe",
    "build\bin\Debug\llama-server.exe",
    "build\bin\llama-server.exe",
    "bin\Release\llama-server.exe",
    "bin\llama-server.exe",
    "examples\server\Release\llama-server.exe",
    "server\Release\llama-server.exe",
    "llama-server.exe"
  )

  $seen = @{}
  foreach ($rootCandidate in $SearchRoots) {
    if ([string]::IsNullOrWhiteSpace($rootCandidate)) { continue }
    $rootPath = Resolve-ProjectPath $rootCandidate
    if ($seen.ContainsKey($rootPath.ToLowerInvariant())) { continue }
    $seen[$rootPath.ToLowerInvariant()] = $true

    foreach ($suffix in $candidateSuffixes) {
      $candidate = Join-Path $rootPath $suffix
      if (Test-Path $candidate) { return (Resolve-Path $candidate).Path }
    }

    if (Test-Path $rootPath) {
      $found = Get-ChildItem -Path $rootPath -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "build|bin|Release|RelWithDebInfo|Debug" } |
        Sort-Object FullName |
        Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  }

  return $null
}

$llamaDir = Resolve-ProjectPath $LlamaCppDir
if ([string]::IsNullOrWhiteSpace($BuildDir)) {
  $BuildDir = Join-Path $llamaDir "build"
}
$buildDirFull = Resolve-ProjectPath $BuildDir
$modelFull = Resolve-ProjectPath $ModelPath
$parentRoot = Split-Path $Root -Parent
$grandParentRoot = Split-Path $parentRoot -Parent
$githubRoot = $null
$githubLlamaRoot = $null
if (Test-Path "F:\Github") {
  $githubRoot = "F:\Github"
  $githubLlamaRoot = Join-Path $githubRoot "llama.cpp"
}

$searchRoots = @(
  $buildDirFull,
  $llamaDir,
  (Join-Path $Root ".tools\llama.cpp"),
  (Join-Path $Root "tools\llama.cpp"),
  (Join-Path $Root "llama.cpp"),
  (Join-Path $parentRoot "llama.cpp"),
  (Join-Path $grandParentRoot "llama.cpp"),
  $githubLlamaRoot
) | Where-Object { $_ }

Write-Host ""
Write-Host "Qwen / llama.cpp Windows setup" -ForegroundColor Cyan
Write-Host "Project:      $Root"
Write-Host "llama.cpp:   $llamaDir"
Write-Host "Build dir:   $buildDirFull"
Write-Host "Model path:  $modelFull"
if (-not [string]::IsNullOrWhiteSpace($LlamaServerBin)) { Write-Host "Explicit bin: $LlamaServerBin" }
Write-Host ""

if ($PrereqsOnly) {
  Require-Command git "Git.Git" | Out-Null
  Require-Command cmake "Kitware.CMake" | Out-Null
  if (-not (Test-VSNativeBuildTools)) {
    Write-BuildToolsHint
  } else {
    Write-Host "C++ build tools detected." -ForegroundColor Green
  }
  Write-Host ""
  Write-Host "Prerequisite check complete." -ForegroundColor Green
  exit 0
}

$serverExe = Find-LlamaServerExe -SearchRoots $searchRoots -ExplicitBin $LlamaServerBin
if ($serverExe) {
  Write-Host "Found llama-server.exe:" -ForegroundColor Green
  Write-Host "  $serverExe"
}

if ($FindOnly) {
  if (-not $serverExe) {
    Write-Host "No llama-server.exe found in PATH or common project folders." -ForegroundColor Yellow
    Write-Host "Searched roots:"
    foreach ($rootCandidate in $searchRoots) { Write-Host "  $rootCandidate" }
    exit 2
  }
}

if ((-not $serverExe) -and (-not $SkipBuild)) {
  Require-Command git "Git.Git" | Out-Null
  $cmakeExe = Require-Command cmake "Kitware.CMake"
  if (-not (Test-VSNativeBuildTools)) { Write-BuildToolsHint }

  if (-not (Test-Path $llamaDir)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $llamaDir -Parent) | Out-Null
    git clone --depth 1 --recursive https://github.com/ggml-org/llama.cpp.git $llamaDir
  } elseif (Test-Path (Join-Path $llamaDir ".git")) {
    Write-Host "llama.cpp already exists; pulling latest changes..." -ForegroundColor DarkGray
    git -C $llamaDir pull --ff-only
    git -C $llamaDir submodule update --init --recursive
  }

  $configureArgs = @(
    "-S", $llamaDir,
    "-B", $buildDirFull,
    "-DLLAMA_BUILD_SERVER=ON",
    "-DCMAKE_BUILD_TYPE=Release"
  )

  if ($Cuda) { $configureArgs += "-DGGML_CUDA=ON" }
  if ($Vulkan) { $configureArgs += "-DGGML_VULKAN=ON" }

  Write-Host "Configuring llama.cpp..." -ForegroundColor Cyan
  & $cmakeExe @configureArgs
  if ($LASTEXITCODE -ne 0) {
    Write-BuildToolsHint
    throw "cmake configure failed. Check that CMake and a Windows C++ build toolchain are installed."
  }

  Write-Host "Building llama-server..." -ForegroundColor Cyan
  & $cmakeExe --build $buildDirFull --config Release --target llama-server --parallel
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Targeted build failed; trying full Release build..." -ForegroundColor Yellow
    & $cmakeExe --build $buildDirFull --config Release --parallel
    if ($LASTEXITCODE -ne 0) {
      Write-BuildToolsHint
      throw "cmake build failed. Check that the Windows C++ build toolchain is installed."
    }
  }

  $serverExe = Find-LlamaServerExe -SearchRoots $searchRoots -ExplicitBin $LlamaServerBin
}

if (-not $serverExe) {
  Write-Host "Searched roots:" -ForegroundColor Yellow
  foreach ($rootCandidate in $searchRoots) { Write-Host "  $rootCandidate" }
  throw "Could not find llama-server.exe. Run this with -LlamaServerBin <path>, build llama.cpp, or put llama-server.exe in PATH."
}

New-Item -ItemType Directory -Force -Path (Split-Path $modelFull -Parent) | Out-Null

$envFile = Join-Path $Root ".env.local"
Upsert-EnvValue $envFile "QWEN_LLAMA_SERVER_BIN" $serverExe
Upsert-EnvValue $envFile "QWEN_MODEL_PATH" $modelFull
Upsert-EnvValue $envFile "QWEN_LLAMA_HOST" "127.0.0.1"
Upsert-EnvValue $envFile "QWEN_LLAMA_PORT" "8081"
Upsert-EnvValue $envFile "QWEN_LLAMA_CONTEXT" "4096"
Upsert-EnvValue $envFile "QWEN_LLAMA_BATCH" "1024"

Write-Host ""
Write-Host "Configured .env.local" -ForegroundColor Green
Write-Host "QWEN_LLAMA_SERVER_BIN=$serverExe"
Write-Host "QWEN_MODEL_PATH=$modelFull"

if (-not (Test-Path $modelFull)) {
  Write-Host ""
  Write-Host "Model file not found yet." -ForegroundColor Yellow
  Write-Host "Place your Qwen3 reranker GGUF here:"
  Write-Host "  $modelFull"
  Write-Host "Any qwen3-reranker*.gguf file in ./models is also auto-detected by the app."
}

Write-Host ""
Write-Host "Next:" -ForegroundColor Cyan
Write-Host "  bun run dev"
Write-Host "  bun run qwen:status"
