@echo off
setlocal

REM whisper-rs needs MSVC's cl.exe/nmake on PATH and a libclang for bindgen,
REM neither of which a plain "npm run tauri dev" picks up on Windows. See
REM docs/PLAN_TECNICO.md, Phase 7, for why this wrapper exists instead of
REM fighting CMake/bindgen toolchain detection directly.

set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"

if "%VSINSTALL%"=="" (
  echo Could not find a Visual Studio install with the C++ build tools component.
  echo Install "Desktop development with C++" from the Visual Studio Installer and retry.
  exit /b 1
)

call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul

if not defined LIBCLANG_PATH set LIBCLANG_PATH=C:\Program Files\LLVM\bin
set CMAKE_GENERATOR=NMake Makefiles

cd /d "%~dp0"
call npm run tauri dev
