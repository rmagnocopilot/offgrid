import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelDefinition, ModelStatus } from '../types/contracts';

interface Manifest { schemaVersion: number; releaseTag: string; models: ModelDefinition[] }

export class ModelCatalog {
  readonly manifest: Manifest;
  constructor(private readonly extensionPath: string, private readonly modelsDirectory: string) {
    this.manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'models', 'manifest.json'), 'utf8')) as Manifest;
  }
  list(activePath = '', loadedPath = '', errors: Record<string, string> = {}): ModelStatus[] {
    return this.manifest.models.map(model => {
      const filePath = path.join(this.modelsDirectory, model.fileName);
      const exists = fs.existsSync(filePath);
      const fileSize = exists ? fs.statSync(filePath).size : 0;
      const sameActive = activePath && path.resolve(activePath) === path.resolve(filePath);
      const sameLoaded = loadedPath && path.resolve(loadedPath) === path.resolve(filePath);
      return {
        ...model, filePath, fileSize,
        state: errors[model.id] ? 'error' : sameLoaded ? 'loaded' : sameActive ? 'active' : exists ? 'installed' : 'notInstalled',
        lastError: errors[model.id]
      };
    });
  }
  get(id: string): ModelDefinition {
    const model = this.manifest.models.find(item => item.id === id);
    if (!model) throw new Error(`Modelo desconhecido: ${id}`);
    return model;
  }
  releaseBaseUrl(repositoryUrl: string): string {
    const match = repositoryUrl.replace(/\.git$/, '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
    if (!match) throw new Error('repository do package.json precisa apontar para um repositório GitHub válido.');
    return `https://github.com/${match[1]}/${match[2]}/releases/download/${this.manifest.releaseTag}`;
  }
}
