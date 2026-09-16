@echo off
setlocal

REM See dev.bat — same toolchain setup, needed for a release build too.

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
call npm run tauri build
