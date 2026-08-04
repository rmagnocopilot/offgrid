const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  loadProjectInstructions,
  parseOffgridRules,
  validateProjectContent,
  validateContentAgainstProjectInstructions
} = require('../out/context/ProjectInstructions');

test('carrega AGENTS.md da raiz e do escopo mais próximo', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-agents-'));
  await fsp.mkdir(path.join(root, 'frontend', 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, 'AGENTS.md'), '# Raiz\n- Preserve arquitetura.', 'utf8');
  await fsp.writeFile(path.join(root, 'frontend', 'AGENTS.md'), '# Frontend\n- Não use any.', 'utf8');
  const result = await loadProjectInstructions({ workspaceRoot: root, targetFiles: ['frontend/src/app.ts'] });
  assert.deepEqual(result.files.map(file => file.filePath), ['AGENTS.md', 'frontend/AGENTS.md']);
  assert.ok(result.text.indexOf('# Raiz') < result.text.indexOf('# Frontend'));
  assert.match(result.text, /prioridade="obrigatoria"/);
});

test('não carrega instruções irmãs nem caminhos fora do workspace', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-agents-safe-'));
  await fsp.mkdir(path.join(root, 'frontend'), { recursive: true });
  await fsp.mkdir(path.join(root, 'backend'), { recursive: true });
  await fsp.writeFile(path.join(root, 'AGENTS.md'), 'raiz', 'utf8');
  await fsp.writeFile(path.join(root, 'frontend', 'AGENTS.md'), 'frontend', 'utf8');
  await fsp.writeFile(path.join(root, 'backend', 'AGENTS.md'), 'backend', 'utf8');
  const result = await loadProjectInstructions({ workspaceRoot: root, targetFiles: ['frontend/app.ts', '../fora.ts'] });
  assert.deepEqual(result.files.map(file => file.filePath), ['AGENTS.md', 'frontend/AGENTS.md']);
});

test('regras estruturadas do escopo específico substituem as da raiz', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-agents-rules-'));
  await fsp.mkdir(path.join(root, 'backend'), { recursive: true });
  await fsp.writeFile(path.join(root, 'AGENTS.md'), '```offgrid\nmaxCyclomaticComplexity: 13\nmaxMethodLines: 40\n```', 'utf8');
  await fsp.writeFile(path.join(root, 'backend', 'AGENTS.md'), '```offgrid\nmaxMethodLines: 25\nallowPlaceholders: false\n```', 'utf8');
  const instructions = await loadProjectInstructions({ workspaceRoot: root, targetFiles: ['backend/App.java'] });
  assert.deepEqual(parseOffgridRules(instructions.files), {
    maxCyclomaticComplexity: 13,
    maxMethodLines: 25,
    allowPlaceholders: false
  });
});

test('bloqueia complexidade, strings repetidas e placeholders configurados', () => {
  const code = [
    'export function processar(valor: number) {',
    '  // TODO remover',
    '  if (valor > 0) console.log("Mensagem repetida");',
    '  if (valor > 1) console.log("Mensagem repetida");',
    '  if (valor > 2) console.log("Mensagem repetida");',
    '  return valor;',
    '}'
  ].join('\n');
  const violations = validateProjectContent('src/a.ts', code, {
    maxCyclomaticComplexity: 3,
    extractStringAfterOccurrences: 2,
    allowPlaceholders: false
  });
  assert.ok(violations.some(item => item.rule === 'maxCyclomaticComplexity'));
  assert.ok(violations.some(item => item.rule === 'extractStringAfterOccurrences'));
  assert.ok(violations.some(item => item.rule === 'allowPlaceholders'));
});

test('validação integrada usa o AGENTS.md aplicável ao arquivo', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-agents-integrated-'));
  await fsp.writeFile(path.join(root, 'AGENTS.md'), '```offgrid\nextractStringAfterOccurrences: 2\n```', 'utf8');
  const result = await validateContentAgainstProjectInstructions({
    workspaceRoot: root,
    filePath: 'src/a.ts',
    content: 'console.log("duplicada");\nconsole.log("duplicada");\nconsole.log("duplicada");'
  });
  assert.equal(result.instructions.files.length, 1);
  assert.equal(result.violations.length, 1);
});

test('integra instruções no Chat, no Agente e na preparação de alterações', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const tools = await fsp.readFile(path.join(__dirname, '..', 'src', 'tools', 'WorkspaceTools.ts'), 'utf8');
  assert.match(extension, /loadProjectInstructions/);
  assert.match(extension, /OFFGRID_AGENTS_MD_CHAT/);
  assert.match(extension, /OFFGRID_AGENTS_MD_AGENT/);
  assert.match(tools, /validateContentAgainstProjectInstructions/);
  assert.match(tools, /OFFGRID_AGENTS_MD_VALIDATION/);
});


test('detecta strings repetidas dentro de envelope JSON serializado', () => {
  const serialized = JSON.stringify({
    name: 'agents-md-check',
    functions: [{
      name: 'processar',
      body: [
        'if (true) return "PROCESSANDO";',
        'if (false) return "PROCESSANDO";',
        'if (null) return "PROCESSANDO";'
      ].join('\n')
    }]
  });

  const violations = validateProjectContent(
    'agents-md-check.ts',
    serialized,
    { extractStringAfterOccurrences: 2 }
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'extractStringAfterOccurrences');
  assert.match(violations[0].message, /PROCESSANDO/);
});

test('WorkspaceTools bloqueia JSON serializado usado como código-fonte', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'tools', 'WorkspaceTools.ts'),
    'utf8'
  );

  assert.match(source, /serializedCodeEnvelopeIssue\(relative, content\)/);
  assert.match(source, /serializado como JSON em vez de código-fonte/);
});
