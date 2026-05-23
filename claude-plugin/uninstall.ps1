# OpenRemote Claude Code Bridge — Windows uninstall
# Run: powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# This script ONLY removes items added by setup.ps1:
#   1. PATH wrappers in ~/.openremote/bin/
#   2. ~/.openremote/bin from user PATH
#   3. OpenRemote hooks from ~/.claude/settings.json
#
# It will NOT touch any other user configuration.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = "$env:USERPROFILE\.openremote\bin"
$hookPath = (Resolve-Path "$scriptDir\hooks\forward.cjs" -ErrorAction SilentlyContinue)
$wrapperCmd = "$binDir\clauderemote.cmd"
$wrapperPs1 = "$binDir\clauderemote.ps1"

Write-Host "=== OpenRemote Claude Code Bridge Uninstall ===" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Remove PATH wrappers ──────────────────────────────

Write-Host "[1/3] Removing PATH wrappers..." -ForegroundColor Yellow

$removed = $false
if (Test-Path $wrapperCmd) {
    Remove-Item $wrapperCmd -Force
    Write-Host "  Removed: $wrapperCmd" -ForegroundColor Green
    $removed = $true
}
if (Test-Path $wrapperPs1) {
    Remove-Item $wrapperPs1 -Force
    Write-Host "  Removed: $wrapperPs1" -ForegroundColor Green
    $removed = $true
}
if (-not $removed) {
    Write-Host "  Wrappers not found (already removed)" -ForegroundColor Gray
}

# Remove the bin directory if empty
if ((Test-Path $binDir) -and ((Get-ChildItem $binDir -Force).Count -eq 0)) {
    Remove-Item $binDir -Force
    Write-Host "  Removed empty directory: $binDir" -ForegroundColor Green
}

# ── Step 2: Remove from user PATH ─────────────────────────────

Write-Host "[2/3] Cleaning user PATH..." -ForegroundColor Yellow

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -like "*$binDir*") {
    $pathParts = $userPath -split ";" | Where-Object { $_ -ne "" -and $_ -ne $binDir }
    $newPath = $pathParts -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "  Removed $binDir from user PATH" -ForegroundColor Green
} else {
    Write-Host "  $binDir not in user PATH (already removed)" -ForegroundColor Gray
}

# ── Step 3: Remove hooks from Claude Code settings ────────────

Write-Host "[3/3] Removing OpenRemote hooks from Claude Code settings..." -ForegroundColor Yellow

$claudeSettingsDir = "$env:USERPROFILE\.claude"
$claudeSettingsFile = "$claudeSettingsDir\settings.json"

if (-not (Test-Path $claudeSettingsFile)) {
    Write-Host "  settings.json not found — nothing to remove" -ForegroundColor Gray
} else {
    # Backup before modifying
    Copy-Item $claudeSettingsFile "$claudeSettingsFile.bak" -Force
    Write-Host "  Backup: $claudeSettingsFile.bak" -ForegroundColor Gray

    # Use temp script file to avoid PowerShell quoting issues (same as setup.ps1)
    if (-not $hookPath) {
        # hookPath not resolved — uninstall may be run from a different location.
        # Attempt to find it from PATH or skip hook removal.
        Write-Host "  hook script not found — skipping hook removal" -ForegroundColor Yellow
    } else {
        $hookCmd = "node `"$hookPath`""
        $tempScript = [System.IO.Path]::GetTempFileName()
        $removeScript = @"
const fs = require("fs");
const settingsFile = process.argv[1];
const hookCmd = process.argv[2];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { process.exit(0); }
if (!settings.hooks) { process.exit(0); }

let removed = 0;
for (const event of Object.keys(settings.hooks)) {
  const before = settings.hooks[event].length;
  settings.hooks[event] = settings.hooks[event].filter(
    entry => !(entry.hooks && entry.hooks.some(h => h.command === hookCmd))
  );
  removed += before - settings.hooks[event].length;
  if (settings.hooks[event].length === 0) {
    delete settings.hooks[event];
  }
}

if (removed > 0) {
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  console.log("REMOVED:" + removed);
} else {
  console.log("NONE");
}
"@
        Set-Content -Path $tempScript -Value $removeScript -Encoding UTF8
        $result = node $tempScript "$claudeSettingsFile" "$hookCmd"
        Remove-Item $tempScript -Force

        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ERROR: Failed to remove hooks" -ForegroundColor Red
            if (Test-Path "$claudeSettingsFile.bak") {
                Copy-Item "$claudeSettingsFile.bak" $claudeSettingsFile -Force
                Write-Host "  Restored from backup" -ForegroundColor Yellow
            }
        } elseif ($result -match "^REMOVED:(\d+)$") {
            $count = $Matches[1]
            Write-Host "  Removed $count hook(s) from $claudeSettingsFile" -ForegroundColor Green
        } else {
            Write-Host "  No OpenRemote hooks found in settings" -ForegroundColor Gray
        }
    }
}

# ── Done ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Uninstall complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "  The following were NOT removed (to preserve your project):" -ForegroundColor Gray
Write-Host "    - node_modules/"
Write-Host "    - dist/"
Write-Host ""
Write-Host "  To remove them manually:" -ForegroundColor Gray
Write-Host "    Remove-Item -Recurse -Force $scriptDir\node_modules, $scriptDir\dist"
Write-Host ""
