// Senhas, sessões e criptografia de tokens — só com node:crypto.
const crypto = require("node:crypto");
const config = require("./config");
const { one, run, now } = require("./db");

const KEY = crypto.createHash("sha256").update("genco-ia:enc:" + config.secret).digest();
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, saltHex, hashHex] = stored.split("$");
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashHex, "hex");
  return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
}

function encrypt(text) {
  if (text == null || text === "") return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString("base64")).join(".");
}
function decrypt(blob) {
  if (!blob) return null;
  try {
    const [iv, tag, enc] = blob.split(".").map(s => Buffer.from(s, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  } catch { return null; }
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = (n = 32) => crypto.randomBytes(n).toString("base64url");

function createSession(userId) {
  const token = randomToken();
  run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", sha(token), userId, now() + SESSION_DAYS * 864e5);
  return token;
}
function sessionUser(token) {
  if (!token) return null;
  const row = one(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.kind = 'pessoa'`, sha(token));
  if (!row || row.expires_at < now()) return null;
  return row;
}
// Acesso pelo e-mail do grupo: a sessão do grupo só permite escolher quem está usando.
function createGroupSession(groupId) {
  const token = randomToken();
  run("INSERT INTO group_sessions (token_hash, group_id, expires_at) VALUES (?, ?, ?)", sha(token), groupId, now() + SESSION_DAYS * 864e5);
  return token;
}
function groupSession(token) {
  if (!token) return null;
  const row = one("SELECT * FROM group_sessions WHERE token_hash = ?", sha(token));
  return row && row.expires_at > now() ? row.group_id : null;
}
function destroyGroupSession(token) { if (token) run("DELETE FROM group_sessions WHERE token_hash = ?", sha(token)); }
function groupCookie(token, maxAgeDays = SESSION_DAYS) {
  const parts = [`genco_grp=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.round(maxAgeDays * 86400)}`];
  if (config.appUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

function destroySession(token) { if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha(token)); }

function sessionCookie(token, maxAgeDays = SESSION_DAYS) {
  const parts = [`genco_sess=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.round(maxAgeDays * 86400)}`];
  if (config.appUrl.startsWith("https://")) parts.push("Secure");
  return parts.join("; ");
}

module.exports = { hashPassword, verifyPassword, encrypt, decrypt, createSession, sessionUser, destroySession, sessionCookie, randomToken, sha,
  createGroupSession, groupSession, destroyGroupSession, groupCookie };
