# Windows Installer for Ontofelia
# Usage: powershell -ExecutionPolicy Bypass -File .\install.ps1

[CmdletBinding()]
param(
    [switch]$NonInteractive
)

$ErrorActionPreference = "Continue"

# ═══════════════════════════════════════════════════════════════
# Ontofelia Installer — Premium Terminal UI
# ═══════════════════════════════════════════════════════════════

$ESC = [char]27
$BOLD = "$ESC[1m"
$DIM = "$ESC[2m"
$ITALIC = "$ESC[3m"
$UNDERLINE = "$ESC[4m"
$BLINK = "$ESC[5m"

# Foreground colors
$FG_BLACK = "$ESC[30m"
$FG_RED = "$ESC[31m"
$FG_GREEN = "$ESC[32m"
$FG_YELLOW = "$ESC[33m"
$FG_BLUE = "$ESC[34m"
$FG_PURPLE = "$ESC[35m"
$FG_CYAN = "$ESC[36m"
$FG_WHITE = "$ESC[37m"
$FG_GRAY = "$ESC[90m"
$FG_BPURPLE = "$ESC[95m"

# Background colors
$BG_PURPLE = "$ESC[45m"
$BG_BLACK = "$ESC[40m"

$NC = "$ESC[0m"

# Layout Constants
$W = 68

# Helper Functions
function repeat_char($char, $count) {
    if ($count -le 0) { return "" }
    return $char * $count
}

function strip_ansi($str) {
    # Remove ANSI escape sequences
    return $str -replace '\x1b\[[0-9;]*m', '' -replace '\e\[[0-9;]*m', '' -replace '\x1b', ''
}

function frame_line($content) {
    $visible = strip_ansi $content
    $vlen = $visible.Length
    $pad = $W - $vlen
    if ($pad -lt 0) { $pad = 0 }
    $spaces = repeat_char " " $pad
    Write-Host "  ${FG_PURPLE}│${NC} ${content}${spaces} ${FG_PURPLE}│${NC}"
}

function frame_top($label, $extra_width = 0) {
    $visible = strip_ansi $label
    $llen = $visible.Length
    $rlen = $W - $llen - $extra_width
    $right_border = repeat_char "─" $rlen
    Write-Host "  ${FG_PURPLE}┌─${NC}${label}${FG_PURPLE}─${right_border}┐${NC}"
}

function frame_bottom() {
    $border = repeat_char "─" $W
    Write-Host "  ${FG_PURPLE}└─${border}─┘${NC}"
}

function frame_divider() {
    $border = repeat_char "─" $W
    Write-Host "  ${FG_PURPLE}├─${border}─┤${NC}"
}

function frame_empty() {
    frame_line ""
}

function make_bar($current, $total, $width = 24) {
    $filled = [math]::Floor($current * $width / $total)
    $empty = $width - $filled
    $bar = (repeat_char "█" $filled) + (repeat_char "░" $empty)
    $pct = [math]::Floor($current * 100 / $total)
    return "${FG_PURPLE}${bar}${NC} ${pct}%"
}

function ok($msg) { Write-Host "    ${FG_GREEN}✔${NC}  $msg" }
function warn($msg) { Write-Host "    ${FG_YELLOW}⚠${NC}  $msg" }
function fail($msg) { Write-Host "    ${FG_RED}✘${NC}  $msg" }
function info($msg) { Write-Host "      ${DIM}$msg${NC}" }

$TOTAL_STEPS = 8
$CURRENT_STEP = 0
function step($title) {
    $global:CURRENT_STEP++
    Write-Host ""
    $bar = make_bar $global:CURRENT_STEP $TOTAL_STEPS 20
    $line_text = "─── $global:CURRENT_STEP/$TOTAL_STEPS $title "
    $remaining = $W - $line_text.Length + 2
    $filler = repeat_char "─" $remaining
    Write-Host "  ${FG_PURPLE}───${NC} ${FG_WHITE}${BOLD}${global:CURRENT_STEP}${NC}${FG_GRAY}/${TOTAL_STEPS}${NC} ${FG_CYAN}${BOLD}$title${NC} ${FG_PURPLE}${filler}${NC} $bar"
    Write-Host ""
}

# Clear Terminal
Clear-Host

# Get SCRIPT_DIR
$SCRIPT_DIR = $PSScriptRoot
if (!$SCRIPT_DIR) {
    $SCRIPT_DIR = Get-Location
}

# Determine Version from CLI package or fallback
$VERSION = "0.0.1"
$cliIndexPath = Join-Path $SCRIPT_DIR "apps\cli\src\index.ts"
if (Test-Path $cliIndexPath) {
    try {
        $src = Get-Content -Path $cliIndexPath -Raw
        if ($src -match '\.version\(\s*[^0-9]*([0-9][0-9A-Za-z.\-]*)') {
            $VERSION = $Matches[1]
        }
    } catch {}
}

# Header Panel
Write-Host ""
frame_top " ${FG_BPURPLE}${BOLD}🦉 Ontofelia${NC} ${FG_GRAY}v${VERSION}${NC} " 1
frame_empty
frame_line "        ${FG_PURPLE}▄███████▄${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}███${NC}${FG_PURPLE}█${NC}${FG_YELLOW}███${NC}${FG_PURPLE}███${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}█${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}███${NC}      ${FG_WHITE}${BOLD}Welcome to Ontofelia${NC}"
frame_line "      ${FG_PURPLE}██████${NC}${FG_WHITE}${BOLD}V${NC}${FG_PURPLE}██████${NC}"
frame_line "      ${FG_PURPLE}█████████████${NC}      ${DIM}The AI agent with semantic memory${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "        ${FG_PURPLE}▀███████▀${NC}"
frame_line "         ${FG_YELLOW}▀▄   ▄▀${NC}"
frame_empty
frame_divider
frame_empty
frame_line " ${FG_PURPLE}◆${NC} ${FG_WHITE}Semantic Knowledge Graph${NC}    ${FG_PURPLE}◆${NC} ${FG_WHITE}Web UI & Telegram${NC}      "
frame_line " ${FG_PURPLE}◆${NC} ${FG_WHITE}Multi-LLM with Fallback${NC}     ${FG_PURPLE}◆${NC} ${FG_WHITE}Tool Execution${NC}         "
frame_line " ${FG_PURPLE}◆${NC} ${FG_WHITE}OWL-DL Reasoning${NC}            ${FG_PURPLE}◆${NC} ${FG_WHITE}Persistent Memory${NC}      "
frame_empty
frame_bottom
Write-Host ""

# ══════════════════════════════════════════
# STEP 1: Prerequisites
# ══════════════════════════════════════════
step "Prerequisites"

# Check & Install Node.js 20 LTS
$needNode = $false
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    $needNode = $true
} else {
    $nodeVersion = node -v
    if ($nodeVersion -match 'v(\d+)\.') {
        $nodeMajor = [int]$Matches[1]
        if ($nodeMajor -lt 20) {
            $needNode = $true
            warn "Node.js $nodeVersion — upgrading to 20+..."
        }
    }
}

if ($needNode) {
    info "Installing Node.js 20 LTS via winget..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        if ($LASTEXITCODE -ne 0) {
            fail "winget install Node.js failed."
            info "Please install Node.js 20+ manually from: https://nodejs.org"
            Exit 1
        }
        # Refresh Path
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    } else {
        fail "Node.js 20+ not found and winget is not available."
        info "Please install Node.js 20+ manually from: https://nodejs.org"
        Exit 1
    }
}
$nodeVersion = node -v
ok "Node.js ${BOLD}$nodeVersion${NC}"

# Check & Install pnpm
if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
    info "Installing pnpm..."
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        $env:COREPACK_ENABLE_AUTO_PIN=0
        $env:COREPACK_ENABLE_STRICT=0
        $env:COREPACK_ENABLE_DOWNLOAD_PROMPT=0
        & corepack enable 2>$null
        # Pin to a Node-compatible pnpm — pnpm@latest now requires Node 22+.
        & corepack prepare pnpm@9.0.0 --activate 2>$null
    }
    if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
        & npm install -g pnpm@9 --silent 2>$null
    }
}

if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
    fail "Could not install pnpm."
    info "Please install pnpm manually, then re-run: npm install -g pnpm"
    Exit 1
}
$pnpmVersion = pnpm -v
ok "pnpm ${BOLD}$pnpmVersion${NC}"

# Check & Install Rust/Cargo for the Reasoner — only needed when there is NO
# prebuilt reasoner.<triple>.node for this platform. The repo ships a Windows
# x64 binary, so a normal install needs neither Rust nor MSVC build tools.
$reasonerDir = Join-Path $SCRIPT_DIR "packages\reasoner"
$hasReasonerPrebuilt = (Test-Path $reasonerDir) -and ((Get-ChildItem -Path $reasonerDir -Filter "reasoner.win32-*.node" -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)

$needRust = $false
if ($hasReasonerPrebuilt) {
    ok "Reasoner ${DIM}(prebuilt native binary present)${NC}"
} elseif (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoBin = "$env:USERPROFILE\.cargo\bin"
    if (Test-Path "$cargoBin\cargo.exe") {
        $env:Path = "$cargoBin;$env:Path"
    } else {
        $needRust = $true
    }
}

if ($needRust) {
    info "Installing Rust toolchain (needed to compile the reasoner)..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        info "Installing Rustup via winget..."
        & winget install -e --id Rustlang.Rustup --accept-source-agreements --accept-package-agreements --silent
        Start-Sleep -Seconds 2
    }
    
    if (!(Get-Command cargo -ErrorAction SilentlyContinue)) {
        # Fallback direct download of rustup-init
        info "Downloading rustup-init.exe from win.rustup.rs..."
        $rustupUrl = "https://win.rustup.rs/x86_64"
        $rustupPath = "$env:TEMP\rustup-init.exe"
        Invoke-WebRequest -Uri $rustupUrl -OutFile $rustupPath
        
        info "Running rustup-init silently..."
        & Start-Process -FilePath $rustupPath -ArgumentList "-y", "--no-modify-path" -NoNewWindow -Wait
        Start-Sleep -Seconds 2
    }
    
    # Reload Path to recognize Cargo bin directory
    $cargoBin = "$env:USERPROFILE\.cargo\bin"
    if (Test-Path "$cargoBin\cargo.exe") {
        $env:Path = "$cargoBin;$env:Path"
    }
}

if (-not $hasReasonerPrebuilt) {
    if (Get-Command cargo -ErrorAction SilentlyContinue) {
        $cargoVersion = cargo --version
        if ($cargoVersion -match 'cargo (\S+)') {
            $cargoVersion = $Matches[1]
        }
        ok "Rust ${BOLD}$cargoVersion${NC}"
    } else {
        warn "Rust/Cargo not available — native reasoner cannot be compiled."
        info "Install Rustup manually via https://rustup.rs, then re-run the installer."
    }
}

# ══════════════════════════════════════════
# STEP 2: Dependencies
# ══════════════════════════════════════════
step "Dependencies"

# Navigate to script folder
Set-Location -Path $SCRIPT_DIR

# Clean node_modules if better-sqlite3 native binding is missing
$sqliteBinding = Get-ChildItem -Path "$SCRIPT_DIR\node_modules" -Filter "better_sqlite3.node" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$sqliteBinding -and (Test-Path "$SCRIPT_DIR\node_modules")) {
    info "Native modules missing — clean install..."
    Remove-Item -Path "$SCRIPT_DIR\node_modules" -Recurse -Force -ErrorAction SilentlyContinue
}

if (!(Test-Path "$SCRIPT_DIR\node_modules")) {
    info "First install — downloading & compiling dependencies..."
    info "This may take 2-3 minutes"
}

& pnpm install --reporter=silent 2>$null
if ($LASTEXITCODE -ne 0) {
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
        fail "pnpm install failed."
        info "Try manually: cd $SCRIPT_DIR && pnpm install"
        Exit 1
    }
}
ok "All dependencies installed"

# ══════════════════════════════════════════
# STEP 3: Build
# ══════════════════════════════════════════
step "Build"

# Clear Turborepo caches
Get-ChildItem -Path $SCRIPT_DIR -Filter ".turbo" -Recurse -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

info "Building all packages (Turborepo resolves order)..."
Write-Host ""
& pnpm build
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    fail "Build failed — see the errors above."
    info "Fix errors and re-run install.ps1"
    Exit 1
}
ok "All packages built successfully"

# ══════════════════════════════════════════
# STEP 4: Triplestore
# ══════════════════════════════════════════
step "Triplestore"

ok "Oxigraph (embedded) ready — no download required"
info "Legacy Fuseki backend: install Java 17+ and select it in 'ontofelia onboard'"

# ══════════════════════════════════════════
# STEP 5: CLI Command
# ══════════════════════════════════════════
step "CLI Command"

$binDir = Join-Path $env:USERPROFILE ".local\bin"
if (!(Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

# Create CMD wrapper
$cmdWrapperPath = Join-Path $binDir "ontofelia.cmd"
$cmdWrapperContent = @"
@echo off
node "$SCRIPT_DIR\apps\cli\dist\index.js" %*
"@
Set-Content -Path $cmdWrapperPath -Value $cmdWrapperContent -Force

# Create PowerShell wrapper
$psWrapperPath = Join-Path $binDir "ontofelia.ps1"
$psWrapperContent = @"
node "$SCRIPT_DIR\apps\cli\dist\index.js" `$args
"@
Set-Content -Path $psWrapperPath -Value $psWrapperContent -Force

# Add binDir permanently to user Path if not present
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$binDir*") {
    $newUserPath = $userPath
    if ($newUserPath -and !$newUserPath.EndsWith(";")) { $newUserPath += ";" }
    $newUserPath += "$binDir"
    [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
}

# Add to active session path
if ($env:Path -notlike "*$binDir*") {
    $env:Path = "$binDir;$env:Path"
}

if (Get-Command ontofelia -ErrorAction SilentlyContinue) {
    $cliVer = ontofelia --version
    ok "'ontofelia' command linked → ${DIM}$cliVer${NC}"
} else {
    warn "Could not verify 'ontofelia' command. Please restart your terminal/PowerShell."
}

# ══════════════════════════════════════════
# STEP 6: Configuration
# ══════════════════════════════════════════
step "Configuration"

$configFile = Join-Path $env:USERPROFILE ".ontofelia\ontofelia.json5"

if (!(Test-Path $configFile)) {
    if ($NonInteractive) {
        info "No config found — running non-interactive onboarding..."
        & node "$SCRIPT_DIR\apps\cli\dist\index.js" onboard --non-interactive
    } else {
        info "No config found — launching setup wizard..."
        Write-Host ""
        & node "$SCRIPT_DIR\apps\cli\dist\index.js" onboard
        if ($LASTEXITCODE -ne 0 -or !(Test-Path $configFile)) {
            warn "Onboarding did not complete, trying non-interactive fallback..."
            & node "$SCRIPT_DIR\apps\cli\dist\index.js" onboard --non-interactive
        }
    }
    
    if (!(Test-Path $configFile)) {
        fail "Onboarding did not complete — no config at $configFile"
        info "Run it manually: ontofelia onboard"
        Exit 1
    }
    ok "Configuration created"
} else {
    ok "Configuration loaded"
}

# ══════════════════════════════════════════
# STEP 7: Telegram Bot (optional)
# ══════════════════════════════════════════
step "Telegram Bot ${DIM}(optional)${NC}"

if (Test-Path $configFile) {
    $configContent = Get-Content -Path $configFile -Raw
    $hasTg = $configContent -match "telegram"
    
    if ($hasTg) {
        ok "Telegram already configured"
    } else {
        if ($NonInteractive) {
            info "Non-interactive mode — skipping optional Telegram configuration."
        } else {
            Write-Host "      Connect Ontofelia to Telegram for mobile chat."
            Write-Host ""
            Write-Host -NoNewline "    Configure now? (y/N) "
            $setupTg = Read-Host
            Write-Host ""
            
            if ($setupTg -match "^[yYjJ]") {
                info "How to get a token:"
                info "1. Open Telegram → @BotFather"
                info "2. Send /newbot → follow instructions"
                info "3. Copy the token"
                Write-Host ""
                Write-Host -NoNewline "    Bot Token: "
                $tgToken = Read-Host
                
                if ($tgToken) {
                    # PowerShell regex insertion
                    if ($configContent -match "channels:\s*\{\s*\}") {
                        $replacement = "channels: {`n    telegram: {`n      enabled: true,`n      token: '$tgToken',`n    },`n  }"
                        $configContent = $configContent -replace "channels:\s*\{\s*\}", $replacement
                    } else {
                        $replacement = "channels: {`n    telegram: {`n      enabled: true,`n      token: '$tgToken',`n    },"
                        $configContent = $configContent -replace "channels:\s*\{", $replacement
                    }
                    Set-Content -Path $configFile -Value $configContent -Force
                    ok "Telegram bot configured"
                } else {
                    warn "No token — skipped"
                }
            } else {
                info "Skipped. Add later in ~/.ontofelia/ontofelia.json5"
            }
        }
    }
}

# ══════════════════════════════════════════
# STEP 8: Launch
# ══════════════════════════════════════════
step "Launch"

$gatewayOk = $true
info "Starting gateway..."
& node "$SCRIPT_DIR\apps\cli\dist\index.js" gateway start
if ($LASTEXITCODE -ne 0) {
    $gatewayOk = $false
}

$configContent = Get-Content -Path $configFile -Raw
$gwPort = 18780
if ($configContent -match 'port:\s*(\d+)') {
    $gwPort = $Matches[1]
}
$gwToken = ""
if ($configContent -match 'token:\s*[^0-9A-Za-z]*([0-9A-Za-z]+)') {
    $gwToken = $Matches[1]
}

Start-Sleep -Seconds 2
Write-Host ""

if (!$gatewayOk) {
    frame_top " ${FG_YELLOW}${BOLD}⚠ Installed — gateway not running${NC} "
    frame_empty
    frame_line " The build and setup completed, but the gateway failed to start."
    frame_line ""
    frame_line " ${FG_WHITE}Inspect the error:${NC}"
    frame_line "   Check logs at ~/.ontofelia/logs/gateway.log"
    frame_line ""
    frame_line " ${FG_WHITE}Then retry:${NC}"
    frame_line "   ontofelia gateway start"
    frame_empty
    frame_bottom
    Write-Host ""
    Exit 1
}

# Successful Installation UI
frame_top " ${FG_GREEN}${BOLD}✔ Installation Complete${NC} "
frame_empty
frame_line "        ${FG_PURPLE}▄███████▄${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}███${NC}${FG_PURPLE}█${NC}${FG_YELLOW}███${NC}${FG_PURPLE}███${NC}"
frame_line "      ${FG_PURPLE}███${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}█${NC}${FG_YELLOW}█${NC}${FG_WHITE}◉${NC}${FG_YELLOW}█${NC}${FG_PURPLE}███${NC}      ${FG_WHITE}${BOLD}Ontofelia is running!${NC}"
frame_line "      ${FG_PURPLE}██████${NC}${FG_WHITE}${BOLD}V${NC}${FG_PURPLE}██████${NC}"
frame_line "      ${FG_PURPLE}█████████████${NC}"
frame_line "       ${FG_PURPLE}███████████${NC}"
frame_line "        ${FG_PURPLE}▀███████▀${NC}"
frame_line "         ${FG_YELLOW}▀▄   ▄▀${NC}"
frame_empty
frame_divider
frame_empty
frame_line " ${FG_GREEN}Web UI${NC}     ${FG_WHITE}${UNDERLINE}http://127.0.0.1:${gwPort}${NC}                       "
if ($gwToken) {
    frame_line " ${FG_GREEN}Token${NC}      ${FG_YELLOW}${gwToken}${NC}"
}
frame_line " ${FG_GREEN}Status${NC}     ${FG_WHITE}ontofelia status${NC}                            "
frame_line " ${FG_GREEN}Logs${NC}       ${FG_WHITE}ontofelia gateway logs${NC}                      "
frame_line " ${FG_GREEN}Stop${NC}       ${FG_WHITE}ontofelia gateway stop${NC}                      "
frame_empty
frame_bottom
Write-Host ""
Write-Host "  $(make_bar $TOTAL_STEPS $TOTAL_STEPS 30)"
Write-Host ""
