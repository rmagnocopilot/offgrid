import * as vscode from 'vscode';
import type { ConversationMode, UiState } from '../types/contracts';

export type UiEvent =
  | { type: 'ready' }
  | { type: 'submit'; text: string; mode: ConversationMode }
  | { type: 'abort' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'modelAction'; action: string; modelId?: string }
  | { type: 'unloadModel' }
  | { type: 'restartEngine' }
  | { type: 'newSession' }
  | { type: 'sessionAction'; action: string; sessionId: string; value?: string }
  | { type: 'pinActiveFile' }
  | { type: 'useAutoFile' }
  | { type: 'addCurrentFile' }
  | { type: 'addSelection' }
  | { type: 'clearContext' }
  | { type: 'openContextItem'; value: string }
  | { type: 'openDiff'; filePath: string }
  | { type: 'acceptReview' }
  | { type: 'rejectReview' }
  | { type: 'copyDiagnostics' }
  | { type: 'openLogs' }
  | { type: 'setDiagnosticsPanel'; value: UiState['diagnosticsPanel'] };

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
    view.webview.onDidReceiveMessage((message: UiEvent) => {
      for (const listener of this.listeners) {
        Promise.resolve(listener(message)).catch(error => console.error('[Offgrid UI]', error));
      }
    });
    if (this.state) void this.postState(this.state);
  }

  onEvent(listener: (event: UiEvent) => void | Promise<void>): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
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
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Offgrid</title>
</head>
<body>
  <div id="app">
    <aside class="sessions" id="sessions">
      <div class="session-head">
        <button id="newSession" title="Nova sessão" aria-label="Nova sessão">＋</button>
        <input class="session-search" id="sessionSearch" placeholder="Buscar sessões" aria-label="Buscar sessões">
      </div>
      <div class="session-list" id="sessionList"></div>
    </aside>
    <main class="main" id="main">
      <div class="toolbar">
        <button class="mobile-sessions icon" id="toggleSessions" title="Sessões" aria-label="Sessões">☰</button>
        <select id="modelSelect" title="Modelo ativo" aria-label="Modelo ativo"></select>
        <button class="icon" id="models" title="Gerenciar modelos" aria-label="Gerenciar modelos">▤</button>
        <button class="icon" id="unload" title="Descarregar modelo" aria-label="Descarregar modelo">⏏</button>
        <button class="icon" id="restart" title="Reiniciar motor" aria-label="Reiniciar motor">↻</button>
        <button class="icon" id="copyDiagnostics" title="Copiar diagnóstico" aria-label="Copiar diagnóstico">⧉</button>
        <button class="icon" id="logs" title="Abrir logs" aria-label="Abrir logs">≡</button>
      </div>
      <section class="status">
        <div class="status-line">
          <span class="dot" id="dot"></span>
          <strong id="compactStatus">Inicializando…</strong>
          <button id="toggleDetails">Detalhes</button>
        </div>
        <div class="details" id="details" hidden></div>
      </section>
      <section class="context">
        <span class="chip" id="fileChip">Arquivo: automático</span>
        <button id="pinFile">Fixar atual</button>
        <button id="autoFile">Auto</button>
        <button id="addFile">+ arquivo</button>
        <button id="addSelection">+ seleção</button>
        <button id="clearContext">Limpar</button>
        <div id="contextItems"></div>
      </section>
      <section class="messages" id="messages" aria-live="polite"></section>
      <section class="composer">
        <textarea id="input" placeholder="Pergunte sobre o projeto… Enter envia; Shift+Enter quebra linha" aria-label="Mensagem"></textarea>
        <div class="composer-row">
          <select id="mode" aria-label="Modo">
            <option value="chat">Chat</option>
            <option value="plan">Planejar</option>
            <option value="readOnly">Somente leitura</option>
            <option value="agent">Agente</option>
          </select>
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
