/**
 * LlamaServerManager
 *
 * Localiza o binário llama-server na pasta de dados da extensão.
 * O binário é distribuído junto com os modelos via release do GitHub
 * e baixado pelo mesmo mecanismo (ModelInstaller-like).
 *
 * Estrutura esperada no release:
 *   llama-server-win-x64.exe   (Windows x64)
 *   llama-server-linux-x64     (Linux x64)
 *   llama-server-darwin-arm64  (macOS Apple Silicon)
 *   llama-server-darwin-x64    (macOS Intel)
 *
 * SHA-256 definido no manifest em binaries[].sha256.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { ModelCatalog } from '../models/ModelCatalog';

export interface BinaryProgress { message: string; increment?: number }

/** Retorna o nome do arquivo do binário para a plataforma atual. */
export function llamaServerBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32' && arch === 'x64') return 'llama-server-win-x64.exe';
  if (platform === 'linux' && arch === 'x64') return 'llama-server-linux-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'llama-server-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'llama-server-darwin-x64';

  throw new Error(
    `Plataforma não suportada pelo llama-server: ${platform}/${arch}. ` +
    'Suporte disponível: Windows x64, Linux x64, macOS (x64 e Apple Silicon).'
  );
}

export class LlamaServerManager {
  private readonly binariesDirectory: string;

  constructor(
    private readonly extensionPath: string,
    private readonly storagePath: string,
    private readonly catalog: ModelCatalog
  ) {
    this.binariesDirectory = path.join(storagePath, 'binaries');
  }

  /** Caminho completo do binário para a plataforma atual. */
  get binaryPath(): string {
    return path.join(this.binariesDirectory, llamaServerBinaryName());
  }

  /** Retorna true se o binário já está presente em disco. */
  isInstalled(): boolean {
    return fs.existsSync(this.binaryPath);
  }

  /**
   * Garante que o binário está instalado e é executável.
   * Se não estiver, baixa do release do GitHub.
   */
  async ensureInstalled(
    repositoryUrl: string,
    onProgress: (progress: BinaryProgress) => void = () => undefined
  ): Promise<string> {
    await fsp.mkdir(this.binariesDirectory, { recursive: true });

    const binaryFile = llamaServerBinaryName();
    const binaryDef = this.catalog.getBinary(binaryFile);
    const target = this.binaryPath;

    // Já instalado e íntegro?
    if (fs.existsSync(target)) {
      const hash = await sha256(target);
      if (hash.toLowerCase() === binaryDef.sha256.toLowerCase()) {
        onProgress({ message: 'llama-server já instalado.' });
        return target;
      }
      onProgress({ message: 'SHA-256 do binário diverge; baixando novamente...' });
    }

    // Baixar
    const baseUrl = this.catalog.releaseBaseUrl(repositoryUrl);
    const url = `${baseUrl}/${encodeURIComponent(binaryFile)}`;
    const partial = `${target}.partial`;

    onProgress({ message: `Baixando ${binaryFile}...` });

    try {
      await download(url, partial, (percent) => {
        onProgress({ message: `Baixando llama-server: ${percent}%`, increment: percent });
      });

      // Valida SHA-256
      onProgress({ message: 'Validando llama-server...' });
      const hash = await sha256(partial);
      if (hash.toLowerCase() !== binaryDef.sha256.toLowerCase()) {
        throw new Error(
          `SHA-256 inválido para ${binaryFile}. Esperado: ${binaryDef.sha256}; recebido: ${hash}`
        );
      }

      await fsp.rm(target, { force: true });
      await fsp.rename(partial, target);

      // Tornar executável em sistemas Unix
      if (process.platform !== 'win32') {
        await fsp.chmod(target, 0o755);
      }

      onProgress({ message: 'llama-server instalado com sucesso.' });
      return target;
    } catch (error) {
      await fsp.rm(partial, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

// ─── Utilitários de download e hash ──────────────────────────────────────────

async function download(
  url: string,
  destination: string,
  onPercent: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https:') ? https : http;
    proto.get(url, { timeout: 30_000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) { reject(new Error(`Redirecionamento sem Location: ${url}`)); return; }
        download(location, destination, onPercent).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ao baixar ${url}`));
        return;
      }

      const total = parseInt(res.headers['content-length'] ?? '0', 10);
      let received = 0;

      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (total > 0) onPercent(Math.round((received / total) * 100));
      });

      const out = fs.createWriteStream(destination);
      pipeline(res as unknown as NodeJS.ReadableStream, out)
        .then(resolve)
        .catch(reject);
    }).on('error', reject);
  });
}

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}
