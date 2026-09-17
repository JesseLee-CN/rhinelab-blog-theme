# 本地上传（Windows）：把 release 通过 SSH 传到服务器。构建仍在本机完成。
# 用法：
#   ./ops/upload-release.ps1 -HostName 203.0.113.10 -UserName root -ReleaseId <id> -DryRun
#   ./ops/upload-release.ps1 -HostName 203.0.113.10 -UserName root -ReleaseId <id> -Activate
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ReleaseId,
  [string]$HostName,
  [string]$UserName = "root",
  [int]$Port = 22,
  [string]$Identity,
  [string]$DeployRoot = "/srv/example-blog",
  [switch]$Activate,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not $HostName) { throw "缺少 -HostName（或在 ops/upload.env 中配置）。" }

if ($ReleaseId -notmatch '^\d{8}T\d{6}Z-[0-9a-f]{7,40}$') {
  throw "release ID 格式应为 YYYYMMDDTHHMMSSZ-<gitsha>：$ReleaseId"
}

$LocalDir = Join-Path $RepoRoot "release/$ReleaseId"
foreach ($f in @("site.tar.gz", "release-manifest.json", "checksums.sha256")) {
  if (-not (Test-Path (Join-Path $LocalDir $f))) {
    throw "本地缺少 $f（先运行 npm run release -- --id $ReleaseId）"
  }
}

$SshOpts = @("-p", "$Port", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes")
if ($Identity) { $SshOpts += @("-i", $Identity) }
# scp 的端口开关是 -P（大写）；沿用 ssh 的 -p 会把 "22" 当成待上传文件而失败。
$ScpOpts = @("-P", "$Port", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes")
if ($Identity) { $ScpOpts += @("-i", $Identity) }
$Remote = "$UserName@$HostName"
$Incoming = "$DeployRoot/incoming/$ReleaseId"
$OpsDir = "$DeployRoot/ops"

function Invoke-Step {
  param([string]$Description, [scriptblock]$Action)
  if ($DryRun) { Write-Host "[dry-run] $Description" } else { & $Action }
}

function Invoke-Ssh([string]$Command) {
  if ($DryRun) {
    Write-Host "[dry-run] ssh $($SshOpts -join ' ') $Remote `"$Command`""
  } else {
    & ssh @SshOpts $Remote $Command
    if ($LASTEXITCODE -ne 0) { throw "远程命令失败：$Command" }
  }
}

Write-Host "[upload] $ReleaseId -> $Remote`:$Incoming"
Invoke-Ssh "mkdir -p '$Incoming'"

$Files = @(
  (Join-Path $LocalDir "site.tar.gz"),
  (Join-Path $LocalDir "release-manifest.json"),
  (Join-Path $LocalDir "checksums.sha256")
)
$NginxDir = Join-Path $LocalDir "nginx"
if (Test-Path $NginxDir) { $Files += $NginxDir }
if ($DryRun) {
  Write-Host "[dry-run] scp -r $($ScpOpts -join ' ') <$($Files.Count) items> $Remote`:$Incoming/"
} else {
  & scp -r @ScpOpts @Files "$Remote`:$Incoming/"
  if ($LASTEXITCODE -ne 0) { throw "scp 上传失败。" }
}

Write-Host "[upload] 服务器校验 sha256"
Invoke-Ssh "cd '$Incoming' && sha256sum -c checksums.sha256"

if ($Activate) {
  Write-Host "[upload] 解包并激活"
  Invoke-Ssh "DEPLOY_ROOT='$DeployRoot' bash '$OpsDir/prepare-release.sh' '$ReleaseId'"
  Invoke-Ssh "DEPLOY_ROOT='$DeployRoot' bash '$OpsDir/activate-release.sh' '$ReleaseId'"
  Write-Host "[upload] 激活命令已完成；请再用 ops/smoke-test.mjs 验证线上。"
} else {
  Write-Host "[upload] 上传与校验完成。激活："
  Write-Host "  ssh $($SshOpts -join ' ') $Remote `"DEPLOY_ROOT=$DeployRoot bash $OpsDir/prepare-release.sh $ReleaseId && DEPLOY_ROOT=$DeployRoot bash $OpsDir/activate-release.sh $ReleaseId`""
}
