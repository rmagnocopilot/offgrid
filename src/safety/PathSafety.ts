import * as fs from 'node:fs';
import * as path from 'node:path';

const WRITE_PROTECTED_SEGMENTS = new Set(['node_modules', '.git']);

export function normalizeRelativePath(value: string): string {
  if (typeof value !== 'string') throw new Error('O caminho precisa ser uma string.');
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized) throw new Error('Caminho vazio.');
  if (normalized.includes('\0')) throw new Error('Caminho inválido.');
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error('Use um caminho relativo ao workspace.');
  }
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../')) throw new Error('O caminho não pode sair do workspace.');
  return clean;
}

export function isWriteProtectedPath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath)
    .toLowerCase()
    .split('/')
    .some(segment => WRITE_PROTECTED_SEGMENTS.has(segment));
}

export function resolveInsideRoot(rootPath: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const resolved = path.resolve(rootPath, ...normalized.split('/'));
  const relative = path.relative(path.resolve(rootPath), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('O caminho não pode sair do workspace.');
  }
  return resolved;
}

export function assertNoSymlinkEscape(rootPath: string, absolutePath: string): void {
  const rootReal = fs.realpathSync.native(path.resolve(rootPath));
  let existing = path.resolve(absolutePath);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error('Não foi possível validar o caminho.');
    existing = parent;
  }
  const existingReal = fs.realpathSync.native(existing);
  const relative = path.relative(rootReal, existingReal);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('O caminho usa um link simbólico que sai do workspace.');
  }
}
