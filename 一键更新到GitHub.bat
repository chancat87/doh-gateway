@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo        Git 通用一键同步工具
echo ========================================
echo.

:: 1. 检查是否为 Git 仓库
git rev-parse --is-inside-work-tree >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 当前目录不是 Git 仓库，无法执行同步！
    echo 请将此脚本放置在包含 .git 的项目根目录下运行。
    echo.
    pause
    exit /b 1
)

:: 2. 获取当前分支名称
for /f "tokens=*" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%i
if "%BRANCH%"=="" set BRANCH=main

echo [1/4] 当前工作分支: %BRANCH%

:: 3. 检查本地是否有新修改，优先提交到本地版本库（防止未暂存文件阻塞拉取）
echo [2/4] 检查本地改动并暂存提交...
git status --porcelain | findstr . >nul 2>&1
if %errorlevel% equ 0 (
    git add -A
    git commit -m "update: %date:~0,10% %time:~0,8%"
    echo [提示] 本地改动已自动保存为新提交。
) else (
    echo [提示] 本地无新文件改动。
)

:: 4. 检查并拉取远端更新（核心：此时本地已提交，rebase 自动合并不打架）
echo [3/4] 正在拉取远端最新提交并自动变基...
git pull --rebase origin %BRANCH%
if %errorlevel% neq 0 (
    echo.
    echo ========================================
    echo [警告] 拉取远端更新失败或存在代码冲突！
    echo 请检查上方报错信息，若有冲突请解决后再运行。
    echo ========================================
    echo.
    pause
    exit /b 1
)

:: 5. 推送到 GitHub 并严格校验结果
echo [4/4] 正在推送到 GitHub...
git push origin %BRANCH%
if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo   [成功] GitHub 已同步并更新完成！
    echo   分支: %BRANCH%
    echo ========================================
) else (
    echo.
    echo ========================================
    echo   [失败] 推送失败！请查看上方错误日志。
    echo   常见原因：网络连不上 GitHub / 权限认证失效
    echo ========================================
)

echo.
pause
