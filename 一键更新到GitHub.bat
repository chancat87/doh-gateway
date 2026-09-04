@echo off
cd /d "%~dp0"
git add .
git commit -m "update %date% %time%"
git push
echo.
echo ============================
echo GitHub 已更新完成！
echo ============================
pause