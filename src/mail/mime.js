// Leitura e montagem de e-mails (MIME) sem dependências: cabeçalhos codificados, acentos em qualquer
// charset, multipart, base64, quoted-printable, anexos e nomes de arquivo (RFC 2047 / 2231).

// ---------- charsets ----------
function decodeCharset(buf, charset) {
  const cs = String(charset || "utf-8").toLowerCase().replace(/^"|"$/g, "").trim();
  const alias = { "utf8": "utf-8", "latin1": "iso-8859-1", "ascii": "utf-8", "us-ascii": "utf-8", "cp1252": "windows-1252", "ks_c_5601-1987": "euc-kr", "gb2312": "gbk" };
  try { return new TextDecoder(alias[cs] || cs, { fatal: false }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

// ---------- codificações de transferência ----------
function decodeQP(str) {
  const s = String(str).replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
function decodeTransfer(buf, enc) {
  const e = String(enc || "").toLowerCase().trim();
  if (e === "base64") return Buffer.from(buf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (e === "quoted-printable") return decodeQP(buf.toString("latin1"));
  return buf;
}

// ---------- cabeçalhos ----------
// =?charset?B|Q?texto?=  (palavras codificadas seguidas são unidas sem espaço)
function decodeWords(s) {
  return String(s || "")
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, "$1")
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      const buf = enc.toUpperCase() === "B" ? Buffer.from(txt, "base64") : decodeQP(txt.replace(/_/g, " "));
      return decodeCharset(buf, cs);
    });
}
function rawHeaderText(buf) {
  const s = buf.toString("latin1");
  const i = s.search(/\r?\n\r?\n/);
  return { head: i < 0 ? s : s.slice(0, i), bodyStart: i < 0 ? buf.length : i + s.slice(i).match(/^\r?\n\r?\n/)[0].length };
}
function parseHeaders(head) {
  const h = {};
  const lines = head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
  for (const l of lines) {
    const i = l.indexOf(":"); if (i <= 0) continue;
    const k = l.slice(0, i).trim().toLowerCase(), v = l.slice(i + 1).trim();
    (h[k] = h[k] || []).push(v);
  }
  return h;
}
// Cabeçalhos em bytes "crus" podem vir em UTF-8 sem codificação: tenta UTF-8 e cai para latin1.
function headerString(v) {
  if (v == null) return "";
  const bytes = Buffer.from(v, "latin1");
  const utf = bytes.toString("utf8");
  return decodeWords(utf.includes("�") ? v : utf);
}
const first = (h, k) => headerString((h[k] || [])[0]);

function parseParams(v) {
  const parts = []; let cur = "", q = false;
  for (const ch of String(v || "")) { if (ch === '"') q = !q; if (ch === ";" && !q) { parts.push(cur); cur = ""; } else cur += ch; }
  parts.push(cur);
  const value = parts.shift().trim().toLowerCase();
  const params = {}, star = {};
  for (const p of parts) {
    const i = p.indexOf("="); if (i < 0) continue;
    const k = p.slice(0, i).trim().toLowerCase(); let val = p.slice(i + 1).trim().replace(/^"|"$/g, "");
    const m = k.match(/^([^*]+)\*(\d+)?(\*)?$/);
    if (m) { (star[m[1]] = star[m[1]] || []).push({ n: Number(m[2] || 0), val, enc: !!m[3] || (!m[2] && k.endsWith("*")) }); }
    else params[k] = decodeWords(val);
  }
  for (const [k, list] of Object.entries(star)) { // RFC 2231: filename*=utf-8''nome%20com%20acento
    list.sort((a, b) => a.n - b.n);
    let cs = "utf-8"; const bytes = [];
    list.forEach((p, i) => {
      let v = p.val;
      if (p.enc && i === 0) { const m = v.match(/^([^']*)'[^']*'(.*)$/); if (m) { cs = m[1] || cs; v = m[2]; } }
      if (p.enc) bytes.push(Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))), "latin1"));
      else bytes.push(Buffer.from(v, "latin1"));
    });
    params[k] = decodeCharset(Buffer.concat(bytes), cs);
  }
  return { value, params };
}

// "Nome" <a@b>, c@d, Outro <e@f>
function parseAddresses(v) {
  const s = headerString(v); const out = []; let cur = "", q = false, depth = 0;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === "<") depth++; if (!q && ch === ">") depth--;
    if (ch === "," && !q && depth <= 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^(.*?)<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim().replace(/^"|"$/g, "").trim(), addr: m[2].trim().toLowerCase() };
    const a = x.match(/[^\s<>"]+@[^\s<>"]+/);
    return { name: "", addr: (a ? a[0] : x).toLowerCase() };
  }).filter(a => a.addr.includes("@"));
}
const msgIds = v => (headerString(v).match(/<[^>]+>/g) || []);

function stripHtml(h) {
  return String(h).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------- corpo ----------
function walk(buf, out, depth = 0) {
  const { head, bodyStart } = rawHeaderText(buf);
  const h = parseHeaders(head);
  const ct = parseParams((h["content-type"] || ["text/plain"])[0]);
  const cd = parseParams((h["content-disposition"] || [""])[0]);
  const body = buf.subarray(bodyStart);
  if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < 12) {
    const b = Buffer.from("--" + ct.params.boundary);
    const parts = []; let pos = body.indexOf(b);
    while (pos >= 0) {
      let start = pos + b.length;
      if (body[start] === 45 && body[start + 1] === 45) break; // "--" final
      while (body[start] === 13 || body[start] === 10 || body[start] === 32 || body[start] === 9) { if (body[start] === 10) { start++; break; } start++; }
      const next = body.indexOf(b, start);
      let end = next < 0 ? body.length : next;
      if (body[end - 1] === 10) end--; if (body[end - 1] === 13) end--;
      parts.push(body.subarray(start, end));
      pos = next;
    }
    parts.forEach(p => walk(p, out, depth + 1));
    return;
  }
  if (ct.value === "message/rfc822" && depth < 12) { out.attachments.push({ name: "mensagem-anexa.eml", mime: ct.value, content: decodeTransfer(body, first(h, "content-transfer-encoding")) }); return; }
  const data = decodeTransfer(body, first(h, "content-transfer-encoding"));
  const name = cd.params.filename || ct.params.name || "";
  const isAttachment = cd.value === "attachment" || (!!name && !ct.value.startsWith("text/")) || (!!name && cd.value !== "inline");
  if (!isAttachment && ct.value === "text/plain" && !out.text) out.text = decodeCharset(data, ct.params.charset);
  else if (!isAttachment && ct.value === "text/html" && !out.html) out.html = decodeCharset(data, ct.params.charset);
  else if (isAttachment || !ct.value.startsWith("text/")) {
    if (ct.value.startsWith("image/") && cd.value !== "attachment" && !name) return; // imagens embutidas na assinatura
    out.attachments.push({ name: name || "anexo", mime: ct.value, content: data, charset: ct.params.charset });
  }
}

function parse(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "latin1");
  const { head } = rawHeaderText(buf);
  const h = parseHeaders(head);
  const out = { text: "", html: "", attachments: [] };
  walk(buf, out);
  const from = parseAddresses((h.from || [""])[0])[0] || { name: "", addr: "" };
  return {
    headers: h,
    from, to: parseAddresses((h.to || []).join(", ")), cc: parseAddresses((h.cc || []).join(", ")),
    deliveredTo: [...(h["delivered-to"] || []), ...(h["x-original-to"] || []), ...(h["envelope-to"] || [])].map(v => headerString(v).toLowerCase()),
    listId: first(h, "list-id").toLowerCase(),
    subject: first(h, "subject"),
    messageId: msgIds((h["message-id"] || [""])[0])[0] || "",
    inReplyTo: msgIds((h["in-reply-to"] || [""])[0])[0] || "",
    references: msgIds((h.references || [""]).join(" ")),
    date: Date.parse(first(h, "date")) || null,
    text: out.text, html: out.html,
    body: (out.text || stripHtml(out.html || "")).trim(),
    attachments: out.attachments
  };
}

// ---------- montagem do rascunho de resposta ----------
const encodeHeader = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=` : s;
function buildReply(msg, { assunto, corpo }, fromAddress) {
  const refs = [msg.references, msg.internet_message_id].filter(Boolean).join(" ").trim();
  const lines = [
    fromAddress ? `From: ${fromAddress}` : null,
    `To: ${msg.from_addr}`,
    `Subject: ${encodeHeader(assunto)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    msg.internet_message_id ? `In-Reply-To: ${msg.internet_message_id}` : null,
    refs ? `References: ${refs}` : null,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@genco-ia>`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(corpo, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n")
  ].filter(l => l !== null);
  return Buffer.from(lines.join("\r\n") + "\r\n");
}

module.exports = { parse, buildReply, decodeWords, parseAddresses, stripHtml, decodeCharset };
