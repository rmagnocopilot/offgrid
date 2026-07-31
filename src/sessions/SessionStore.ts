import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSession, SessionMetadata } from '../types/contracts';

interface SessionFile { currentSessionId: string; sessions: ChatSession[] }

export class SessionStore {
  private sessions: ChatSession[] = [];
  private currentSessionId = '';
  private readonly file: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storagePath: string) { this.file = path.join(storagePath, 'sessions.json'); }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8')) as SessionFile;
      this.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      this.currentSessionId = parsed.currentSessionId || '';
    } catch { this.sessions = []; this.currentSessionId = ''; }
    if (!this.sessions.length) this.create('Nova conversa');
    if (!this.sessions.some(item => item.id === this.currentSessionId)) this.currentSessionId = this.sessions[0]?.id ?? this.create('Nova conversa').id;
    await this.save();
  }

  list(query = ''): ChatSession[] {
    const needle = query.trim().toLowerCase();
    return [...this.sessions]
      .filter(session => !needle || `${session.title} ${session.messages.map(item => item.text).join(' ')}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }
  current(): ChatSession { return this.get(this.currentSessionId); }
  get(id: string): ChatSession {
    const session = this.sessions.find(item => item.id === id);
    if (!session) throw new Error(`Sessão não encontrada: ${id}`);
    return session;
  }
  create(title = 'Nova conversa'): ChatSession {
    const now = new Date().toISOString();
    const session: ChatSession = { id: randomUUID(), title, createdAt: now, updatedAt: now, pinned: false, messages: [], metadata: {} };
    this.sessions.push(session); this.currentSessionId = session.id; void this.save(); return session;
  }
  switch(id: string): ChatSession { this.get(id); this.currentSessionId = id; void this.save(); return this.current(); }
  rename(id: string, title: string): void { const session = this.get(id); session.title = title.trim() || session.title; this.touch(session); }
  pin(id: string, pinned?: boolean): void { const session = this.get(id); session.pinned = pinned ?? !session.pinned; this.touch(session); }
  delete(id: string): void {
    this.sessions = this.sessions.filter(item => item.id !== id);
    if (!this.sessions.length) this.create();
    if (this.currentSessionId === id) this.currentSessionId = this.sessions[0]?.id ?? this.create().id;
    void this.save();
  }
  duplicate(id: string): ChatSession {
    const source = this.get(id); const now = new Date().toISOString();
    const clone: ChatSession = { ...source, id: randomUUID(), title: `${source.title} (cópia)`, createdAt: now, updatedAt: now, pinned: false, messages: source.messages.map(item => ({ ...item, id: randomUUID() })), metadata: { ...source.metadata, contextFiles: [...(source.metadata.contextFiles ?? [])] } };
    this.sessions.push(clone); this.currentSessionId = clone.id; void this.save(); return clone;
  }
  clear(id = this.currentSessionId): void { const session = this.get(id); session.messages = []; this.touch(session); }
  archiveCurrent(): boolean {
    const session = this.current();
    if (!session.messages.length) return false;
    this.create('Nova conversa');
    return true;
  }
  addMessage(message: Omit<ChatMessage, 'id' | 'createdAt'>, id = this.currentSessionId): ChatMessage {
    const session = this.get(id);
    const value: ChatMessage = { ...message, id: randomUUID(), createdAt: new Date().toISOString() };
    session.messages.push(value);
    if (session.messages.length > 300) session.messages.splice(0, session.messages.length - 300);
    if (session.title === 'Nova conversa' && message.role === 'user') session.title = message.text.replace(/\s+/g, ' ').slice(0, 60) || session.title;
    this.touch(session); return value;
  }
  updateMetadata(metadata: Partial<SessionMetadata>, id = this.currentSessionId): void { const session = this.get(id); session.metadata = { ...session.metadata, ...metadata }; this.touch(session); }
  async flush(): Promise<void> { await this.writeQueue; }

  private touch(session: ChatSession): void { session.updatedAt = new Date().toISOString(); void this.save(); }
  private save(): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.file, JSON.stringify({ currentSessionId: this.currentSessionId, sessions: this.sessions }, null, 2), 'utf8');
    });
    return this.writeQueue;
  }
}
