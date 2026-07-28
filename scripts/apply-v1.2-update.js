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
  'src/extension.js',
  'src/llama-engine.js',
  'src/chat-view.js',
  'src/workspace-agent.js',
  'src/change-preview.js',
  'resources/agent-system-prompt.md'
];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`Arquivo da atualização não encontrado: ${file}`);
    process.exit(1);
  }
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = '1.2.0';
pkg.scripts ||= {};
pkg.scripts.check = [
  'src/extension.js',
  'src/llama-engine.js',
  'src/model-installer.js',
  'src/chat-view.js',
  'src/workspace-agent.js',
  'src/agent-safety.js',
  'src/change-preview.js'
].map(file => `node --check ${file}`).join(' && ');

pkg.contributes ||= {};
pkg.contributes.commands ||= [];
const commands = [
  {
    command: 'offgrid.undoLastAgentChanges',
    title: 'Offgrid: Desfazer Últimas Alterações do Agente',
    icon: '$(discard)'
  },
  {
    command: 'offgrid.reloadModel',
    title: 'Offgrid: Recarregar Modelo',
    icon: '$(refresh)'
  },
  {
    command: 'offgrid.pinActiveFile',
    title: 'Offgrid: Fixar Arquivo Ativo no Chat',
    icon: '$(pin)'
  },
  {
    command: 'offgrid.unpinFile',
    title: 'Offgrid: Voltar a Acompanhar a Aba Ativa',
    icon: '$(pinned-dirty)'
  }
];
for (const command of commands) {
  const index = pkg.contributes.commands.findIndex(item => item.command === command.command);
  if (index >= 0) pkg.contributes.commands[index] = command;
  else pkg.contributes.commands.push(command);
}

pkg.contributes.configuration ||= { title: 'Offgrid', properties: {} };
pkg.contributes.configuration.properties ||= {};
const properties = pkg.contributes.configuration.properties;
properties['offgrid.agentMaxTokens'] ||= {
  type: 'number',
  default: 4096,
  minimum: 512,
  maximum: 16384,
  description: 'Máximo de tokens usado pelo modo Agente para planejar, chamar ferramentas e resumir alterações.'
};
properties['offgrid.agentRequireConfirmation'] ||= {
  type: 'boolean',
  default: true,
  description: 'Solicita confirmação antes de permitir que o modo Agente leia o workspace.'
};
properties['offgrid.agentRequireReview'] = {
  type: 'boolean',
  default: true,
  description: 'Exibe os arquivos alterados e exige aceitar ou rejeitar a proposta antes de salvar.'
};
if (properties['offgrid.contextSize']) properties['offgrid.contextSize'].default = 4096;

fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('Offgrid atualizado para 1.2.0.');
console.log('Incluído: carregamento resiliente, logs, arquivo fixado e revisão visual de diffs.');
console.log('Publisher e repository foram preservados.');
console.log('Agora execute: npm run check; npm test; npm run package');
