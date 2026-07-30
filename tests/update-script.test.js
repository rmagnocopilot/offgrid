'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const requiredUpdateFiles = [
  '.editorconfig', '.vscodeignore', 'README.md', 'models/manifest.json',
  'resources/agent-system-prompt.md', 'resources/system-prompt.md',
  'resources/icons/offgrid.svg', 'resources/windows/gpu-memory.ps1',
  'src/agent-context.js', 'src/agent-safety.js', 'src/agent-tool-loop.js',
  'src/change-preview.js', 'src/chat-view.js', 'src/engine-client.js',
  'src/engine-worker.js', 'src/extension.js', 'src/file-logger.js',
  'src/hardware-profile.js', 'src/llama-engine.js', 'src/model-catalog.js',
  'src/model-installer.js', 'src/resource-monitor.js', 'src/session-store.js',
  'src/workspace-agent.js', 'tests/agent-context.test.js',
  'tests/agent-safety.test.js', 'tests/agent-tool-loop.test.js',
  'tests/change-review.test.js', 'tests/charset-ui.test.js',
  'tests/file-logger.test.js', 'tests/hardware-profile.test.js',
  'tests/llama-engine.test.js', 'tests/model-installer.test.js',
  'tests/session-store.test.js', 'tests/update-script.test.js'
];

function createRequiredUpdateFiles(root) {
  for (const relativePath of requiredUpdateFiles) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, 'arquivo de teste\n', 'utf8');
  }
}

test('atualizador 1.5 preserva publisher/repository e adiciona comandos/configurações', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-update-script-'));
  try {
    const packagePath = path.join(dir, 'package.json');
    fs.writeFileSync(packagePath, JSON.stringify({
      name: 'offgrid', version: '1.4.0', publisher: 'rmagnocopilot',
      repository: { type: 'git', url: 'https://github.com/rmagnocopilot/offgrid.git' },
      scripts: {},
      contributes: { commands: [], configuration: { properties: {} } }
    }), 'utf8');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'offgrid', version: '1.4.0', lockfileVersion: 3, packages: { '': { name: 'offgrid', version: '1.4.0' } } }), 'utf8');
    createRequiredUpdateFiles(dir);
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/apply-v1.5-update.js')], { cwd: dir });
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.equal(pkg.version, '1.5.0');
    assert.equal(pkg.publisher, 'rmagnocopilot');
    assert.equal(pkg.repository.url, 'https://github.com/rmagnocopilot/offgrid.git');
    assert.ok(pkg.contributes.commands.some(item => item.command === 'offgrid.copyDiagnostics'));
    assert.equal(pkg.contributes.configuration.properties['offgrid.maxAgentSteps'].default, 10);
    assert.equal(pkg.contributes.configuration.properties['offgrid.diagnosticsPanel'].default, 'compact');
    assert.equal(pkg.contributes.configuration.properties['offgrid.logLevel'].default, 'debug');
    assert.match(pkg.scripts.check, /agent-tool-loop\.js/);
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '1.5.0');
    assert.equal(lock.packages[''].version, '1.5.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('atualizador 1.5 interrompe quando o pacote foi copiado de forma incompleta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-update-incomplete-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'offgrid', version: '1.4.0', publisher: 'rmagnocopilot',
      repository: { type: 'git', url: 'https://github.com/rmagnocopilot/offgrid.git' },
      contributes: { commands: [], configuration: { properties: {} } }
    }), 'utf8');
    assert.throws(() => execFileSync(
      process.execPath,
      [path.resolve(__dirname, '../scripts/apply-v1.5-update.js')],
      { cwd: dir, stdio: 'pipe' }
    ), error => {
      const output = `${error.stdout || ''}${error.stderr || ''}`;
      return /copiada de forma incompleta/.test(output) && /src\agent-tool-loop\.js|src\/agent-tool-loop\.js/.test(output);
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.4.0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
