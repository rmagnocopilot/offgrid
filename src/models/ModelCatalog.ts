import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelDefinition, ModelStatus } from '../types/contracts';

export interface BinaryDefinition {
  fileName: string;
  sha256: string;
  description: string;
}

interface Manifest {
  schemaVersion: number;
  releaseTag: string;
  models: ModelDefinition[];
  binaries: BinaryDefinition[];
}

export class ModelCatalog {
  readonly manifest: Manifest;

  constructor(private readonly extensionPath: string, private readonly modelsDirectory: string) {
    const manifestPath = path.join(extensionPath, 'models', 'manifest.json');
    this.manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown, manifestPath);
  }

  list(activePath = '', loadedPath = '', errors: Record<string, string> = {}): ModelStatus[] {
    return this.manifest.models.map(model => {
      const filePath = path.join(this.modelsDirectory, model.fileName);
      const fileSize = safeFileSize(filePath);
      const exists = fileSize > 0;
      const sameActive = Boolean(activePath) && samePath(activePath, filePath);
      const sameLoaded = Boolean(loadedPath) && samePath(loadedPath, filePath);
      return {
        ...model,
        filePath,
        fileSize,
        state: errors[model.id] ? 'error' : sameLoaded ? 'loaded' : sameActive && exists ? 'active' : exists ? 'installed' : 'notInstalled',
        lastError: errors[model.id] || undefined
      };
    });
  }

  get(id: string): ModelDefinition {
    const model = this.manifest.models.find(item => item.id === id);
    if (!model) throw new Error(`Modelo desconhecido: ${id}`);
    return model;
  }

  getBinary(fileName: string): BinaryDefinition {
    const binary = this.manifest.binaries?.find(b => b.fileName === fileName);
    if (!binary) throw new Error(`Binário desconhecido no manifesto: ${fileName}`);
    return binary;
  }

  releaseBaseUrl(repositoryUrl: string): string {
    const match = repositoryUrl.replace(/\.git$/, '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (!match) throw new Error('repository do package.json precisa apontar para um repositório GitHub válido.');
    return `https://github.com/${match[1]}/${match[2]}/releases/download/${this.manifest.releaseTag}`;
  }
}

function safeFileSize(file: string): number {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function validateManifest(value: unknown, manifestPath: string): Manifest {
  if (!value || typeof value !== 'object') throw new Error(`Manifesto de modelos inválido: ${manifestPath}`);
  const candidate = value as Partial<Manifest>;
  if (typeof candidate.schemaVersion !== 'number' || !Number.isInteger(candidate.schemaVersion) || !candidate.releaseTag || !Array.isArray(candidate.models)) {
    throw new Error(`Manifesto de modelos incompleto: ${manifestPath}`);
  }
  // binaries é opcional para retrocompatibilidade
  if (!Array.isArray(candidate.binaries)) candidate.binaries = [];
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const model of candidate.models) {
    if (!model?.id || !model.displayName || !model.fileName || !Array.isArray(model.parts) || !model.parts.length) {
      throw new Error(`Definição de modelo incompleta no manifesto: ${manifestPath}`);
    }
    if (path.basename(model.fileName) !== model.fileName) throw new Error(`Nome de arquivo de modelo inválido: ${model.fileName}`);
    if (!/^[a-f0-9]{64}$/i.test(model.sha256)) throw new Error(`SHA-256 inválido para ${model.id}.`);
    if (ids.has(model.id)) throw new Error(`ID de modelo duplicado: ${model.id}`);
    if (files.has(model.fileName.toLowerCase())) throw new Error(`Arquivo de modelo duplicado: ${model.fileName}`);
    ids.add(model.id);
    files.add(model.fileName.toLowerCase());
  }
  return candidate as Manifest;
}
