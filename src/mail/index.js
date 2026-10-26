// Orquestra as contas de e-mail: tokens, leitura periódica, rascunhos e etiquetas.
const config = require("../config");
const { one, all, run, now, json } = require("../db");
const { encrypt, decrypt } = require("../security");
const gmail = require("./gmail");
const outlook = require("./outlook");
const demo = require("./demo");

const PROVIDERS = { gmail, outlook };

function account(userId) { return one("SELECT * FROM mail_accounts WHERE user_id = ?", userId); }

function saveAccount(userId, provider, t, extra = {}) {
  run(`INSERT INTO mail_accounts (user_id, provider, address, access_token_enc, refresh_token_enc, expires_at, demo_sector, last_sync_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, address = excluded.address, access_token_enc = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at, demo_sector = excluded.demo_sector, last_sync_at = NULL, last_error = NULL`,
    userId, provider, t.address || extra.address || null, encrypt(t.access), encrypt(t.refresh), t.expiresAt || null, extra.demoSector || null);
  // Trocar de conta limpa o que era da conta anterior.
  clearBox(userId);
}
function clearBox(userId) {
  ["messages", "triage", "drafts"].forEach(tbl => run(`DELETE FROM ${tbl} WHERE user_id = ?`, userId));
  ["handling", "events"].forEach(tbl => run(`DELETE FROM ${tbl} WHERE box_id = ?`, userId));
}

function disconnect(userId) {
  run("DELETE FROM mail_accounts WHERE user_id = ?", userId);
  clearBox(userId);
}

async function accessToken(acc) {
  const p = PROVIDERS[acc.provider];
  if (acc.expires_at && acc.expires_at > now()) return decrypt(acc.access_token_enc);
  const r = await p.refresh(decrypt(acc.refresh_token_enc));
  run("UPDATE mail_accounts SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ? WHERE user_id = ?", encrypt(r.access), encrypt(r.refresh), r.expiresAt, acc.user_id);
  return r.access;
}

// Caixa de grupo: lê só o que chega para o endereço do grupo e reconhece as respostas da equipe.
// Ex.: grupo do Google Groups "operacional@empresa.com.br" lido pela conta de um dos membros.
function groupFetchOptions(userId, acc) {
  const g = one("SELECT * FROM groups WHERE user_id = ?", userId);
  if (!g) return {};
  const addr = String(g.address || "").trim().toLowerCase();
  let query = String(g.filtro || "").trim();
  // Só filtra quando a conta conectada não é a própria caixa do grupo.
  if (!query && addr && addr !== String(acc.address || "").toLowerCase()) query = `{to:${addr} cc:${addr} list:${addr} deliveredto:${addr}}`;
  const internal = new Set(all("SELECT u.email FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?", userId).map(r => r.email.toLowerCase()));
  if (addr) internal.add(addr);
  if (acc.address && acc.address.includes("@")) internal.add(acc.address.toLowerCase());
  return { query, internal };
}

function nextShortId(userId) {
  const r = one("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS n FROM messages WHERE user_id = ?", userId);
  return (r?.n || 0) + 1;
}

// Busca e-mails novos e grava no banco. Retorna os ids curtos dos novos.
async function sync(userId, { ai } = {}) {
  const acc = account(userId);
  if (!acc) return { added: [], error: "Nenhum e-mail conectado." };
  const known = new Set(all("SELECT provider_id FROM messages WHERE user_id = ?", userId).map(r => r.provider_id));
  try {
    let list;
    const opts = { knownIds: known, ...groupFetchOptions(userId, acc) };
    if (acc.provider === "demo") list = await demo.fetchRecent(acc.demo_sector, opts);
    else list = await PROVIDERS[acc.provider].fetchRecent(await accessToken(acc), opts);
    const added = [];
    let n = nextShortId(userId);
    for (const m of list) {
      if (m.known) {
        if (m.lastSent) run("UPDATE messages SET replied = 1 WHERE user_id = ? AND provider_id = ? AND received_at < ?", userId, m.provider_id, m.lastSent);
        continue;
      }
      const attachments = [];
      for (const a of m.attachments || []) {
        let text = a.text || null;
        if (!text && a.pdfBase64 && ai?.extractPdf) {
          try { text = await ai.extractPdf(a.pdfBase64, { userId }); } catch (e) { text = null; }
        }
        attachments.push({ name: a.name, mime: a.mime, size: a.size, text: text ? String(text).slice(0, 20000) : null });
      }
      const id = "m" + n++;
      run(`INSERT OR IGNORE INTO messages (user_id, id, provider_id, thread_id, internet_message_id, from_name, from_addr, subject, body, received_at, replied, attachments_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId, id, m.provider_id, m.thread_id || null, m.internet_message_id || null, m.from_name || "", m.from_addr || "", m.subject || "", m.body || "", m.received_at, m.replied ? 1 : 0, JSON.stringify(attachments), now());
      added.push(id);
    }
    run("UPDATE mail_accounts SET last_sync_at = ?, last_error = NULL WHERE user_id = ?", now(), userId);
    return { added };
  } catch (e) {
    run("UPDATE mail_accounts SET last_error = ? WHERE user_id = ?", e.message, userId);
    return { added: [], error: e.message };
  }
}

function inbox(userId, limit = 60) {
  return all(`SELECT m.*, t.prioridade, t.categoria, t.responsavel, t.motivo, t.tarefa, t.prazo, t.divergencias_json,
                     d.assunto AS draft_assunto, d.corpo AS draft_corpo, d.saved_to_mailbox,
                     h.assignee_id, h.status AS h_status, h.updated_at AS h_updated, a.name AS assignee_name,
                     (SELECT COUNT(*) FROM events e WHERE e.box_id = m.user_id AND e.message_id = m.id AND e.kind = 'nota') AS notes
              FROM messages m
              LEFT JOIN triage t ON t.user_id = m.user_id AND t.message_id = m.id
              LEFT JOIN drafts d ON d.user_id = m.user_id AND d.message_id = m.id
              LEFT JOIN handling h ON h.box_id = m.user_id AND h.message_id = m.id
              LEFT JOIN users a ON a.id = h.assignee_id
              WHERE m.user_id = ? ORDER BY m.received_at DESC LIMIT ?`, userId, limit)
    .map(r => ({
      id: r.id, from_name: r.from_name, from_addr: r.from_addr, subject: r.subject, body: r.body, received_at: r.received_at, replied: !!r.replied,
      attachments: json(r.attachments_json, []),
      triage: r.prioridade ? { prioridade: r.prioridade, categoria: r.categoria, responsavel: r.responsavel, motivo: r.motivo, tarefa: r.tarefa, prazo: r.prazo, divergencias: json(r.divergencias_json, []) } : null,
      draft: r.draft_corpo != null ? { assunto: r.draft_assunto, corpo: r.draft_corpo, saved: !!r.saved_to_mailbox } : null,
      handling: { assignee_id: r.assignee_id || null, assignee: r.assignee_name || null, status: r.h_status || "novo", updated_at: r.h_updated || null, notes: r.notes || 0 }
    }));
}

// Grava o rascunho no próprio e-mail (Gmail/Outlook). Na caixa demo fica só no app.
async function saveDraft(userId, messageId, draft) {
  const msg = one("SELECT * FROM messages WHERE user_id = ? AND id = ?", userId, messageId);
  if (!msg) throw new Error("E-mail não encontrado: " + messageId);
  const prev = one("SELECT * FROM drafts WHERE user_id = ? AND message_id = ?", userId, messageId);
  const acc = account(userId);
  let providerId = prev?.provider_draft_id || null, saved = 0;
  if (acc && acc.provider !== "demo") {
    try {
      const p = PROVIDERS[acc.provider], tok = await accessToken(acc);
      providerId = providerId ? await p.updateDraft(tok, providerId, msg, draft) : await p.createDraft(tok, msg, draft);
      saved = 1;
    } catch (e) { console.error("[rascunho]", e.message); }
  }
  run(`INSERT INTO drafts (user_id, message_id, assunto, corpo, provider_draft_id, saved_to_mailbox, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, message_id) DO UPDATE SET assunto = excluded.assunto, corpo = excluded.corpo, provider_draft_id = excluded.provider_draft_id, saved_to_mailbox = excluded.saved_to_mailbox, updated_at = excluded.updated_at`,
    userId, messageId, draft.assunto, draft.corpo, providerId, saved, now());
  return { saved: !!saved, demo: acc?.provider === "demo" };
}

const PRI_LABEL = { urgente: "Urgente", alta: "Alta", normal: "Normal", baixa: "Baixa" };
async function labelMessages(userId, ids) {
  const acc = account(userId);
  if (!acc || acc.provider === "demo") return;
  const p = PROVIDERS[acc.provider];
  try {
    const tok = await accessToken(acc);
    for (const id of ids) {
      const m = one(`SELECT m.*, t.prioridade, t.responsavel, a.name AS dono FROM messages m JOIN triage t ON t.user_id = m.user_id AND t.message_id = m.id
                     LEFT JOIN handling h ON h.box_id = m.user_id AND h.message_id = m.id LEFT JOIN users a ON a.id = h.assignee_id
                     WHERE m.user_id = ? AND m.id = ?`, userId, id);
      if (!m) continue;
      const labels = [PRI_LABEL[m.prioridade] || "Normal"]; const who = m.dono || m.responsavel; if (who) labels.push(who);
      await p.applyLabels(tok, m, labels);
    }
  } catch (e) { console.error("[etiquetas]", e.message); }
}

module.exports = { PROVIDERS, account, saveAccount, disconnect, clearBox, sync, inbox, saveDraft, labelMessages, accessToken };
