import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import type { ModelDefinition } from '../types/contracts';

export interface InstallProgress { message: string; increment?: number }

export class ModelInstaller {
  constructor(private readonly modelsDirectory: string, private readonly releaseBaseUrl: string) {}

  async install(model: ModelDefinition, onProgress: (progress: InstallProgress) => void = () => undefined): Promise<string> {
    await fsp.mkdir(this.modelsDirectory, { recursive: true });
    const target = path.join(this.modelsDirectory, model.fileName);
    const tempDirectory = path.join(this.modelsDirectory, `.parts-${model.id}-${Date.now()}`);
    await fsp.mkdir(tempDirectory, { recursive: true });
    try {
      const parts: string[] = [];
      for (let index = 0; index < model.parts.length; index += 1) {
        const part = model.parts[index];
        if (!part) continue;
        const destination = path.join(tempDirectory, part);
        onProgress({ message: `Baixando parte ${index + 1}/${model.parts.length}: ${part}` });
        await download(`${this.releaseBaseUrl}/${encodeURIComponent(part)}`, destination, progress => onProgress({ message: `Baixando ${part}: ${progress}%` }));
        parts.push(destination);
      }
      const temporaryTarget = `${target}.partial`;
      await merge(parts, temporaryTarget);
      onProgress({ message: 'Validando SHA-256 do modelo...' });
      const hash = await sha256(temporaryTarget);
      if (hash.toLowerCase() !== model.sha256.toLowerCase()) {
        throw new Error(`SHA-256 inválido. Esperado ${model.sha256}; recebido ${hash}.`);
      }
      await fsp.rm(target, { force: true });
      await fsp.rename(temporaryTarget, target);
      onProgress({ message: 'Modelo instalado e validado.' });
      return target;
    } finally {
      await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async validate(model: ModelDefinition): Promise<{ valid: boolean; actual?: string; expected: string }> {
    const file = path.join(this.modelsDirectory, model.fileName);
    if (!fs.existsSync(file)) return { valid: false, expected: model.sha256 };
    const actual = await sha256(file);
    return { valid: actual.toLowerCase() === model.sha256.toLowerCase(), actual, expected: model.sha256 };
  }

  async remove(model: ModelDefinition): Promise<void> {
    await fsp.rm(path.join(this.modelsDirectory, model.fileName), { force: true });
  }
}

async function merge(parts: string[], destination: string): Promise<void> {
  const output = fs.createWriteStream(destination);
  for (const part of parts) {
    await new Promise<void>((resolve, reject) => {
      const input = fs.createReadStream(part);
      input.on('error', reject); output.on('error', reject);
      input.on('end', resolve); input.pipe(output, { end: false });
    });
  }
  await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => error ? reject(error) : resolve()));
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject); stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function download(url: string, destination: string, onProgress: (percent: number) => void, redirects = 0): Promise<void> {
  if (redirects > 8) throw new Error('Muitos redirecionamentos durante o download.');
  await new Promise<void>((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'Offgrid-VSCode' } }, response => {
      const status = response.statusCode ?? 0;
      if ([301,302,303,307,308].includes(status) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        download(next, destination, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`Falha no download: HTTP ${status}`)); return; }
      const total = Number(response.headers['content-length'] ?? 0);
      let received = 0;
      const output = fs.createWriteStream(destination);
      response.on('data', chunk => { received += Buffer.byteLength(chunk); if (total > 0) onProgress(Math.min(100, Math.round(received / total * 100))); });
      response.on('error', reject); output.on('error', reject); output.on('finish', () => output.close(() => resolve()));
      response.pipe(output);
    });
    request.on('error', reject); request.setTimeout(60_000, () => request.destroy(new Error('Tempo esgotado durante o download.')));
  });
}
