'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = [
  'package.json','tsconfig.json','.vscode/launch.json','.vscode/tasks.json','.vscodeignore','.editorconfig',
  'models/manifest.json','resources/icons/offgrid.svg','resources/windows/gpu-memory.ps1','resources/webview/main.css',
  'resources/system-prompt.md','resources/agent-system-prompt.md',
  'src/extension.ts','src/types/contracts.ts','src/engine/EngineClient.ts','src/engine/EngineWorker.ts',
  'src/llm/LlamaEngine.ts','src/agent/AgentLoop.ts','src/agent/ToolCallParser.ts','src/tools/WorkspaceTools.ts',
  'src/ui/ChatViewProvider.ts','src/ui/webview/main.ts','tests/core.test.cjs'
];
const missing = required.filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error('Atualização interrompida. Arquivos ausentes:');
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

removeLegacyJavaScript(path.join(root, 'src'));
for (const file of safeList(path.join(root, 'tests'))) {
  if (file.endsWith('.test.js')) fs.rmSync(path.join(root, 'tests', file), { force: true });
}
fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'package-lock.json'), { force: true });

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.name !== 'offgrid' || pkg.version !== '2.0.0' || pkg.main !== './out/extension.js') {
  throw new Error('package.json não corresponde à base TypeScript Offgrid 2.0.0.');
}

console.log(`Arquivos obrigatórios verificados: ${required.length}/${required.length}.`);
console.log('Offgrid preparado para a base TypeScript 2.0.0.');
console.log('Arquivos JavaScript legados em src/ foram removidos.');
console.log('Os modelos baixados no globalStorage não foram alterados.');
console.log('Agora execute: npm install; npm run check; npm test; npm run package');

function removeLegacyJavaScript(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) removeLegacyJavaScript(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.js.map')) fs.rmSync(full, { force: true });
  }
}
function safeList(directory) { return fs.existsSync(directory) ? fs.readdirSync(directory) : []; }
