// Banco de dados SQLite nativo do Node (node:sqlite). Em produção com muitos clientes,
// a mesma estrutura pode ser migrada para PostgreSQL.
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sector TEXT NOT NULL DEFAULT 'geral',
  status TEXT NOT NULL DEFAULT 'trialing',          -- trialing | active | past_due | canceled
  trial_ends_at INTEGER NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  rules_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'membro',              -- admin | gestor | membro
  invite_token TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                           -- gmail | outlook | demo
  address TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  expires_at INTEGER,
  demo_sector TEXT,
  last_sync_at INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                                 -- id curto usado pela IA e pela interface
  provider_id TEXT NOT NULL,
  thread_id TEXT,
  internet_message_id TEXT,
  from_name TEXT, from_addr TEXT, subject TEXT, body TEXT,
  received_at INTEGER NOT NULL,
  replied INTEGER NOT NULL DEFAULT 0,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, provider_id)
);
CREATE TABLE IF NOT EXISTS triage (
  user_id INTEGER NOT NULL, message_id TEXT NOT NULL,
  prioridade TEXT, categoria TEXT, responsavel TEXT, motivo TEXT, tarefa TEXT, prazo TEXT,
  divergencias_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE IF NOT EXISTS drafts (
  user_id INTEGER NOT NULL, message_id TEXT NOT NULL,
  assunto TEXT, corpo TEXT, provider_draft_id TEXT, saved_to_mailbox INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, text TEXT, cards_json TEXT NOT NULL DEFAULT '[]', error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL, user_id INTEGER,
  kind TEXT NOT NULL, provider TEXT, model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_company_time ON usage(company_id, created_at);
`);

const now = () => Date.now();
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

module.exports = { db, one, all, run, now, json };
