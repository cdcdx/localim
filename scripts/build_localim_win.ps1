# LocalIM @ LAN — Windows 构建脚本。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File .\build_localim_win.ps1
#   $env:BUILD_WEBUI=1; .\build_localim_win.ps1   # 一并构建前端 WebUI
#
# 若 ui\out\webui 已有构建产物, 会自动拷贝到 exe 旁 out\localim\webui,
# 供 daemon 以 --webui-dist= 直接托管（无需 dev node 中间层）。
#
# 依赖: 已配好 developer prompt 的 Visual Studio、chromium 源码 + depot_tools(gn/ninja)
# 产物: {chromium}\src\out\localim\localim_daemon.exe
$ErrorActionPreference = "Stop"

$ScriptDir = $PSScriptRoot                       # <chromium>\localim\scripts
$Workspace = Split-Path (Split-Path $ScriptDir -Parent) -Parent   # <chromium>
$ChromiumSrc = Join-Path $Workspace "src"
$LocalIm = Join-Path $Workspace "localim"
$OutDir = Join-Path $ChromiumSrc "out\localim"   # GN(旧版)要求构建目录位于源码根内

# ---- 1. depot_tools / gn / ninja 定位 ----
function Find-DepotTools {
    if ($env:DEPOT_TOOLS -and (Test-Path (Join-Path $env:DEPOT_TOOLS "gn.bat"))) {
        return $env:DEPOT_TOOLS
    }
    $candidates = @(
        (Join-Path (Split-Path $Workspace -Parent) "depot_tools"),
        (Join-Path $env:USERPROFILE "depot_tools")
    )
    foreach ($c in $candidates) {
        if (Test-Path (Join-Path $c "gn.bat")) { return $c }
    }
    # 退而检查 PATH
    if (Get-Command gn -ErrorAction SilentlyContinue) { return $env:PATH }
    throw "depot_tools not found (must contain gn.bat). Set DEPOT_TOOLS and retry."
}
$DepotTools = Find-DepotTools
if ($DepotTools -ne $env:PATH) { $env:PATH = $DepotTools + ";" + $env:PATH }
$env:CHROME_HEADLESS = "1"
Write-Host "[localim] depot_tools: $DepotTools"
if (-not (Get-Command gn -ErrorAction SilentlyContinue)) { throw "gn is not in PATH" }

# ---- 2. 挂载 src\localim junction -> ..\localim（首跑建立） ----
$mount = Join-Path $ChromiumSrc "localim"
if (-not (Test-Path $mount)) {
    Write-Host "[localim] mount $mount -> $LocalIm"
    New-Item -ItemType Junction -Path $mount -Target $LocalIm | Out-Null
}

# ---- 3. args.gn（UTF-8 无 BOM；带 BOM 会令旧版 GN 拒绝，需重写） ----
$argsFile = Join-Path $OutDir "args.gn"
New-Item -ItemType Directory -Force -Path (Split-Path $argsFile -Parent) | Out-Null
$bomDetected = $false
if (Test-Path $argsFile) {
    $bytes = [System.IO.File]::ReadAllBytes($argsFile)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $bomDetected = $true
    }
}
$content = @"
is_debug = false
is_component_build = true
symbol_level = 0
use_siso = false
# 显式挂在构建图里，否则 standalone 图不含 localim 目标，autoninja 报 unknown target。
root_extra_deps = [
  "//localim/native:localim_daemon",
  "//localim/native:localim_relay",
]
"@
[System.IO.File]::WriteAllText($argsFile, $content, (New-Object System.Text.UTF8Encoding($false)))
if ($bomDetected) { Write-Host "[localim] args.gn has BOM, rewritten as UTF-8 without BOM" }

# ---- 4. gn gen + 构建 ----
Set-Location $ChromiumSrc
Write-Host "[localim] gn gen(win)..."
gn gen $OutDir
if ($LASTEXITCODE -ne 0) { throw "gn gen failed" }

Write-Host "[localim] building localim_daemon + localim_relay (win)..."
& "$DepotTools\autoninja.bat" -C $OutDir localim/native:localim_daemon localim/native:localim_relay
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# ---- 5. 产物 ----
$exe = Join-Path $OutDir "localim_daemon.exe"
if (-not (Test-Path $exe)) { throw "build produced no output at $exe" }
$relay = Join-Path $OutDir "localim_relay.exe"
if (-not (Test-Path $relay)) { throw "build produced no output at $relay" }
Write-Host "[localim] OK: $exe"
Write-Host "[localim] OK: $relay  (cross-subnet relay service, usage: $relay --relay-port=7618)"
Write-Host "[localim] run: $exe --user-data-dir=%USERPROFILE%\.localim"

# ---- 5.5 可选: 拷贝 WebUI 产物到 exe 旁(已有构建产物时), 供 --webui-dist 使用 ----
$webuiBuildDir = Join-Path $LocalIm "ui\out\webui"
if (Test-Path (Join-Path $webuiBuildDir "index.html")) {
    $webuiStage = Join-Path $OutDir "webui"
    Write-Host "[localim] copy WebUI artifacts -> $webuiStage"
    if (Test-Path $webuiStage) { Remove-Item -Recurse -Force $webuiStage }
    New-Item -ItemType Directory -Force -Path $webuiStage | Out-Null
    Copy-Item -Path (Join-Path $webuiBuildDir "*") -Destination $webuiStage -Recurse -Force
    Write-Host "[localim] hosted run: $exe --webui-dist=$webuiStage"
}

# ---- 6. 可选: 一并构建 WebUI ----
if ($env:BUILD_WEBUI -eq "1") {
    Push-Location (Join-Path $LocalIm "ui")
    try {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "BUILD_WEBUI=1 but npm was not found" }
        Write-Host "[localim] building WebUI..."
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
        Write-Host ("[localim] OK: " + (Join-Path $LocalIm "ui\out\webui"))
    } finally { Pop-Location }
}