'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class SessionStore {
  constructor(storageDir, logger = () => {}) {
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, 'chat-sessions.json');
    this.logger = logger;
    this.data = { version: 3, activeSessionId: '', sessions: [] };
  }

  async init() {
    await fsp.mkdir(this.storageDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed?.sessions)) {
        this.data = { ...parsed, version: 3 };
        this.data.sessions = parsed.sessions.map(session => ({ ...session, metadata: session.metadata || {} }));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger(`Falha ao ler histórico: ${error.message || error}`);
    }
    if (!this.data.sessions.length) {
      const created = this.#createSession('Nova conversa');
      this.data.sessions.push(created);
      this.data.activeSessionId = created.id;
      await this.#save();
    }
    if (!this.getActiveSession()) {
      this.data.activeSessionId = this.data.sessions[0].id;
      await this.#save();
    }
    return this.snapshot();
  }

  snapshot() {
    const sorted = [...this.data.sessions].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    return {
      activeSessionId: this.data.activeSessionId,
      sessions: sorted.map(session => ({
        id: session.id,
        title: session.title,
        pinned: Boolean(session.pinned),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        metadata: { ...(session.metadata || {}) },
        searchText: [session.title, ...(session.messages || []).slice(-20).map(message => message.text || '')].join(' ').slice(0, 12000)
      }))
    };
  }

  getActiveSession() {
    return this.data.sessions.find(session => session.id === this.data.activeSessionId) || null;
  }

  getMessages() {
    return [...(this.getActiveSession()?.messages || [])];
  }

  getRecentTranscript(limit = 10) {
    return this.getMessages()
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-Math.max(1, limit));
  }

  async create(title = 'Nova conversa') {
    const session = this.#createSession(title);
    this.data.sessions.push(session);
    this.data.activeSessionId = session.id;
    await this.#save();
    return session;
  }

  async select(id) {
    if (!this.data.sessions.some(session => session.id === id)) throw new Error('Sessão não encontrada.');
    this.data.activeSessionId = id;
    await this.#save();
    return this.getActiveSession();
  }

  async addMessage(role, text, mode = 'chat') {
    const session = this.getActiveSession();
    if (!session) throw new Error('Nenhuma sessão ativa.');
    const clean = String(text || '').trim();
    if (!clean) return;
    session.messages.push({
      id: crypto.randomUUID(),
      role,
      text: clean,
      mode,
      timestamp: new Date().toISOString()
    });
    if (role === 'user' && session.title === 'Nova conversa') {
      session.title = clean.replace(/\s+/g, ' ').slice(0, 48) || 'Nova conversa';
    }
    session.metadata = { ...(session.metadata || {}), mode };
    session.updatedAt = new Date().toISOString();
    await this.#save();
  }

  async updateMetadata(patch = {}) {
    const session = this.getActiveSession();
    if (!session) return;
    session.metadata = { ...(session.metadata || {}), ...patch };
    session.updatedAt = new Date().toISOString();
    await this.#save();
  }

  async clearActive() {
    const session = this.getActiveSession();
    if (!session) return;
    session.messages = [];
    session.updatedAt = new Date().toISOString();
    await this.#save();
  }

  async rename(id, title) {
    const session = this.#require(id);
    session.title = String(title || '').trim().slice(0, 80) || session.title;
    session.updatedAt = new Date().toISOString();
    await this.#save();
  }

  async togglePin(id) {
    const session = this.#require(id);
    session.pinned = !session.pinned;
    session.updatedAt = new Date().toISOString();
    await this.#save();
  }

  async duplicate(id) {
    const source = this.#require(id);
    const copy = this.#createSession(`${source.title} — cópia`);
    copy.messages = source.messages.map(message => ({ ...message, id: crypto.randomUUID() }));
    copy.metadata = { ...(source.metadata || {}) };
    copy.pinned = false;
    this.data.sessions.push(copy);
    this.data.activeSessionId = copy.id;
    await this.#save();
    return copy;
  }

  async delete(id) {
    if (this.data.sessions.length === 1) {
      await this.clearActive();
      return this.getActiveSession();
    }
    const index = this.data.sessions.findIndex(session => session.id === id);
    if (index < 0) throw new Error('Sessão não encontrada.');
    this.data.sessions.splice(index, 1);
    if (this.data.activeSessionId === id) {
      this.data.activeSessionId = this.data.sessions[0].id;
    }
    await this.#save();
    return this.getActiveSession();
  }

  #createSession(title) {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      title: String(title || 'Nova conversa').trim().slice(0, 80) || 'Nova conversa',
      pinned: false,
      createdAt: now,
      updatedAt: now,
      metadata: {},
      messages: []
    };
  }

  #require(id) {
    const session = this.data.sessions.find(item => item.id === id);
    if (!session) throw new Error('Sessão não encontrada.');
    return session;
  }

  async #save() {
    const temporary = `${this.filePath}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
    await fsp.rename(temporary, this.filePath);
  }
}

module.exports = { SessionStore };
