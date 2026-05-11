# OpenRemote Claude Code Bridge — Windows uninstall
# Run: powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# Reverts everything setup.ps1 did:
#   1. Remove clauderemote.cmd + clauderemote.ps1 wrappers
#   2. Remove wrapper directory from user PATH
#   3. Remove Claude Code hooks from ~/.claude/settings.json

$ErrorActionPreference = "Stop"

$binDir = "$env:USERPROFILE\.openremote\bin"
$wrapperCmd = "$binDir\clauderemote.cmd"
$wrapperPs1 = "$binDir\clauderemote.ps1"

Write-Host "=== OpenRemote Claude Code Bridge Uninstall ===" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Remove wrappers ───────────────────────────────────

Write-Host "[1/3] Removing wrappers..." -ForegroundColor Yellow

if (Test-Path $wrapperCmd) {
    Remove-Item $wrapperCmd -Force
    Write-Host "  Removed: $wrapperCmd" -ForegroundColor Green
} else {
    Write-Host "  Not found (already removed): $wrapperCmd" -ForegroundColor Gray
}

if (Test-Path $wrapperPs1) {
    Remove-Item $wrapperPs1 -Force
    Write-Host "  Removed: $wrapperPs1" -ForegroundColor Green
} else {
    Write-Host "  Not found (already removed): $wrapperPs1" -ForegroundColor Gray
}

# Remove bin directory if empty
if ((Test-Path $binDir) -and ((Get-ChildItem $binDir -ErrorAction SilentlyContinue).Count -eq 0)) {
    Remove-Item $binDir -Force
    Write-Host "  Removed empty directory: $binDir" -ForegroundColor Green
}

# ── Step 2: Remove from user PATH ─────────────────────────────

Write-Host "[2/3] Cleaning user PATH..." -ForegroundColor Yellow

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -like "*$binDir*") {
    # Split, remove our entry, rejoin — preserves all other paths
    $pathParts = $userPath -split ";" | Where-Object {
        $_ -and $_.TrimEnd("\") -ne $binDir.TrimEnd("\")
    }
    $newPath = $pathParts -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "  Removed $binDir from user PATH" -ForegroundColor Green
} else {
    Write-Host "  $binDir not in PATH (already clean)" -ForegroundColor Gray
}

# ── Step 3: Remove Claude Code hooks ──────────────────────────

Write-Host "[3/3] Cleaning Claude Code hooks..." -ForegroundColor Yellow
$claudeSettingsFile = "$env:USERPROFILE\.claude\settings.json"

if (Test-Path $claudeSettingsFile) {
    try {
        $raw = Get-Content $claudeSettingsFile -Raw
        $settings = $raw | ConvertFrom-Json -AsHashtable
    } catch {
        Write-Host "  Could not parse settings.json, skipping" -ForegroundColor Yellow
        $settings = $null
    }

    if ($settings -and $settings.ContainsKey("hooks")) {
        $OUR_HOOKS = @("UserPromptSubmit", "Stop", "PostToolUse")
        $removedAny = $false

        foreach ($eventName in $OUR_HOOKS) {
            if (-not $settings["hooks"].ContainsKey($eventName)) { continue }

            # Filter out entries that contain our forward.cjs
            $filtered = @()
            foreach ($entry in $settings["hooks"][$eventName]) {
                $hasOurHook = $false
                if ($entry -is [hashtable] -and $entry.ContainsKey("hooks")) {
                    foreach ($h in $entry["hooks"]) {
                        if ($h -is [hashtable] -and $h.ContainsKey("command") -and
                            $h["command"] -match "forward\.cjs") {
                            $hasOurHook = $true
                            break
                        }
                    }
                }
                if (-not $hasOurHook) {
                    $filtered += $entry
                }
            }

            if ($filtered.Count -eq 0) {
                $settings["hooks"].Remove($eventName)
            } else {
                $settings["hooks"][$eventName] = $filtered
            }
            $removedAny = $true
        }

        # Remove empty hooks object
        if ($settings["hooks"].Count -eq 0) {
            $settings.Remove("hooks")
        }

        if ($removedAny) {
            $settings | ConvertTo-Json -Depth 10 | Set-Content $claudeSettingsFile -Encoding UTF8
            Write-Host "  Cleaned hooks in $claudeSettingsFile" -ForegroundColor Green
        } else {
            Write-Host "  No bridge hooks found in settings.json" -ForegroundColor Gray
        }
    } else {
        Write-Host "  No hooks section in settings.json" -ForegroundColor Gray
    }
} else {
    Write-Host "  No settings.json found, skipping" -ForegroundColor Gray
}

# ── Done ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Uninstall complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "The following were NOT removed (may be used by other things):" -ForegroundColor Yellow
Write-Host "  $env:USERPROFILE\.openremote\  (credentials + logs)" -ForegroundColor Gray
Write-Host "  $env:USERPROFILE\.claude\      (Claude Code config)" -ForegroundColor Gray
Write-Host ""
Write-Host "To remove everything:" -ForegroundColor Yellow
Write-Host "  Remove-Item -Recurse -Force $env:USERPROFILE\.openremote"
Write-Host ""
Write-Host "Open a new terminal to apply PATH changes."
