import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { AccountUser, HarmonyJob } from '../shared/types.js';

const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});

export class Store {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS projects_owner ON projects(user_id, complete, created_at DESC);
    `);
  }
  async register(email: string, password: string): Promise<AccountUser | null> {
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt)).toString('hex');
    const user = { id: randomUUID(), email };
    const result = this.db.prepare('INSERT OR IGNORE INTO users(id,email,salt,password_hash) VALUES(?,?,?,?)').run(user.id, email, salt, hash);
    return Number(result.changes) === 1 ? user : null;
  }
  async login(email: string, password: string): Promise<AccountUser | null> {
    const row = this.db.prepare('SELECT id,email,salt,password_hash FROM users WHERE email = ?').get(email) as { id: string; email: string; salt: string; password_hash: string } | undefined;
    const hash = await derive(password, row?.salt ?? 'missing-account-dummy-salt');
    const expected = row ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
    const valid = timingSafeEqual(hash, expected);
    return row && valid ? { id: row.id, email: row.email } : null;
  }
  createSession(userId: string): string {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token), userId, Date.now() + SESSION_AGE);
    return token;
  }
  userForSession(token?: string): AccountUser | null {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare('SELECT users.id, users.email FROM sessions JOIN users ON sessions.user_id = users.id WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), Date.now()) as unknown as AccountUser | undefined ?? null;
  }
  deleteSession(token?: string) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
  }
  putProject(owner: string, job: HarmonyJob) {
    this.db.prepare('INSERT INTO projects(id,user_id,created_at,complete,metadata) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET complete=excluded.complete,metadata=excluded.metadata')
      .run(job.id, owner, job.createdAt, job.status === 'complete' ? 1 : 0, JSON.stringify(job));
  }
  project(id: string): { owner: string; job: HarmonyJob } | null {
    const row = this.db.prepare('SELECT user_id,metadata FROM projects WHERE id = ?').get(id) as { user_id: string; metadata: string } | undefined;
    return row ? { owner: row.user_id, job: JSON.parse(row.metadata) as HarmonyJob } : null;
  }
  projects(owner: string): HarmonyJob[] {
    return (this.db.prepare('SELECT metadata FROM projects WHERE user_id = ? AND complete = 1 ORDER BY created_at DESC, id DESC LIMIT 10').all(owner) as { metadata: string }[]).map(row => JSON.parse(row.metadata) as HarmonyJob);
  }
  /** Persist completion and enforce retention in one transaction, including concurrent completions. */
  completeProject(owner: string, job: HarmonyJob): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.putProject(owner, job);
      const removed = this.db.prepare('SELECT id FROM projects WHERE user_id = ? AND complete = 1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 10').all(owner) as { id: string }[];
      for (const { id } of removed) this.deleteProject(id);
      this.db.exec('COMMIT');
      return removed.map(row => row.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  deleteProject(id: string) { this.db.prepare('DELETE FROM projects WHERE id = ?').run(id); }
  recoverInterrupted(): string[] {
    const interrupted = this.db.prepare('SELECT id FROM projects WHERE complete = 0').all() as { id: string }[];
    this.db.prepare('DELETE FROM projects WHERE complete = 0').run();
    return interrupted.map(row => row.id);
  }
  cleanupSessions() { this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()); }
  close() { this.db.close(); }
}
