# 移植自官方 apps/desktop/scripts/prepare-windows-installer.ps1 的 DLL 编译段：
# vswhere 定位 VS → vcvars32.bat（x86）→ cl /LD /MT /O1 /W4 /WX。
# 产物落在 desktop-electrobun/installer/window-frame.dll，供 build:installer 打进安装器。
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../installer')
)

$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $output | Out-Null
$source = Join-Path $output 'window-frame.cpp'
if (-not (Test-Path -LiteralPath $source)) { throw "window-frame.cpp not found: $source" }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'window-frame.dll 编译需要 Visual Studio C++ Build Tools（vswhere 不可用）。' }
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $visualStudio) { throw '未找到带 C++ 工具链的 Visual Studio。' }
$vcvars = Join-Path $visualStudio 'VC/Auxiliary/Build/vcvars32.bat'

$library = Join-Path $output 'window-frame.dll'
$compileScript = Join-Path $output 'compile-frame.cmd'
$compileLines = @(
    '@echo off',
    ('call "{0}" >nul' -f $vcvars),
    'if errorlevel 1 exit /b %errorlevel%',
    ('cl /nologo /LD /MT /O1 /W4 /WX /EHsc "{0}" /Fo"{1}" /link /OUT:"{2}" /IMPLIB:"{3}" user32.lib gdi32.lib comctl32.lib dwmapi.lib gdiplus.lib ole32.lib uuid.lib' -f $source, (Join-Path $output 'window-frame.obj'), $library, (Join-Path $output 'window-frame.lib'))
)
[IO.File]::WriteAllLines($compileScript, $compileLines, [Text.Encoding]::Default)
& $env:ComSpec /d /c $compileScript
if ($LASTEXITCODE -ne 0) { throw 'window-frame.dll 编译失败。' }
Write-Host "window-frame.dll -> $library"
