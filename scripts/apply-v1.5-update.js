'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const packagePath = path.join(root, 'package.json');
if (!fs.existsSync(packagePath)) {
  console.error('package.json não encontrado. Execute dentro da pasta do repositório Offgrid.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (pkg.name !== 'offgrid') {
  console.error('Este script deve ser executado no repositório Offgrid.');
  process.exit(1);
}

const requiredUpdateFiles = [
  '.editorconfig',
  '.vscodeignore',
  'README.md',
  'models/manifest.json',
  'resources/agent-system-prompt.md',
  'resources/system-prompt.md',
  'resources/icons/offgrid.svg',
  'resources/windows/gpu-memory.ps1',
  'src/agent-context.js',
  'src/agent-safety.js',
  'src/agent-tool-loop.js',
  'src/change-preview.js',
  'src/chat-view.js',
  'src/engine-client.js',
  'src/engine-worker.js',
  'src/extension.js',
  'src/file-logger.js',
  'src/hardware-profile.js',
  'src/llama-engine.js',
  'src/model-catalog.js',
  'src/model-installer.js',
  'src/resource-monitor.js',
  'src/session-store.js',
  'src/workspace-agent.js',
  'tests/agent-context.test.js',
  'tests/agent-safety.test.js',
  'tests/agent-tool-loop.test.js',
  'tests/change-review.test.js',
  'tests/charset-ui.test.js',
  'tests/file-logger.test.js',
  'tests/hardware-profile.test.js',
  'tests/llama-engine.test.js',
  'tests/model-installer.test.js',
  'tests/session-store.test.js',
  'tests/update-script.test.js'
];
const missingUpdateFiles = requiredUpdateFiles.filter(file => !fs.existsSync(path.join(root, file)));
if (missingUpdateFiles.length) {
  console.error('A atualização 1.5.0 foi copiada de forma incompleta. Arquivos ausentes:');
  for (const file of missingUpdateFiles) console.error(` - ${file}`);
  console.error('Extraia novamente o ZIP e copie todo o conteúdo interno para a raiz do repositório.');
  process.exit(1);
}
console.log(`Arquivos da atualização verificados: ${requiredUpdateFiles.length}/${requiredUpdateFiles.length}.`);

const preservedPublisher = pkg.publisher;
const preservedRepository = pkg.repository;

pkg.version = '1.5.0';
pkg.description = 'Assistente de programação local para VS Code, otimizado para Windows, com Agente por ferramentas, logs de diagnóstico, modelos gerenciáveis e revisão visual.';
pkg.scripts ||= {};
pkg.scripts.check = [
  'src/extension.js',
  'src/llama-engine.js',
  'src/engine-client.js',
  'src/engine-worker.js',
  'src/resource-monitor.js',
  'src/hardware-profile.js',
  'src/model-installer.js',
  'src/model-catalog.js',
  'src/chat-view.js',
  'src/workspace-agent.js',
  'src/agent-safety.js',
  'src/change-preview.js',
  'src/session-store.js',
  'src/agent-tool-loop.js',
  'src/agent-context.js',
  'src/file-logger.js'
].map(file => `node --check ${file}`).join(' && ');
pkg.scripts.test = 'node --test tests/*.test.js';
pkg.scripts.package = 'npx --yes @vscode/vsce package';

pkg.contributes ||= {};
pkg.contributes.commands ||= [];
const commands = [
  ['offgrid.copyDiagnostics', 'Offgrid: Copiar Diagnóstico Completo', '$(copy)'],
  ['offgrid.openLogsFolder', 'Offgrid: Abrir Pasta de Logs', '$(folder-opened)'],
  ['offgrid.restartEngine', 'Offgrid: Reiniciar Processo do Motor', '$(server-process)'],
  ['offgrid.unloadModel', 'Offgrid: Liberar Modelo da Memória', '$(debug-disconnect)'],
  ['offgrid.showResourceDiagnostics', 'Offgrid: Mostrar RAM e VRAM', '$(dashboard)'],
  ['offgrid.showAgentDiagnostics', 'Offgrid: Mostrar Diagnóstico do Agente', '$(bug)']
];
const byCommand = new Map(pkg.contributes.commands.map(item => [item.command, item]));
for (const [command, title, icon] of commands) {
  if (byCommand.has(command)) Object.assign(byCommand.get(command), { title, icon });
  else pkg.contributes.commands.push({ command, title, icon });
}

const properties = pkg.contributes.configuration?.properties;
if (!properties) {
  console.error('Bloco contributes.configuration.properties não encontrado.');
  process.exit(1);
}

properties['offgrid.maxAgentSteps'] = {
  type: 'number',
  default: 10,
  minimum: 1,
  maximum: 30,
  description: 'Número máximo de etapas de ferramentas executadas por uma tarefa do Agente.'
};
properties['offgrid.diagnosticsPanel'] = {
  type: 'string',
  enum: ['hidden', 'compact', 'expanded', 'onError'],
  enumDescriptions: [
    'Oculta o diagnóstico no chat.',
    'Exibe uma linha resumida.',
    'Exibe todos os dados de modelo, motor, RAM e GPU.',
    'Exibe detalhes somente quando houver erro.'
  ],
  default: 'compact',
  description: 'Controla a visibilidade do diagnóstico no painel do chat.'
};
properties['offgrid.logLevel'] = {
  type: 'string',
  enum: ['trace', 'debug', 'info', 'warn', 'error'],
  default: 'debug',
  description: 'Nível mínimo gravado no Output e nos arquivos de log. A versão 1.5 usa debug por padrão para facilitar diagnóstico.'
};
properties['offgrid.diagnosticMode'] = {
  type: 'boolean',
  default: false,
  description: 'Ativa logs trace, stack traces, prévias de prompts e resultados de ferramentas. Pode registrar caminhos e trechos de código; use somente durante depuração.'
};

pkg.publisher = preservedPublisher;
pkg.repository = preservedRepository;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = '1.5.0';
  if (lock.packages?.['']) lock.packages[''].version = '1.5.0';
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

console.log('Offgrid atualizado para 1.5.0.');
console.log('Incluído: loop real de ferramentas, prioridade de arquivos citados, unload verificável, estados consistentes, interface responsiva, modos Planejar/Somente leitura e logs em arquivo.');
console.log('Windows: diagnóstico avançado de RAM/VRAM e perfis adaptativos. Linux/macOS continuam funcionando com diagnóstico reduzido.');
console.log('Publisher e repository foram preservados.');
console.log('Agora execute: npm run check; npm test; npm run package');
