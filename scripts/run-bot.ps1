# Keeps the marketing bot running on this Windows PC.
#
#   Started at logon by the "Argus marketing bot" scheduled task
#   (scripts/install-bot-task.ps1). Can also be run by hand.
#
# - One instance only: a named mutex. Two bots polling the same Telegram token
#   would fight (Telegram answers 409 to the second) and could double-deliver.
# - Restarts node if it exits, with backoff (5s doubling to 5 min, reset after
#   10 min of healthy running) so a config error can't spin the CPU.
# - Logs to bot/state/bot.log (gitignored), rotated at 5 MB. The bot never
#   prints secrets — tokens appear only as lengths.
#
# The bot survives the PC sleeping or rebooting: on return it posts anything
# whose slot passed (late) and runs the day's batch if it hasn't run yet.

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot          # ...\marketing
$bot  = Join-Path $root "bot\bot.mjs"
$log  = Join-Path $root "bot\state\bot.log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

# Every launch leaves a line here FIRST, before the mutex or anything else can
# fail. The bot has twice been killed from outside (runner and node together,
# exit 0xC000013A, cause not found — 2026-09-26 22:3x and 2026-09-27 18:29),
# and the watchdog restarts after the second left no trace at all. This file
# says whether the watchdog fired and how far each launch got.
$launches = Join-Path $root "bot\state\launches.log"
try { Add-Content -Path $launches -Encoding utf8 -Value "[$(Get-Date -Format s)] launch pid=$PID parent=$((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)" } catch {}

$mutex = New-Object System.Threading.Mutex($false, "Local\ArgusMarketingBot")
if (-not $mutex.WaitOne(0)) {
    try { Add-Content -Path $launches -Encoding utf8 -Value "[$(Get-Date -Format s)]   pid=${PID}: bot already running - exiting (normal for the watchdog)" } catch {}
    exit 0
}
try { Add-Content -Path $launches -Encoding utf8 -Value "[$(Get-Date -Format s)]   pid=${PID}: holds the mutex, starting the bot" } catch {}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }

Set-Location $root
$backoff = 5
while ($true) {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 5MB)) { Move-Item $log "$log.1" -Force }
    $started = Get-Date
    Add-Content -Path $log -Encoding utf8 -Value "[$(Get-Date -Format s)] starting bot ($node)"

    # cmd does the redirection so node's stdout and stderr both land in the
    # log as plain UTF-8 (PowerShell 5.1 would wrap stderr lines as errors).
    & cmd.exe /d /c "`"$node`" `"$bot`" >> `"$log`" 2>&1"
    $code = $LASTEXITCODE

    if (((Get-Date) - $started).TotalMinutes -gt 10) { $backoff = 5 }
    Add-Content -Path $log -Encoding utf8 -Value "[$(Get-Date -Format s)] bot exited with code $code - restarting in ${backoff}s"
    Start-Sleep -Seconds $backoff
    $backoff = [Math]::Min($backoff * 2, 300)
}
