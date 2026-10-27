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

async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function pages(access, url, cap, headers) {
  const all = [];
  while (url && all.length < cap) { const d = await api(access, "GET", url, null, headers); all.push(...(d.value || [])); url = d["@odata.nextLink"] || ""; }
  return all.slice(0, cap);
}
const addrs = list => (list || []).map(r => String(r.emailAddress?.address || "").toLowerCase()).filter(Boolean);

// Todos os e-mails novos (não só os últimos): primeiro a lista leve, depois o conteúdo só dos novos.
async function fetchRecent(access, { days = 7, max = 300, knownIds = new Set() } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const textPref = { Prefer: 'outlook.body-content-type="text"' };
  const refs = await pages(access, `/me/mailFolders/inbox/messages?$top=200&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${since}&$select=id,conversationId,receivedDateTime`, 3000);
  const sent = await pages(access, `/me/mailFolders/sentitems/messages?$top=200&$orderby=sentDateTime desc&$filter=sentDateTime ge ${new Date(Date.now() - (days + 2) * 864e5).toISOString()}&$select=conversationId,sentDateTime`, 1500);
  const lastSent = {};
  for (const s of sent) lastSent[s.conversationId] = Math.max(lastSent[s.conversationId] || 0, Date.parse(s.sentDateTime));
  const out = [], fresh = [];
  for (const r of refs) {
    if (knownIds.has(r.id)) { out.push({ provider_id: r.id, known: true, thread_id: r.conversationId, lastSent: lastSent[r.conversationId] || 0 }); continue; }
    if (fresh.length < max) fresh.push(r);
  }
  const full = await pmap(fresh, 8, r => api(access, "GET", `/me/messages/${r.id}?$select=id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,internetMessageHeaders`, null, textPref).catch(e => { console.error("[outlook]", e.message); return null; }));
  for (const m of full) {
    if (!m) continue;
    const attachments = [];
    if (m.hasAttachments) {
      try {
        const at = await api(access, "GET", `/me/messages/${m.id}/attachments?$select=name,contentType,size`);
        for (const a of (at.value || []).slice(0, 5)) {
          const item = { name: a.name, mime: a.contentType, size: a.size };
          const isText = /^text\//.test(a.contentType || "") || /\.(txt|csv)$/i.test(a.name);
          const isPdf = a.contentType === "application/pdf" || /\.pdf$/i.test(a.name);
          if ((isText && a.size <= 200_000) || (isPdf && a.size <= 4_000_000)) {
            const f = await api(access, "GET", `/me/messages/${m.id}/attachments/${a.id}`);
            if (f.contentBytes) { if (isText) item.text = Buffer.from(f.contentBytes, "base64").toString("utf8").slice(0, 20000); else item.pdfBase64 = f.contentBytes; }
          }
          attachments.push(item);
        }
      } catch (e) { console.error("[outlook anexo]", e.message); }
    }
    const hdr = n => (m.internetMessageHeaders || []).filter(h => h.name.toLowerCase() === n).map(h => String(h.value).toLowerCase());
    const received = Date.parse(m.receivedDateTime);
    out.push({
      provider_id: m.id, thread_id: m.conversationId, internet_message_id: m.internetMessageId,
      from_name: m.from?.emailAddress?.name || "", from_addr: m.from?.emailAddress?.address || "",
      subject: m.subject || "(sem assunto)", body: String(m.body?.content || "").slice(0, 20000),
      received_at: received, replied: (lastSent[m.conversationId] || 0) > received, attachments,
      to: addrs(m.toRecipients), cc: addrs(m.ccRecipients),
      delivered: [...hdr("delivered-to"), ...hdr("x-original-to"), ...hdr("list-id")], in_reply_to: hdr("in-reply-to")[0] || ""
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
