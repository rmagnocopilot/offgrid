import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ModelDefinition } from '../types/contracts';

export interface InstallProgress { message: string; increment?: number }

export class ModelInstaller {
  constructor(private readonly modelsDirectory: string, private readonly releaseBaseUrl: string) {}

  get baseUrl(): string { return this.releaseBaseUrl; }

  async install(model: ModelDefinition, onProgress: (progress: InstallProgress) => void = () => undefined): Promise<string> {
    if (!model.parts.length) throw new Error(`O modelo ${model.displayName} não possui partes configuradas no manifesto.`);
    await fsp.mkdir(this.modelsDirectory, { recursive: true });

    const target = path.join(this.modelsDirectory, model.fileName);
    const temporaryTarget = `${target}.partial`;
    const tempDirectory = path.join(this.modelsDirectory, `.parts-${model.id}-${Date.now()}`);
    await fsp.mkdir(tempDirectory, { recursive: true });
    await fsp.rm(temporaryTarget, { force: true }).catch(() => undefined);

    try {
      const parts: string[] = [];
      for (let index = 0; index < model.parts.length; index += 1) {
        const part = model.parts[index];
        if (!part) continue;
        if (path.basename(part) !== part) throw new Error(`Nome de parte inválido no manifesto: ${part}`);

        const destination = path.join(tempDirectory, part);
        const url = `${this.releaseBaseUrl}/${encodeURIComponent(part)}`;
        let lastPercent = 0;
        onProgress({ message: `Baixando parte ${index + 1}/${model.parts.length}: ${part}` });

        try {
          await download(url, destination, percent => {
            const delta = Math.max(0, percent - lastPercent) / model.parts.length;
            lastPercent = percent;
            onProgress({ message: `Baixando ${part}: ${percent}%`, increment: delta });
          });
        } catch (error) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(`Falha ao baixar ${part}: ${cause}`);
        }
        parts.push(destination);
      }

      if (parts.length !== model.parts.length) {
        throw new Error(`Foram baixadas ${parts.length} de ${model.parts.length} partes esperadas.`);
      }

      onProgress({ message: model.parts.length > 1 ? 'Montando as partes do modelo...' : 'Preparando o arquivo do modelo...' });
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
      await fsp.rm(temporaryTarget, { force: true }).catch(() => undefined);
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
    await fsp.rm(path.join(this.modelsDirectory, `${model.fileName}.partial`), { force: true }).catch(() => undefined);
  }
}

async function merge(parts: string[], destination: string): Promise<void> {
  const output = fs.createWriteStream(destination, { flags: 'w' });
  try {
    for (const part of parts) {
      await pipeWithoutClosing(fs.createReadStream(part), output);
    }
    await new Promise<void>((resolve, reject) => {
      output.once('error', reject);
      output.end(() => resolve());
    });
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function pipeWithoutClosing(input: fs.ReadStream, output: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      input.off('error', onError);
      output.off('error', onError);
      input.off('end', onEnd);
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onEnd = (): void => { cleanup(); resolve(); };
    input.once('error', onError);
    output.once('error', onError);
    input.once('end', onEnd);
    input.pipe(output, { end: false });
  });
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function download(url: string, destination: string, onProgress: (percent: number) => void, redirects = 0): Promise<void> {
  if (redirects > 8) throw new Error('Muitos redirecionamentos durante o download.');

  await new Promise<void>((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, {
      headers: {
        'User-Agent': 'Offgrid-VSCode',
        'Accept': 'application/octet-stream'
      }
    }, response => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        download(next, destination, onProgress, redirects + 1).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}`));
        return;
      }

      const total = Number(response.headers['content-length'] ?? 0);
      let received = 0;
      let lastReported = -1;
      const output = fs.createWriteStream(destination, { flags: 'w' });

      response.on('data', chunk => {
        received += Buffer.byteLength(chunk);
        if (total > 0) {
          const percent = Math.min(100, Math.floor(received / total * 100));
          if (percent !== lastReported) {
            lastReported = percent;
            onProgress(percent);
          }
        }
      });
      response.on('aborted', () => output.destroy(new Error('A conexão foi interrompida antes do fim do download.')));

      pipeline(response, output)
        .then(() => { onProgress(100); resolve(); })
        .catch(reject);
    });

    request.on('error', reject);
    request.setTimeout(60_000, () => request.destroy(new Error('Tempo esgotado durante o download.')));
  }).catch(async error => {
    await fsp.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  });
}
