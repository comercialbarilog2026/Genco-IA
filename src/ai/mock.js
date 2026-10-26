// Provedor simulado: segue regras simples para testar o app inteiro sem chave de IA.
// As respostas são previsíveis e servem só para desenvolvimento e demonstração técnica.
const URG = /(vermelho|canal amarelo|exig[êe]ncia|free time|vence|vencimento|2[ªa] cobran|segunda vez|segundo e-mail|cobrando|parada|pane|n[ãa]o chegou|vazia|urgente)/i;
const ALTA = /(diverg|n[ãa]o batem|reajuste|numer[áa]rio|estoque m[íi]nimo|lpco|chega dia|documentos do embarque)/i;
const BAIXA = /(boletim|informativo|newsletter|tend[êe]ncias|obrigad[oa] pela)/i;

function pickOwner(msg, team) {
  const txt = (msg.subject + " " + msg.body).toLowerCase();
  let best = team[0]?.nome || "", score = 0;
  for (const m of team) {
    const words = String(m.regra).toLowerCase().split(/[^a-zà-ú0-9]+/).filter(w => w.length > 4);
    const s = words.filter(w => txt.includes(w)).length;
    if (s > score) { score = s; best = m.nome; }
  }
  return best;
}

async function run({ messages, tools, mockState }) {
  const { inbox, team } = mockState;
  const user = String(messages[messages.length - 1]?.content || "").toLowerCase();
  const tool = n => tools.find(t => t.name === n) || { execute: async () => ({}) };
  const todo = inbox.filter(m => !m.triage);
  if (todo.length) {
    await tool("registrar_qualificacao").execute({ itens: todo.map(m => {
      const t = m.subject + " " + m.body;
      const prioridade = BAIXA.test(t) ? "baixa" : URG.test(t) ? "urgente" : (ALTA.test(t) || m.attachments.length) ? "alta" : "normal";
      return { id: m.id, prioridade, categoria: "", responsavel: pickOwner(m, team), motivo: prioridade === "urgente" ? "Pede ação imediata pelo conteúdo do e-mail." : prioridade === "baixa" ? "Informativo, sem ação." : "Pede acompanhamento.", tarefa: "Responder " + (m.from_name || m.from_addr), prazo: "", divergencias: [] };
    }) });
  }
  const fresh = (await tool("ler_caixa").execute({})).emails;
  const urg = fresh.filter(m => m.prioridade === "urgente");
  const late = fresh.filter(m => m.atrasado);
  if (/rascunho|respost|responda|prepare/.test(user)) {
    const alvo = (late.length ? late : urg).slice(0, 3);
    for (const m of alvo) await tool("criar_rascunho").execute({ id: m.id, assunto: "Re: " + m.assunto, corpo: `Olá${m.de_nome ? ", " + m.de_nome.split(" ")[0] : ""}.\n\nRecebemos sua mensagem e já estamos verificando. Retornamos com uma posição até [confirmar horário].\n\nAtenciosamente,\nEquipe` });
    await tool("mostrar_emails").execute({ ids: alvo.map(m => m.id) });
    return { text: `Deixei ${alvo.length} rascunho${alvo.length === 1 ? "" : "s"} pronto${alvo.length === 1 ? "" : "s"} para revisão. (Resposta do modo de teste: configure AI_PROVIDER para ter a IA de verdade.)`, usage: { input: 0, output: 0 }, model: "mock" };
  }
  if (mockState.group) {
    const semDono = fresh.filter(m => !m.dono && !m.respondido && m.situacao !== "resolvido" && m.prioridade !== "baixa");
    if (/assum|eu pego|fico com/.test(user) && semDono.length) {
      const alvo = semDono.filter(m => m.prioridade === "urgente").slice(0, 2);
      const pick = alvo.length ? alvo : semDono.slice(0, 1);
      await tool("atribuir_emails").execute({ ids: pick.map(m => m.id), pessoa: mockState.me.name });
      return { text: `Pronto: ${pick.length} e-mail${pick.length === 1 ? "" : "s"} agora com você. (Modo de teste.)`, usage: { input: 0, output: 0 }, model: "mock" };
    }
    if (/sem dono|ningu[eé]m/.test(user)) {
      await tool("mostrar_emails").execute({ ids: semDono.slice(0, 5).map(m => m.id) });
      return { text: `${semDono.length} e-mail${semDono.length === 1 ? "" : "s"} do grupo sem dono. (Modo de teste.)`, usage: { input: 0, output: 0 }, model: "mock" };
    }
    if (/\bmeus\b|comigo/.test(user)) {
      const mine = fresh.filter(m => m.dono === mockState.me.name && m.situacao !== "resolvido");
      await tool("mostrar_emails").execute({ ids: mine.slice(0, 5).map(m => m.id) });
      return { text: `Você está com ${mine.length} e-mail${mine.length === 1 ? "" : "s"} em aberto no grupo. (Modo de teste.)`, usage: { input: 0, output: 0 }, model: "mock" };
    }
  }
  const show = (/atras|sem resposta/.test(user) ? late : urg).slice(0, 5);
  await tool("mostrar_emails").execute({ ids: show.map(m => m.id) });
  return { text: `Qualifiquei a caixa: ${urg.length} urgentes e ${late.length} sem resposta além do prazo. Separei os principais acima. (Resposta do modo de teste: configure AI_PROVIDER para ter a IA de verdade.)`, usage: { input: 0, output: 0 }, model: "mock" };
}

module.exports = { run, extractPdf: async () => null, ready: () => true };
