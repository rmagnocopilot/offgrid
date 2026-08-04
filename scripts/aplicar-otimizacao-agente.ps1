param(
  [Parameter(Mandatory = $false, Position = 0)]
  [string]$Projeto = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$Projeto = [System.IO.Path]::GetFullPath($Projeto)
$ExtensionPath = Join-Path $Projeto 'src\extension.ts'

if (-not (Test-Path $ExtensionPath)) {
  throw "Arquivo não encontrado: $ExtensionPath"
}

$Utf8SemBom = [System.Text.UTF8Encoding]::new($false)
$Texto = [System.IO.File]::ReadAllText($ExtensionPath, [System.Text.Encoding]::UTF8)
$Alterado = $false

$ImportAnchor = "import { buildAgentWorkspaceContext } from './agent/WorkspaceContextBuilder';"
$ImportLine = "import { tryPrepareSimpleEditFastPath } from './agent/SimpleEditFastPath';"

if (-not $Texto.Contains($ImportLine)) {
  if (-not $Texto.Contains($ImportAnchor)) {
    throw 'Não foi possível localizar o import de WorkspaceContextBuilder em src/extension.ts.'
  }
  $Texto = $Texto.Replace($ImportAnchor, "$ImportAnchor`r`n$ImportLine")
  $Alterado = $true
}

$ContextAnchor = @"
      const contextSize = s.engine.diagnostics.contextSize ?? 4096;
"@

$FastPathBlock = @"
      if (mode === 'agent' && approvalMode !== 'readOnly') {
        const fastPath = await tryPrepareSimpleEditFastPath({
          request: text,
          workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          priority: s.contextManager.priority(text),
          execute: call => s.tools.execute(call),
          info: message => s.logger.info('agent', message),
          warn: message => s.logger.warn('agent', message)
        });

        if (fastPath) {
          response = fastPath.text;
          await s.view.streamChunk(messageId, response);
          s.sessions.addMessage({ role: 'assistant', text: response });
          s.sessions.updateMetadata({
            lastError: undefined,
            backend: s.engine.diagnostics.backend
          });
          return;
        }
      }

"@

if (-not $Texto.Contains('const fastPath = await tryPrepareSimpleEditFastPath({')) {
  if (-not $Texto.Contains($ContextAnchor.TrimStart("`r", "`n"))) {
    throw 'Não foi possível localizar o início da configuração de contexto em src/extension.ts.'
  }
  $Texto = $Texto.Replace(
    $ContextAnchor.TrimStart("`r", "`n"),
    $FastPathBlock + $ContextAnchor.TrimStart("`r", "`n")
  )
  $Alterado = $true
}

if ($Alterado) {
  $Backup = "$ExtensionPath.backup-speed-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $ExtensionPath $Backup -Force
  [System.IO.File]::WriteAllText($ExtensionPath, $Texto, $Utf8SemBom)
  Write-Host "Atualizado: $ExtensionPath"
  Write-Host "Backup: $Backup"
} else {
  Write-Host 'src/extension.ts já contém a otimização.'
}

$ArquivosObrigatorios = @(
  'src\agent\AgentLoop.ts',
  'src\agent\ToolCallParser.ts',
  'src\agent\SimpleEditFastPath.ts',
  'tests\agent-optimization.test.cjs'
)

foreach ($Relativo in $ArquivosObrigatorios) {
  $Caminho = Join-Path $Projeto $Relativo
  if (-not (Test-Path $Caminho)) {
    throw "Arquivo da otimização ausente: $Caminho. Extraia o ZIP sobre a raiz do projeto antes de executar este script."
  }
}

Write-Host ''
Write-Host 'Otimização aplicada com sucesso.'
Write-Host 'Próximo passo: npm run compile; npm test'
