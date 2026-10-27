// Conector Gmail (Google). Escopo gmail.modify: ler, criar rascunhos e aplicar etiquetas. Nunca envia.
const config = require("../config");

const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify"];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const redirectUri = () => `${config.appUrl}/oauth/gmail/callback`;

// Na conexão de um grupo pedimos também a leitura dos membros do grupo (Google Workspace / Cloud Identity),
// para o app separar automaticamente cada pessoa do grupo.
const GROUP_SCOPE = "https://www.googleapis.com/auth/cloud-identity.groups.readonly";
function authUrl(state, { group = false } = {}) {
  const p = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p;
}

async function token(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.google.clientId, client_secret: config.google.clientSecret, ...params }) });
  const d = await res.json();
  if (!res.ok) throw new Error("Google recusou o acesso: " + (d.error_description || d.error || res.status));
  return d;
}

async function exchange(code) {
  const t = await token({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const profile = await api(t.access_token, "GET", "/profile");
  // nome da pessoa, para criar a conta na entrada com Google
  let name = "";
  try { const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } }); if (r.ok) name = (await r.json()).name || ""; } catch {}
  return { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000, address: profile.emailAddress, name };
}
async function refresh(refreshToken) {
  const t = await token({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return { access: t.access_token, refresh: t.refresh_token || refreshToken, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
}

async function api(access, method, path, body) {
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${access}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return {};
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error("Gmail: " + (d.error?.message || res.status)); e.status = res.status; throw e; }
  return d;
}

const b64url = s => Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
const header = (h, n) => (h || []).find(x => x.name.toLowerCase() === n.toLowerCase())?.value || "";
const stripHtml = h => String(h).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
function parseFrom(v) { const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/); return m ? { name: m[1].trim(), addr: m[2].trim() } : { name: "", addr: String(v).trim() }; }

function walk(part, out) {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) out.attachments.push({ name: part.filename, mime: part.mimeType, size: part.body.size, attachmentId: part.body.attachmentId });
  else if (part.mimeType === "text/plain" && part.body?.data && !out.text) out.text = b64url(part.body.data).toString("utf8");
  else if (part.mimeType === "text/html" && part.body?.data && !out.html) out.html = b64url(part.body.data).toString("utf8");
  (part.parts || []).forEach(p => walk(p, out));
}

// Executa fn em paralelo, n de cada vez (a API do Gmail aceita bem ~10 pedidos simultâneos).
async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
// Lista todas as referências que batem com a busca (paginando), até um teto.
async function listAll(access, q, cap) {
  const refs = []; let pageToken = "";
  do {
    const d = await api(access, "GET", `/messages?maxResults=500&q=${encodeURIComponent(q)}${pageToken ? "&pageToken=" + pageToken : ""}`);
    refs.push(...(d.messages || [])); pageToken = d.nextPageToken || "";
  } while (pageToken && refs.length < cap);
  return refs.slice(0, cap);
}
const addrList = v => String(v || "").split(",").map(x => parseFrom(x).addr.toLowerCase()).filter(a => a.includes("@"));

// E-mails da caixa de entrada (todos os novos, não só os últimos) + marcação de "já respondido" pelos enviados.
// query: filtro extra (caixa de grupo). internal: endereços da própria equipe — e-mails deles no grupo
// contam como resposta, não como e-mail novo a atender.
const internalSkip = new Map(); // ids já vistos como mensagens internas (evita reler a cada ciclo)
const sentDates = new Map();    // id do enviado -> data (evita reler os mesmos enviados a cada ciclo)
async function fetchRecent(access, { days = 7, max = 300, knownIds = new Set(), query = "", internal = null, teamDomain = "" } = {}) {
  const teamSeen = new Map();
  const base = query ? `newer_than:${days}d ${query} -in:sent -in:drafts -in:trash -in:spam` : `in:inbox newer_than:${days}d -category:promotions -category:social`;
  const refs = await listAll(access, base, 3000);
  const sent = await listAll(access, `in:sent newer_than:${days + 2}d`, 1500);
  const lastSentByThread = {};
  const markSent = (thread, t) => { lastSentByThread[thread] = Math.max(lastSentByThread[thread] || 0, t); };
  await pmap(sent.filter(s => !sentDates.has(s.id)), 10, async s => { const m = await api(access, "GET", `/messages/${s.id}?format=minimal`); sentDates.set(s.id, Number(m.internalDate)); });
  for (const s of sent) if (sentDates.has(s.id)) markSent(s.threadId, sentDates.get(s.id));
  const out = [];
  const fresh = [];
  for (const ref of refs) {
    if (knownIds.has(ref.id)) { out.push({ provider_id: ref.id, known: true, thread_id: ref.threadId }); continue; }
    if (internal && internalSkip.has(ref.id)) { markSent(ref.threadId, internalSkip.get(ref.id)); continue; }
    if (fresh.length < max) fresh.push(ref); // o resto entra na próxima leitura
  }
  const full = await pmap(fresh, 10, ref => api(access, "GET", `/messages/${ref.id}?format=full`).catch(e => { console.error("[gmail]", e.message); return null; }));
  for (const m of full) {
    if (!m) continue;
    const hs = m.payload.headers;
    const from = parseFrom(header(hs, "From"));
    const fromAddr = from.addr.toLowerCase();
    // Alguém do mesmo domínio respondendo na conversa do grupo = pessoa da equipe (detectada automaticamente).
    const isTeamReply = teamDomain && fromAddr.endsWith("@" + teamDomain) && !!header(hs, "In-Reply-To");
    if (isTeamReply) teamSeen.set(fromAddr, { email: fromAddr, name: from.name });
    if (internal && (internal.has(fromAddr) || isTeamReply)) {
      // Resposta de alguém da equipe (ex.: respondeu pelo próprio e-mail com cópia para o grupo).
      internalSkip.set(m.id, Number(m.internalDate)); markSent(m.threadId, Number(m.internalDate));
      continue;
    }
    const parts = { attachments: [], text: "", html: "" };
    walk(m.payload, parts);
    const attachments = [];
    for (const a of parts.attachments.slice(0, 5)) {
      const item = { name: a.name, mime: a.mime, size: a.size };
      const isText = /^text\//.test(a.mime) || /\.(txt|csv)$/i.test(a.name);
      const isPdf = a.mime === "application/pdf" || /\.pdf$/i.test(a.name);
      if ((isText && a.size <= 200_000) || (isPdf && a.size <= 4_000_000)) {
        try {
          const d = await api(access, "GET", `/messages/${m.id}/attachments/${a.attachmentId}`);
          const buf = b64url(d.data);
          if (isText) item.text = buf.toString("utf8").slice(0, 20000); else item.pdfBase64 = buf.toString("base64");
        } catch (e) { console.error("[gmail anexo]", e.message); }
      }
      attachments.push(item);
    }
    const received = Number(m.internalDate);
    out.push({
      provider_id: m.id, thread_id: m.threadId, internet_message_id: header(hs, "Message-ID"),
      from_name: from.name, from_addr: from.addr, subject: header(hs, "Subject") || "(sem assunto)",
      body: (parts.text || stripHtml(parts.html) || m.snippet || "").slice(0, 20000),
      received_at: received, replied: (lastSentByThread[m.threadId] || 0) > received, attachments,
      to: addrList(header(hs, "To")), cc: addrList(header(hs, "Cc")),
      delivered: [...hs.filter(x => /^(delivered-to|x-original-to)$/i.test(x.name)).map(x => x.value.toLowerCase().trim()), ...(header(hs, "List-Id") ? [header(hs, "List-Id").toLowerCase()] : [])],
      in_reply_to: header(hs, "In-Reply-To")
    });
  }
  // Atualiza "respondido" também dos já conhecidos.
  out.filter(x => x.known).forEach(x => { x.lastSent = lastSentByThread[x.thread_id] || 0; });
  out.teamSeen = [...teamSeen.values()];
  return out;
}

const encodeHeader = s => /[^\x20-\x7e]/.test(s) ? `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=` : s;
async function createDraft(access, msg, { assunto, corpo }) {
  const lines = [
    `To: ${msg.from_addr}`,
    `Subject: ${encodeHeader(assunto)}`,
    msg.internet_message_id ? `In-Reply-To: ${msg.internet_message_id}` : null,
    msg.internet_message_id ? `References: ${msg.internet_message_id}` : null,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(corpo, "utf8").toString("base64")
  ].filter(l => l !== null).join("\r\n");
  const raw = Buffer.from(lines).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const d = await api(access, "POST", "/drafts", { message: { raw, threadId: msg.thread_id } });
  return d.id;
}
async function updateDraft(access, draftId, msg, draft) {
  try { await api(access, "DELETE", `/drafts/${draftId}`); } catch { /* já apagado pelo usuário */ }
  return createDraft(access, msg, draft);
}

let labelCache = new Map();
async function applyLabels(access, msg, names) {
  const key = access.slice(-12);
  let labels = labelCache.get(key);
  if (!labels) { labels = (await api(access, "GET", "/labels")).labels || []; labelCache.set(key, labels); }
  const ids = [];
  for (const n of names) {
    const full = `GENCO IA/${n}`;
    let l = labels.find(x => x.name === full);
    if (!l) { l = await api(access, "POST", "/labels", { name: full, labelListVisibility: "labelShow", messageListVisibility: "show" }); labels.push(l); }
    ids.push(l.id);
  }
  const old = labels.filter(l => l.name.startsWith("GENCO IA/") && !ids.includes(l.id)).map(l => l.id);
  await api(access, "POST", `/messages/${msg.provider_id}/modify`, { addLabelIds: ids, removeLabelIds: old });
}

// Membros do grupo do Google Workspace (precisa do escopo de leitura de grupos e que a conta possa ver os membros).
async function listGroupMembers(access, groupAddress) {
  const CI = "https://cloudidentity.googleapis.com/v1";
  const call = async url => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error("Google Grupos: " + (d.error?.message || res.status)); e.status = res.status; throw e; }
    return d;
  };
  const g = await call(`${CI}/groups:lookup?${new URLSearchParams({ "groupKey.id": groupAddress })}`);
  const out = []; let pageToken = "";
  do {
    const d = await call(`${CI}/${g.name}/memberships?${new URLSearchParams({ view: "FULL", pageSize: "200", ...(pageToken ? { pageToken } : {}) })}`);
    for (const m of d.memberships || []) if ((m.type || "USER") === "USER" && m.preferredMemberKey?.id) out.push({ email: m.preferredMemberKey.id.toLowerCase(), name: "" });
    pageToken = d.nextPageToken || "";
  } while (pageToken);
  return out;
}

module.exports = { authUrl, exchange, refresh, fetchRecent, listGroupMembers, createDraft, updateDraft, applyLabels };
