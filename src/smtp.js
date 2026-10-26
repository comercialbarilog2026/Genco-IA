// Envio de e-mails do próprio sistema (resumo diário e recuperação de senha) por SMTP, sem dependências.
// Serve qualquer provedor SMTP: Locaweb, Gmail/Workspace (senha de app), Microsoft 365, SendGrid, Resend, Amazon SES...
// Importante: são e-mails da GENCO IA para os usuários. Os e-mails dos clientes nunca são enviados pelo app.
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const config = require("./config");

const enabled = () => !!(config.smtp.host && config.smtp.from);

function session(sock) {
  let buf = "", waiter = null;
  const onData = d => { buf += d.toString("utf8"); check(); };
  function check() {
    if (!waiter) return;
    const lines = buf.split("\r\n"); // resposta completa: última linha "250 ..." (sem hífen)
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const text = lines.slice(0, i + 1).join("\n"); buf = lines.slice(i + 1).join("\r\n");
        const w = waiter; waiter = null; w.resolve({ code: Number(lines[i].slice(0, 3)), text });
        return;
      }
    }
  }
  const attach = s => { s.on("data", onData); s.on("error", e => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } }); s.setTimeout(30000, () => s.destroy(new Error("O servidor SMTP não respondeu a tempo."))); };
  attach(sock);
  return {
    get sock() { return sock; },
    read() { return new Promise((resolve, reject) => { waiter = { resolve, reject }; check(); }); },
    async cmd(line, expect) {
      sock.write(line + "\r\n");
      const r = await this.read();
      const code = Number(r.text.split("\n").pop().slice(0, 3));
      if (expect && !expect.includes(code)) throw new Error(`SMTP recusou (${code}): ${r.text.split("\n").pop().slice(4)}`);
      return { code, text: r.text };
    },
    upgrade(host) {
      sock.removeListener("data", onData);
      return new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: net.isIP(host) ? undefined : host, minVersion: "TLSv1.2" }, () => { sock = s; attach(s); resolve(); });
        s.once("error", reject);
      });
    }
  };
}

const enc = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=` : s;
const b64lines = s => Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");

function buildMessage({ from, to, subject, text, html }) {
  const boundary = "genco-" + Math.random().toString(36).slice(2);
  const head = [
    `From: ${from}`, `To: ${to}`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@genco-ia>`, "MIME-Version: 1.0", "Auto-Submitted: auto-generated"
  ];
  const body = html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64lines(text),
      `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64lines(html), `--${boundary}--`, ""]
    : ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64lines(text), ""];
  return [...head, ...body].join("\r\n");
}

async function sendMail({ to, subject, text, html }) {
  if (!enabled()) throw new Error("Envio de e-mails não configurado (SMTP_HOST e SMTP_FROM).");
  const { host, port, secure, user, pass, from } = config.smtp;
  const local = ["127.0.0.1", "localhost", "::1"].includes(host);
  const sock = secure ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, minVersion: "TLSv1.2" }) : net.connect({ host, port });
  const s = session(sock);
  try {
    let r = await s.read(); if (r.code !== 220) throw new Error("Servidor SMTP recusou a conexão.");
    const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "genco-ia";
    r = await s.cmd(`EHLO ${name}`, [250]);
    if (!secure) {
      if (/STARTTLS/i.test(r.text)) { await s.cmd("STARTTLS", [220]); await s.upgrade(host); r = await s.cmd(`EHLO ${name}`, [250]); }
      else if (!local) throw new Error("O servidor SMTP não oferece conexão segura (STARTTLS).");
    }
    if (user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(r.text)) await s.cmd("AUTH PLAIN " + Buffer.from(`\u0000${user}\u0000${pass}`).toString("base64"), [235]);
      else { await s.cmd("AUTH LOGIN", [334]); await s.cmd(Buffer.from(user).toString("base64"), [334]); await s.cmd(Buffer.from(pass).toString("base64"), [235]); }
    }
    const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
    await s.cmd(`MAIL FROM:<${fromAddr}>`, [250]);
    await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
    await s.cmd("DATA", [354]);
    const data = buildMessage({ from, to, subject, text, html }).replace(/\r\n\./g, "\r\n..");
    await s.cmd(data + "\r\n.", [250]);
    await s.cmd("QUIT").catch(() => {});
  } finally { try { s.sock.destroy(); } catch {} }
}

module.exports = { sendMail, enabled, buildMessage };
