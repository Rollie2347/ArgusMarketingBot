# Stops the marketing bot until the next logon (or Start-ScheduledTask
# "Argus marketing bot"). Stops the runner first so it can't restart node.

Stop-ScheduledTask -TaskName "Argus marketing bot" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*run-bot.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*marketing*bot*bot.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output "Argus marketing bot stopped"
