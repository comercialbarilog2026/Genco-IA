// Conector Outlook / Microsoft 365 (Microsoft Graph). Permissões: Mail.ReadWrite (ler, rascunhar, categorizar). Nunca envia.
const config = require("../config");

const SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite"];
const GRAPH = "https://graph.microsoft.com/v1.0";
const redirectUri = () => `${config.appUrl}/oauth/outlook/callback`;

function authUrl(state) {
  const p = new URLSearchParams({ client_id: config.microsoft.clientId, response_type: "code", redirect_uri: redirectUri(), response_mode: "query", scope: SCOPES.join(" "), state, prompt: "select_account" });
  return "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + p;
}
async function token(params) {
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, scope: SCOPES.join(" "), ...params }) });
  const d = await res.json();
  if (!res.ok) throw new Error("Microsoft recusou o acesso: " + (d.error_description || d.error || res.status));
  return d;
}
async function exchange(code) {
  const t = await token({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const me = await api(t.access_token, "GET", "/me?$select=mail,userPrincipalName,displayName");
  return { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000, address: me.mail || me.userPrincipalName, name: me.displayName || "" };
}
async function refresh(refreshToken) {
  const t = await token({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return { access: t.access_token, refresh: t.refresh_token || refreshToken, expiresAt: Date.now() + (t.expires_in - 60) * 1000 };
}
async function api(access, method, path, body, headers = {}) {
  const res = await fetch(path.startsWith("http") ? path : GRAPH + path, { method, headers: { Authorization: `Bearer ${access}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204 || res.status === 202) return {};
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error("Outlook: " + (d.error?.message || res.status)); e.status = res.status; throw e; }
  return d;
}

async function fetchRecent(access, { days = 7, max = 40, knownIds = new Set() } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const textPref = { Prefer: 'outlook.body-content-type="text"' };
  const inbox = await api(access, "GET", `/me/mailFolders/inbox/messages?$top=${max}&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since}&$select=id,conversationId,internetMessageId,subject,from,receivedDateTime,body,hasAttachments`, null, textPref);
  const sent = await api(access, "GET", `/me/mailFolders/sentitems/messages?$top=60&$orderby=sentDateTime desc&$select=conversationId,sentDateTime`);
  const lastSent = {};
  for (const s of sent.value || []) lastSent[s.conversationId] = Math.max(lastSent[s.conversationId] || 0, Date.parse(s.sentDateTime));
  const out = [];
  for (const m of inbox.value || []) {
    if (knownIds.has(m.id)) { out.push({ provider_id: m.id, known: true, thread_id: m.conversationId, lastSent: lastSent[m.conversationId] || 0 }); continue; }
    const attachments = [];
    if (m.hasAttachments) {
      const at = await api(access, "GET", `/me/messages/${m.id}/attachments?$select=name,contentType,size`);
      for (const a of (at.value || []).slice(0, 5)) {
        const item = { name: a.name, mime: a.contentType, size: a.size };
        const isText = /^text\//.test(a.contentType || "") || /\.(txt|csv)$/i.test(a.name);
        const isPdf = a.contentType === "application/pdf" || /\.pdf$/i.test(a.name);
        if ((isText && a.size <= 200_000) || (isPdf && a.size <= 4_000_000)) {
          const full = await api(access, "GET", `/me/messages/${m.id}/attachments/${a.id}`);
          if (full.contentBytes) { if (isText) item.text = Buffer.from(full.contentBytes, "base64").toString("utf8").slice(0, 20000); else item.pdfBase64 = full.contentBytes; }
        }
        attachments.push(item);
      }
    }
    const received = Date.parse(m.receivedDateTime);
    out.push({
      provider_id: m.id, thread_id: m.conversationId, internet_message_id: m.internetMessageId,
      from_name: m.from?.emailAddress?.name || "", from_addr: m.from?.emailAddress?.address || "",
      subject: m.subject || "(sem assunto)", body: String(m.body?.content || "").slice(0, 20000),
      received_at: received, replied: (lastSent[m.conversationId] || 0) > received, attachments
    });
  }
  return out;
}

async function createDraft(access, msg, { assunto, corpo }) {
  const d = await api(access, "POST", `/me/messages/${msg.provider_id}/createReply`, {});
  await api(access, "PATCH", `/me/messages/${d.id}`, { subject: assunto, body: { contentType: "Text", content: corpo } });
  return d.id;
}
async function updateDraft(access, draftId, msg, draft) {
  try { await api(access, "PATCH", `/me/messages/${draftId}`, { subject: draft.assunto, body: { contentType: "Text", content: draft.corpo } }); return draftId; }
  catch { return createDraft(access, msg, draft); }
}
async function applyLabels(access, msg, names) {
  const cur = await api(access, "GET", `/me/messages/${msg.provider_id}?$select=categories`);
  const keep = (cur.categories || []).filter(c => !c.startsWith("GENCO IA: "));
  await api(access, "PATCH", `/me/messages/${msg.provider_id}`, { categories: [...keep, ...names.map(n => `GENCO IA: ${n}`)] });
}

module.exports = { authUrl, exchange, refresh, fetchRecent, createDraft, updateDraft, applyLabels };
