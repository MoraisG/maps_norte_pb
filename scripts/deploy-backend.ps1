<#
.SYNOPSIS
  Automatiza o envio do backend (Code.gs) para o Google Apps Script via @google/clasp
  e atualiza a implantação ativa sem alterar a URL do Web App.

.EXAMPLE
  .\scripts\deploy-backend.ps1 -Descricao "Atualiza regra de 120 dias e relatorio S-13"
#>
param(
  [string]$Descricao = "Deploy automatizado via clasp",
  [switch]$SetupInicial
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

# Carrega variáveis do arquivo .env se existir
$EnvFile = Join-Path $RootDir ".env"
if (Test-Path $EnvFile) {
  Get-Content $EnvFile | ForEach-Object {
    if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
      $k = $matches[1].Trim()
      $v = $matches[2].Trim().Trim('"').Trim("'")
      [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
    }
  }
}

# 1. Verifica se Node.js / npx estão instalados
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Host "⚠️ Node.js (npx) não encontrado no PATH." -ForegroundColor Yellow
  Write-Host "Para instalar o Node.js LTS automaticamente via Winget, execute:" -ForegroundColor Cyan
  Write-Host "  winget install OpenJS.NodeJS.LTS" -ForegroundColor White
  exit 1
}

# 2. Se for setup inicial, autentica no Google e gera o .clasp.json
$ClaspJson = Join-Path $RootDir ".clasp.json"
if ($SetupInicial -or -not (Test-Path $ClaspJson)) {
  $ScriptId = $env:GAS_SCRIPT_ID
  if (-not $ScriptId -or $ScriptId -eq "COLE_AQUI_SEU_SCRIPT_ID") {
    $ScriptId = Read-Host "Informe o Script ID do seu projeto Google Apps Script"
  }
  @{
    scriptId = $ScriptId
    rootDir  = "backend"
  } | ConvertTo-Json | Set-Content -Path $ClaspJson -Encoding UTF8
  Write-Host "✅ Arquivo .clasp.json configurado com sucesso." -ForegroundColor Green

  if ($SetupInicial) {
    Write-Host "🔐 Iniciando login no Google (@google/clasp)..." -ForegroundColor Cyan
    npx @google/clasp login
  }
}

# 3. Sincroniza backend/Code.gs com o Google Apps Script
Write-Host "🚀 Enviando backend/Code.gs para o Google Apps Script (clasp push)..." -ForegroundColor Cyan
npx @google/clasp push --force

# 4. Atualiza a implantação existente mantendo a mesma URL do Web App
$DeploymentId = $env:GAS_DEPLOYMENT_ID
if ($DeploymentId) {
  Write-Host "🔄 Atualizando implantação ativa ($DeploymentId)..." -ForegroundColor Cyan
  npx @google/clasp deploy -i $DeploymentId -d $Descricao
  Write-Host "✅ Backend publicado e atualizado na mesma URL do Web App!" -ForegroundColor Green
} else {
  Write-Host "ℹ️ Código enviado! Para atualizar a implantação automaticamente, defina GAS_DEPLOYMENT_ID no seu arquivo .env." -ForegroundColor Yellow
}
