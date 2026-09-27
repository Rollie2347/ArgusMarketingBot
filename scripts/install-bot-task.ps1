# Installs (or reinstalls) the "Argus marketing bot" scheduled task: runs
# scripts/run-bot.ps1, hidden, every time you log in to Windows, and starts it
# now. No admin rights needed — it runs as you.
#
#   powershell -ExecutionPolicy Bypass -File marketing\scripts\install-bot-task.ps1
#   powershell -ExecutionPolicy Bypass -File marketing\scripts\install-bot-task.ps1 -Remove
#
# Status / control:
#   Get-ScheduledTask "Argus marketing bot" | Get-ScheduledTaskInfo
#   Get-Content marketing\bot\state\bot.log -Tail 40 -Wait
#   marketing\scripts\stop-bot.ps1        # stop until next logon (or Start-ScheduledTask)

param([switch]$Remove)

$name = "Argus marketing bot"
$runner = Join-Path $PSScriptRoot "run-bot.ps1"

if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    & (Join-Path $PSScriptRoot "stop-bot.ps1")
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Output "removed existing task"
}
if ($Remove) { exit 0 }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Watchdog: fire every 10 minutes as well. run-bot.ps1 holds a mutex, so if
# the bot is up the extra start exits immediately; if something killed it
# (seen once on 2026-09-26: runner and bot both gone, exit 0xC000013A, cause
# not identified) it is back within 10 minutes instead of silently missing
# every posting slot until the next logon.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$trigger = @($atLogon, $watchdog)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Argus marketing: daily slideshow batch, Telegram approvals, scheduled posting. marketing\scripts\run-bot.ps1" | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "installed and started '$name' (runs at every logon)"
