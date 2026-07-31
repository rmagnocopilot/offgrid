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

function iconSvg(name: string): string {
  return `<svg class="codicon" aria-hidden="true" focusable="false"><use href="#codicon-${escapeHtml(name)}"></use></svg>`;
}

function formatBytes(value?: number): string {
  return typeof value === 'number' ? `${(value / 1_073_741_824).toFixed(2)} GB` : '—';
}

function shortModel(name: string): string {
  const match = name.match(/Qwen2\.5-Coder-(\d+(?:\.\d+)?)B/i);
  return match?.[1] ? `Qwen ${match[1]}B` : name.split(/[—·]/)[0]?.trim() || name;
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
  const pinned = session.pinned ? `<span class="session-pin" title="Sessão fixada">${iconSvg('pinned')}</span>` : '';
  return `<div class="session ${session.id === currentId ? 'active' : ''}">
    <div class="session-title" tabindex="0" data-id="${escapeHtml(session.id)}">${pinned}<span>${escapeHtml(session.title)}</span></div>
    <div class="session-actions">
      <button data-action="pin" data-id="${escapeHtml(session.id)}" title="Fixar sessão" aria-label="Fixar sessão">${iconSvg('pinned')}</button>
      <button data-action="duplicate" data-id="${escapeHtml(session.id)}" title="Duplicar sessão" aria-label="Duplicar sessão">${iconSvg('copy')}</button>
      <button data-action="rename" data-id="${escapeHtml(session.id)}" title="Renomear sessão" aria-label="Renomear sessão">${iconSvg('edit')}</button>
      <button data-action="delete" data-id="${escapeHtml(session.id)}" title="Excluir sessão" aria-label="Excluir sessão">${iconSvg('trash')}</button>
    </div>
  </div>`;
}

function reviewHtml(current: UiState): string {
  const review = current.pendingReview;
  if (!review) return '';
  const files = review.files.map(file => `<button class="diff" data-file="${escapeHtml(file)}">Ver diff · ${escapeHtml(file)}</button>`).join('');
  return `<div class="review"><strong>${escapeHtml(review.summary)}</strong><div class="review-files">${files}</div><button class="primary" id="acceptReview">Aceitar alterações</button> <button class="danger" id="rejectReview">Rejeitar</button></div>`;
}

function isOperationalSystemMessage(text: string): boolean {
  return /^(Bem-vindo ao Offgrid|Modelo carregado:|Modelo descarregado da memória|Nenhum modelo carregado\.)/i.test(text.trim());
}

function visibleMessages(current: UiState): ChatSession['messages'] {
  const session = current.sessions.find(candidate => candidate.id === current.currentSessionId);
  const visible: ChatSession['messages'] = [];

  for (const message of session?.messages ?? []) {
    if (message.role === 'system' && isOperationalSystemMessage(message.text)) continue;

    const previous = visible.at(-1);
    if (message.role === 'system' && previous?.role === 'system' && previous.text === message.text) continue;
    visible.push(message);
  }

  return visible;
}

function renderMessages(current: UiState): void {
  const messages = visibleMessages(current)
    .map(message => `<div class="message ${escapeHtml(message.role)}" data-message="${escapeHtml(message.id)}">${escapeHtml(message.text)}</div>`)
    .join('');
  const container = element('messages');
  container.innerHTML = messages + reviewHtml(current);
  container.scrollTop = container.scrollHeight;
}

function render(): void {
  if (!state) return;
  const engine = state.engine;
  const loaded = engine.loaded;
  const statusClass = engine.engineState === 'ready' ? 'ready' : engine.engineState === 'error' ? 'error' : '';
  const statusText = `${loaded ? nameFromPath(engine.modelPath) : 'Nenhum modelo'} · ${String(engine.backend).toUpperCase()} · Motor ${labelEngineState(engine.engineState)}`;
  element('dot').className = `dot ${statusClass}`;
  element('compactStatus').textContent = statusText;
  const error = engine.lastError ? `<div style="color:var(--vscode-errorForeground)">Erro: ${escapeHtml(engine.lastError.slice(0, 600))}</div>` : '';
  element('details').innerHTML = [
    `<div>Modelo: ${escapeHtml(engine.modelPath || 'nenhum')}</div>`,
    `<div>Backend: ${escapeHtml(String(engine.backend).toUpperCase())} · contexto: ${escapeHtml(engine.contextSize ?? '—')} · camadas: ${escapeHtml(engine.gpuLayers)}</div>`,
    `<div>Chat: ${loaded ? 'pronto' : 'indisponível'} · Agente: ${loaded ? 'pronto' : 'indisponível'} · PID: ${escapeHtml(engine.workerPid ?? '—')}</div>`,
    resourceHtml(state),
    error
  ].join('');
  const forcedOpen = engine.engineState === 'loading' || engine.engineState === 'error';
  const showDetails = forcedOpen || state.diagnosticsPanel === 'expanded' || (state.diagnosticsPanel === 'onError' && engine.engineState === 'error');
  const statusSection = element<HTMLElement>('status');
  const statusToggle = element<HTMLButtonElement>('toggleDetails');
  statusSection.classList.toggle('expanded', showDetails);
  element<HTMLDivElement>('details').hidden = !showDetails;
  statusToggle.setAttribute('aria-expanded', String(showDetails));
  statusToggle.title = `${statusText}. ${showDetails ? 'Clique para recolher os detalhes.' : 'Clique para abrir os detalhes.'}`;
  statusToggle.setAttribute('aria-label', statusToggle.title);
  const activeModelId = state.activeModelId;
  const modelOptions = state.models.map(model => {
    const fullLabel = `${model.displayName} · ${labelModelState(model.state)}`;
    return `<option value="${escapeHtml(model.id)}" title="${escapeHtml(fullLabel)}" ${model.id === activeModelId ? 'selected' : ''}>${escapeHtml(shortModel(model.displayName))}</option>`;
  }).join('');
  const emptyOption = activeModelId ? '' : '<option value="" selected disabled>Selecione um modelo</option>';
  const modelSelect = element<HTMLSelectElement>('modelSelect');
  modelSelect.innerHTML = emptyOption + modelOptions;
  const activeModel = state.models.find(model => model.id === activeModelId);
  const modelHint = activeModel
    ? `${activeModel.displayName} · ${labelModelState(activeModel.state)}`
    : 'Selecione um modelo';
  modelSelect.title = modelHint;
  modelSelect.setAttribute('aria-label', modelHint);
  element<HTMLSelectElement>('mode').value = state.mode;
  const fileContext = state.pinnedFile
    ? `Arquivo fixado: ${state.pinnedFile}`
    : state.autoFile
      ? `Arquivo automático: ${state.autoFile}`
      : 'Arquivo automático: nenhum arquivo aberto';
  const fileChip = element<HTMLElement>('fileChip');
  fileChip.title = fileContext;
  fileChip.setAttribute('aria-label', fileContext);
  fileChip.classList.toggle('active', Boolean(state.pinnedFile));
  element('contextItems').innerHTML = state.contextItems.map(item => `<button class="chip context-open" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join(' ');
  renderSessions(state);
  renderMessages(state);
  const busy = state.busy;
  const canSubmit = loaded && !busy;
  element('main').classList.toggle('busy', busy);
  element<HTMLTextAreaElement>('input').disabled = busy;
  element<HTMLSelectElement>('mode').disabled = busy;
  element<HTMLSelectElement>('modelSelect').disabled = busy;
  const sendButton = element<HTMLButtonElement>('send');
  sendButton.disabled = !canSubmit;
  sendButton.title = loaded ? (busy ? 'Aguarde a resposta atual ou use Parar.' : 'Enviar mensagem') : 'Carregue um modelo para enviar mensagens.';
  element<HTMLButtonElement>('abort').disabled = !busy;
  element<HTMLButtonElement>('unload').disabled = !loaded || busy;
  element<HTMLButtonElement>('pinFile').disabled = !state.autoFile || busy;
  element<HTMLButtonElement>('autoFile').disabled = !state.pinnedFile || busy;
  element<HTMLButtonElement>('addFile').disabled = !state.autoFile || busy;
  element<HTMLButtonElement>('addSelection').disabled = busy;
  element<HTMLButtonElement>('clearContext').disabled = busy || (!state.pinnedFile && state.contextItems.length === 0);
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
  if (!state?.engine.loaded || state.busy) return;
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
element<HTMLSelectElement>('modelSelect').addEventListener('change', event => {
  const modelId = (event.target as HTMLSelectElement).value;
  if (modelId) post('selectModel', { modelId });
});
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
element('toggleDetails').addEventListener('click', () => post('setDiagnosticsPanel', { value: element('status').classList.contains('expanded') ? 'compact' : 'expanded' }));

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
