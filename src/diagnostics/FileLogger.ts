import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LogLevel } from '../types/contracts';

const PRIORITY: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
export type LogCategory = 'offgrid' | 'agent' | 'model' | 'diagnostics';

export interface LoggerOptions {
  directory: string;
  level: LogLevel;
  maxBytes?: number;
  retainedFiles?: number;
  output?: (line: string) => void;
}

export class FileLogger {
  private readonly maxBytes: number;
  private readonly retainedFiles: number;
  private readonly recent: string[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: LoggerOptions) {
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.retainedFiles = options.retainedFiles ?? 10;
    fs.mkdirSync(options.directory, { recursive: true });
  }

  setLevel(level: LogLevel): void { this.options.level = level; }

  log(level: LogLevel, category: LogCategory, message: string, error?: unknown): void {
    if (PRIORITY[level] < PRIORITY[this.options.level]) return;
    const timestamp = new Date().toISOString();
    const details = error instanceof Error ? `\n${error.stack ?? error.message}` : error ? `\n${String(error)}` : '';
    const line = `[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}${details}`;
    this.recent.push(line);
    if (this.recent.length > 100) this.recent.splice(0, this.recent.length - 100);
    this.options.output?.(line);
    this.writeQueue = this.writeQueue.then(() => this.write(category, line)).catch(() => undefined);
  }

  trace(category: LogCategory, message: string): void { this.log('trace', category, message); }
  debug(category: LogCategory, message: string): void { this.log('debug', category, message); }
  info(category: LogCategory, message: string): void { this.log('info', category, message); }
  warn(category: LogCategory, message: string, error?: unknown): void { this.log('warn', category, message, error); }
  error(category: LogCategory, message: string, error?: unknown): void { this.log('error', category, message, error); }
  recentLines(): string[] { return [...this.recent]; }
  async flush(): Promise<void> { await this.writeQueue; }

  private filePath(category: LogCategory): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(this.options.directory, `${category}-${date}.log`);
  }

  private async write(category: LogCategory, line: string): Promise<void> {
    const file = this.filePath(category);
    await this.rotateIfNeeded(category, file, Buffer.byteLength(line, 'utf8') + 1);
    await fsp.appendFile(file, `${line}\n`, 'utf8');
  }

  private async rotateIfNeeded(category: LogCategory, file: string, incomingBytes: number): Promise<void> {
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { /* absent */ }
    if (size + incomingBytes <= this.maxBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.rename(file, path.join(this.options.directory, `${category}-${stamp}.log`)).catch(() => undefined);
    const files = (await fsp.readdir(this.options.directory))
      .filter(name => name.startsWith(`${category}-`) && name.endsWith('.log'))
      .sort()
      .reverse();
    await Promise.all(files.slice(this.retainedFiles).map(name => fsp.unlink(path.join(this.options.directory, name)).catch(() => undefined)));
  }
}
