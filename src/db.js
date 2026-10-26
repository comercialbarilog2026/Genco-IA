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
-- Grupos de e-mail (caixas compartilhadas). Cada grupo tem uma "caixa" própria, representada por uma
-- linha em users com kind = 'grupo' (como as caixas compartilhadas do Exchange). Assim mensagens,
-- qualificações e rascunhos do grupo reaproveitam as mesmas tabelas das caixas pessoais.
CREATE TABLE IF NOT EXISTS groups (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,   -- id da caixa do grupo
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  address TEXT,                                     -- ex.: operacional@empresa.com.br
  filtro TEXT,                                      -- busca do Gmail que separa os e-mails do grupo (opcional)
  auto_atribuir INTEGER NOT NULL DEFAULT 1,         -- IA define o dono pela sugestão de responsável
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(user_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  regra TEXT NOT NULL DEFAULT '',                   -- o que essa pessoa cuida dentro do grupo
  coordena INTEGER NOT NULL DEFAULT 0,              -- responsável pelo grupo (recebe o resumo)
  PRIMARY KEY (group_id, user_id)
);
-- Atendimento de cada e-mail do grupo: quem é o dono e em que situação está.
CREATE TABLE IF NOT EXISTS handling (
  box_id INTEGER NOT NULL, message_id TEXT NOT NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'novo',              -- novo | andamento | aguardando | resolvido
  updated_by INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (box_id, message_id)
);
-- Histórico e notas internas (a equipe conversa sobre o e-mail sem responder ao cliente).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  box_id INTEGER NOT NULL, message_id TEXT NOT NULL,
  user_id INTEGER,                                  -- NULL = GENCO IA
  kind TEXT NOT NULL,                               -- nota | dono | situacao
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_msg ON events(box_id, message_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, id);
CREATE INDEX IF NOT EXISTS idx_usage_company_time ON usage(company_id, created_at);
`);

// Migrações de colunas novas em bancos já existentes.
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn("users", "kind", "kind TEXT NOT NULL DEFAULT 'pessoa'");   // pessoa | grupo
addColumn("chats", "box_id", "box_id INTEGER");                     // NULL = caixa pessoal
addColumn("groups", "password_hash", "password_hash TEXT");
addColumn("users", "digest_on", "digest_on INTEGER NOT NULL DEFAULT 1");   // resumo diário por e-mail
addColumn("users", "digest_hour", "digest_hour INTEGER");                   // NULL = hora padrão (DIGEST_HOUR)
addColumn("users", "last_digest_day", "last_digest_day TEXT");
addColumn("users", "reset_token_hash", "reset_token_hash TEXT");            // recuperação de senha
addColumn("users", "reset_expires", "reset_expires INTEGER");
addColumn("companies", "modo", "modo TEXT NOT NULL DEFAULT 'equipe'");       // individual (uma pessoa, um e-mail) | equipe          // acesso da equipe pelo e-mail do grupo
addColumn("group_members", "origem", "origem TEXT NOT NULL DEFAULT 'manual'"); // manual | google | email | demo
db.exec(`CREATE TABLE IF NOT EXISTS group_excluded (     -- pessoas que o gestor tirou do grupo: a detecção não as recoloca
  group_id INTEGER NOT NULL REFERENCES groups(user_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);`);
// Entrada com Google / Microsoft: estado do pedido de login (antes de existir sessão).
db.exec(`CREATE TABLE IF NOT EXISTS login_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  created_at INTEGER NOT NULL
);`);
db.exec(`CREATE TABLE IF NOT EXISTS group_sessions (
  token_hash TEXT PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(user_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);`);
db.exec("CREATE INDEX IF NOT EXISTS idx_chats_box ON chats(user_id, box_id, id);");

const now = () => Date.now();
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

module.exports = { db, one, all, run, now, json };
