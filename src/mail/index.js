// Orquestra as contas de e-mail: tokens, leitura periódica, rascunhos e etiquetas.
const config = require("../config");
const { one, all, run, now, json } = require("../db");
const { encrypt, decrypt } = require("../security");
const gmail = require("./gmail");
const outlook = require("./outlook");
const demo = require("./demo");
const imap = require("./imap");
const { discover } = require("./discover");

// gmail e outlook: acesso oficial (OAuth). imap: qualquer outro provedor, com e-mail e senha.
const PROVIDERS = { gmail, outlook, imap };

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
  // IMAP: o "token" é a configuração do servidor com a senha, guardada criptografada.
  if (acc.provider === "imap") return JSON.parse(decrypt(acc.access_token_enc) || "{}");
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
  const filtering = !!addr && addr !== String(acc.address || "").toLowerCase();
  return { query, internal, teamDomain: addr.includes("@") ? addr.split("@")[1] : "", groupAddress: filtering ? addr : "" };
}

// Separa automaticamente as pessoas do grupo: membros do grupo no Google (quando permitido) e
// quem da equipe responde nas conversas do grupo.
async function detectMembers(userId, acc, teamSeen = []) {
  const groups = require("../groups");
  const g = groups.byBox(userId);
  if (!g) return [];
  const added = [];
  if (acc.provider === "gmail" && g.address) {
    try { added.push(...groups.addDetected(g, await gmail.listGroupMembers(await accessToken(acc), g.address), "google")); }
    catch (e) { if (e.status !== 403 && e.status !== 404) console.error("[membros]", e.message); }
  }
  if (teamSeen.length) added.push(...groups.addDetected(g, teamSeen, acc.provider === "demo" ? "demo" : "email"));
  if (added.length) require("../billing").syncSeats(g.company_id);
  return added;
}

// Conecta qualquer provedor por IMAP: descobre o servidor (ou usa o informado), testa o login e guarda.
async function connectImap(userId, opts) {
  const cfg = await resolveImap(opts);
  saveOrRefresh(userId, "imap", { access: JSON.stringify(cfg), refresh: null, address: cfg.address });
  return { host: cfg.host, port: cfg.port };
}
// Mesma conta de e-mail de antes: só renova o acesso, sem apagar o que já foi lido e qualificado.
function saveOrRefresh(userId, provider, t) {
  const cur = account(userId);
  if (cur && cur.provider === provider && String(cur.address || "").toLowerCase() === String(t.address || "").toLowerCase()) {
    run("UPDATE mail_accounts SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), expires_at = ?, last_error = NULL WHERE user_id = ?",
      encrypt(t.access), t.refresh ? encrypt(t.refresh) : null, t.expiresAt || null, userId);
  } else saveAccount(userId, provider, t);
}
// Descobre o servidor e confere o login no próprio provedor. Devolve a configuração pronta para guardar.
async function resolveImap({ email, senha, host, port, secure }) {
  email = String(email || "").trim().toLowerCase(); senha = String(senha || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !senha) throw Object.assign(new Error("Informe o e-mail e a senha."), { status: 400 });
  const found = host ? { candidates: [{ host: String(host).trim(), port: Number(port) || 993, secure: secure !== false && Number(port) !== 143 }] } : await discover(email);
  let lastErr = null;
  for (const c of found.candidates.slice(0, 6)) {
    const cfg = { host: c.host, port: c.port, secure: c.secure, user: email, pass: senha, address: email };
    try {
      await imap.test(cfg);
      return cfg;
    } catch (e) {
      lastErr = e;
      if (e.kind === "auth") break; // servidor certo, senha recusada: não adianta tentar outros
    }
  }
  const hint = found.oauth === "gmail" ? " Para Gmail, prefira o botão Gmail; por senha, use uma senha de app."
    : found.oauth === "outlook" ? " Para Outlook e Microsoft 365, use o botão Outlook." : found.appPassword ? " Este provedor exige uma senha de app (gerada nas configurações de segurança da conta)." : "";
  const msg = lastErr?.kind === "auth" ? lastErr.message : (host ? (lastErr?.message || "Não foi possível conectar.") : "Não consegui encontrar o servidor deste e-mail sozinho. Informe o servidor IMAP em \"Configurações avançadas\" (o provedor de e-mail informa).");
  throw Object.assign(new Error(msg + hint), { status: 400, needsAdvanced: !host && lastErr?.kind !== "auth" });
}

function nextShortId(userId) {
  const r = one("SELECT MAX(CAST(SUBSTR(id, 2) AS INTEGER)) AS n FROM messages WHERE user_id = ?", userId);
  return (r?.n || 0) + 1;
}

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|uol|bol|terra|ig|zoho|zohomail|aol|gmx|proton|protonmail)\./i;

// Quem é "da casa" para a caixa pessoal: o próprio endereço, colegas cadastrados na mesma empresa
// e qualquer endereço do mesmo domínio corporativo (ex.: @brcomexx.com.br).
function ownerContext(userId, acc) {
  const u = one("SELECT * FROM users WHERE id = ?", userId);
  if (!u || u.kind === "grupo") return null;
  const me = String(acc.address || u.email || "").toLowerCase();
  const mine = new Set([me, String(u.email || "").toLowerCase()].filter(Boolean));
  const domain = me.split("@")[1] || "";
  const colleagues = new Map(all("SELECT name, email FROM users WHERE company_id = ? AND kind = 'pessoa' AND id != ?", u.company_id, u.id).map(r => [r.email.toLowerCase(), r.name]));
  return { mine, domain: domain && !FREE_MAIL.test(domain) ? domain : "", colleagues };
}
const isColleague = (ctx, addr) => !ctx.mine.has(addr) && (ctx.colleagues.has(addr) || (ctx.domain && addr.endsWith("@" + ctx.domain)));

// Para mim, em cópia ou via grupo/lista.
function roleOf(ctx, m) {
  if (!ctx || !m.to) return { papel: "para", via: null };
  const to = (m.to || []).map(a => a.toLowerCase()), cc = (m.cc || []).map(a => a.toLowerCase());
  if (to.some(a => ctx.mine.has(a))) return { papel: "para", via: null };
  if (cc.some(a => ctx.mine.has(a))) return { papel: "cc", via: null };
  // Não estou em Para nem em Cópia: chegou por um grupo/lista (ex.: compras@) ou cópia oculta.
  const group = [...to, ...cc].find(a => !ctx.mine.has(a) && ctx.domain && a.endsWith("@" + ctx.domain)) || to[0] || null;
  return group ? { papel: "grupo", via: group } : { papel: "para", via: null };
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
    const ctx = ownerContext(userId, acc);
    const added = [];
    let n = nextShortId(userId);
    // Mais antigos primeiro: os ids curtos seguem a ordem de chegada e a "resposta do colega" acha a conversa.
    const fresh = list.filter(m => !m.known).sort((a, b) => a.received_at - b.received_at);
    for (const m of list) if (m.known && m.lastSent) run("UPDATE messages SET replied = 1 WHERE user_id = ? AND provider_id = ? AND received_at < ?", userId, m.provider_id, m.lastSent);
    for (const m of fresh) {
      const attachments = [];
      for (const a of m.attachments || []) {
        let text = a.text || null;
        if (!text && a.pdfBase64 && ai?.extractPdf) {
          try { text = await ai.extractPdf(a.pdfBase64, { userId }); } catch (e) { text = null; }
        }
        attachments.push({ name: a.name, mime: a.mime, size: a.size, text: text ? String(text).slice(0, 20000) : null });
      }
      const id = "m" + n++;
      const role = roleOf(ctx, m);
      run(`INSERT OR IGNORE INTO messages (user_id, id, provider_id, thread_id, internet_message_id, from_name, from_addr, subject, body, received_at, replied, attachments_json, synced_at, papel, via)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        userId, id, m.provider_id, m.thread_id || null, m.internet_message_id || null, m.from_name || "", m.from_addr || "", m.subject || "", m.body || "", m.received_at, m.replied ? 1 : 0, JSON.stringify(attachments), now(), role.papel, role.via);
      added.push(id);
      // Um colega da empresa respondeu nesta conversa: o que veio antes dele já foi atendido.
      const from = String(m.from_addr || "").toLowerCase();
      if (ctx && m.thread_id && isColleague(ctx, from)) {
        const who = ctx.colleagues.get(from) || m.from_name || from.split("@")[0];
        run(`UPDATE messages SET answered_by = ?, answered_at = ? WHERE user_id = ? AND thread_id = ? AND received_at < ? AND replied = 0
               AND (answered_at IS NULL OR answered_at < ?) AND id != ?`, who, m.received_at, userId, m.thread_id, m.received_at, m.received_at, id);
        // A própria mensagem do colega é só acompanhamento, a não ser que seja dirigida a mim.
        if (role.papel !== "para" && m.in_reply_to) run("UPDATE messages SET answered_by = ?, answered_at = ? WHERE user_id = ? AND id = ?", who, m.received_at, userId, id);
      }
    }
    autoResolve(userId);
    run("UPDATE mail_accounts SET last_sync_at = ?, last_error = NULL WHERE user_id = ?", now(), userId);
    const newPeople = await detectMembers(userId, acc, list.teamSeen || []);
    return { added, newPeople };
  } catch (e) {
    run("UPDATE mail_accounts SET last_error = ? WHERE user_id = ?", e.message, userId);
    return { added: [], error: e.message };
  }
}

// Concluído = resolvido, ou respondido (por mim ou por um colega) sem estar aguardando terceiros.
// A listagem mostra só o que está pendente; os concluídos saem da tela e depois são apagados (prune).
const DONE_SQL = `(COALESCE(h.status, 'novo') = 'resolvido' OR ((m.replied = 1 OR m.answered_by IS NOT NULL) AND COALESCE(h.status, 'novo') != 'aguardando'))`;
// Respondido (por mim ou por alguém da equipe) = resolvido automaticamente, a não ser que esteja aguardando terceiros.
function autoResolve(userId) {
  run(`INSERT INTO handling (box_id, message_id, assignee_id, status, updated_by, updated_at)
       SELECT m.user_id, m.id, NULL, 'resolvido', NULL, ? FROM messages m
       LEFT JOIN handling h ON h.box_id = m.user_id AND h.message_id = m.id
       WHERE m.user_id = ? AND (m.replied = 1 OR m.answered_by IS NOT NULL) AND COALESCE(h.status, 'novo') IN ('novo', 'andamento')
       ON CONFLICT(box_id, message_id) DO UPDATE SET status = 'resolvido', updated_at = excluded.updated_at`, now(), userId);
}

// Limpeza para não pesar: concluídos perdem o conteúdo depois de 1 dia e são apagados depois de 10
// (a leitura só olha os últimos 7 dias, então não voltam). Pendentes nunca são apagados.
function prune() {
  const t = now(), day = 864e5;
  const doneIds = `SELECT m.user_id, m.id FROM messages m LEFT JOIN handling h ON h.box_id = m.user_id AND h.message_id = m.id WHERE ${DONE_SQL}`;
  run(`UPDATE messages SET body = '', attachments_json = '[]' WHERE body != '' AND (user_id, id) IN (${doneIds} AND COALESCE(h.updated_at, m.synced_at) < ?)`, t - day);
  const old = all(`${doneIds} AND m.received_at < ?`, t - 10 * day);
  for (const r of old) {
    run("DELETE FROM triage WHERE user_id = ? AND message_id = ?", r.user_id, r.id);
    run("DELETE FROM drafts WHERE user_id = ? AND message_id = ?", r.user_id, r.id);
    run("DELETE FROM events WHERE box_id = ? AND message_id = ?", r.user_id, r.id);
    run("DELETE FROM handling WHERE box_id = ? AND message_id = ?", r.user_id, r.id);
    run("DELETE FROM messages WHERE user_id = ? AND id = ?", r.user_id, r.id);
  }
  // Conversas antigas com a IA (mais de 30 dias).
  run("DELETE FROM chats WHERE created_at < ?", t - 30 * day);
  return old.length;
}

function inbox(userId, limit = 60, { bodyMax = 0, includeDone = false } = {}) {
  return all(`SELECT m.*, t.prioridade, t.categoria, t.responsavel, t.motivo, t.tarefa, t.prazo, t.divergencias_json,
                     d.assunto AS draft_assunto, d.corpo AS draft_corpo, d.saved_to_mailbox,
                     h.assignee_id, h.status AS h_status, h.updated_at AS h_updated, a.name AS assignee_name,
                     (SELECT COUNT(*) FROM events e WHERE e.box_id = m.user_id AND e.message_id = m.id AND e.kind = 'nota') AS notes
              FROM messages m
              LEFT JOIN triage t ON t.user_id = m.user_id AND t.message_id = m.id
              LEFT JOIN drafts d ON d.user_id = m.user_id AND d.message_id = m.id
              LEFT JOIN handling h ON h.box_id = m.user_id AND h.message_id = m.id
              LEFT JOIN users a ON a.id = h.assignee_id
              WHERE m.user_id = ? ${includeDone ? "" : `AND NOT ${DONE_SQL}`} ORDER BY m.received_at DESC LIMIT ?`, userId, limit)
    .map(r => ({
      id: r.id, thread_id: r.thread_id || r.id, from_name: r.from_name, from_addr: r.from_addr, subject: r.subject, body: bodyMax ? String(r.body || "").slice(0, bodyMax) : r.body, received_at: r.received_at,
      replied: !!r.replied || !!r.answered_by, answered_by: r.replied ? null : (r.answered_by || null), papel: r.papel || "para", via: r.via || null,
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

module.exports = { prune, autoResolve, connectImap, resolveImap, saveOrRefresh, discover, detectMembers, PROVIDERS, account, saveAccount, disconnect, clearBox, sync, inbox, saveDraft, labelMessages, accessToken };
