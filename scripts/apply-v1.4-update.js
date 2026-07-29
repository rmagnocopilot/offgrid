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

pkg.version = '1.4.0';
pkg.description = 'Assistente de programação local para VS Code, otimizado para Windows, com motor isolado, perfis de RAM/VRAM, sessões e modo Agente revisável.';
pkg.scripts ||= {};
pkg.scripts.check = 'node --check src/extension.js && node --check src/llama-engine.js && node --check src/engine-client.js && node --check src/engine-worker.js && node --check src/resource-monitor.js && node --check src/hardware-profile.js && node --check src/model-installer.js && node --check src/chat-view.js && node --check src/workspace-agent.js && node --check src/agent-safety.js && node --check src/change-preview.js && node --check src/session-store.js';

pkg.contributes ||= {};
pkg.contributes.commands ||= [];
const commands = [
  ['offgrid.restartEngine', 'Offgrid: Reiniciar Processo do Motor', '$(server-process)'],
  ['offgrid.showResourceDiagnostics', 'Offgrid: Mostrar RAM e VRAM', '$(dashboard)'],
  ['offgrid.clearHardwareProfile', 'Offgrid: Limpar Perfil Automático de Hardware', '$(trash)']
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
properties['offgrid.resourceMonitoring'] = {
  type: 'boolean',
  default: true,
  description: 'Monitora RAM e, no Windows, VRAM/orçamento de GPU. Em Linux/macOS a extensão continua funcionando com diagnóstico reduzido.'
};
properties['offgrid.adaptiveGpu'] = {
  type: 'boolean',
  default: true,
  description: 'No Windows, escolhe backend e quantidade de GPU Layers com base na memória disponível e reaproveita o último perfil bem-sucedido.'
};
properties['offgrid.resourceRefreshSeconds'] = {
  type: 'number',
  default: 15,
  minimum: 5,
  maximum: 120,
  description: 'Intervalo de atualização do painel de RAM/VRAM, em segundos.'
};

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Offgrid atualizado para 1.4.0.');
console.log('Incluído: motor isolado, RAM do processo, diagnóstico de VRAM no Windows, perfis adaptativos e GPU Layers progressivas.');
console.log('Linux/macOS continuam funcionando; apenas a VRAM avançada e o autoajuste Windows ficam indisponíveis.');
console.log('Publisher e repository foram preservados.');
console.log('Agora execute: npm run check; npm test; npm run package');
