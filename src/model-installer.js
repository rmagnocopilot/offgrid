'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

class ModelInstaller {
  constructor({ modelsDir, baseUrl = '', resolveAssetUrl, headers = {}, onProgress = () => {} }) {
    this.modelsDir = modelsDir;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.resolveAssetUrl = resolveAssetUrl || (part => `${this.baseUrl}/${encodeURIComponent(part)}`);
    this.headers = headers;
    this.onProgress = onProgress;
    this.abortController = null;
  }

  cancel() {
    this.abortController?.abort();
  }

  modelPath(model) {
    return path.join(this.modelsDir, model.fileName);
  }

  async isInstalled(model) {
    try {
      await fsp.access(this.modelPath(model), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async install(model) {
    await fsp.mkdir(this.modelsDir, { recursive: true });
    const chunksDir = path.join(this.modelsDir, '.downloads', model.id);
    await fsp.mkdir(chunksDir, { recursive: true });

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      for (let index = 0; index < model.parts.length; index += 1) {
        const part = model.parts[index];
        const partPath = path.join(chunksDir, part);
        await this.#downloadPart(model, part, partPath, index, signal);
      }

      const destination = this.modelPath(model);
      const temporary = `${destination}.assembling`;
      await fsp.rm(temporary, { force: true });

      const output = fs.createWriteStream(temporary, { flags: 'w' });
      try {
        for (let index = 0; index < model.parts.length; index += 1) {
          if (signal.aborted) throw abortError();
          const partPath = path.join(chunksDir, model.parts[index]);
          this.onProgress({ stage: 'assemble', model, partIndex: index, partCount: model.parts.length });
          await appendFileToStream(partPath, output);
        }
      } finally {
        output.end();
        await waitForFinish(output);
      }

      this.onProgress({ stage: 'verify', model });
      const digest = await sha256File(temporary);
      if (digest.toLowerCase() !== model.sha256.toLowerCase()) {
        await fsp.rm(temporary, { force: true });
        throw new Error(`SHA-256 inválido. Esperado ${model.sha256}, recebido ${digest}.`);
      }

      await fsp.rm(destination, { force: true });
      await fsp.rename(temporary, destination);
      await fsp.rm(chunksDir, { recursive: true, force: true });
      this.onProgress({ stage: 'done', model, destination });
      return destination;
    } finally {
      this.abortController = null;
    }
  }

  async #downloadPart(model, part, destination, partIndex, signal) {
    const url = this.resolveAssetUrl(part);
    const temporary = `${destination}.tmp`;
    await fsp.rm(temporary, { force: true });

    this.onProgress({ stage: 'download-start', model, part, partIndex, partCount: model.parts.length, url });
    const response = await fetch(url, { redirect: 'follow', signal, headers: this.headers });
    if (!response.ok || !response.body) {
      throw new Error(`Falha ao baixar ${part}: HTTP ${response.status}. Confirme se o Release models-v1 foi publicado.`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    const body = Readable.fromWeb(response.body);
    body.on('data', chunk => {
      received += chunk.length;
      this.onProgress({
        stage: 'download-progress',
        model,
        part,
        partIndex,
        partCount: model.parts.length,
        received,
        total
      });
    });

    try {
      await pipeline(body, fs.createWriteStream(temporary));
      await fsp.rename(temporary, destination);
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    }
  }
}

async function appendFileToStream(filePath, output) {
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.once('error', reject);
    input.once('end', resolve);
    input.pipe(output, { end: false });
  });
}

function waitForFinish(stream) {
  if (stream.closed || stream.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once('finish', resolve);
    stream.once('error', reject);
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function abortError() {
  const error = new Error('Download cancelado.');
  error.name = 'AbortError';
  return error;
}

module.exports = { ModelInstaller, sha256File };
