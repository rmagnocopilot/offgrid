const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const { extractExplicitFileReferences, buildContextPriority } = require('../out/agent/AgentContext');
const { detectToolCall, looksLikeToolCall } = require('../out/agent/ToolCallParser');
const { AgentLoop } = require('../out/agent/AgentLoop');
const { normalizeRelativePath, isWriteProtectedPath, resolveInsideRoot } = require('../out/safety/PathSafety');
const { chooseLoadAttempts, HardwareProfileStore } = require('../out/diagnostics/HardwareProfile');
const { SessionStore } = require('../out/sessions/SessionStore');
const { FileLogger } = require('../out/diagnostics/FileLogger');
const { isDeviceMemoryError } = require('../out/llm/LlamaEngine');
const { TOOL_SCHEMAS, schemasForMode } = require('../out/tools/ToolRegistry');
const { ModelCatalog } = require('../out/models/ModelCatalog');
const { ModelInstaller } = require('../out/models/ModelInstaller');

const resources = (gpus = []) => ({
  capturedAt: new Date().toISOString(), platform: process.platform,
  systemRam: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 }, gpus
});
const loadOptions = { modelPath: 'model.gguf', gpu: 'auto', gpuLayers: 'auto', contextSize: 4096, maxTokens: 1024, temperature: .2, fallbackToCpu: true, adaptiveGpu: true };

// Contexto e prioridade
test('extrai arquivos explicitamente citados', () => {
  assert.deepEqual(extractExplicitFileReferences('use src/app/a.component.html e src/app/a.component.ts'), ['src/app/a.component.html','src/app/a.component.ts']);
});
test('expande abreviação html / ts', () => {
  assert.deepEqual(extractExplicitFileReferences('agenteFinanceiro.component.html / ts'), ['agenteFinanceiro.component.html','agenteFinanceiro.component.ts']);
});
test('arquivo citado vence seleção e arquivo fixado', () => {
  const values = buildContextPriority({ prompt: 'altere src/a.ts', selectionFile: 'src/selection.ts', pinnedFile: 'src/pinned.ts', relatedFiles: ['src/related.ts'] });
  assert.deepEqual(values, ['src/a.ts','src/selection.ts','src/pinned.ts','src/related.ts']);
});
test('remove referências duplicadas ignorando caixa e barras', () => {
  const values = buildContextPriority({ prompt: 'SRC\\A.ts', pinnedFile: 'src/a.ts' });
  assert.equal(values.length, 1);
});

// Tool calling
test('interpreta JSON de ferramenta puro', () => {
  const call = detectToolCall('{"name":"list_files","arguments":{"pattern":"**/*.ts"}}');
  assert.equal(call.name, 'list_files'); assert.equal(call.arguments.pattern, '**/*.ts');
});
test('interpreta JSON em bloco markdown', () => {
  const call = detectToolCall('```json\n{"name":"read_file","arguments":{"filePath":"a.ts"}}\n```');
  assert.equal(call.name, 'read_file');
});
test('interpreta function_call', () => {
  const call = detectToolCall(JSON.stringify({ function_call: { name: 'git_status', arguments: '{}' } }));
  assert.equal(call.name, 'git_status');
});
test('interpreta tool_calls no formato de APIs', () => {
  const call = detectToolCall(JSON.stringify({ tool_calls: [{ id: 'x', function: { name: 'read_file', arguments: '{"filePath":"a.ts"}' } }] }));
  assert.equal(call.id, 'x'); assert.equal(call.arguments.filePath, 'a.ts');
});
test('interpreta XML do AgentLoop do Unplugged', () => {
  const call = detectToolCall('<tool_call name="list_files">{"pattern":"**/*.java"}</tool_call>');
  assert.equal(call.name, 'list_files');
});
test('encontra JSON balanceado dentro de texto', () => {
  const call = detectToolCall('Vou pesquisar. {"name":"search_codebase","arguments":{"query":"foo"}}');
  assert.equal(call.name, 'search_codebase');
});

test('normaliza aliases antigos do Agente', () => {
  assert.equal(detectToolCall('{"name":"listWorkspaceFiles","arguments":{}}').name, 'list_files');
  assert.equal(detectToolCall('{"name":"applyChanges","arguments":{"summary":"ok"}}').name, 'apply_changes');
});
test('interpreta tag function alternativa', () => {
  assert.equal(detectToolCall('<function=listWorkspaceFiles>{"pattern":"**/*.ts"}</function>').name, 'list_files');
});

test('identifica aparência de ferramenta inválida', () => assert.equal(looksLikeToolCall('{"name":'), true));

test('AgentLoop executa ferramenta e devolve resultado ao modelo', async () => {
  const prompts = [];
  const result = await new AgentLoop().run({
    initialPrompt: 'liste', maxSteps: 3, diagnosticMode: true, log() {},
    async invokeStep(prompt, step) { prompts.push(prompt); return step === 1 ? '{"name":"list_files","arguments":{}}' : 'Arquivos encontrados.'; },
    async executeTool(call) { return { callId: call.id, name: call.name, ok: true, content: ['a.ts'], durationMs: 1 }; }
  });
  assert.equal(result.text, 'Arquivos encontrados.'); assert.equal(result.calls.length, 1); assert.match(prompts[1], /resultado_ferramenta/);
});
test('AgentLoop não exibe JSON de ferramenta inválido como resposta final', async () => {
  await assert.rejects(() => new AgentLoop().run({ initialPrompt: 'x', maxSteps: 1, diagnosticMode: false, log() {}, invokeStep: async () => '{"name":', executeTool: async () => { throw new Error('não deveria'); } }), /chamada de ferramenta inválida/);
});
test('AgentLoop respeita limite de etapas', async () => {
  await assert.rejects(() => new AgentLoop().run({ initialPrompt: 'x', maxSteps: 2, diagnosticMode: false, log() {}, invokeStep: async () => '{"name":"list_files","arguments":{}}', executeTool: async call => ({ callId: call.id, name: call.name, ok: true, content: [], durationMs: 0 }) }), /excedeu o limite de 2/);
});

// Segurança
test('normaliza caminho relativo', () => assert.equal(normalizeRelativePath('.\\src\\a.ts'), 'src/a.ts'));
test('bloqueia caminho absoluto e saída do workspace', () => {
  assert.throws(() => normalizeRelativePath('C:/x.txt')); assert.throws(() => normalizeRelativePath('../x.txt'));
});
test('node_modules e .git são somente leitura', () => {
  assert.equal(isWriteProtectedPath('node_modules/x.js'), true); assert.equal(isWriteProtectedPath('src/.git/config'), true); assert.equal(isWriteProtectedPath('src/a.ts'), false);
});
test('resolve somente dentro da raiz', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-safe-'));
  assert.equal(resolveInsideRoot(dir, 'src/a.ts'), path.join(dir, 'src', 'a.ts'));
  assert.throws(() => resolveInsideRoot(dir, '../../fora'));
});

// Hardware
test('perfil manual preserva backend e adiciona CPU', () => {
  const attempts = chooseLoadAttempts({ ...loadOptions, gpu: 'vulkan', gpuLayers: 10 }, resources());
  assert.deepEqual(attempts.map(x => [x.gpu,x.gpuLayers]), [['vulkan',10],['cpu',0]]);
});
test('sem telemetria de GPU tenta auto antes de CPU', () => {
  const attempts = chooseLoadAttempts(loadOptions, resources());
  assert.deepEqual(attempts.map(x => x.gpu), ['auto','cpu']);
});
test('VRAM disponível gera camadas progressivas', () => {
  const attempts = chooseLoadAttempts(loadOptions, resources([{ name:'GPU', totalBytes:4*1024**3, usedBytes:2*1024**3, freeBytes:2*1024**3, dedicated:true, source:'nvidia-smi' }]));
  assert.equal(attempts[0].gpu, 'vulkan'); assert.ok(attempts.some(x => x.gpuLayers === 1)); assert.equal(attempts.at(-1).gpu, 'cpu');
});
test('perfil funcional persiste por máquina e modelo', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-profile-'));
  const store = new HardwareProfileStore(dir); await store.init(); await store.recordSuccess('C:/models/a.gguf', { gpu:'cpu', gpuLayers:0, reason:'ok' });
  const restored = new HardwareProfileStore(dir); await restored.init(); assert.equal(restored.get('D:/outra/a.gguf').gpu, 'cpu');
});
test('perfil antigo ou inválido não quebra o carregamento', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-profile-legacy-'));
  await fsp.writeFile(path.join(dir, 'hardware-profiles.json'), JSON.stringify({ version: 1, profiles: 'formato-antigo' }), 'utf8');
  const store = new HardwareProfileStore(dir);
  await store.init();
  assert.equal(store.get('C:/models/a.gguf'), undefined);
  await store.recordSuccess('C:/models/a.gguf', { gpu:'cpu', gpuLayers:0, reason:'ok' });
  assert.equal(store.get('C:/models/a.gguf').gpu, 'cpu');
});

test('perfil legado encapsulado é migrado sem erro', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-profile-wrapper-'));
  const current = new HardwareProfileStore(dir);
  await current.init();
  await current.recordSuccess('C:/models/a.gguf', { gpu:'cpu', gpuLayers:0, reason:'ok' });
  const file = path.join(dir, 'hardware-profiles.json');
  const list = JSON.parse(await fsp.readFile(file, 'utf8'));
  await fsp.writeFile(file, JSON.stringify({ profiles: list }), 'utf8');
  const restored = new HardwareProfileStore(dir);
  await restored.init();
  assert.equal(restored.get('D:/outra/a.gguf').gpu, 'cpu');
});

// Sessões
test('sessões são persistidas e restauradas', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-session-'));
  const store = new SessionStore(dir); await store.init(); store.addMessage({ role:'user', text:'Erro Maven' }); store.updateMetadata({ mode:'agent', contextFiles:['pom.xml'] }); await store.flush();
  const restored = new SessionStore(dir); await restored.init(); assert.equal(restored.current().messages[0].text, 'Erro Maven'); assert.equal(restored.current().metadata.mode, 'agent');
});
test('duplicar sessão copia metadados sem compartilhar arrays', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-session-'));
  const store = new SessionStore(dir); await store.init(); store.updateMetadata({ contextFiles:['a.ts'] }); const clone = store.duplicate(store.current().id); clone.metadata.contextFiles.push('b.ts');
  assert.deepEqual(store.list().find(x => x.id !== clone.id).metadata.contextFiles, ['a.ts']);
});
test('busca de sessões considera mensagens', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-session-'));
  const store = new SessionStore(dir); await store.init(); store.addMessage({ role:'user', text:'problema no DSC Table' }); assert.equal(store.list('DSC').length, 1);
});

// Logs, modelos e estrutura
test('logger grava UTF-8 e preserva acentos', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-log-'));
  const logger = new FileLogger({ directory:dir, level:'trace', output(){} }); logger.info('offgrid', 'Memória · Não iniciado · Alterações'); await logger.flush();
  const file = (await fsp.readdir(dir)).find(x => x.startsWith('offgrid-')); const text = await fsp.readFile(path.join(dir,file), 'utf8'); assert.match(text, /Memória · Não iniciado · Alterações/);
});
test('logger respeita nível configurado', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-log-'));
  const logger = new FileLogger({ directory:dir, level:'warn', output(){} }); logger.debug('offgrid','não gravar'); logger.warn('offgrid','gravar'); await logger.flush();
  const file = (await fsp.readdir(dir))[0]; const text = await fsp.readFile(path.join(dir,file),'utf8'); assert.doesNotMatch(text,/não gravar/); assert.match(text,/gravar/);
});
test('reconhece erros comuns de memória de GPU', () => {
  assert.equal(isDeviceMemoryError(new Error('vk::Device::allocateMemory: ErrorOutOfDeviceMemory')), true); assert.equal(isDeviceMemoryError(new Error('arquivo ausente')), false);
});
test('catálogo contém 20 ferramentas e remove escrita de Planejar', () => {
  assert.equal(TOOL_SCHEMAS.length, 20); assert.ok(schemasForMode('agent').some(x => x.write)); assert.ok(schemasForMode('plan').every(x => !x.write)); assert.equal(schemasForMode('chat').length, 0);
});
test('catálogo de modelos deriva release models-v1 do repositório', () => {
  const catalog = new ModelCatalog(root, path.join(root, '.tmp-models'));

  const modelIds = catalog.manifest.models.map(model => model.id);

  assert.deepEqual(modelIds, [
    'qwen2.5-coder-0.5b-q4_k_m',
    'qwen2.5-coder-3b-q4_k_m',
    'qwen2.5-coder-7b-q4_k_m'
  ]);

  assert.match(
    catalog.releaseBaseUrl('https://github.com/rmagnocopilot/offgrid.git'),
    /releases\/download\/models-v1$/
  );
});
test('validação local de modelo usa SHA-256', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-model-')); const content = Buffer.from('modelo'); const hash = crypto.createHash('sha256').update(content).digest('hex');
  const model = { id:'x', displayName:'x', fileName:'x.gguf', description:'', hardware:'', approxSize:'', sha256:hash, parts:[], license:'MIT', commercialUse:true, source:'' };
  await fsp.writeFile(path.join(dir,'x.gguf'), content); const installer = new ModelInstaller(dir,'https://invalid'); assert.equal((await installer.validate(model)).valid, true);
});


test('logger usa a data local em vez do dia UTC seguinte', () => {
  const script = `const { formatLocalDate, formatLocalTimestamp } = require(${JSON.stringify(path.join(root, 'out/diagnostics/FileLogger.js'))}); const date = new Date('2026-07-31T00:30:00.000Z'); process.stdout.write(formatLocalDate(date) + '|' + formatLocalTimestamp(date));`;
  const result = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Sao_Paulo' }, encoding: 'utf8' });
  assert.equal(result.split('|')[0], '2026-07-30');
  assert.match(result, /2026-07-30T21:30:00\.000-03:00$/);
});

test('instalador baixa, valida SHA-256 e grava o modelo', async t => {
  const content = Buffer.from('modelo-offgrid-valido');
  const server = http.createServer((request, response) => {
    if (request.url !== '/ok.gguf') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-length': String(content.length), 'content-type': 'application/octet-stream' });
    response.end(content);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-install-'));
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const model = { id:'ok', displayName:'OK', fileName:'ok.gguf', description:'', hardware:'', approxSize:'', sha256:hash, parts:['ok.gguf'], license:'MIT', commercialUse:true, source:'' };
  const progress = [];
  const installer = new ModelInstaller(dir, `http://127.0.0.1:${address.port}`);
  const installed = await installer.install(model, item => progress.push(item.message));
  assert.deepEqual(await fsp.readFile(installed), content);
  assert.ok(progress.some(message => /Validando SHA-256/.test(message)));
  assert.equal((await installer.validate(model)).valid, true);
});

test('instalador informa HTTP e limpa arquivos parciais após falha', async t => {
  const server = http.createServer((_request, response) => response.writeHead(404, 'Not Found').end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-install-error-'));
  const model = { id:'missing', displayName:'Ausente', fileName:'missing.gguf', description:'', hardware:'', approxSize:'', sha256:'0'.repeat(64), parts:['missing.gguf'], license:'MIT', commercialUse:true, source:'' };
  const installer = new ModelInstaller(dir, `http://127.0.0.1:${address.port}`);
  await assert.rejects(() => installer.install(model), /HTTP 404/);
  assert.deepEqual(await fsp.readdir(dir), []);
});

test('package declara runtime, comandos de pastas e versão de correção', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.version, '2.0.1');
  assert.equal(pkg.dependencies['node-llama-cpp'], '3.19.1');
  const commands = new Set(pkg.contributes.commands.map(item => item.command));
  for (const command of ['offgrid.openModelsFolder','offgrid.openDataFolder','offgrid.openLogsFolder']) assert.equal(commands.has(command), true);
});

test('fluxo de interface registra falha de instalação e limpa modelo ativo ao descarregar', () => {
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
  assert.match(extension, /logger\.error\('model-install'/);
  assert.match(extension, /activeModelId = undefined/);
  assert.match(extension, /globalState\.update\('offgrid\.activeModelId', undefined\)/);
  assert.match(extension, /const hasLoadedModel = engine\.loaded && Boolean\(engine\.modelPath\)/);
  assert.match(extension, /let activeModelId = hasLoadedModel \? s\.activeModelId : undefined/);
  assert.match(extension, /const restoredModelId = s\.engine\.isLoaded \? previous : undefined/);
  const webview = fs.readFileSync(path.join(root, 'src/ui/webview/main.ts'), 'utf8');
  assert.match(webview, /Selecione um modelo/);
  assert.match(webview, /unload'\)\.disabled = !loaded/);
});

test('botão Enviar exige modelo carregado e bloqueia envio por Enter sem motor', () => {
  const webview = fs.readFileSync(path.join(root, 'src/ui/webview/main.ts'), 'utf8');
  assert.match(webview, /const canSubmit = loaded && !busy/);
  assert.match(webview, /sendButton\.disabled = !canSubmit/);
  assert.match(webview, /if \(!state\?\.engine\.loaded \|\| state\.busy\) return/);
  assert.match(webview, /Carregue um modelo para enviar mensagens/);
  assert.match(webview, /`Qwen \${match\[1\]}B`/);
  assert.match(webview, /modelSelect\.title = modelHint/);
});

test('chat oculta eventos operacionais do motor e mantém conversa útil', () => {
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'src/ui/webview/main.ts'), 'utf8');

  assert.doesNotMatch(extension, /addMessage\(\{ role: 'system', text: `Modelo carregado:/);
  assert.doesNotMatch(extension, /addMessage\(\{ role: 'system', text: 'Modelo descarregado da memória/);
  assert.match(webview, /isOperationalSystemMessage/);
  assert.match(webview, /Modelo carregado:/);
  assert.match(webview, /Modelo descarregado da memória/);
  assert.match(webview, /previous\?\.role === 'system'/);
});

test('workflow publica também o modelo 0.5B no release de modelos', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish-models.yml'), 'utf8');
  assert.match(workflow, /Baixar, validar e publicar Qwen 0\.5B/);
  assert.match(workflow, /qwen2\.5-coder-0\.5b-instruct-q4_k_m\.gguf/);
  assert.match(workflow, /1d9614638d18024d0fbb36575a15f1302a3adf044df10345688ec4f6e1c4ff32/);
});

test('runtime node-llama-cpp usa import ESM nativo mesmo com saída CommonJS', async () => {
  const source = fs.readFileSync(path.join(root, 'src/llm/LlamaEngine.ts'), 'utf8');
  assert.match(source, /Function\('return import\(\"node-llama-cpp\"\)'\)/);

  const compiledPath = path.join(root, 'out/llm/LlamaEngine.js');
  const compiled = fs.readFileSync(compiledPath, 'utf8');
  assert.doesNotMatch(compiled, /require\(["']node-llama-cpp["']\)/);

  const { importNodeLlamaCppRuntime } = require(compiledPath);
  const runtime = await importNodeLlamaCppRuntime();
  assert.equal(typeof runtime.getLlama, 'function');
});


test('ao fechar ou reabrir o chat a conversa atual vai para o histórico', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-session-archive-'));
  const store = new SessionStore(dir);
  await store.init();
  const previousId = store.current().id;
  store.addMessage({ role: 'user', text: 'mensagem anterior' });
  store.addMessage({ role: 'assistant', text: 'resposta anterior' });

  assert.equal(store.archiveCurrent(), true);
  assert.notEqual(store.current().id, previousId);
  assert.equal(store.current().messages.length, 0);
  assert.equal(store.get(previousId).messages.length, 2);
  assert.equal(store.archiveCurrent(), false);
});

test('contexto temporal informa a data local atual ao modelo', () => {
  const { buildTemporalContext } = require('../out/context/TemporalContext.js');
  const context = buildTemporalContext(new Date(2026, 6, 30, 23, 28, 0));
  assert.match(context, /2026/);
  assert.match(context, /30 de julho/);
  assert.match(context, /hoje, ontem, amanhã/);
});

test('interface diferencia envio bloqueado e mantém o botão Parar utilizável', () => {
  const css = fs.readFileSync(path.join(root, 'resources/webview/main.css'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'src/ui/webview/main.ts'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/ui/ChatViewProvider.ts'), 'utf8');
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

  assert.match(css, /button\.primary:disabled/);
  assert.doesNotMatch(css, /\.busy \.composer[^\n]*pointer-events:none/);
  assert.match(webview, /'input'\)\.disabled = busy/);
  assert.match(webview, /'abort'\)\.disabled = !busy/);
  assert.match(provider, /viewHidden/);
  assert.match(extension, /sessions\.archiveCurrent\(\)/);
  assert.match(extension, /buildTemporalContext\(\)/);
});

test('interface usa Codicons e recolhe o painel do motor em acordeão compacto', () => {
  const pkg = require('../package.json');
  const provider = fs.readFileSync(path.join(root, 'src/ui/ChatViewProvider.ts'), 'utf8');
  const webview = fs.readFileSync(path.join(root, 'src/ui/webview/main.ts'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'resources/webview/main.css'), 'utf8');
  const sprite = fs.readFileSync(path.join(root, 'src/ui/CodiconSprite.ts'), 'utf8');

  for (const icon of ['archive','pinned','refresh','new-file','screen-cut','collection','redo','copy','open-preview']) {
    assert.match(sprite, new RegExp(`id=["']codicon-${icon}["']`));
  }
  assert.match(provider, /CODICON_SPRITE/);
  assert.match(provider, /href=\"#codicon-\$\{name\}\"/);
  assert.doesNotMatch(provider, /codiconUri|codicon\.svg/);
  assert.match(provider, /icon\('collection'\)/);
  assert.match(provider, /icon\('archive'\)/);
  assert.match(provider, /icon\('screen-cut'\)/);
  assert.match(webview, /const forcedOpen = engine\.engineState === 'loading' \|\| engine\.engineState === 'error'/);
  assert.match(webview, /statusSection\.classList\.toggle\('expanded', showDetails\)/);
  assert.match(webview, /Carregue um modelo para enviar mensagens/);
  assert.match(webview, /`Qwen \${match\[1\]}B`/);
  assert.match(webview, /modelSelect\.title = modelHint/);
  assert.match(css, /\.status:not\(\.expanded\) \.status-text/);
  assert.match(css, /\.codicon\{/);
  const commandIcons = new Map(pkg.contributes.commands.map(item => [item.command, item.icon]));
  assert.equal(commandIcons.get('offgrid.manageModels'), '$(symbol-structure)');
  assert.equal(commandIcons.get('offgrid.restartEngine'), '$(redo)');
  assert.equal(commandIcons.get('offgrid.openLogsFolder'), '$(open-preview)');
});

test('PowerShell usa Int64 e UTF-8', () => {
  const ps = fs.readFileSync(path.join(root,'resources/windows/gpu-memory.ps1'),'utf8'); assert.match(ps,/\[int64\]/); assert.match(ps,/UTF8Encoding/); assert.doesNotMatch(ps,/\[Math\]::Max\(0,/);
});
test('package aponta para JavaScript compilado e mantém fontes TypeScript', () => {
  const pkg = require('../package.json'); assert.equal(pkg.main,'./out/extension.js'); assert.equal(pkg.version,'2.0.1'); assert.ok(fs.existsSync(path.join(root,'src/extension.ts'))); assert.equal(fs.existsSync(path.join(root,'src/extension.js')),false);
});
test('Activity Bar e abertura por F5 estão configuradas', () => {
  const pkg = require('../package.json'); assert.equal(pkg.contributes.viewsContainers.activitybar[0].id,'offgrid'); const launch = JSON.parse(fs.readFileSync(path.join(root,'.vscode/launch.json'),'utf8')); assert.equal(launch.configurations[0].type,'extensionHost');
});
test('interface possui breakpoints responsivos e modos completos', () => {
  const css = fs.readFileSync(path.join(root,'resources/webview/main.css'),'utf8'); const ui = fs.readFileSync(path.join(root,'src/ui/ChatViewProvider.ts'),'utf8'); assert.match(css,/@media\(max-width:520px\)/); assert.match(css,/@media\(max-width:330px\)/); for (const mode of ['Chat','Planejar','Somente leitura','Agente']) assert.match(ui,new RegExp(mode));
});
test('fontes não contêm sinais conhecidos de mojibake', async () => {
  const bad = ['Mem��ria','nÃ£o','alteraÃ§','diagn¾'];
  for (const dir of ['src','resources']) for (const file of walk(path.join(root,dir))) { const text = await fsp.readFile(file,'utf8'); for (const token of bad) assert.equal(text.includes(token),false,`${file} contém ${token}`); }
});
test('saída compilada contém extensão, worker e webview', () => {
  for (const file of ['out/extension.js','out/engine/EngineWorker.js','out/ui/webview/main.js']) assert.equal(fs.existsSync(path.join(root,file)),true,file);
});

function walk(directory) {
  const result=[]; for (const entry of fs.readdirSync(directory,{withFileTypes:true})) { const full=path.join(directory,entry.name); if(entry.isDirectory()) result.push(...walk(full)); else result.push(full); } return result;
}
