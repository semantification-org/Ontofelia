# Stress benchmark: load N synthetic quads, measure boot/query/insert.
#
# Usage:  . .\bench\run_bench.ps1; Run-Bench -Facts 3000

$ErrorActionPreference = 'Stop'

$global:OntoToken = $null
$global:OntoBase = 'http://127.0.0.1:18780'
$global:DataFile = "$env:USERPROFILE\dev\Ontofelia\.ontofelia\triplestore\oxigraph\dataset.nq"
$global:BootstrapKeep = "$env:USERPROFILE\dev\Ontofelia\.ontofelia\triplestore\oxigraph\dataset.bootstrap.nq"

function Get-Token {
  $raw = & ontofelia auth token 2>&1
  $line = $raw | Where-Object { $_ -match '^\s*[0-9a-f]{64}\s*$' } | Select-Object -First 1
  if ($line) { return $line.Trim() }
  return $null
}

function Stop-Gw {
  & ontofelia gateway stop 2>&1 | Out-Null
  Start-Sleep -Seconds 1
}

function Start-Gw-Timed {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & ontofelia gateway start 2>&1 | Out-Null
  for ($i = 0; $i -lt 120; $i++) {
    try {
      $null = Invoke-RestMethod -Uri "$global:OntoBase/api/health" -Method Get -ErrorAction Stop -TimeoutSec 1
      $sw.Stop()
      return $sw.ElapsedMilliseconds
    } catch { Start-Sleep -Milliseconds 250 }
  }
  $sw.Stop()
  return -1
}

function Save-Bootstrap {
  if (-not (Test-Path $global:BootstrapKeep)) {
    Copy-Item $global:DataFile $global:BootstrapKeep -Force
    Write-Host "  bootstrap saved: $global:BootstrapKeep ($([Math]::Round((Get-Item $global:BootstrapKeep).Length/1KB,1)) KB)"
  }
}

function Restore-Bootstrap-Plus {
  param([int]$Facts)
  # 1. Generate synthetic quads to temp file
  $tmpGen = Join-Path "$env:USERPROFILE\dev\Ontofelia\bench" "gen_$Facts.nq"
  & node "$env:USERPROFILE\dev\Ontofelia\bench\gen_quads.cjs" $Facts $tmpGen 2>&1 | Out-Null
  # 2. Concatenate bootstrap + synthetic into dataset.nq
  $bootBytes = (Get-Item $global:BootstrapKeep).Length
  $genBytes = (Get-Item $tmpGen).Length
  # Use cmd /c copy /b to concat binary
  & cmd /c "copy /b `"$global:BootstrapKeep`" + `"$tmpGen`" `"$global:DataFile`"" | Out-Null
  Remove-Item $tmpGen -ErrorAction SilentlyContinue
  return @{ BootstrapBytes = $bootBytes; GenBytes = $genBytes }
}

function Send-Chat-Timed {
  param([string]$Text)
  $sid = "bench-" + [Guid]::NewGuid().ToString().Substring(0,6)
  $body = @{ message = $Text; channel = 'webchat'; senderId = 'owner'; sessionId = $sid }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri "$global:OntoBase/api/chat" -Method Post `
      -Headers @{ Authorization = "Bearer $global:OntoToken"; 'Content-Type' = 'application/json; charset=utf-8' } `
      -Body $bytes -TimeoutSec 300
    $sw.Stop()
    return @{ ms = $sw.ElapsedMilliseconds; ok = $true; reply = $r.text }
  } catch {
    $sw.Stop()
    return @{ ms = $sw.ElapsedMilliseconds; ok = $false; reply = "$_" }
  }
}

function Graphs-Counts-Timed {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $resp = Invoke-RestMethod -Uri "$global:OntoBase/api/knowledge/graphs" `
      -Headers @{ Authorization = "Bearer $global:OntoToken" } -TimeoutSec 300
    $sw.Stop()
    $tot = ($resp.graphs | Measure-Object -Property tripleCount -Sum).Sum
    return @{ ms = $sw.ElapsedMilliseconds; total = $tot; ok = $true }
  } catch {
    $sw.Stop()
    return @{ ms = $sw.ElapsedMilliseconds; total = -1; ok = $false; err = "$_" }
  }
}

function Run-One-Level {
  param([int]$Facts, [string]$Msg = 'Mein Hobby ist Lesen.')
  Stop-Gw
  $sz = Restore-Bootstrap-Plus -Facts $Facts
  $bootMs = Start-Gw-Timed
  $global:OntoToken = Get-Token
  Start-Sleep -Milliseconds 500
  $statusBefore = Graphs-Counts-Timed
  $chat = Send-Chat-Timed -Text $Msg
  $statusAfter = Graphs-Counts-Timed
  $fileSizeMB = [Math]::Round((Get-Item $global:DataFile).Length / 1MB, 1)
  return [pscustomobject]@{
    facts = $Facts
    bootMs = $bootMs
    statusBeforeMs = $statusBefore.ms
    totalBefore = $statusBefore.total
    chatMs = $chat.ms
    statusAfterMs = $statusAfter.ms
    totalAfter = $statusAfter.total
    fileSizeMB = $fileSizeMB
    chatOk = $chat.ok
  }
}

function Run-Bench {
  param(
    [int[]]$Levels = @(300, 3000, 14000, 28000),
    [string]$Msg = 'Mein neues Hobby ist Bouldern.'
  )
  Save-Bootstrap
  $results = @()
  foreach ($n in $Levels) {
    Write-Host ""
    Write-Host "===== Level: $n facts =====" -ForegroundColor Cyan
    $r = Run-One-Level -Facts $n -Msg $Msg
    Write-Host "  boot: $($r.bootMs) ms"
    Write-Host "  graphs (before chat): $($r.statusBeforeMs) ms — $($r.totalBefore) triples"
    Write-Host "  chat: $($r.chatMs) ms (ok=$($r.chatOk))"
    Write-Host "  graphs (after chat): $($r.statusAfterMs) ms — $($r.totalAfter) triples"
    Write-Host "  dataset.nq: $($r.fileSizeMB) MB"
    $results += $r
  }
  Write-Host ""
  Write-Host "===== Summary =====" -ForegroundColor Green
  $results | Format-Table -AutoSize
}

Write-Host "Loaded bench harness. Functions:" -ForegroundColor Green
Write-Host "  Save-Bootstrap          # snapshot current dataset.nq as bootstrap"
Write-Host "  Run-One-Level -Facts N  # one scaling step"
Write-Host "  Run-Bench               # full sweep (300, 3000, 14000, 28000 facts)"
