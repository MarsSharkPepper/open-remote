# OpenRemote Claude Code Bridge — Windows setup
# Run: powershell -ExecutionPolicy Bypass -File setup.ps1
#
# This script:
#   1. Checks prerequisites (node, npm, VCRUNTIME for node-pty)
#   2. Installs npm dependencies
#   3. Builds TypeScript
#   4. Creates PATH wrappers (clauderemote.cmd + clauderemote.ps1)
#   5. Adds wrapper dir to user PATH
#   6. Configures Claude Code hooks in ~/.claude/settings.json

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binDir = "$env:USERPROFILE\.openremote\bin"
$wrapperCmd = "$binDir\clauderemote.cmd"
$wrapperPs1 = "$binDir\clauderemote.ps1"

Write-Host "=== OpenRemote Claude Code Bridge Setup ===" -ForegroundColor Cyan
Write-Host ""

# ── Prerequisites ─────────────────────────────────────────────

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "ERROR: node is required but not found" -ForegroundColor Red
    Write-Host "  Install: https://nodejs.org" -ForegroundColor Gray
    exit 1
}
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "ERROR: npm is required but not found" -ForegroundColor Red
    exit 1
}

Write-Host "Node: $(node --version)  npm: $(npm --version)" -ForegroundColor Gray

# ── Step 1: Install dependencies ──────────────────────────────

Write-Host ""
Write-Host "[1/5] Installing dependencies..." -ForegroundColor Yellow
Push-Location $scriptDir
npm install
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }

# ── Step 2: Build ─────────────────────────────────────────────

Write-Host "[2/5] Building TypeScript..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; exit 1 }
Pop-Location

$bridgePath = (Resolve-Path "$scriptDir\dist\index.js").Path
$hookPath = (Resolve-Path "$scriptDir\hooks\forward.cjs").Path

if (-not (Test-Path $bridgePath)) {
    Write-Host "ERROR: Build output not found: $bridgePath" -ForegroundColor Red
    exit 1
}

# ── Step 3: Create wrappers ───────────────────────────────────

Write-Host "[3/5] Installing PATH wrappers..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# .cmd wrapper (for CMD)
# Uses `where` to find claude, skips wrapper's own directory
$cmdContent = @"
@echo off
setlocal
for /f "tokens=*" %%i in ('where claude 2^>nul') do (
    for %%w in ("$binDir\clauderemote.cmd") do (
        if /i not "%%i"=="%%~fw" (
            node "$bridgePath" "%%i" %*
            exit /b %errorlevel%
        )
    )
)
echo [ClaudeRemote] ERROR: cannot find real 'claude' binary in PATH
echo   Install: npm install -g @anthropic-ai/claude-code
exit /b 1
"@
Set-Content -Path $wrapperCmd -Value $cmdContent -Encoding ASCII

# .ps1 wrapper (for PowerShell)
$ps1Content = @"
`$self = `$MyInvocation.MyCommand.Path
`$candidates = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
`$realClaude = `$candidates | Where-Object { `$_.ToLower() -ne `$self.ToLower() } | Select-Object -First 1
if (-not `$realClaude) {
    Write-Error "[ClaudeRemote] Cannot find real 'claude' binary in PATH"
    exit 1
}
& node "$bridgePath" `$realClaude @args
"@
Set-Content -Path $wrapperPs1 -Value $ps1Content -Encoding UTF8

# ── Step 4: Add to PATH ───────────────────────────────────────

Write-Host "[4/5] Configuring PATH..." -ForegroundColor Yellow
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$binDir;$userPath", "User")
    Write-Host "  Added $binDir to user PATH" -ForegroundColor Green
} else {
    Write-Host "  $binDir already in PATH" -ForegroundColor Green
}
$env:Path = "$binDir;$env:Path"

# ── Step 5: Configure Claude Code hooks ───────────────────────

Write-Host "[5/5] Configuring Claude Code hooks..." -ForegroundColor Yellow
$claudeSettingsDir = "$env:USERPROFILE\.claude"
$claudeSettingsFile = "$claudeSettingsDir\settings.json"

New-Item -ItemType Directory -Force -Path $claudeSettingsDir | Out-Null

# Read existing settings or start fresh
$settings = @{}
if (Test-Path $claudeSettingsFile) {
    try {
        $raw = Get-Content $claudeSettingsFile -Raw
        $settings = $raw | ConvertFrom-Json -AsHashtable
    } catch {
        Write-Host "  Warning: could not parse existing settings.json, backing up" -ForegroundColor Yellow
        Copy-Item $claudeSettingsFile "$claudeSettingsFile.bak"
    }
}

# Add hooks — append to existing ones instead of overwriting
if (-not $settings.ContainsKey("hooks")) {
    $settings["hooks"] = @{}
}

$hookCommand = "node `"$hookPath`""

$events = @("SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PostToolUse", "PreToolUse")
foreach ($event in $events) {
    $hookEntry = @{
        matcher = ""
        hooks = @(@{
            type = "command"
            command = $hookCommand
        })
    }

    if (-not $settings["hooks"].ContainsKey($event)) {
        $settings["hooks"][$event] = @($hookEntry)
    } else {
        $existing = @($settings["hooks"][$event])
        $found = $false
        foreach ($entry in $existing) {
            $hooks = $entry.hooks
            if ($hooks -and ($hooks | Where-Object { $_.command -eq $hookCommand })) {
                $found = $true
                break
            }
        }
        if (-not $found) {
            $settings["hooks"][$event] = $existing + @($hookEntry)
        }
    }
}

$settings | ConvertTo-Json -Depth 10 | Set-Content $claudeSettingsFile -Encoding UTF8
Write-Host "  Hooks configured in $claudeSettingsFile" -ForegroundColor Green

# ── Done ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "  Wrapper:  $wrapperCmd" -ForegroundColor Gray
Write-Host "            $wrapperPs1" -ForegroundColor Gray
Write-Host "  Bridge:   $bridgePath" -ForegroundColor Gray
Write-Host "  Hooks:    $claudeSettingsFile" -ForegroundColor Gray
Write-Host ""
Write-Host "Usage:" -ForegroundColor Cyan
Write-Host "  1. Open a NEW terminal (to reload PATH)"
Write-Host "  2. Run 'clauderemote' — starts Claude Code with remote bridge"
Write-Host "  3. Run 'claude' — normal unbridged session (unchanged)"
Write-Host ""
Write-Host "Make sure you have configured your token:" -ForegroundColor Yellow
Write-Host "  `$env:OPENREMOTE_TOKEN = 'ort_xxxxx'"
Write-Host "  OR update $env:USERPROFILE\.openremote\credentials.json"
Write-Host ""
Write-Host "To uninstall: del $wrapperCmd $wrapperPs1"
Write-Host "  Remove hooks from $claudeSettingsFile"
