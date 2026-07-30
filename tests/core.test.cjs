const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

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

test('PowerShell usa Int64 e UTF-8', () => {
  const ps = fs.readFileSync(path.join(root,'resources/windows/gpu-memory.ps1'),'utf8'); assert.match(ps,/\[int64\]/); assert.match(ps,/UTF8Encoding/); assert.doesNotMatch(ps,/\[Math\]::Max\(0,/);
});
test('package aponta para JavaScript compilado e mantém fontes TypeScript', () => {
  const pkg = require('../package.json'); assert.equal(pkg.main,'./out/extension.js'); assert.equal(pkg.version,'2.0.0'); assert.ok(fs.existsSync(path.join(root,'src/extension.ts'))); assert.equal(fs.existsSync(path.join(root,'src/extension.js')),false);
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
