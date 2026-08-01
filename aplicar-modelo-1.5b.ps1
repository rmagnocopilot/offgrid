[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$ProjectRoot = (Get-Location).Path,

  [string]$ModelsDirectory = (Join-Path $env:APPDATA 'Code\User\globalStorage\rmagnocopilot.offgrid\models'),

  [switch]$SkipDownload,
  [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Model = [ordered]@{
  Id          = 'qwen2.5-coder-1.5b-q4_k_m'
  DisplayName = 'Qwen2.5-Coder-1.5B-Instruct Q4_K_M — Recomendado'
  FileName    = 'qwen2.5-coder-1.5b-instruct-q4_k_m.gguf'
  Description = 'Modelo intermediário recomendado para Chat e Agente em computadores com RAM limitada. Oferece qualidade superior ao 0.5B sem o consumo do 3B.'
  Hardware    = 'CPU; recomendado 8 GB de RAM ou mais; contexto de 4096'
  ApproxSize  = '~1,12 GB'
  Sha256      = 'cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046'
  Source      = 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF'
  DownloadUrl = 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf?download=true'
}

$OldModel = [ordered]@{
  Id       = 'qwen2.5-coder-0.5b-q4_k_m'
  FileName = 'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf'
  Sha256   = '1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32'
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Assert-ProjectRoot {
  param([string]$Root)

  $required = @(
    'package.json',
    'models\manifest.json',
    '.github\workflows\publish-models.yml',
    'tests\core.test.cjs'
  )

  foreach ($relative in $required) {
    $candidate = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "Arquivo obrigatório não encontrado: $candidate"
    }
  }
}

function Backup-File {
  param(
    [string]$Root,
    [string]$BackupRoot,
    [string]$RelativePath
  )

  $source = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { return }

  $destination = Join-Path $BackupRoot $RelativePath
  $destinationDirectory = Split-Path -Parent $destination
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Replace-InFile {
  param(
    [string]$Path,
    [hashtable]$Replacements
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }

  $content = [System.IO.File]::ReadAllText($Path)
  $updated = $content

  foreach ($entry in $Replacements.GetEnumerator()) {
    $updated = $updated.Replace([string]$entry.Key, [string]$entry.Value)
  }

  if ($updated -ne $content) {
    Write-Utf8NoBom -Path $Path -Content $updated
    Write-Host "Atualizado: $Path"
  }
}

function Install-LocalModel {
  param([string]$Directory)

  New-Item -ItemType Directory -Force -Path $Directory | Out-Null

  $destination = Join-Path $Directory $Model.FileName
  $partial = "$destination.download"

  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    Write-Host 'Validando modelo 1.5B já existente...'
    $existingHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existingHash -eq $Model.Sha256) {
      Write-Host "Modelo 1.5B já está instalado e válido: $destination"
      return
    }

    Remove-Item -LiteralPath $destination -Force
  }

  Write-Host 'Baixando Qwen2.5-Coder-1.5B-Instruct Q4_K_M (~1,12 GB)...'
  Write-Host "Destino: $destination"

  & curl.exe --fail --location --retry 5 --retry-all-errors --continue-at - --output $partial $Model.DownloadUrl
  if ($LASTEXITCODE -ne 0) {
    throw "Falha no download do modelo. Código do curl: $LASTEXITCODE"
  }

  Write-Host 'Validando SHA-256 do modelo...'
  $actualHash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $Model.Sha256) {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
    throw "SHA-256 inválido. Esperado=$($Model.Sha256); obtido=$actualHash"
  }

  Move-Item -LiteralPath $partial -Destination $destination -Force
  Write-Host "Modelo 1.5B instalado: $destination"
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
Assert-ProjectRoot -Root $ProjectRoot

Write-Host "Projeto: $ProjectRoot"
Write-Host 'Substituição: Qwen 0.5B -> Qwen 1.5B'

# Baixa e valida primeiro para não deixar o catálogo apontando para um modelo ausente.
if (-not $SkipDownload) {
  Install-LocalModel -Directory $ModelsDirectory
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $ProjectRoot ".offgrid-backup-modelo-1.5b-$timestamp"
$trackedFiles = @(
  'models\manifest.json',
  '.github\workflows\publish-models.yml',
  'tests\core.test.cjs'
)

foreach ($relative in $trackedFiles) {
  Backup-File -Root $ProjectRoot -BackupRoot $backupRoot -RelativePath $relative
}

Write-Host "Backup criado em: $backupRoot"

# 1) Catálogo: remove 0.5B e mantém 1.5B como primeira opção.
$manifestPath = Join-Path $ProjectRoot 'models\manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$remainingModels = @(
  $manifest.models | Where-Object {
    $_.id -ne $OldModel.Id -and $_.id -ne $Model.Id
  }
)

$newDefinition = [pscustomobject][ordered]@{
  id            = $Model.Id
  displayName   = $Model.DisplayName
  fileName      = $Model.FileName
  description   = $Model.Description
  hardware      = $Model.Hardware
  approxSize    = $Model.ApproxSize
  sha256        = $Model.Sha256
  parts         = @($Model.FileName)
  license       = 'Apache-2.0'
  commercialUse = $true
  source        = $Model.Source
}

$manifest.models = @($newDefinition) + $remainingModels
$manifestJson = $manifest | ConvertTo-Json -Depth 20
Write-Utf8NoBom -Path $manifestPath -Content ($manifestJson + [Environment]::NewLine)
Write-Host "Atualizado: $manifestPath"

# 2) Workflow de publicação: publica o 1.5B no lugar do 0.5B.
$workflowPath = Join-Path $ProjectRoot '.github\workflows\publish-models.yml'
$workflowReplacements = @{
  'Baixar, validar e publicar Qwen 0.5B' = 'Baixar, validar e publicar Qwen 1.5B'
  'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf' = $Model.FileName
  'Qwen2.5-Coder-0.5B-Instruct-GGUF' = 'Qwen2.5-Coder-1.5B-Instruct-GGUF'
  $OldModel.Sha256 = $Model.Sha256
  'work/0.5b' = 'work/1.5b'
}
Replace-InFile -Path $workflowPath -Replacements $workflowReplacements

$workflow = [System.IO.File]::ReadAllText($workflowPath).Replace("`r`n", "`n")
if ($workflow -notmatch 'QWEN-1\.5B-APACHE-2\.0\.txt') {
  $licenseNeedle = @'
          curl --fail --location --retry 5 \
            --output release-metadata/QWEN-7B-APACHE-2.0.txt \
            "https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/resolve/main/LICENSE"
'@

  $license15 = @'
          curl --fail --location --retry 5 \
            --output release-metadata/QWEN-1.5B-APACHE-2.0.txt \
            "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct/resolve/main/LICENSE"
'@

  if ($workflow.Contains($licenseNeedle)) {
    $workflow = $workflow.Replace($licenseNeedle, $license15 + $licenseNeedle)
    Write-Utf8NoBom -Path $workflowPath -Content $workflow
    Write-Host 'Licença Apache-2.0 do 1.5B adicionada ao workflow.'
  }
}

# 3) Testes: atualiza somente as referências do modelo substituído.
$testsPath = Join-Path $ProjectRoot 'tests\core.test.cjs'
$testReplacements = @{
  'qwen2.5-coder-0.5b-q4_k_m' = $Model.Id
  'qwen2.5-coder-0.5b-instruct-q4_k_m.gguf' = $Model.FileName
  'qwen2\.5-coder-0\.5b-instruct-q4_k_m\.gguf' = 'qwen2\.5-coder-1\.5b-instruct-q4_k_m\.gguf'
  'Qwen 0.5B' = 'Qwen 1.5B'
  'Qwen 0\.5B' = 'Qwen 1\.5B'
  'modelo 0.5B' = 'modelo 1.5B'
  $OldModel.Sha256 = $Model.Sha256
}
Replace-InFile -Path $testsPath -Replacements $testReplacements

# Remove o arquivo antigo apenas depois que o novo modelo foi validado.
if (-not $SkipDownload) {
  $oldModelPath = Join-Path $ModelsDirectory $OldModel.FileName
  if (Test-Path -LiteralPath $oldModelPath -PathType Leaf) {
    Remove-Item -LiteralPath $oldModelPath -Force
    Write-Host "Modelo 0.5B removido: $oldModelPath"
  }
}

if (-not $SkipValidation) {
  Push-Location $ProjectRoot
  try {
    Write-Host 'Executando npm run compile...'
    & npm.cmd run compile
    if ($LASTEXITCODE -ne 0) { throw 'npm run compile falhou.' }

    Write-Host 'Executando npm test...'
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'npm test falhou.' }
  }
  finally {
    Pop-Location
  }
}

Write-Host ''
Write-Host 'Troca concluída com sucesso.' -ForegroundColor Green
Write-Host "Modelo ativo no catálogo: $($Model.DisplayName)"
Write-Host 'Feche a janela do Extension Development Host e pressione F5 novamente.'
Write-Host 'Para disponibilizar o download corporativo, envie as alterações ao GitHub e execute o workflow Publicar modelos no GitHub Release.'
