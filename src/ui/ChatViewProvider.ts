import * as vscode from 'vscode';
import type { AgentAutonomy, ConversationMode, UiState } from '../types/contracts';
import { CODICON_SPRITE } from './CodiconSprite';

export type UiEvent =
  | { type: 'ready' }
  | { type: 'submit'; text: string; mode: ConversationMode; autonomy: AgentAutonomy }
  | { type: 'setAutonomy'; value: AgentAutonomy; mode: ConversationMode;}
  | { type: 'abort' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'modelAction'; action: string; modelId?: string }
  | { type: 'unloadModel' }
  | { type: 'restartEngine' }
  | { type: 'newSession' }
  | { type: 'viewHidden' }
  | { type: 'sessionAction'; action: string; sessionId: string; value?: string }
  | { type: 'pinActiveFile' }
  | { type: 'useAutoFile' }
  | { type: 'addCurrentFile' }
  | { type: 'addSelection' }
  | { type: 'clearContext' }
  | { type: 'openContextItem'; value: string }
  | { type: 'openDiff'; filePath: string }
  | { type: 'acceptReviewFile'; filePath: string }
  | { type: 'rejectReviewFile'; filePath: string }
  | { type: 'acceptReview' }
  | { type: 'rejectReview' }
  | { type: 'copyDiagnostics' }
  | { type: 'openLogs' }
  | { type: 'setDiagnosticsPanel'; value: UiState['diagnosticsPanel'] }
  | { type: 'setMode'; mode: ConversationMode };

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'offgrid.chatView';
  private view?: vscode.WebviewView;
  private state?: UiState;
  private readonly listeners = new Set<(event: UiEvent) => void | Promise<void>>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'out'),
        vscode.Uri.joinPath(this.extensionUri, 'resources')
      ]
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message: UiEvent) => this.emit(message));
    view.onDidChangeVisibility(() => {
      if (!view.visible) this.emit({ type: 'viewHidden' });
    });
    if (this.state) void this.postState(this.state);
  }

  onEvent(listener: (event: UiEvent) => void | Promise<void>): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(event: UiEvent): void {
    for (const listener of this.listeners) {
      Promise.resolve(listener(event)).catch(error => console.error('[Offgrid UI]', error));
    }
  }

  async postState(state: UiState): Promise<void> {
    this.state = state;
    await this.view?.webview.postMessage({ type: 'state', state });
  }

  async streamStart(messageId: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'streamStart', messageId });
  }

  async streamChunk(messageId: string, chunk: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'streamChunk', messageId, chunk });
  }

  async streamEnd(messageId: string): Promise<void> {
    await this.view?.webview.postMessage({ type: 'streamEnd', messageId });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.offgrid');
  }

  dispose(): void {
    this.listeners.clear();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'ui', 'webview', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview', 'main.css'));
    const icon = (name: string): string => `<svg class="codicon" aria-hidden="true" focusable="false"><use href="#codicon-${name}"></use></svg>`;
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Offgrid</title>
</head>
<body>
  ${CODICON_SPRITE}
  <div id="app">
    <aside class="sessions" id="sessions">
      <div class="session-head">
        <button class="icon" id="newSession" title="Nova sessão" aria-label="Nova sessão">${icon('add')}</button>
        <input class="session-search" id="sessionSearch" placeholder="Buscar sessões" aria-label="Buscar sessões">
      </div>
      <div class="session-list" id="sessionList"></div>
    </aside>
    <main class="main" id="main">
      <div class="toolbar">
        <button class="mobile-sessions icon" id="toggleSessions" title="Sessões" aria-label="Sessões">${icon('menu')}</button>
        <select id="modelSelect" title="Modelo ativo" aria-label="Modelo ativo"></select>
        <button class="icon" id="models" title="Gerenciar modelos" aria-label="Gerenciar modelos">${icon('collection')}</button>
        <button class="icon" id="unload" title="Descarregar modelo" aria-label="Descarregar modelo">${icon('debug-disconnect')}</button>
        <button class="icon" id="restart" title="Reiniciar motor" aria-label="Reiniciar motor">${icon('redo')}</button>
        <button class="icon" id="copyDiagnostics" title="Copiar diagnóstico" aria-label="Copiar diagnóstico">${icon('copy')}</button>
        <button class="icon" id="logs" title="Abrir logs" aria-label="Abrir logs">${icon('open-preview')}</button>
      </div>
      <section class="status" id="status">
        <button class="status-toggle" id="toggleDetails" title="Inicializando…" aria-label="Inicializando…" aria-expanded="false">
          <span class="dot" id="dot"></span>
          <strong class="status-text" id="compactStatus">Inicializando…</strong>
          <span class="status-chevron">${icon('chevron-up')}</span>
        </button>
        <div class="details" id="details" hidden></div>
      </section>
      <section class="context" aria-label="Contexto da conversa">
        <div class="context-actions">
          <span class="context-indicator icon-control" id="fileChip" title="Arquivo automático" aria-label="Arquivo automático">${icon('archive')}</span>
          <button class="icon-control" id="pinFile" title="Fixar arquivo atual" aria-label="Fixar arquivo atual">${icon('pinned')}</button>
          <button class="icon-control" id="autoFile" title="Voltar ao arquivo automático" aria-label="Voltar ao arquivo automático">${icon('refresh')}</button>
          <button class="icon-control" id="addFile" title="Adicionar arquivo atual ao contexto" aria-label="Adicionar arquivo atual ao contexto">${icon('new-file')}</button>
          <button class="icon-control" id="addSelection" title="Adicionar seleção ao contexto" aria-label="Adicionar seleção ao contexto">${icon('screen-cut')}</button>
          <button class="icon-control" id="clearContext" title="Limpar contexto" aria-label="Limpar contexto">${icon('clear-all')}</button>
        </div>
        <div id="contextItems"></div>
      </section>
      <section class="messages" id="messages" aria-live="polite"></section>
      <section class="changes" id="changes" aria-label="Alterações propostas" hidden></section>
      <section class="composer">
        <textarea id="input" placeholder="Pergunte sobre o projeto… Enter envia; Shift+Enter quebra linha" aria-label="Mensagem"></textarea>
        <div class="composer-row">
          <select id="mode" aria-label="Modo">
            <option value="chat">Chat</option>
            <option value="plan">Planejar</option>
            <option value="readOnly">Somente leitura</option>
            <option value="agent">Agente</option>
          </select>
          <button id="autonomy"
              class="autonomy-toggle"
              type="button"
              aria-label="Modo Assistido"
              aria-pressed="false"
              title="M-AS — Modo Assistido: pergunta antes de criar ou excluir arquivos.">
              M-AS
          </button>
          <span class="spacer"></span>
          <button id="abort">Parar</button>
          <button class="primary" id="send">Enviar</button>
        </div>
      </section>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  return value;
}
