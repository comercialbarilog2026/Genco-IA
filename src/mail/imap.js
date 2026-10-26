// Conector "Outro provedor" (IMAP): Locaweb, UOL, Hostinger, Titan, Zoho, Yahoo, KingHost, iCloud,
// e-mail do próprio domínio e qualquer servidor com IMAP. Lê os e-mails, reconhece os já respondidos e
// grava as respostas na pasta Rascunhos da própria conta. Nunca envia nada.
const { withImap } = require("./imap-client");
const mime = require("./mime");

const DAY = 864e5;
const MAX_FULL = 12 * 1024 * 1024; // e-mails maiores: lê só o cabeçalho

// Pastas especiais: usa a marcação do servidor (\Sent, \Drafts) e cai para nomes comuns em português e inglês.
function findBox(boxes, flag, names) {
  return boxes.find(b => b.flags.includes(flag))?.name
    || boxes.find(b => names.some(n => b.name.toLowerCase() === n || b.name.toLowerCase().endsWith((b.delimiter || "/") + n)))?.name || null;
}
const SENT = ["sent", "sent items", "sent messages", "enviados", "itens enviados", "mensagens enviadas", "enviadas", "inbox.sent", "[gmail]/sent mail", "[gmail]/e-mails enviados"];
const DRAFTS = ["drafts", "rascunhos", "rascunho", "inbox.drafts", "[gmail]/drafts", "[gmail]/rascunhos"];

async function test(cfg) {
  return withImap(cfg, async c => {
    const boxes = await c.list();
    await c.select("INBOX");
    return { drafts: findBox(boxes, "\\drafts", DRAFTS), sent: findBox(boxes, "\\sent", SENT) };
  });
}

const internalSkip = new Map(); // ids de mensagens da própria equipe já vistas (não relê a cada ciclo)
const notForGroup = new Set();  // ids que não são do grupo (caixa pessoal de quem conectou)

// Mesmo formato do conector Gmail: { provider_id, thread_id, from_*, subject, body, received_at, replied, attachments }
async function fetchRecent(cfg, { days = 7, max = 40, knownIds = new Set(), internal = null, teamDomain = "", groupAddress = "" } = {}) {
  return withImap(cfg, async c => {
    const boxes = await c.list();
    const sentBox = findBox(boxes, "\\sent", SENT);
    const since = Date.now() - days * DAY;

    // 1) O que já foi respondido: mensagens da pasta Enviados que respondem a outras.
    const answeredIds = new Set();
    if (sentBox) {
      try {
        await c.select(sentBox);
        const uids = (await c.searchSince(since - 2 * DAY)).slice(-80);
        for (const f of await c.fetch(uids, "UID BODY.PEEK[HEADER.FIELDS (IN-REPLY-TO REFERENCES)]")) {
          const h = mime.parse(f.body || Buffer.alloc(0));
          if (h.inReplyTo) answeredIds.add(h.inReplyTo);
          h.references.forEach(r => answeredIds.add(r));
        }
      } catch { /* pasta de enviados ilegível: segue sem ela */ }
    }

    // 2) Caixa de entrada.
    const { uidValidity } = await c.select("INBOX");
    const all = (await c.searchSince(since)).slice(-Math.max(max * 3, 60));
    const pid = uid => `imap:${uidValidity}:${uid}`;
    const heads = await c.fetch(all, "UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES DELIVERED-TO X-ORIGINAL-TO LIST-ID DATE)]");
    heads.sort((a, b) => b.uid - a.uid);
    const teamSeen = new Map();
    const out = [], toRead = [];
    for (const f of heads) {
      const id = pid(f.uid), h = mime.parse(f.body || Buffer.alloc(0));
      const answered = f.flags.includes("\\answered") || answeredIds.has(h.messageId);
      if (knownIds.has(id)) { out.push({ provider_id: id, known: true, lastSent: answered ? Date.now() : 0 }); continue; }
      if (notForGroup.has(id)) continue;
      // Grupo lido pela conta de um dos membros: só o que foi enviado para o endereço do grupo.
      if (groupAddress) {
        const g = groupAddress.toLowerCase();
        const toGroup = [...h.to, ...h.cc].some(a => a.addr === g) || h.deliveredTo.includes(g) || h.listId.includes(g.replace("@", "."));
        if (!toGroup) { notForGroup.add(id); continue; }
      }
      const fromAddr = h.from.addr;
      const isTeamReply = teamDomain && fromAddr.endsWith("@" + teamDomain) && !!h.inReplyTo;
      if (isTeamReply) teamSeen.set(fromAddr, { email: fromAddr, name: h.from.name });
      if (internal && (internal.has(fromAddr) || isTeamReply)) {
        // resposta de alguém da equipe: marca a conversa como respondida
        if (h.inReplyTo) answeredIds.add(h.inReplyTo); h.references.forEach(r => answeredIds.add(r));
        internalSkip.set(id, true); continue;
      }
      if (toRead.length < max) toRead.push({ f, h, id });
    }

    // 3) Conteúdo completo só dos novos.
    const small = toRead.filter(x => x.f.size <= MAX_FULL).map(x => x.f.uid);
    const full = new Map((await c.fetch(small, "UID BODY.PEEK[]")).map(f => [f.uid, f.body]));
    for (const { f, h, id } of toRead) {
      const raw = full.get(f.uid);
      const m = raw ? mime.parse(raw) : h;
      const received = f.internalDate || m.date || Date.now();
      const attachments = (m.attachments || []).slice(0, 5).map(a => {
        const item = { name: a.name, mime: a.mime, size: a.content.length };
        if ((/^text\//.test(a.mime) || /\.(txt|csv)$/i.test(a.name)) && a.content.length <= 200_000) item.text = mime.decodeCharset(a.content, a.charset).slice(0, 20000);
        else if ((a.mime === "application/pdf" || /\.pdf$/i.test(a.name)) && a.content.length <= 4_000_000) item.pdfBase64 = a.content.toString("base64");
        return item;
      });
      out.push({
        provider_id: id,
        thread_id: m.references[0] || m.inReplyTo || m.messageId || id,
        internet_message_id: m.messageId,
        references: m.references.join(" "),
        from_name: m.from.name, from_addr: m.from.addr,
        subject: m.subject || "(sem assunto)",
        body: raw ? String(m.body || "").slice(0, 20000) : "(E-mail muito grande para ler aqui. Abra no seu e-mail.)",
        received_at: received,
        replied: f.flags.includes("\\answered") || answeredIds.has(m.messageId),
        attachments
      });
    }
    out.teamSeen = [...teamSeen.values()];
    return out;
  });
}

// Grava a resposta como rascunho na pasta Rascunhos da própria conta (na mesma conversa).
async function createDraft(cfg, msg, draft) {
  return withImap(cfg, async c => {
    const box = findBox(await c.list(), "\\drafts", DRAFTS);
    if (!box) throw new Error("Não encontrei a pasta de rascunhos nesta conta.");
    const r = await c.append(box, mime.buildReply(msg, draft, cfg.address || cfg.user));
    return JSON.stringify({ box, uid: r?.uid || null });
  });
}
async function updateDraft(cfg, draftId, msg, draft) {
  try {
    const d = JSON.parse(draftId || "{}");
    if (d.box && d.uid) await withImap(cfg, async c => { await c.select(d.box, { readOnly: false }); await c.deleteUid(d.uid); });
  } catch { /* rascunho antigo já apagado pela pessoa */ }
  return createDraft(cfg, msg, draft);
}

// IMAP não tem etiquetas padronizadas entre provedores: a qualificação fica no app.
async function applyLabels() {}

module.exports = { test, fetchRecent, createDraft, updateDraft, applyLabels, findBox };
