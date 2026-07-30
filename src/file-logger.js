'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 });
const CATEGORIES = new Set(['offgrid', 'agent', 'model', 'diagnostics']);

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function safeText(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function categoryFilePattern(category) {
  return new RegExp(`^${category}-\\d{4}-\\d{2}-\\d{2}(?:\\.\\d+)?\\.log$`);
}

class FileLogger {
  constructor({ storagePath, outputChannel, level = 'debug', diagnosticMode = false, maxBytes = 10 * 1024 * 1024, maxFiles = 10 } = {}) {
    this.storagePath = storagePath || process.cwd();
    this.logsPath = path.join(this.storagePath, 'logs');
    this.outputChannel = outputChannel;
    this.level = LEVELS[level] ? level : 'debug';
    this.diagnosticMode = Boolean(diagnosticMode);
    this.maxBytes = Math.max(1024, Number(maxBytes) || 10 * 1024 * 1024);
    this.maxFiles = Math.max(1, Number(maxFiles) || 10);
    this.recent = [];
    fs.mkdirSync(this.logsPath, { recursive: true });
  }

  configure({ level, diagnosticMode } = {}) {
    if (level && LEVELS[level]) this.level = level;
    if (diagnosticMode !== undefined) this.diagnosticMode = Boolean(diagnosticMode);
  }

  enabled(level) {
    const threshold = this.diagnosticMode ? LEVELS.trace : LEVELS[this.level];
    return LEVELS[level] >= threshold;
  }

  log(category, level, message) {
    const normalizedCategory = CATEGORIES.has(category) ? category : 'offgrid';
    const normalizedLevel = LEVELS[level] ? level : 'info';
    if (!this.enabled(normalizedLevel)) return;

    const line = `[${new Date().toISOString()}] [${normalizedLevel.toUpperCase()}] [${normalizedCategory}] ${safeText(message)}`;
    this.outputChannel?.appendLine(line);
    this.recent.push(line);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);

    try {
      const filePath = this.#activeFilePath(normalizedCategory, Buffer.byteLength(line, 'utf8') + 1);
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
      this.#trimCategory(normalizedCategory);
    } catch (error) {
      this.outputChannel?.appendLine(`[${new Date().toISOString()}] [WARN] [offgrid] Falha ao gravar log em arquivo: ${error?.message || error}`);
    }
  }

  trace(category, message) { this.log(category, 'trace', message); }
  debug(category, message) { this.log(category, 'debug', message); }
  info(category, message) { this.log(category, 'info', message); }
  warn(category, message) { this.log(category, 'warn', message); }
  error(category, message) { this.log(category, 'error', message); }

  lastLines(limit = 100) {
    return this.recent.slice(-Math.max(1, Number(limit) || 100));
  }

  #baseFilePath(category) {
    return path.join(this.logsPath, `${category}-${dateKey()}.log`);
  }

  #activeFilePath(category, incomingBytes) {
    const base = this.#baseFilePath(category);
    if (this.#size(base) + incomingBytes <= this.maxBytes) return base;

    for (let index = 1; index < 1000; index += 1) {
      const candidate = path.join(this.logsPath, `${category}-${dateKey()}.${index}.log`);
      if (this.#size(candidate) + incomingBytes <= this.maxBytes) return candidate;
    }
    throw new Error(`Não foi possível selecionar arquivo de rotação para ${category}.`);
  }

  #size(filePath) {
    try { return fs.statSync(filePath).size; } catch { return 0; }
  }

  #trimCategory(category) {
    const pattern = categoryFilePattern(category);
    const files = fs.readdirSync(this.logsPath)
      .filter(name => pattern.test(name))
      .map(name => {
        const filePath = path.join(this.logsPath, name);
        const stat = fs.statSync(filePath);
        return { name, path: filePath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const stale of files.slice(this.maxFiles)) fs.rmSync(stale.path, { force: true });
  }
}

module.exports = { FileLogger, LEVELS, dateKey, categoryFilePattern };
