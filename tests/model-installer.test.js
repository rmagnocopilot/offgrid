'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ModelInstaller, sha256File } = require('../src/model-installer');
const { repositoryReleaseBase } = require('../src/model-catalog');

test('deriva a URL do release a partir do package.json', () => {
  const url = repositoryReleaseBase({
    repository: { url: 'https://github.com/exemplo/offgrid.git' }
  }, 'models-v1');
  assert.equal(url, 'https://github.com/exemplo/offgrid/releases/download/models-v1');
});

test('recusa o placeholder de repositório', () => {
  assert.throws(() => repositoryReleaseBase({
    repository: { url: 'https://github.com/SEU_USUARIO/offgrid.git' }
  }, 'models-v1'), /npm run configure/);
});

test('baixa partes, remonta e valida SHA-256', async t => {
  const first = Buffer.from('modelo-');
  const second = Buffer.from('de-teste');
  const complete = Buffer.concat([first, second]);
  const digest = crypto.createHash('sha256').update(complete).digest('hex');

  const server = http.createServer((request, response) => {
    if (request.url === '/release/test.gguf.part-00') response.end(first);
    else if (request.url === '/release/test.gguf.part-01') response.end(second);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-test-'));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const address = server.address();
  const installer = new ModelInstaller({
    modelsDir: temp,
    baseUrl: `http://127.0.0.1:${address.port}/release`
  });
  const model = {
    id: 'test',
    fileName: 'test.gguf',
    sha256: digest,
    parts: ['test.gguf.part-00', 'test.gguf.part-01']
  };

  const installed = await installer.install(model);
  assert.equal(fs.readFileSync(installed, 'utf8'), 'modelo-de-teste');
  assert.equal(await sha256File(installed), digest);
});
