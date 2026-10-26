// Cliente IMAP mínimo, sem dependências (node:tls / node:net). Faz só o que a GENCO IA precisa:
// login, listar pastas, abrir pasta, buscar por data, ler mensagens, gravar rascunho e apagar o rascunho antigo.
const net = require("node:net");
const tls = require("node:tls");

class ImapError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

// ---------- leitura das respostas do servidor (linhas + literais {n}) ----------
class Reader {
  constructor() { this.buf = Buffer.alloc(0); this.cur = null; }
  push(chunk) { this.buf = Buffer.concat([this.buf, chunk]); }
  // Devolve uma resposta completa: { text, lits[] } — os literais ficam no texto como \u0000N\u0000.
  next() {
    if (!this.cur) this.cur = { text: "", lits: [], need: 0 };
    const c = this.cur;
    for (;;) {
      if (c.need) {
        if (this.buf.length < c.need) return null;
        c.lits.push(this.buf.subarray(0, c.need)); c.text += `\u0000${c.lits.length - 1}\u0000`;
        this.buf = this.buf.subarray(c.need); c.need = 0;
      }
      const i = this.buf.indexOf("\r\n");
      if (i < 0) return null;
      const line = this.buf.subarray(0, i).toString("utf8"); this.buf = this.buf.subarray(i + 2);
      const m = line.match(/\{(\d+)\+?\}$/);
      if (m) { c.text += line.slice(0, m.index); c.need = Number(m[1]); if (c.need === 0) { c.lits.push(Buffer.alloc(0)); c.text += `\u0000${c.lits.length - 1}\u0000`; } continue; }
      c.text += line; this.cur = null; return c;
    }
  }
}

// Tokenizador de listas IMAP: átomos, "strings", literais e (listas aninhadas).
function tokenize(text, lits) {
  let i = 0;
  const read = () => {
    const out = [];
    while (i < text.length) {
      const ch = text[i];
      if (ch === " ") { i++; continue; }
      if (ch === "(") { i++; out.push(read()); continue; }
      if (ch === ")") { i++; return out; }
      if (ch === '"') {
        let s = ""; i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; s += text[i++]; }
        i++; out.push(s); continue;
      }
      if (ch === "\u0000") { const j = text.indexOf("\u0000", i + 1); out.push(lits[Number(text.slice(i + 1, j))]); i = j + 1; continue; }
      let s = "";
      // átomos podem conter [ ] (ex.: BODY[HEADER.FIELDS (FROM)]) — junta o conteúdo entre colchetes
      while (i < text.length && !" ()".includes(text[i]) || (s.includes("[") && !s.includes("]") && i < text.length)) s += text[i++];
      out.push(s === "NIL" ? null : s);
    }
    return out;
  };
  return read();
}

const quote = s => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const isLocal = h => ["127.0.0.1", "localhost", "::1"].includes(String(h));

class ImapClient {
  constructor({ host, port = 993, secure = true, timeoutMs = 45000 }) {
    this.host = host; this.port = Number(port); this.secure = secure; this.timeoutMs = timeoutMs;
    this.tag = 0; this.reader = new Reader(); this.waiting = null; this.untagged = []; this.caps = new Set(); this.greeting = null;
  }

  _attach(sock) {
    this.sock = sock;
    sock.setTimeout(this.timeoutMs, () => sock.destroy(new ImapError("O servidor de e-mail não respondeu a tempo.", "timeout")));
    sock.on("data", d => { this.reader.push(d); this._drain(); });
    sock.on("error", e => this._fail(e));
    sock.on("close", () => this._fail(new ImapError("Conexão com o servidor de e-mail encerrada.", "closed")));
  }
  _fail(e) {
    const w = this.waiting; this.waiting = null; this.closed = true;
    if (this.greeting) { const g = this.greeting; this.greeting = null; g.reject(e); }
    if (w) w.reject(e instanceof ImapError ? e : new ImapError(friendlyNet(e), "net"));
  }
  _drain() {
    let r;
    while ((r = this.reader.next())) {
      if (this.greeting) { const g = this.greeting; this.greeting = null; /^\* (OK|PREAUTH)/i.test(r.text) ? g.resolve(r) : g.reject(new ImapError("O servidor recusou a conexão.", "greeting")); continue; }
      const w = this.waiting;
      if (r.text.startsWith("+")) { if (w?.onContinue) { const f = w.onContinue; w.onContinue = null; f(); } continue; }
      if (r.text.startsWith("* ")) {
        const cap = r.text.match(/\[CAPABILITY ([^\]]+)\]|^\* CAPABILITY (.+)$/i);
        if (cap) this.caps = new Set((cap[1] || cap[2]).toUpperCase().split(" "));
        this.untagged.push(r); continue;
      }
      if (w && r.text.startsWith(w.tag + " ")) {
        this.waiting = null;
        const [, status, rest] = r.text.match(/^\S+ (\w+) ?(.*)$/) || [];
        const untagged = this.untagged; this.untagged = [];
        const cap = rest && rest.match(/\[CAPABILITY ([^\]]+)\]/i); if (cap) this.caps = new Set(cap[1].toUpperCase().split(" "));
        if (String(status).toUpperCase() === "OK") w.resolve({ text: rest || "", untagged });
        else w.reject(new ImapError(rest || "Comando recusado pelo servidor.", "no"));
      }
    }
  }

  async connect() {
    const opts = { host: this.host, port: this.port, servername: net.isIP(this.host) ? undefined : this.host };
    const greeting = new Promise((resolve, reject) => { this.greeting = { resolve, reject }; });
    if (this.secure) {
      const s = tls.connect({ ...opts, minVersion: "TLSv1.2" });
      this._attach(s);
    } else {
      this._attach(net.connect(opts));
    }
    await greeting;
    if (!this.secure) {
      await this.cmd("CAPABILITY");
      if (this.caps.has("STARTTLS")) {
        await this.cmd("STARTTLS");
        const raw = this.sock; raw.removeAllListeners("data"); raw.removeAllListeners("close"); raw.removeAllListeners("error"); raw.setTimeout(0);
        this.reader = new Reader();
        const s = tls.connect({ socket: raw, servername: opts.servername, minVersion: "TLSv1.2" });
        await new Promise((res, rej) => { s.once("secureConnect", res); s.once("error", e => rej(new ImapError(friendlyNet(e), "tls"))); });
        this._attach(s); this.secure = true;
        await this.cmd("CAPABILITY");
      } else if (!isLocal(this.host)) {
        throw new ImapError("Este servidor não oferece conexão segura (TLS). Por segurança, a GENCO IA não envia senhas sem criptografia.", "insecure");
      }
    }
  }

  cmd(command, literal) {
    if (this.closed) return Promise.reject(new ImapError("Conexão com o servidor de e-mail encerrada.", "closed"));
    if (this.waiting) return Promise.reject(new Error("Comando IMAP em andamento."));
    const tag = "G" + (++this.tag);
    return new Promise((resolve, reject) => {
      this.waiting = { tag, resolve, reject };
      if (literal) {
        this.waiting.onContinue = () => { this.sock.write(literal); this.sock.write("\r\n"); };
        this.sock.write(`${tag} ${command} {${literal.length}}\r\n`);
      } else this.sock.write(`${tag} ${command}\r\n`);
    });
  }

  async login(user, pass) {
    if (!this.caps.size) await this.cmd("CAPABILITY");
    try {
      // senha com caracteres especiais ou não ASCII vai como literal
      if (/[^\x20-\x7e]/.test(pass)) await this.cmd(`LOGIN ${quote(user)}`, Buffer.from(pass, "utf8"));
      else await this.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    } catch (e) {
      if (e.kind === "no") throw new ImapError("E-mail ou senha recusados pelo servidor. Se a conta tiver verificação em duas etapas, use uma senha de app.", "auth");
      throw e;
    }
    if (!this.caps.has("IMAP4REV1") && !this.caps.has("IMAP4REV2")) await this.cmd("CAPABILITY").catch(() => {});
  }

  async list() {
    const r = await this.cmd('LIST "" "*"');
    return r.untagged.filter(u => /^\* LIST /i.test(u.text)).map(u => {
      const t = tokenize(u.text.replace(/^\* LIST /i, ""), u.lits);
      const flags = (t[0] || []).map(f => String(f).toLowerCase());
      const name = Buffer.isBuffer(t[2]) ? t[2].toString("utf8") : String(t[2] ?? "");
      return { name, flags, delimiter: t[1] };
    });
  }

  async select(box, { readOnly = true } = {}) {
    const r = await this.cmd(`${readOnly ? "EXAMINE" : "SELECT"} ${quote(box)}`);
    const v = (r.untagged.map(u => u.text).join("\n") + "\n" + r.text).match(/UIDVALIDITY (\d+)/i);
    return { uidValidity: v ? Number(v[1]) : 0 };
  }

  async searchSince(date) {
    const d = new Date(date);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    const r = await this.cmd(`UID SEARCH SINCE ${d.getUTCDate()}-${mon}-${d.getUTCFullYear()}`);
    const line = r.untagged.find(u => /^\* SEARCH/i.test(u.text));
    return line ? line.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  // items: string IMAP (ex.: "UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]")
  async fetch(uids, items) {
    if (!uids.length) return [];
    const r = await this.cmd(`UID FETCH ${uids.join(",")} (${items})`);
    return r.untagged.filter(u => /^\* \d+ FETCH /i.test(u.text)).map(u => {
      const t = tokenize(u.text.replace(/^\* \d+ FETCH /i, ""), u.lits)[0] || [];
      const o = {};
      for (let i = 0; i < t.length; i += 2) {
        const k = String(t[i]).toUpperCase().replace(/^BODY\[(.*)\](<\d+>)?$/, "BODY[$1]");
        o[k] = t[i + 1];
      }
      return {
        uid: Number(o.UID), flags: (o.FLAGS || []).map(f => String(f).toLowerCase()),
        internalDate: o.INTERNALDATE ? Date.parse(String(o.INTERNALDATE).replace(/^(\d+)-(\w+)-(\d+)/, "$2 $1 $3")) : null,
        size: Number(o["RFC822.SIZE"] || 0),
        body: Object.entries(o).filter(([k]) => k.startsWith("BODY[")).map(([, v]) => v)[0] || null
      };
    });
  }

  async append(box, raw, flags = ["\\Draft", "\\Seen"]) {
    const r = await this.cmd(`APPEND ${quote(box)} (${flags.join(" ")})`, raw);
    const m = r.text.match(/APPENDUID (\d+) (\d+)/i);
    return m ? { uidValidity: Number(m[1]), uid: Number(m[2]) } : null;
  }

  async deleteUid(uid) {
    await this.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    if (this.caps.has("UIDPLUS")) await this.cmd(`UID EXPUNGE ${uid}`); // só apaga este rascunho
  }

  async logout() {
    try { if (!this.closed) await Promise.race([this.cmd("LOGOUT"), new Promise(r => setTimeout(r, 2000))]); } catch {}
    try { this.sock?.destroy(); } catch {}
    this.closed = true;
  }
}

function friendlyNet(e) {
  const c = e?.code || "";
  if (c === "ENOTFOUND" || c === "EAI_AGAIN") return "Servidor de e-mail não encontrado. Confira o endereço do servidor.";
  if (c === "ECONNREFUSED" || c === "ETIMEDOUT" || c === "EHOSTUNREACH") return "Não foi possível conectar ao servidor de e-mail nessa porta.";
  if (/certificate|self.signed|CERT_/i.test(e?.message || c)) return "O certificado de segurança do servidor de e-mail não é válido para esse endereço.";
  return e?.message || "Falha de conexão com o servidor de e-mail.";
}

// Abre, entra, executa e sempre fecha.
async function withImap(cfg, fn) {
  const c = new ImapClient({ host: cfg.host, port: cfg.port, secure: cfg.secure !== false });
  try { await c.connect(); await c.login(cfg.user, cfg.pass); return await fn(c); }
  finally { await c.logout(); }
}

module.exports = { ImapClient, ImapError, withImap, tokenize };
