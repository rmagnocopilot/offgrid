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
/** Nome do arquivo do binário no release (o que é baixado). */
export function llamaServerPackageName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32' && arch === 'x64') return 'llama-server-win-x64.zip';
  if (platform === 'linux' && arch === 'x64') return 'llama-server-linux-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'llama-server-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'llama-server-darwin-x64';

  throw new Error(
    `Plataforma não suportada pelo llama-server: ${platform}/${arch}. ` +
    'Suporte disponível: Windows x64, Linux x64, macOS (x64 e Apple Silicon).'
  );
}

/** Caminho do executável llama-server após instalação. */
export function llamaServerExecutablePath(binariesDir: string): string {
  const platform = process.platform;
  const arch = process.arch;
  const path = require('node:path');

  if (platform === 'win32' && arch === 'x64') {
    // Windows: extraído em subpasta, exe dentro dela
    return path.join(binariesDir, 'llama-server-win-x64', 'llama-server.exe');
  }
  if (platform === 'linux' && arch === 'x64') return path.join(binariesDir, 'llama-server-linux-x64');
  if (platform === 'darwin' && arch === 'arm64') return path.join(binariesDir, 'llama-server-darwin-arm64');
  if (platform === 'darwin' && arch === 'x64') return path.join(binariesDir, 'llama-server-darwin-x64');

  throw new Error(`Plataforma não suportada: ${platform}/${arch}`);
}

/** @deprecated use llamaServerPackageName */
export function llamaServerBinaryName(): string { return llamaServerPackageName(); }

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

    const packageFile = llamaServerPackageName();
    const binaryDef = this.catalog.getBinary(packageFile);
    const executablePath = llamaServerExecutablePath(this.binariesDirectory);

    // Já instalado e íntegro?
    if (fs.existsSync(executablePath)) {
      onProgress({ message: 'llama-server já instalado.' });
      return executablePath;
    }

    // Baixar o pacote
    const baseUrl = this.catalog.releaseBaseUrl(repositoryUrl);
    const url = `${baseUrl}/${encodeURIComponent(packageFile)}`;
    const partial = path.join(this.binariesDirectory, `${packageFile}.partial`);

    onProgress({ message: `Baixando ${packageFile}...` });

    try {
      await download(url, partial, (percent) => {
        onProgress({ message: `Baixando llama-server: ${percent}%`, increment: percent });
      });

      // Valida SHA-256
      onProgress({ message: 'Validando llama-server...' });
      const hash = await sha256(partial);
      if (hash.toLowerCase() !== binaryDef.sha256.toLowerCase()) {
        throw new Error(
          `SHA-256 inválido para ${packageFile}. Esperado: ${binaryDef.sha256}; recebido: ${hash}`
        );
      }

      // Instala: extrai zip (Windows) ou move binário diretamente (Unix)
      if (packageFile.endsWith('.zip')) {
        onProgress({ message: 'Extraindo llama-server...' });
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const extractDir = path.join(this.binariesDirectory, path.basename(packageFile, '.zip'));
        await fsp.mkdir(extractDir, { recursive: true });
        // Renomeia .partial → .zip antes de extrair (Expand-Archive exige extensão .zip)
        const partialAsZip = partial.replace(/\.partial$/, '');
        await fsp.rename(partial, partialAsZip);
        try {
          await execFileAsync('powershell.exe', [
            '-NoProfile', '-Command',
            `Expand-Archive -Path "${partialAsZip}" -DestinationPath "${extractDir}" -Force`
          ]);
        } finally {
          await fsp.rm(partialAsZip, { force: true }).catch(() => undefined);
        }
      } else {
        const target = executablePath;
        await fsp.rm(target, { force: true });
        await fsp.rename(partial, target);
        await fsp.chmod(target, 0o755);
      }

      onProgress({ message: 'llama-server instalado com sucesso.' });
      return executablePath;
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