'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');

if (!fs.existsSync(packagePath)) {
  console.error('package.json não encontrado. Execute este script dentro do repositório Offgrid.');
  process.exit(1);
}

const requiredFiles = [
  'src/workspace-agent.js',
  'src/agent-safety.js',
  'resources/agent-system-prompt.md'
];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`Arquivo da atualização não encontrado: ${file}`);
    process.exit(1);
  }
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = '1.1.0';
pkg.scripts ||= {};
pkg.scripts.check = [
  'src/extension.js',
  'src/llama-engine.js',
  'src/model-installer.js',
  'src/chat-view.js',
  'src/workspace-agent.js',
  'src/agent-safety.js'
].map(file => `node --check ${file}`).join(' && ');

pkg.contributes ||= {};
pkg.contributes.commands ||= [];
if (!pkg.contributes.commands.some(command => command.command === 'offgrid.undoLastAgentChanges')) {
  pkg.contributes.commands.push({
    command: 'offgrid.undoLastAgentChanges',
    title: 'Offgrid: Desfazer Últimas Alterações do Agente',
    icon: '$(discard)'
  });
}

pkg.contributes.configuration ||= { title: 'Offgrid', properties: {} };
pkg.contributes.configuration.properties ||= {};
pkg.contributes.configuration.properties['offgrid.agentMaxTokens'] = {
  type: 'number',
  default: 4096,
  minimum: 512,
  maximum: 16384,
  description: 'Máximo de tokens usado pelo modo Agente para planejar, chamar ferramentas e resumir alterações.'
};
pkg.contributes.configuration.properties['offgrid.agentRequireConfirmation'] = {
  type: 'boolean',
  default: true,
  description: 'Solicita confirmação antes de permitir que o modo Agente leia e altere o workspace.'
};

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Offgrid atualizado para 1.1.0 com modo Agente.');
console.log('As configurações de publisher e repository foram preservadas.');
console.log('Agora execute: npm run check; npm test; npm run package');
