'use strict';

const crypto = require('node:crypto');

class ChatViewProvider {
  static viewType = 'offgrid.chatView';

  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
    this.submitHandler = null;
    this.abortHandler = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.#html(view.webview);
    view.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'send' && typeof message.text === 'string') {
        await this.submitHandler?.(message.text.trim(), message.mode === 'agent' ? 'agent' : 'chat');
      } else if (message?.type === 'abort') {
        this.abortHandler?.();
      }
    });
  }

  onSubmit(handler) { this.submitHandler = handler; }
  onAbort(handler) { this.abortHandler = handler; }

  addMessage(role, text, streaming = false) {
    this.view?.webview.postMessage({ type: 'message', role, text, streaming });
  }

  appendAssistant(text) {
    this.view?.webview.postMessage({ type: 'appendAssistant', text });
  }

  finishAssistant() {
    this.view?.webview.postMessage({ type: 'finishAssistant' });
  }

  setStatus(text, state = 'idle') {
    this.view?.webview.postMessage({ type: 'status', text, state });
  }

  clear() {
    this.view?.webview.postMessage({ type: 'clear' });
  }

  reveal() {
    this.view?.show?.(true);
  }

  #html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  #app { height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
  #status { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; opacity: .85; }
  #messages { overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .message { padding: 10px 11px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  .user { background: var(--vscode-inputOption-activeBackground); border: 1px solid var(--vscode-inputOption-activeBorder); }
  .assistant { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); }
  .system { opacity: .8; border-left: 3px solid var(--vscode-descriptionForeground); border-radius: 0; }
  #composer { padding: 10px; border-top: 1px solid var(--vscode-panel-border); display: grid; gap: 8px; }
  textarea { width: 100%; min-height: 72px; resize: vertical; padding: 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
  .toolbar { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  select { min-width: 150px; padding: 6px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
  .mode-help { font-size: 11px; opacity: .8; }
  .buttons { display: flex; gap: 8px; }
  button { border: 0; padding: 7px 12px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
<div id="app">
  <div id="status">Configure um modelo no gerenciador.</div>
  <div id="messages"><div class="message system">Tudo é executado localmente. Os modelos são baixados do GitHub Release configurado.</div></div>
  <div id="composer">
    <div class="toolbar">
      <select id="mode">
        <option value="chat">Chat — somente resposta</option>
        <option value="agent">Agente — altera arquivos</option>
      </select>
      <span id="modeHelp" class="mode-help">Não modifica o workspace.</span>
    </div>
    <textarea id="input" placeholder="Pergunte sobre o código... (Ctrl+Enter para enviar)"></textarea>
    <div class="buttons"><button id="send">Enviar</button><button id="abort" class="secondary" disabled>Parar</button></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const abort = document.getElementById('abort');
  const mode = document.getElementById('mode');
  const modeHelp = document.getElementById('modeHelp');
  let currentAssistant = null;

  function add(role, text) {
    const el = document.createElement('div');
    el.className = 'message ' + role;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }
  function submit() {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    input.value = '';
    send.disabled = true;
    abort.disabled = false;
    vscode.postMessage({ type: 'send', text, mode: mode.value });
  }
  mode.addEventListener('change', () => {
    const agent = mode.value === 'agent';
    modeHelp.textContent = agent
      ? 'Lê o projeto e node_modules; grava apenas fora de pastas protegidas.'
      : 'Não modifica o workspace.';
    input.placeholder = agent
      ? 'Descreva a alteração que deve ser aplicada no projeto...'
      : 'Pergunte sobre o código... (Ctrl+Enter para enviar)';
  });
  send.addEventListener('click', submit);
  abort.addEventListener('click', () => vscode.postMessage({ type: 'abort' }));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.ctrlKey) { event.preventDefault(); submit(); }
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'message') {
      currentAssistant = add(message.role, message.text || '');
    } else if (message.type === 'appendAssistant') {
      if (!currentAssistant || !currentAssistant.classList.contains('assistant')) currentAssistant = add('assistant', '');
      currentAssistant.textContent += message.text;
      messages.scrollTop = messages.scrollHeight;
    } else if (message.type === 'finishAssistant') {
      currentAssistant = null; send.disabled = false; abort.disabled = true; input.focus();
    } else if (message.type === 'status') {
      document.getElementById('status').textContent = message.text;
    } else if (message.type === 'clear') {
      messages.innerHTML = ''; currentAssistant = null;
    }
  });
</script>
</body>
</html>`;
  }
}

module.exports = { ChatViewProvider };
