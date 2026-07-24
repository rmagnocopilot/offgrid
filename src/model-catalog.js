'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadCatalog(extensionPath) {
  const manifestPath = path.join(extensionPath, 'models', 'manifest.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.models) || !parsed.releaseTag) {
    throw new Error('Manifesto de modelos inválido.');
  }
  return parsed;
}

function repositoryReleaseBase(packageJson, releaseTag) {
  const raw = typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository?.url;

  if (!raw) {
    throw new Error('O campo repository do package.json não está configurado.');
  }

  const normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  if (!normalized.startsWith('https://github.com/')) {
    throw new Error('O repositório deve apontar para github.com.');
  }

  if (normalized.includes('/SEU_USUARIO/')) {
    throw new Error('Execute npm run configure -- SEU_USUARIO NOME_DO_REPOSITORIO antes de empacotar a extensão.');
  }

  return `${normalized}/releases/download/${encodeURIComponent(releaseTag)}`;
}

function repositoryCoordinates(packageJson) {
  const raw = typeof packageJson.repository === 'string'
    ? packageJson.repository
    : packageJson.repository?.url;
  const normalized = String(raw || '')
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!match || match[1] === 'SEU_USUARIO') {
    throw new Error('Repositório GitHub inválido ou ainda não configurado.');
  }
  return { owner: match[1], repository: match[2] };
}

module.exports = { loadCatalog, repositoryReleaseBase, repositoryCoordinates };
