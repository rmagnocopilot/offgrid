type ChatSession = import('../../types/contracts').ChatSession;
type UiState = import('../../types/contracts').UiState;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
let state: UiState | undefined;
const streamNodes = new Map<string, HTMLElement>();

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Elemento ausente: ${id}`);
  return value as T;
}

function post(type: string, data: Record<string, unknown> = {}): void {
  vscode.postMessage({ type, ...data });
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] ?? character));
}

function formatBytes(value?: number): string {
  return typeof value === 'number' ? `${(value / 1_073_741_824).toFixed(2)} GB` : '—';
}

function shortModel(name: string): string {
  return name.replace('Qwen2.5-Coder-', 'Qwen ').replace('-Instruct Q4_K_M', '');
}

function nameFromPath(path?: string): string {
  return path?.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') || 'modelo';
}

function labelEngineState(value: string): string {
  return ({ notStarted: 'não iniciado', loading: 'carregando', ready: 'pronto', unloading: 'descarregando', unloaded: 'descarregado', error: 'erro' } as Record<string, string>)[value] ?? value;
}

function labelModelState(value: string): string {
  return ({ notInstalled: 'não instalado', installed: 'instalado', active: 'ativo', loaded: 'carregado', error: 'erro' } as Record<string, string>)[value] ?? value;
}

function resourceHtml(current: UiState): string {
  const resources = current.engine.resources;
  if (!resources) return '';
  const gpu = resources.gpus?.[0];
  const gpuText = gpu
    ? `${escapeHtml(gpu.name)} · ${formatBytes(gpu.freeBytes)} livres / ${formatBytes(gpu.totalBytes)}${gpu.source === 'windows-cim' ? ' (estimado)' : ''}`
    : 'indisponível';
  return [
    `<div>RAM: ${formatBytes(resources.systemRam.freeBytes)} livres / ${formatBytes(resources.systemRam.totalBytes)} · Motor: ${resources.engineRam ? formatBytes(resources.engineRam.workingSetBytes) : '—'}</div>`,
    `<div>GPU: ${gpuText}</div>`
  ].join('');
}

function renderSessions(current: UiState): void {
  const query = element<HTMLInputElement>('sessionSearch').value.toLowerCase();
  const html = current.sessions
    .filter(session => !query || `${session.title} ${session.messages.map(message => message.text).join(' ')}`.toLowerCase().includes(query))
    .map(session => sessionHtml(session, current.currentSessionId))
    .join('');
  element('sessionList').innerHTML = html;
}

function sessionHtml(session: ChatSession, currentId?: string): string {
  return `<div class="session ${session.id === currentId ? 'active' : ''}">
    <div class="session-title" tabindex="0" data-id="${escapeHtml(session.id)}">${session.pinned ? '📌 ' : ''}${escapeHtml(session.title)}</div>
    <div class="session-actions">
      <button data-action="pin" data-id="${escapeHtml(session.id)}" title="Fixar">📌</button>
      <button data-action="duplicate" data-id="${escapeHtml(session.id)}" title="Duplicar">⧉</button>
      <button data-action="rename" data-id="${escapeHtml(session.id)}" title="Renomear">✎</button>
      <button data-action="delete" data-id="${escapeHtml(session.id)}" title="Excluir">×</button>
    </div>
  </div>`;
}

function reviewHtml(current: UiState): string {
  const review = current.pendingReview;
  if (!review) return '';
  const files = review.files.map(file => `<button class="diff" data-file="${escapeHtml(file)}">Ver diff · ${escapeHtml(file)}</button>`).join('');
  return `<div class="review"><strong>${escapeHtml(review.summary)}</strong><div class="review-files">${files}</div><button class="primary" id="acceptReview">Aceitar alterações</button> <button class="danger" id="rejectReview">Rejeitar</button></div>`;
}

function renderMessages(current: UiState): void {
  const session = current.sessions.find(candidate => candidate.id === current.currentSessionId);
  const messages = (session?.messages ?? []).map(message => `<div class="message ${escapeHtml(message.role)}" data-message="${escapeHtml(message.id)}">${escapeHtml(message.text)}</div>`).join('');
  const container = element('messages');
  container.innerHTML = messages + reviewHtml(current);
  container.scrollTop = container.scrollHeight;
}

function render(): void {
  if (!state) return;
  const engine = state.engine;
  const loaded = engine.loaded;
  const statusClass = engine.engineState === 'ready' ? 'ready' : engine.engineState === 'error' ? 'error' : '';
  element('dot').className = `dot ${statusClass}`;
  element('compactStatus').textContent = `${loaded ? nameFromPath(engine.modelPath) : 'Nenhum modelo'} · ${String(engine.backend).toUpperCase()} · Motor ${labelEngineState(engine.engineState)}`;
  const error = engine.lastError ? `<div style="color:var(--vscode-errorForeground)">Erro: ${escapeHtml(engine.lastError.slice(0, 600))}</div>` : '';
  element('details').innerHTML = [
    `<div>Modelo: ${escapeHtml(engine.modelPath || 'nenhum')}</div>`,
    `<div>Backend: ${escapeHtml(String(engine.backend).toUpperCase())} · contexto: ${escapeHtml(engine.contextSize ?? '—')} · camadas: ${escapeHtml(engine.gpuLayers)}</div>`,
    `<div>Chat: ${loaded ? 'pronto' : 'indisponível'} · Agente: ${loaded ? 'pronto' : 'indisponível'} · PID: ${escapeHtml(engine.workerPid ?? '—')}</div>`,
    resourceHtml(state),
    error
  ].join('');
  const showDetails = state.diagnosticsPanel === 'expanded' || (state.diagnosticsPanel === 'onError' && engine.engineState === 'error');
  element<HTMLDivElement>('details').hidden = !showDetails;
  element('toggleDetails').textContent = showDetails ? 'Recolher' : 'Detalhes';
  element<HTMLSelectElement>('modelSelect').innerHTML = state.models.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === state?.activeModelId ? 'selected' : ''}>${escapeHtml(shortModel(model.displayName))} — ${labelModelState(model.state)}</option>`).join('');
  element<HTMLSelectElement>('mode').value = state.mode;
  element('fileChip').textContent = `Arquivo: ${state.pinnedFile || state.autoFile || 'automático'}`;
  element('contextItems').innerHTML = state.contextItems.map(item => `<button class="chip context-open" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join(' ');
  renderSessions(state);
  renderMessages(state);
  element('main').classList.toggle('busy', state.busy);
  element<HTMLButtonElement>('send').disabled = state.busy;
  element<HTMLButtonElement>('abort').disabled = !state.busy;
}

window.addEventListener('message', event => {
  const message = event.data as { type?: string; state?: UiState; messageId?: string; chunk?: string };
  if (message.type === 'state' && message.state) {
    state = message.state;
    render();
    return;
  }
  if (message.type === 'streamStart' && message.messageId) {
    const node = document.createElement('div');
    node.className = 'message assistant';
    node.dataset.stream = message.messageId;
    element('messages').appendChild(node);
    streamNodes.set(message.messageId, node);
    return;
  }
  if (message.type === 'streamChunk' && message.messageId) {
    const node = streamNodes.get(message.messageId);
    if (node) node.textContent += message.chunk ?? '';
    const messages = element('messages');
    messages.scrollTop = messages.scrollHeight;
    return;
  }
  if (message.type === 'streamEnd' && message.messageId) streamNodes.delete(message.messageId);
});

function submit(): void {
  const input = element<HTMLTextAreaElement>('input');
  const text = input.value.trim();
  if (!text) return;
  post('submit', { text, mode: element<HTMLSelectElement>('mode').value });
  input.value = '';
}

element('send').addEventListener('click', submit);
element<HTMLTextAreaElement>('input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});
element('abort').addEventListener('click', () => post('abort'));
element<HTMLSelectElement>('modelSelect').addEventListener('change', event => post('selectModel', { modelId: (event.target as HTMLSelectElement).value }));
element('models').addEventListener('click', () => post('modelAction', { action: 'manage' }));
element('unload').addEventListener('click', () => post('unloadModel'));
element('restart').addEventListener('click', () => post('restartEngine'));
element('copyDiagnostics').addEventListener('click', () => post('copyDiagnostics'));
element('logs').addEventListener('click', () => post('openLogs'));
element('newSession').addEventListener('click', () => post('newSession'));
element('pinFile').addEventListener('click', () => post('pinActiveFile'));
element('autoFile').addEventListener('click', () => post('useAutoFile'));
element('addFile').addEventListener('click', () => post('addCurrentFile'));
element('addSelection').addEventListener('click', () => post('addSelection'));
element('clearContext').addEventListener('click', () => post('clearContext'));
element('toggleSessions').addEventListener('click', () => element('sessions').classList.toggle('open'));
element('sessionSearch').addEventListener('input', () => state && renderSessions(state));
element('toggleDetails').addEventListener('click', () => post('setDiagnosticsPanel', { value: element<HTMLDivElement>('details').hidden ? 'expanded' : 'compact' }));

document.addEventListener('click', event => {
  const target = event.target as Element | null;
  const action = target?.closest<HTMLElement>('[data-action]');
  if (action) {
    const value = action.dataset.action === 'rename' ? window.prompt('Novo nome da sessão:') ?? undefined : undefined;
    post('sessionAction', { action: action.dataset.action, sessionId: action.dataset.id, value });
    return;
  }
  const title = target?.closest<HTMLElement>('.session-title');
  if (title) {
    post('sessionAction', { action: 'switch', sessionId: title.dataset.id });
    element('sessions').classList.remove('open');
    return;
  }
  const diff = target?.closest<HTMLElement>('.diff');
  if (diff) {
    post('openDiff', { filePath: diff.dataset.file });
    return;
  }
  const context = target?.closest<HTMLElement>('.context-open');
  if (context) {
    post('openContextItem', { value: context.dataset.value });
    return;
  }
  if ((target as HTMLElement | null)?.id === 'acceptReview') post('acceptReview');
  if ((target as HTMLElement | null)?.id === 'rejectReview') post('rejectReview');
});

post('ready');
