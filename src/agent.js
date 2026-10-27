// O "cérebro" da GENCO IA: monta o contexto, oferece as ferramentas e conduz a conversa.
const ai = require("./ai");
const mail = require("./mail");
const { SECTORS } = require("./templates");
const groups = require("./groups");
const { one, all, run, now, json } = require("./db");

const PRI = ["urgente", "alta", "normal", "baixa"];
const isLate = (m, rules) => !m.replied && m.handling?.status !== "resolvido" && (now() - m.received_at) / 36e5 >= Number(rules.atraso || 4);
const hours = m => Math.round((now() - m.received_at) / 36e5 * 10) / 10;

function rulesOf(company) { return json(company.rules_json, {}); }

// Caixa em uso na conversa: a pessoal (id = id da pessoa) ou a de um grupo.
function boxFor(user, groupId) {
  if (!groupId) return { id: user.id, group: null };
  const g = groups.get(user.company_id, groupId);
  if (!groups.canSee(user, g)) throw new Error("Grupo não encontrado.");
  return { id: g.user_id, group: g };
}
const boxRules = (company, box) => box.group ? groups.rulesFor(box.group, rulesOf(company)) : rulesOf(company);
function saveRules(companyId, rules) { run("UPDATE companies SET rules_json = ? WHERE id = ?", JSON.stringify(rules), companyId); }

const ROLE = m => m.papel === "cc" ? "você está EM CÓPIA" : m.papel === "grupo" ? `chegou via grupo/lista ${m.via || ""}` : "para você";
function systemPrompt(user, company, rules, inbox, boxInfo = { group: null }, { bodyMax = 1800, title } = {}) {
  const g = boxInfo.group;
  const sector = SECTORS[company.sector] || SECTORS.geral;
  const box = inbox.map(m => `--- E-MAIL ${m.id}
De: ${m.from_name || ""} <${m.from_addr}>${g ? "" : ` · ${ROLE(m)}`}
Assunto: ${m.subject}
Recebido há ${hours(m)} h · ${m.answered_by ? `já respondido por ${m.answered_by} (colega)` : m.replied ? "já respondido" : isLate(m, rules) ? "SEM RESPOSTA, ATRASADO" : "aguardando resposta"}
${String(m.body).slice(0, bodyMax)}
${m.attachments.map(a => `[Anexo: ${a.name}]${a.text ? "\n" + String(a.text).slice(0, bodyMax) : " (conteúdo não lido)"}`).join("\n")}
${m.triage ? `[Já qualificado: ${m.triage.prioridade} · ${m.triage.categoria || ""} · responsável sugerido ${m.triage.responsavel || "-"}]` : "[Ainda não qualificado]"}${m.draft ? " [Já tem rascunho]" : ""}${g ? ` [Dono: ${m.handling.assignee || "sem dono"} · situação: ${groups.STATUS[m.handling.status] || m.handling.status}${m.handling.notes ? ` · ${m.handling.notes} nota(s) interna(s)` : ""}]` : ""}`).join("\n\n");

  const whose = g
    ? `A caixa abaixo é a do GRUPO "${g.name}"${g.address ? ` (${g.address})` : ""}, uma caixa compartilhada atendida pelos membros listados em EQUIPE. Cada e-mail tem um dono (quem está atendendo) e uma situação (novo, em andamento, aguardando terceiros, resolvido).`
    : `A caixa abaixo é a do e-mail de ${user.name}.`;
  const groupRules = g ? `
GESTÃO DO GRUPO
- "Meus e-mails" = os que têm ${user.name} como dono. "Sem dono" = ninguém assumiu ainda; destaque esses, principalmente os urgentes e atrasados.
- Para definir ou trocar o dono, use atribuir_emails (pessoa = nome exato de um membro, ou "ninguém" para tirar o dono). Se ${user.name} disser "eu assumo", atribua a ${user.name}.
- Para mudar a situação, use mudar_situacao. Para registrar algo só para a equipe (sem responder ao remetente), use nota_interna.
- Evite que duas pessoas respondam o mesmo e-mail: se já houver dono diferente de ${user.name}, avise antes de preparar resposta.
` : "";

  return `Você é a GENCO IA, assistente de e-mails da ${company.name} (${sector.descricao}).
Você conversa com ${user.name} (${user.role === "membro" ? "membro da equipe" : user.role}). ${whose}
Data e hora atual: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.

COMO CONVERSAR
- Português do Brasil, tom de colega experiente: curto, direto, sem jargão de sistema. Poucas linhas; listas só quando ajudarem.
- Ao falar de e-mails específicos, chame mostrar_emails com os ids e comente só o essencial (o cartão já mostra remetente, assunto e prioridade).
- Antes de responder sobre prioridades, responsáveis ou atrasos, garanta que os e-mails citados estejam qualificados; se não estiverem, chame registrar_qualificacao (de preferência com todos os pendentes de uma vez).
- Para escrever respostas, use criar_rascunho. Você nunca envia e-mails: os rascunhos ficam no e-mail da pessoa para revisão.
- Se a pessoa disser quem cuida do quê ou mudar critérios, use atualizar_equipe ou atualizar_criterios e confirme em uma frase.
- Não invente fatos, números, prazos ou processos que não estejam nos e-mails. Nos rascunhos, marque [confirmar ...] onde for preciso verificar.
- Ao conferir anexos, compare quantidades, preços, pesos, valores, descrições e partes entre documentos e liste cada divergência com os números dos dois lados.
${groupRules}
EQUIPE (responsável = exatamente um destes nomes)
${(rules.team || []).map(m => `- ${m.nome}: ${m.regra}`).join("\n")}
Gestor que recebe o resumo: ${rules.coord || "-"}

CRITÉRIOS DE PRIORIDADE
${rules.urg || ""}
Atraso: sem resposta há mais de ${rules.atraso || 4} horas.

TOM E ASSINATURA DOS RASCUNHOS
${rules.tom || ""}
Quem assina: ${user.name}, ${company.name}.

CATEGORIAS POSSÍVEIS: ${sector.cats.join(", ")}

${g ? "" : `PAPEL DE ${user.name.toUpperCase()} EM CADA E-MAIL
- "para você": cobra resposta normalmente.
- "em cópia": só acompanhamento. Só trate como pendência de ${user.name} se o texto pedir algo diretamente a ${user.name} (pelo nome) ou se for urgente para ela/ele.
- "via grupo/lista": chegou por um grupo do qual ${user.name} faz parte; pode ser de outra pessoa do grupo.
- "já respondido por (colega)": alguém da empresa já respondeu; não cobre de ${user.name}.
`}
${title || `CAIXA (${inbox.length} e-mails: primeiro os em aberto, depois os mais recentes)`}
${box || "(vazia)"}`;
}

function tools({ user, company, cards, box = { id: user.id, group: null } }) {
  const exists = id => !!one("SELECT 1 FROM messages WHERE user_id = ? AND id = ?", box.id, String(id));
  const canEditRules = user.role === "admin" || user.role === "gestor";
  const addCard = c => { if (!cards.some(k => k.t === c.t && k.id === c.id)) cards.push(c); };
  return [
    { name: "ler_caixa", description: "Lista os e-mails da caixa com a qualificação atual (prioridade, responsável, atraso, se tem rascunho). Use para conferir o estado depois de qualificar.",
      schema: { type: "object", properties: {} },
      execute() {
        const rules = boxRules(one("SELECT * FROM companies WHERE id = ?", company.id), box);
        return { emails: mail.inbox(box.id).map(m => ({ id: m.id, de_nome: m.from_name, assunto: m.subject, prioridade: m.triage?.prioridade || null, responsavel: m.triage?.responsavel || null, atrasado: isLate(m, rules), rascunho: !!m.draft,
          ...(box.group ? { dono: m.handling.assignee, situacao: m.handling.status, respondido: m.replied } : {}) })) };
      } },
    { name: "registrar_qualificacao", description: "Registra a qualificação de um ou mais e-mails (prioridade, categoria, responsável, motivo, tarefa, prazo, divergências documentais), aplica as etiquetas no e-mail e mostra o resumo da caixa.",
      schema: { type: "object", properties: { itens: { type: "array", items: { type: "object", properties: {
        id: { type: "string" }, prioridade: { type: "string", enum: PRI }, categoria: { type: "string" }, responsavel: { type: "string" },
        motivo: { type: "string" }, tarefa: { type: "string" }, prazo: { type: "string" }, divergencias: { type: "array", items: { type: "string" } } },
        required: ["id", "prioridade", "responsavel", "motivo"] } } }, required: ["itens"] },
      execute(input) {
        const ids = [];
        for (const it of Array.isArray(input.itens) ? input.itens : []) {
          const id = String(it.id || ""); if (!exists(id)) continue;
          run(`INSERT INTO triage (user_id, message_id, prioridade, categoria, responsavel, motivo, tarefa, prazo, divergencias_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id, message_id) DO UPDATE SET prioridade=excluded.prioridade, categoria=excluded.categoria, responsavel=excluded.responsavel, motivo=excluded.motivo, tarefa=excluded.tarefa, prazo=excluded.prazo, divergencias_json=excluded.divergencias_json, updated_at=excluded.updated_at`,
            box.id, id, PRI.includes(it.prioridade) ? it.prioridade : "normal", String(it.categoria || ""), String(it.responsavel || ""), String(it.motivo || ""), String(it.tarefa || ""), String(it.prazo || ""),
            JSON.stringify(Array.isArray(it.divergencias) ? it.divergencias.map(String) : []), now());
          ids.push(id);
        }
        if (cards) { if (!cards.some(k => k.t === "sum")) cards.unshift({ t: "sum" }); }
        const auto = box.group ? groups.autoAssign(groups.byBox(box.id)) : [];
        mail.labelMessages(box.id, ids); // em segundo plano
        return { registrados: ids.length, ...(box.group ? { atribuidos_automaticamente: auto.length } : {}) };
      } },
    { name: "mostrar_emails", description: "Mostra à pessoa os cartões dos e-mails indicados, na ordem dada. Use sempre que citar e-mails específicos.",
      schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
      execute(input) { const v = (Array.isArray(input.ids) ? input.ids : []).map(String).filter(exists); v.forEach(id => cards && addCard({ t: "mail", id })); return { exibidos: v.length }; } },
    { name: "criar_rascunho", description: "Cria ou substitui o rascunho de resposta de um e-mail, salvando-o no e-mail da pessoa como rascunho na mesma conversa. Não envia.",
      schema: { type: "object", properties: { id: { type: "string" }, assunto: { type: "string" }, corpo: { type: "string" }, ...(box.group ? { mesmo_com_outro_dono: { type: "boolean" } } : {}) }, required: ["id", "assunto", "corpo"] },
      async execute(input) {
        const id = String(input.id || ""); if (!exists(id)) throw new Error("E-mail não encontrado: " + id);
        if (box.group) {
          const h = groups.handlingOf(box.id, id);
          if (h.assignee_id && h.assignee_id !== user.id && !input.mesmo_com_outro_dono) throw new Error(`Este e-mail está com outro dono (${one("SELECT name FROM users WHERE id = ?", h.assignee_id)?.name}). Pergunte antes de preparar resposta; se a pessoa confirmar, chame de novo com mesmo_com_outro_dono = true.`);
        }
        const r = await mail.saveDraft(box.id, id, { assunto: String(input.assunto || ""), corpo: String(input.corpo || "") });
        cards && addCard({ t: "draft", id });
        return { ok: true, salvo_no_email: r.saved };
      } },
    { name: "atualizar_equipe", description: "Substitui a lista da equipe (nome e o que cada pessoa cuida) e, opcionalmente, o gestor que recebe o resumo. Envie a lista completa já com as mudanças. Só administradores e gestores podem mudar.",
      schema: { type: "object", properties: { equipe: { type: "array", items: { type: "object", properties: { nome: { type: "string" }, regra: { type: "string" } }, required: ["nome", "regra"] } }, gestor: { type: "string" } }, required: ["equipe"] },
      execute(input) {
        if (!canEditRules) throw new Error("Só administradores ou gestores podem mudar a equipe. Avise a pessoa.");
        const c = one("SELECT * FROM companies WHERE id = ?", company.id), rules = rulesOf(c);
        const team = (Array.isArray(input.equipe) ? input.equipe : []).filter(m => m?.nome).map((m, i) => ({ id: "t" + i, nome: String(m.nome), regra: String(m.regra || "") }));
        if (!team.length) throw new Error("Lista vazia.");
        rules.team = team; if (input.gestor) rules.coord = String(input.gestor);
        saveRules(company.id, rules); cards && addCard({ t: "rules" });
        return { equipe: team.length };
      } },
    { name: "atualizar_criterios", description: "Atualiza critérios de prioridade (texto completo), horas para considerar atraso e/ou tom e assinatura dos rascunhos. Só administradores e gestores podem mudar.",
      schema: { type: "object", properties: { criterios: { type: "string" }, atrasoHoras: { type: "number" }, tom: { type: "string" } } },
      execute(input) {
        if (!canEditRules) throw new Error("Só administradores ou gestores podem mudar os critérios. Avise a pessoa.");
        const c = one("SELECT * FROM companies WHERE id = ?", company.id), rules = rulesOf(c);
        if (input.criterios) rules.urg = String(input.criterios);
        if (Number(input.atrasoHoras) > 0) rules.atraso = Number(input.atrasoHoras);
        if (input.tom) rules.tom = String(input.tom);
        saveRules(company.id, rules); cards && addCard({ t: "rules" });
        return { ok: true };
      } },
    ...(box.group ? groupTools({ user, cards, box, exists, addCard }) : [])
  ];
}

function groupTools({ user, cards, box, exists, addCard }) {
  const g = () => groups.byBox(box.id);
  const ids = input => (Array.isArray(input.ids) ? input.ids : []).map(String).filter(exists);
  return [
    { name: "atribuir_emails", description: "Define quem é o dono (quem atende) de um ou mais e-mails do grupo. pessoa = nome exato de um membro do grupo, ou \"ninguém\" para deixar sem dono.",
      schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, pessoa: { type: "string" } }, required: ["ids", "pessoa"] },
      execute(input) {
        const alvo = String(input.pessoa || "").trim().toLowerCase();
        let assigneeId = null;
        if (!["ninguém", "ninguem", "sem dono", ""].includes(alvo)) {
          const m = groups.members(box.id).find(x => x.name.toLowerCase() === alvo) || groups.members(box.id).find(x => x.name.toLowerCase().startsWith(alvo));
          if (!m) throw new Error(`"${input.pessoa}" não é membro do grupo. Membros: ${groups.members(box.id).map(x => x.name).join(", ") || "nenhum"}.`);
          assigneeId = m.id;
        }
        const v = ids(input), changed = groups.setHandling(g(), v, { assigneeId }, user.id);
        mail.labelMessages(box.id, changed);
        v.forEach(id => cards && addCard({ t: "mail", id }));
        return { alterados: changed.length };
      } },
    { name: "mudar_situacao", description: "Muda a situação de um ou mais e-mails do grupo: novo, andamento (em andamento), aguardando (aguardando terceiros) ou resolvido.",
      schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, situacao: { type: "string", enum: Object.keys(groups.STATUS) } }, required: ["ids", "situacao"] },
      execute(input) {
        const v = ids(input), changed = groups.setHandling(g(), v, { status: String(input.situacao) }, user.id);
        v.forEach(id => cards && addCard({ t: "mail", id }));
        return { alterados: changed.length };
      } },
    { name: "nota_interna", description: "Registra uma nota interna num e-mail do grupo, visível só para a equipe (não é enviada ao remetente).",
      schema: { type: "object", properties: { id: { type: "string" }, texto: { type: "string" } }, required: ["id", "texto"] },
      execute(input) {
        const id = String(input.id || ""); if (!exists(id)) throw new Error("E-mail não encontrado: " + id);
        groups.addNote(g(), id, user.id, String(input.texto || ""));
        cards && addCard({ t: "mail", id });
        return { ok: true };
      } },
    { name: "ver_historico", description: "Mostra o histórico de um e-mail do grupo: quem assumiu, mudanças de situação e notas internas.",
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute(input) { const id = String(input.id || ""); if (!exists(id)) throw new Error("E-mail não encontrado: " + id); return { historico: groups.history(g(), id) }; } }
  ];
}

function history(userId, boxId, n = 12) {
  const rows = all("SELECT * FROM chats WHERE user_id = ? AND box_id IS ? ORDER BY id DESC LIMIT ?", userId, boxId, n).reverse();
  const out = rows.map(r => ({ role: r.role, content: r.role === "user" ? r.text : (r.text || "(ações registradas)") + (json(r.cards_json, []).length ? `\n[Mostrei: ${json(r.cards_json, []).map(k => k.t === "mail" ? "e-mail " + k.id : k.t === "draft" ? "rascunho " + k.id : k.t === "sum" ? "resumo da caixa" : "regras").join(", ")}]` : "") }));
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// Contexto da conversa com caixa cheia: tudo o que está em aberto (até 50, os mais importantes primeiro)
// e os 15 mais recentes, para a IA enxergar o que importa sem ler a caixa inteira.
const PRI_ORDER = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
function chatContext(boxId) {
  const all = mail.inbox(boxId, 500);
  const open = all.filter(m => !m.replied && m.handling.status !== "resolvido")
    .sort((a, b) => (PRI_ORDER[a.triage?.prioridade] ?? 2) - (PRI_ORDER[b.triage?.prioridade] ?? 2) || a.received_at - b.received_at).slice(0, 50);
  const ids = new Set(open.map(m => m.id));
  return [...open, ...all.filter(m => !ids.has(m.id)).slice(0, 15)];
}

async function chat(user, company, text, box = { id: user.id, group: null }) {
  const rules = boxRules(company, box);
  const inbox = chatContext(box.id);
  const cards = [];
  const boxKey = box.group ? box.id : null;
  run("INSERT INTO chats (user_id, box_id, role, text, cards_json, created_at) VALUES (?, ?, 'user', ?, '[]', ?)", user.id, boxKey, text, now());
  const messages = [...history(user.id, boxKey, 13).slice(0, -1), { role: "user", content: text }];
  let reply = { text: "", error: null };
  try {
    const r = await ai.run({ system: systemPrompt(user, company, rules, inbox, box, { bodyMax: 1200 }), messages, tools: tools({ user, company, cards, box }), mockState: { inbox, team: rules.team || [], me: user, group: box.group } });
    reply.text = r.text || (cards.length ? "" : "Pronto.");
    ai.recordUsage({ companyId: company.id, userId: user.id, kind: "chat", model: r.model, usage: r.usage });
  } catch (e) {
    console.error("[ia]", e.message);
    reply.error = e.message.startsWith("Chave") || e.message.startsWith("AI_PROVIDER") ? e.message : "Não consegui responder agora. Tente de novo em instantes.";
  }
  run("INSERT INTO chats (user_id, box_id, role, text, cards_json, error, created_at) VALUES (?, ?, 'assistant', ?, ?, ?, ?)", user.id, boxKey, reply.text, JSON.stringify(cards), reply.error, now());
  return { text: reply.text, cards, error: reply.error };
}

// Qualificação automática dos e-mails novos (roda em segundo plano, sem aparecer na conversa).
// Caixa cheia: só os ainda não qualificados, em lotes, com o modelo rápido, até zerar a fila.
// boxUser = a pessoa dona da caixa, ou a linha da caixa do grupo.
const BATCH = 20, MAX_BATCHES = 15;
const triaging = new Set(); // uma qualificação por caixa de cada vez
async function autoTriage(boxUser, company) {
  if (triaging.has(boxUser.id)) return -1;
  triaging.add(boxUser.id);
  try { return await triageLoop(boxUser, company); } finally { triaging.delete(boxUser.id); }
}
async function triageLoop(boxUser, company) {
  const g = boxUser.kind === "grupo" ? groups.byBox(boxUser.id) : null;
  const box = { id: boxUser.id, group: g };
  const user = g ? { ...boxUser, name: "equipe do grupo " + g.name, role: "membro" } : boxUser;
  const rules = boxRules(company, box);
  const pendingOf = () => mail.inbox(box.id, 1000).filter(m => !m.triage && !m.replied);
  let pending = pendingOf();
  for (let i = 0; i < MAX_BATCHES && pending.length; i++) {
    const lote = pending.slice(0, BATCH); // mais recentes primeiro
    const r = await ai.run({
      system: systemPrompt(user, company, rules, lote, box, { bodyMax: 1500, title: `E-MAILS PARA QUALIFICAR AGORA (${lote.length})` }),
      messages: [{ role: "user", content: `Tarefa automática: qualifique com registrar_qualificacao todos os ${lote.length} e-mails acima, numa única chamada. Não escreva rascunhos. Responda apenas 'ok'.` }],
      tools: tools({ user, company, cards: null, box }).filter(t => t.name === "registrar_qualificacao"),
      mockState: { inbox: lote, team: rules.team || [] }, maxRounds: 2, maxTokens: 8000, fast: true, allowFallback: true
    });
    ai.recordUsage({ companyId: company.id, userId: g ? null : user.id, kind: "auto", model: r.model, usage: r.usage });
    const next = pendingOf();
    if (next.length >= pending.length) break; // a IA não avançou: tenta de novo na próxima leitura
    pending = next;
  }
  return pending.length;
}

module.exports = { chat, autoTriage, rulesOf, saveRules, isLate, boxFor, boxRules };
