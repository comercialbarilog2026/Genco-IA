// O "cérebro" da GENCO IA: monta o contexto, oferece as ferramentas e conduz a conversa.
const ai = require("./ai");
const mail = require("./mail");
const { SECTORS } = require("./templates");
const { one, all, run, now, json } = require("./db");

const PRI = ["urgente", "alta", "normal", "baixa"];
const isLate = (m, rules) => !m.replied && (now() - m.received_at) / 36e5 >= Number(rules.atraso || 4);
const hours = m => Math.round((now() - m.received_at) / 36e5 * 10) / 10;

function rulesOf(company) { return json(company.rules_json, {}); }
function saveRules(companyId, rules) { run("UPDATE companies SET rules_json = ? WHERE id = ?", JSON.stringify(rules), companyId); }

function systemPrompt(user, company, rules, inbox) {
  const sector = SECTORS[company.sector] || SECTORS.geral;
  const box = inbox.map(m => `--- E-MAIL ${m.id}
De: ${m.from_name || ""} <${m.from_addr}>
Assunto: ${m.subject}
Recebido há ${hours(m)} h · ${m.replied ? "já respondido" : isLate(m, rules) ? "SEM RESPOSTA, ATRASADO" : "aguardando resposta"}
${String(m.body).slice(0, 1800)}
${m.attachments.map(a => `[Anexo: ${a.name}]${a.text ? "\n" + String(a.text).slice(0, 1800) : " (conteúdo não lido)"}`).join("\n")}
${m.triage ? `[Já qualificado: ${m.triage.prioridade} · ${m.triage.categoria || ""} · responsável ${m.triage.responsavel || "-"}]` : "[Ainda não qualificado]"}${m.draft ? " [Já tem rascunho]" : ""}`).join("\n\n");

  return `Você é a GENCO IA, assistente de e-mails da ${company.name} (${sector.descricao}).
Você conversa com ${user.name} (${user.role === "membro" ? "membro da equipe" : user.role}). A caixa abaixo é a do e-mail de ${user.name}.
Data e hora atual: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.

COMO CONVERSAR
- Português do Brasil, tom de colega experiente: curto, direto, sem jargão de sistema. Poucas linhas; listas só quando ajudarem.
- Ao falar de e-mails específicos, chame mostrar_emails com os ids e comente só o essencial (o cartão já mostra remetente, assunto e prioridade).
- Antes de responder sobre prioridades, responsáveis ou atrasos, garanta que os e-mails citados estejam qualificados; se não estiverem, chame registrar_qualificacao (de preferência com todos os pendentes de uma vez).
- Para escrever respostas, use criar_rascunho. Você nunca envia e-mails: os rascunhos ficam no e-mail da pessoa para revisão.
- Se a pessoa disser quem cuida do quê ou mudar critérios, use atualizar_equipe ou atualizar_criterios e confirme em uma frase.
- Não invente fatos, números, prazos ou processos que não estejam nos e-mails. Nos rascunhos, marque [confirmar ...] onde for preciso verificar.
- Ao conferir anexos, compare quantidades, preços, pesos, valores, descrições e partes entre documentos e liste cada divergência com os números dos dois lados.

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

CAIXA (${inbox.length} e-mails mais recentes)
${box || "(vazia)"}`;
}

function tools({ user, company, cards }) {
  const exists = id => !!one("SELECT 1 FROM messages WHERE user_id = ? AND id = ?", user.id, String(id));
  const canEditRules = user.role === "admin" || user.role === "gestor";
  const addCard = c => { if (!cards.some(k => k.t === c.t && k.id === c.id)) cards.push(c); };
  return [
    { name: "ler_caixa", description: "Lista os e-mails da caixa com a qualificação atual (prioridade, responsável, atraso, se tem rascunho). Use para conferir o estado depois de qualificar.",
      schema: { type: "object", properties: {} },
      execute() {
        const rules = rulesOf(one("SELECT * FROM companies WHERE id = ?", company.id));
        return { emails: mail.inbox(user.id).map(m => ({ id: m.id, de_nome: m.from_name, assunto: m.subject, prioridade: m.triage?.prioridade || null, responsavel: m.triage?.responsavel || null, atrasado: isLate(m, rules), rascunho: !!m.draft })) };
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
            user.id, id, PRI.includes(it.prioridade) ? it.prioridade : "normal", String(it.categoria || ""), String(it.responsavel || ""), String(it.motivo || ""), String(it.tarefa || ""), String(it.prazo || ""),
            JSON.stringify(Array.isArray(it.divergencias) ? it.divergencias.map(String) : []), now());
          ids.push(id);
        }
        if (cards) { if (!cards.some(k => k.t === "sum")) cards.unshift({ t: "sum" }); }
        mail.labelMessages(user.id, ids); // em segundo plano
        return { registrados: ids.length };
      } },
    { name: "mostrar_emails", description: "Mostra à pessoa os cartões dos e-mails indicados, na ordem dada. Use sempre que citar e-mails específicos.",
      schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
      execute(input) { const v = (Array.isArray(input.ids) ? input.ids : []).map(String).filter(exists); v.forEach(id => cards && addCard({ t: "mail", id })); return { exibidos: v.length }; } },
    { name: "criar_rascunho", description: "Cria ou substitui o rascunho de resposta de um e-mail, salvando-o no e-mail da pessoa como rascunho na mesma conversa. Não envia.",
      schema: { type: "object", properties: { id: { type: "string" }, assunto: { type: "string" }, corpo: { type: "string" } }, required: ["id", "assunto", "corpo"] },
      async execute(input) {
        const id = String(input.id || ""); if (!exists(id)) throw new Error("E-mail não encontrado: " + id);
        const r = await mail.saveDraft(user.id, id, { assunto: String(input.assunto || ""), corpo: String(input.corpo || "") });
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
      } }
  ];
}

function history(userId, n = 12) {
  const rows = all("SELECT * FROM chats WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, n).reverse();
  const out = rows.map(r => ({ role: r.role, content: r.role === "user" ? r.text : (r.text || "(ações registradas)") + (json(r.cards_json, []).length ? `\n[Mostrei: ${json(r.cards_json, []).map(k => k.t === "mail" ? "e-mail " + k.id : k.t === "draft" ? "rascunho " + k.id : k.t === "sum" ? "resumo da caixa" : "regras").join(", ")}]` : "") }));
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function chat(user, company, text) {
  const rules = rulesOf(company);
  const inbox = mail.inbox(user.id, 40);
  const cards = [];
  run("INSERT INTO chats (user_id, role, text, cards_json, created_at) VALUES (?, 'user', ?, '[]', ?)", user.id, text, now());
  const messages = [...history(user.id, 13).slice(0, -1), { role: "user", content: text }];
  let reply = { text: "", error: null };
  try {
    const r = await ai.run({ system: systemPrompt(user, company, rules, inbox), messages, tools: tools({ user, company, cards }), mockState: { inbox, team: rules.team || [] } });
    reply.text = r.text || (cards.length ? "" : "Pronto.");
    ai.recordUsage({ companyId: company.id, userId: user.id, kind: "chat", model: r.model, usage: r.usage });
  } catch (e) {
    console.error("[ia]", e.message);
    reply.error = e.message.startsWith("Chave") || e.message.startsWith("AI_PROVIDER") ? e.message : "Não consegui responder agora. Tente de novo em instantes.";
  }
  run("INSERT INTO chats (user_id, role, text, cards_json, error, created_at) VALUES (?, 'assistant', ?, ?, ?, ?)", user.id, reply.text, JSON.stringify(cards), reply.error, now());
  return { text: reply.text, cards, error: reply.error };
}

// Qualificação automática dos e-mails novos (roda em segundo plano, sem aparecer na conversa).
async function autoTriage(user, company) {
  const inbox = mail.inbox(user.id, 40);
  if (!inbox.some(m => !m.triage)) return 0;
  const rules = rulesOf(company);
  const r = await ai.run({
    system: systemPrompt(user, company, rules, inbox),
    messages: [{ role: "user", content: "Tarefa automática: qualifique com registrar_qualificacao todos os e-mails marcados como ainda não qualificados, numa única chamada. Não escreva rascunhos. Responda apenas 'ok'." }],
    tools: tools({ user, company, cards: null }).filter(t => ["registrar_qualificacao", "ler_caixa"].includes(t.name)),
    mockState: { inbox, team: rules.team || [] }, maxRounds: 3
  });
  ai.recordUsage({ companyId: company.id, userId: user.id, kind: "auto", model: r.model, usage: r.usage });
  return inbox.filter(m => !m.triage).length;
}

module.exports = { chat, autoTriage, rulesOf, saveRules, isLate };
