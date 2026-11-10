<#
.SYNOPSIS
  Consulta de forma segura a Planilha Google (Banco de Dados) através da rota protegida
  'dev/inspecionar-planilha' usando a chave CLI_DIAGNOSTIC_KEY definida localmente no .env.

.EXAMPLE
  .\scripts\query-sheet.ps1 -Operacao resumo
  .\scripts\query-sheet.ps1 -Operacao ler-aba -Aba Respostas -Limite 20 -Ultimas
#>
param(
  [ValidateSet("resumo", "ler-aba")]
  [string]$Operacao = "resumo",
  [string]$Aba = "Respostas",
  [int]$Limite = 30,
  [switch]$Ultimas
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
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

$ApiUrl = $env:GAS_API_URL
if (-not $ApiUrl) {
  $ApiUrl = "https://script.google.com/macros/s/AKfycbwc4E6uP1hPc04h6rECqLgywaxD5KjG5VfhPaTf0d6Tp2_3l_FSaicv4O9Qs3QCad90Jw/exec"
}

$DiagKey = $env:CLI_DIAGNOSTIC_KEY
if (-not $DiagKey -or $DiagKey -like "COLE_AQUI*") {
  Write-Error "Defina CLI_DIAGNOSTIC_KEY no arquivo .env local (gere a chave executando gerarChaveDiagnosticoSegura() uma vez no Apps Script)."
  exit 1
}

$Payload = @{
  rota          = "dev/inspecionar-planilha"
  diagnosticKey = $DiagKey
  operacao      = $Operacao
  aba           = $Aba
  limite        = $Limite
  ultimas       = [bool]$Ultimas
} | ConvertTo-Json -Compress

$Response = Invoke-RestMethod -Uri $ApiUrl -Method Post -ContentType "text/plain;charset=utf-8" -Body $Payload
if (-not $Response.sucesso) {
  Write-Error "Erro retornado pela API ($($Response.codigo)): $($Response.erro)"
  exit 1
}

$Response | ConvertTo-Json -Depth 6
