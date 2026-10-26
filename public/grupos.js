// GENCO IA — tela "Pendências" do grupo: a IA avisa, em frases, o que está pendente na caixa compartilhada
// e cada aviso já traz as ações (assumir, passar, resolver). Configuração do grupo fica em "Configurar".
(() => {
  const G = () => window.Genco;
  const $ = id => document.getElementById(id);
  const PRI = ["urgente", "alta", "normal", "baixa"];
  const PRI_ORD = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
  
  // current: id do grupo aberto, ou 0 = "Minha caixa" (pessoa que usa sozinha, com um único e-mail).
  const initialGroup = Number(new URLSearchParams(location.search).get("grupo")) || null;
  const boxUrl = () => current === 0 ? "/api/me/box" : "/api/groups/" + current;
  let skipEmpty = false;
  let current = initialGroup, D = null, openId = null, configOpen = false, people = null, busy = false;

  const hrs = m => (Date.now() - m.received_at) / 36e5;
  const isOpen = m => m.handling.status !== "resolvido" && !(m.replied && m.handling.status === "novo");
  const isLate = m => isOpen(m) && !m.replied && hrs(m) >= Number(D.atraso || 4);
  const statusOf = m => m.handling.status === "novo" && m.replied ? "respondido" : m.handling.status;
  const page = () => $("grupos");

  async function render() {
    const { S, esc } = G();
    const manage = ["admin", "gestor"].includes(S.me.role);
    // Empresa que se cadastrou como equipe e ainda não tem grupo nem e-mail: começa criando o grupo.
    if (!S.groups.length && !S.myAccount && manage && S.company.modo === "equipe" && !skipEmpty) return renderEmpty();
    if (current === null || (current !== 0 && !S.groups.some(g => g.id === current)))
      current = S.groupLogin ? S.groupLogin.id : (S.groups.length && !S.myAccount ? S.groups[0].id : 0);
    // Quem entrou pelo e-mail do grupo abre direto na própria aba.
    if (!render.opened && S.groupLogin && S.groupLogin.id === current) person = S.me.id;
    render.opened = true;
    if (!D || D.group.id !== current) page().innerHTML = `<div class="brief"><span class="cap">GENCO IA</span><h2 class="brief-h">Vendo o que está pendente…</h2></div>`;
    try { D = await G().api("GET", boxUrl()); }
    catch (e) { page().innerHTML = `<div class="brief"><h2 class="brief-h">Não consegui abrir a caixa.</h2><p class="err">${esc(e.message)}</p></div>`; return; }
    draw();
  }

  // ---------- sem grupos ----------
  function renderEmpty() {
    const { S } = G(), manage = ["admin", "gestor"].includes(S.me.role);
    page().innerHTML = `<div class="brief"><span class="cap">Primeiro passo</span><h2 class="brief-h">Vamos criar o e-mail da sua equipe.</h2>
      <p class="lead">Um grupo é um e-mail atendido por várias pessoas, como operacional@ ou atendimento@. Eu leio o que chega, aviso o que está pendente e separo o que é de cada pessoa.</p></div>
      ${manage ? createForm() : ""}
      <p class="calm" style="padding-left:0;margin-top:18px">Vai usar só com o seu e-mail, sem equipe? <button type="button" class="linkbtn" id="gSolo">Conectar só o meu e-mail</button></p>`;
    if (manage) wireCreate();
    $("gSolo").onclick = () => { skipEmpty = true; current = 0; render(); };
  }
  function createForm() {
    return `<div class="panel" id="gNewPanel"><h3>Criar grupo</h3>
      <div class="grid2"><div class="field"><label for="gNome">Nome do grupo</label><input id="gNome" placeholder="Operacional"></div>
        <div class="field"><label for="gEnd">Endereço do grupo</label><input id="gEnd" type="email" placeholder="operacional@suaempresa.com.br"></div></div>
      <div class="actions"><button type="button" class="btn" id="gCreate">Criar grupo</button></div>
      <p class="small muted">Depois de criar, você escolhe os membros e conecta o e-mail que recebe as mensagens do grupo.</p></div>`;
  }
  function wireCreate() {
    $("gCreate").onclick = async () => {
      try {
        const d = await G().api("POST", "/api/groups", { nome: $("gNome").value, endereco: $("gEnd").value || undefined, membros: [{ user_id: G().S.me.id, coordena: true }] });
        current = d.group.id; configOpen = true; D = null; await G().refresh();
        G().toast("Grupo criado. Agora escolha os membros e conecte o e-mail.");
      } catch (e) { G().toast(e.message); }
    };
  }

  // ---------- tela do grupo: a IA avisa o que está pendente ----------
  const firstName = n => String(n || "").split(" ")[0];
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"; };
  const byPriority = (a, b) => (PRI_ORD[a.triage?.prioridade] ?? 9) - (PRI_ORD[b.triage?.prioridade] ?? 9) || a.received_at - b.received_at;
  let showAll = false, person = null; // person = id da pessoa na aba aberta (null = visão geral)

  // Separa a caixa do grupo em avisos, do mais importante para o menos.
  function buckets() {
    const me = G().S.me.id;
    const open = D.inbox.filter(isOpen);
    const needsOwner = open.filter(m => !m.handling.assignee_id && m.triage?.prioridade !== "baixa").sort(byPriority);
    const mine = open.filter(m => m.handling.assignee_id === me && m.handling.status !== "aguardando").sort((a, b) => (isLate(b) - isLate(a)) || byPriority(a, b));
    const teamLate = open.filter(m => m.handling.assignee_id && m.handling.assignee_id !== me && isLate(m) && m.handling.status !== "aguardando").sort(byPriority);
    const waiting = open.filter(m => m.handling.status === "aguardando");
    const used = new Set([...needsOwner, ...mine, ...teamLate, ...waiting].map(m => m.id));
    const rest = D.inbox.filter(m => !used.has(m.id));
    return { open, needsOwner, mine, teamLate, waiting, rest };
  }

  function draw() {
    const { S, esc } = G(), acc = D.account;
    const switcher = S.groups.length ? `<select id="gSwitch" class="pillsel" aria-label="Caixa">${[{ id: 0, name: "Minha caixa" }, ...S.groups].map(g => `<option value="${g.id}" ${g.id === current ? "selected" : ""}>${g.id ? "Grupo " : ""}${esc(g.name)}</option>`).join("")}</select>` : "";
    const manageAny = ["admin", "gestor"].includes(S.me.role);
    const tools = `<div class="btools">${switcher}${acc ? `<button type="button" class="txtbtn" id="gSync">Atualizar</button>` : ""}${D.canManage ? `<button type="button" class="txtbtn" id="gCfg" aria-expanded="${configOpen}">Configurar</button>` : ""}${manageAny ? `<button type="button" class="txtbtn" data-newgroup>${S.groups.length ? "Novo grupo" : "Usar com equipe"}</button>` : ""}</div>`;
    if (D.personal) return drawPersonal(tools);
    const cap = `<span class="cap">Grupo ${esc(D.group.name)}${D.group.address ? " · " + esc(D.group.address) : ""}</span>`;

    if (!acc) {
      page().innerHTML = `<div class="brief">${tools}${cap}<h2 class="brief-h">O e-mail do grupo ainda não está conectado.</h2>
        <p class="lead">${D.canManage ? "Abra <b>Configurar</b>, escolha quem faz parte do grupo e conecte o e-mail. Depois disso eu aviso aqui tudo o que estiver pendente." : "Peça ao administrador ou gestor para conectar o e-mail do grupo."}</p></div><div id="gCfgBox"></div>`;
      wire(); if (configOpen && D.canManage) drawConfig();
      return;
    }

    if (person && !D.members.some(m => m.id === person)) person = null;
    if (person) return drawPerson(tools, cap);
    const b = buckets(), me = S.me;
    const total = b.needsOwner.length + b.mine.length + b.teamLate.length;
    const headline = total
      ? `${greeting()}, ${esc(firstName(me.name))}. <em>${plural(total, "coisa precisa", "coisas precisam")} de atenção</em> no ${esc(D.group.name)}.`
      : `${greeting()}, ${esc(firstName(me.name))}. Está tudo em dia no ${esc(D.group.name)}.`;

    const sections = [];
    const noFn = D.members.filter(m => !String(m.regra || "").trim());
    if (D.canManage && noFn.length) sections.push(`<section class="aviso ink"><div class="aviso-msg"><i></i><p><b>${noFn.length === 1 ? `Encontrei ${esc(firstName(noFn[0].name))} no grupo, mas ainda não sei o que ${esc(firstName(noFn[0].name))} cuida.` : `Encontrei ${noFn.length} pessoas no grupo sem função definida: ${noFn.map(m => esc(firstName(m.name))).join(", ")}.`}</b> Diga o que cada uma cuida para eu dividir os e-mails certo. <button type="button" class="linkbtn" data-person="${noFn[0].id}">Definir agora</button></p></div></section>`);
    if (b.needsOwner.length) {
      const urg = b.needsOwner.filter(m => m.triage?.prioridade === "urgente").length;
      sections.push(aviso("crit", `<b>${plural(b.needsOwner.length, "e-mail está", "e-mails estão")} sem ninguém cuidando${urg ? `, ${urg === b.needsOwner.length ? (urg === 1 ? "e é urgente" : "todos urgentes") : `${urg} urgente${urg > 1 ? "s" : ""}`}` : ""}.</b> Alguém precisa assumir.`, b.needsOwner, "semdono"));
    }
    if (b.mine.length) {
      const late = b.mine.filter(isLate).length;
      sections.push(aviso(late ? "warn" : "ink", `<b>Com você: ${plural(b.mine.length, "e-mail", "e-mails")}.</b> ${late ? `${plural(late, "está atrasado", "estão atrasados")} — o cliente está esperando.` : "Todos dentro do prazo."}`, b.mine, "meus"));
    } else if (D.isMember) {
      sections.push(aviso("good", `<b>Nada pendente com você.</b>`, [], "meus"));
    }
    if (b.teamLate.length) {
      const per = {};
      b.teamLate.forEach(m => { per[m.handling.assignee] = (per[m.handling.assignee] || 0) + 1; });
      const who = Object.entries(per).sort((x, y) => y[1] - x[1]).map(([n, k]) => `${esc(firstName(n))} com ${k}`).join(", ");
      sections.push(aviso("warn", `<b>${plural(b.teamLate.length, "e-mail atrasado", "e-mails atrasados")} com a equipe</b> (sem resposta há mais de ${esc(D.atraso)} h): ${who}.`, b.teamLate, "equipe", !D.canManage));
    }
    if (b.waiting.length) sections.push(aviso("quiet", `<b>${plural(b.waiting.length, "e-mail aguardando", "e-mails aguardando")} retorno de terceiros.</b>`, b.waiting, "aguardando", true));

    const restOpen = b.rest.filter(isOpen).length, done = b.rest.length - restOpen;
    const calm = `<p class="calm">${restOpen ? `${plural(restOpen, "outro e-mail está", "outros e-mails estão")} com a equipe dentro do prazo` : "Não há mais nada em aberto"}${done ? ` · ${plural(done, "já respondido ou resolvido", "já respondidos ou resolvidos")}` : ""}. <button type="button" class="linkbtn" id="gAll">${showAll ? "Esconder" : "Ver todos os e-mails"}</button></p>
      ${showAll ? `<div class="pcards">${b.rest.sort((x, y) => y.received_at - x.received_at).map(card).join("")}</div>` : ""}`;

    page().innerHTML = `<div class="brief">${tools}${cap}${peopleTabs()}<h2 class="brief-h">${headline}</h2></div>
      <div id="gCfgBox"></div>
      <div class="avisos">${sections.join("")}${calm}</div>
      <form class="askbox" id="gAsk"><input id="gAskIn" placeholder="Pergunte à GENCO IA sobre o grupo — ex.: o que a Ana tem de urgente?" aria-label="Pergunta sobre o grupo"><button type="submit" class="send" aria-label="Perguntar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></form>`;
    wire();
    if (configOpen && D.canManage) drawConfig();
  }

  // ---------- caixa pessoal (quem usa sozinho, com um único e-mail) ----------
  function drawPersonal(tools) {
    const { S, esc } = G(), acc = D.account, me = S.me;
    const cap = `<span class="cap">Minha caixa${acc?.address ? " · " + esc(acc.address) : ""}</span>`;
    if (!acc) {
      const f = S.features;
      page().innerHTML = `<div class="brief">${tools}${cap}<h2 class="brief-h">${greeting()}, ${esc(firstName(me.name))}. Conecte o seu e-mail e eu aviso aqui tudo o que precisa de resposta.</h2>
        <p class="lead">Funciona com Gmail, Outlook e qualquer outro provedor (Locaweb, UOL, Hostinger, Yahoo, e-mail do seu domínio). Eu preparo as respostas como rascunho e nunca envio nada por você.</p></div>
        <div id="gCfgBox"></div>
        <div class="connect">
          <button type="button" class="conn" data-pconn="gmail" ${f.gmail ? "" : "disabled"}><b>Gmail</b><span>${f.gmail ? "Gmail ou Google Workspace" : "Ainda não configurado neste servidor"}</span></button>
          <button type="button" class="conn" data-pconn="outlook" ${f.outlook ? "" : "disabled"}><b>Outlook</b><span>${f.outlook ? "Outlook.com ou Microsoft 365" : "Ainda não configurado neste servidor"}</span></button>
          <button type="button" class="conn" data-pconn="imap"><b>Outro provedor</b><span>Locaweb, UOL, Hostinger, Yahoo, domínio próprio…</span></button>
          <button type="button" class="conn" data-pconn="demo"><b>Demonstração</b><span>E-mails fictícios do seu ramo, para conhecer</span></button>
        </div><div id="imapBox"></div>`;
      wire();
      page().querySelectorAll("[data-pconn]").forEach(b => b.onclick = async () => {
        const p = b.dataset.pconn;
        if (p === "imap") { G().imapConnect($("imapBox"), { onDone: async () => { await G().refresh(); } }); return; }
        if (p !== "demo") { location.href = "/api/connect/" + p; return; }
        b.disabled = true;
        try { await G().api("POST", "/api/connect/demo", { setor: S.company.sector }); await G().refresh(); G().toast("Caixa de demonstração conectada"); }
        catch (e) { G().toast(e.message); b.disabled = false; }
      });
      return;
    }
    const open = D.inbox.filter(isOpen);
    const waitingReply = m => !m.replied && m.handling.status !== "aguardando";
    const now = open.filter(m => waitingReply(m) && (m.triage?.prioridade === "urgente" || isLate(m))).sort((a, b) => (isLate(b) - isLate(a)) || byPriority(a, b));
    const used = new Set(now.map(m => m.id));
    const ready = open.filter(m => m.draft && !used.has(m.id)); ready.forEach(m => used.add(m.id));
    const soon = open.filter(m => waitingReply(m) && m.triage?.prioridade === "alta" && !used.has(m.id)).sort(byPriority); soon.forEach(m => used.add(m.id));
    const waiting = open.filter(m => m.handling.status === "aguardando"); waiting.forEach(m => used.add(m.id));
    const reading = D.inbox.filter(m => !m.triage).length;
    const rest = D.inbox.filter(m => !used.has(m.id));
    const total = now.length + soon.length;
    const headline = total
      ? `${greeting()}, ${esc(firstName(me.name))}. <em>${plural(total, "e-mail precisa", "e-mails precisam")} da sua resposta.</em>`
      : `${greeting()}, ${esc(firstName(me.name))}. Sua caixa está em dia.`;
    const sections = [];
    if (now.length) {
      const late = now.filter(isLate).length;
      sections.push(aviso("crit", `<b>Responda primeiro: ${plural(now.length, "e-mail", "e-mails")}.</b> ${late ? `${plural(late, "está atrasado", "estão atrasados")} — o cliente está esperando.` : "São urgentes."}`, now, "me-now"));
    }
    if (ready.length) sections.push(aviso("good", `<b>${plural(ready.length, "resposta pronta", "respostas prontas")} para você revisar e enviar.</b> Ficaram como rascunho no seu e-mail.`, ready, "me-ready"));
    if (soon.length) sections.push(aviso("warn", `<b>${plural(soon.length, "e-mail importante", "e-mails importantes")} para hoje.</b>`, soon, "me-soon"));
    if (waiting.length) sections.push(aviso("quiet", `<b>${plural(waiting.length, "e-mail aguardando", "e-mails aguardando")} retorno de terceiros.</b>`, waiting, "me-wait", true));
    if (reading) sections.push(`<p class="calm">Ainda estou lendo ${plural(reading, "e-mail", "e-mails")}. Em instantes eles aparecem aqui.</p>`);
    const restOpen = rest.filter(isOpen).length, done = rest.length - restOpen;
    sections.push(`<p class="calm">${restOpen ? `${plural(restOpen, "outro e-mail não pede", "outros e-mails não pedem")} ação agora` : "Não há mais nada em aberto"}${done ? ` · ${plural(done, "já respondido ou resolvido", "já respondidos ou resolvidos")}` : ""}. <button type="button" class="linkbtn" id="gAll">${showAll ? "Esconder" : "Ver todos os e-mails"}</button></p>
      ${showAll ? `<div class="pcards">${rest.sort((x, y) => y.received_at - x.received_at).map(card).join("")}</div>` : ""}`);
    page().innerHTML = `<div class="brief">${tools}${cap}<h2 class="brief-h">${headline}</h2></div>
      <div id="gCfgBox"></div>
      <div class="avisos">${sections.join("")}</div>
      <form class="askbox" id="gAsk"><input id="gAskIn" placeholder="Pergunte à GENCO IA sobre a sua caixa — ex.: o que o cliente X pediu?" aria-label="Pergunta sobre a sua caixa"><button type="submit" class="send" aria-label="Perguntar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></form>`;
    wire();
  }

  // ---------- abas por pessoa ----------
  function peopleTabs() {
    const { esc, initials } = G();
    if (!D.members.length) return "";
    const openOf = id => D.inbox.filter(m => isOpen(m) && m.handling.assignee_id === id).length;
    const lateOf = id => D.inbox.filter(m => isLate(m) && m.handling.assignee_id === id).length;
    return `<nav class="ptabs" aria-label="Pessoas do grupo">
      <button type="button" data-person="" aria-current="${!person}">Visão geral</button>
      ${D.members.map(m => { const n = openOf(m.id), l = lateOf(m.id); return `<button type="button" data-person="${m.id}" aria-current="${person === m.id}"><span class="av sm">${esc(initials(m.name))}</span>${esc(firstName(m.name))}${n ? `<span class="pcount ${l ? "late" : ""}" title="${n} em aberto${l ? `, ${l} atrasado${l > 1 ? "s" : ""}` : ""}">${n}</span>` : ""}</button>`; }).join("")}
    </nav>`;
  }

  function drawPerson(tools, cap) {
    const { esc, S } = G(), p = D.members.find(m => m.id === person), isMe = p.id === S.me.id;
    const mine = D.inbox.filter(m => m.handling.assignee_id === p.id);
    const open = mine.filter(isOpen);
    const late = open.filter(m => isLate(m) && m.handling.status !== "aguardando").sort(byPriority);
    const onTime = open.filter(m => !isLate(m) && m.handling.status !== "aguardando").sort(byPriority);
    const waiting = open.filter(m => m.handling.status === "aguardando");
    const weekAgo = Date.now() - 7 * 864e5;
    const done = mine.filter(m => m.handling.status === "resolvido" && (m.handling.updated_at || 0) >= weekAgo);
    const suggested = D.inbox.filter(m => isOpen(m) && !m.handling.assignee_id && m.triage?.responsavel === p.name).sort(byPriority);
    const nome = isMe ? "Você" : esc(firstName(p.name));
    const headline = open.length
      ? `${nome} ${isMe ? "está" : "está"} com <em>${plural(open.length, "e-mail", "e-mails")} em aberto</em>${late.length ? `, ${plural(late.length, "atrasado", "atrasados")}` : ", todos no prazo"}.`
      : `${nome} não ${isMe ? "tem" : "tem"} nada pendente no grupo agora.`;
    const fn = `<div class="pfunc"><span class="cap">${isMe ? "Sua função no grupo" : "Função no grupo"}${p.coordena ? " · responsável pelo grupo" : ""}</span>
      <p id="pfText">${esc(p.regra || (D.canManage ? "Ainda não definida. Defina para a IA mandar os e-mails certos para esta pessoa." : "Ainda não definida. O gestor do grupo define o que cada pessoa cuida."))}</p>
      ${D.canManage ? `<button type="button" class="linkbtn" id="pfEdit">Editar função</button>` : ""}</div>`;
    const sections = [];
    if (late.length) sections.push(aviso("crit", `<b>${plural(late.length, "atrasado", "atrasados")}.</b> ${late.length === 1 ? "O cliente está" : "Os clientes estão"} esperando resposta há mais de ${esc(D.atraso)} h.`, late, "p-late"));
    if (suggested.length) sections.push(aviso("warn", `<b>${plural(suggested.length, "e-mail sem dono é", "e-mails sem dono são")} da área ${isMe ? "sua" : `de ${esc(firstName(p.name))}`}</b>, pela função acima.`, suggested, "p-sug"));
    if (isMe) {
      const sug = new Set(suggested.map(m => m.id));
      const others = D.inbox.filter(m => isOpen(m) && !m.handling.assignee_id && m.triage?.prioridade !== "baixa" && !sug.has(m.id)).sort(byPriority);
      if (others.length) sections.push(aviso("crit", `<b>${plural(others.length, "e-mail do grupo está", "e-mails do grupo estão")} sem ninguém cuidando.</b> Se for com você, é só assumir.`, others, "p-semdono", true));
    }
    if (onTime.length) sections.push(aviso("ink", `<b>${plural(onTime.length, "dentro do prazo", "dentro do prazo")}.</b>`, onTime, "p-ok"));
    if (waiting.length) sections.push(aviso("quiet", `<b>${plural(waiting.length, "aguardando", "aguardando")} retorno de terceiros.</b>`, waiting, "p-wait", true));
    sections.push(`<p class="calm">${done.length ? `${plural(done.length, "e-mail resolvido", "e-mails resolvidos")} nos últimos 7 dias.` : "Nenhum e-mail resolvido nos últimos 7 dias."}${done.length ? ` <button type="button" class="linkbtn" data-open="p-done">${openSections.has("p-done") ? "" : "Ver"}</button>` : ""}</p>${openSections.has("p-done") && done.length ? `<div class="pcards">${done.map(card).join("")}</div>` : ""}`);

    page().innerHTML = `<div class="brief">${tools}${cap}${peopleTabs()}<h2 class="brief-h">${headline}</h2>${fn}</div>
      <div id="gCfgBox"></div>
      <div class="avisos">${sections.join("")}</div>
      <form class="askbox" id="gAsk"><input id="gAskIn" placeholder="Pergunte à GENCO IA sobre ${isMe ? "os seus e-mails" : "os e-mails de " + esc(firstName(p.name))}" aria-label="Pergunta"><button type="submit" class="send" aria-label="Perguntar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></form>`;
    wire();
    $("pfEdit") && ($("pfEdit").onclick = () => {
      $("pfText").outerHTML = `<form class="noteform" id="pfForm"><input id="pfIn" value="${esc(p.regra || "")}" placeholder="O que essa pessoa cuida no grupo" aria-label="Função"><button type="submit" class="btn">Salvar</button></form>`;
      $("pfEdit").hidden = true; $("pfIn").focus();
      $("pfForm").onsubmit = async ev => {
        ev.preventDefault();
        const membros = D.members.map(m => ({ user_id: m.id, regra: m.id === p.id ? $("pfIn").value : m.regra, coordena: m.coordena }));
        try { await G().api("PUT", `/api/groups/${current}/members`, { membros }); G().toast("Função salva. A IA passa a usar esta regra."); await reload(); }
        catch (e) { G().toast(e.message); }
      };
    });
    if (configOpen && D.canManage) drawConfig();
  }

  const collapsed = new Set(["equipe:closed-default", "aguardando:closed-default"]);
  const openSections = new Set();
  function aviso(tone, text, items, key, startClosed = false) {
    const isClosed = startClosed && !openSections.has(key);
    return `<section class="aviso ${tone}"><div class="aviso-msg"><i></i><p>${text}</p></div>
      ${items.length ? (isClosed ? `<button type="button" class="linkbtn more" data-open="${key}">Mostrar ${plural(items.length, "e-mail", "e-mails")}</button>` : `<div class="pcards">${items.map(card).join("")}</div>`) : ""}</section>`;
  }

  function card(m) {
    const { esc, ago, S } = G(), t = m.triage || {}, h = m.handling, me = S.me.id, late = isLate(m), open = isOpen(m);
    const mineCard = h.assignee_id === me;
    const who = h.assignee ? (mineCard ? "com você" : `com ${esc(h.assignee)}`) : (t.responsavel ? `IA sugere ${esc(t.responsavel)}` : "sem dono");
    const state = !open ? (statusOf(m) === "respondido" ? "respondido" : "resolvido") : h.status === "aguardando" ? "aguardando terceiros" : "";
    const others = D.members.filter(p => p.id !== h.assignee_id);
    const btns = [];
    if (D.personal) {
      if (open) {
        if (!m.replied) btns.push(m.draft ? `<button type="button" class="btn" data-toggle="${esc(m.id)}">Ver resposta pronta</button>` : `<button type="button" class="btn" data-reply="${esc(m.id)}">Preparar resposta</button>`);
        btns.push(`<button type="button" class="btn ghost" data-act="resolver">Resolvido</button>`);
        if (h.status !== "aguardando") btns.push(`<button type="button" class="btn ghost" data-act="aguardar">Aguardando terceiros</button>`);
      } else btns.push(`<button type="button" class="btn ghost" data-act="reabrir">Reabrir</button>`);
      btns.push(`<button type="button" class="linkbtn" data-toggle="${esc(m.id)}" aria-expanded="${openId === m.id}">${openId === m.id ? "Fechar" : "Ver e-mail"}</button>`);
      return `<article class="pcard ${open ? "" : "done"} ${openId === m.id ? "open" : ""}" data-id="${esc(m.id)}">
        <div class="pc-top"><span class="pdot ${esc(t.prioridade || "")}" title="${esc(t.prioridade || "")}"></span><b>${esc(m.from_name || m.from_addr)}</b><time class="${late ? "late" : ""}">${late ? "esperando há " : "há "}${esc(ago(m))}</time></div>
        <div class="pc-subj">${esc(m.subject)}</div>
        <div class="pc-do">${t.tarefa ? `<b>${esc(t.tarefa)}</b>` : esc(t.motivo || "")}${state ? ` · <span>${state}</span>` : ""}${m.draft ? " · resposta pronta" : ""}</div>
        <div class="pc-act">${btns.join("")}</div>
        ${openId === m.id ? detail(m) : ""}
      </article>`;
    }
    if (open && !mineCard) btns.push(`<button type="button" class="btn" data-act="assumir">Eu assumo</button>`);
    if (open && !h.assignee_id && t.responsavel && D.members.some(p => p.name === t.responsavel && p.id !== me)) {
      const sug = D.members.find(p => p.name === t.responsavel);
      btns.push(`<button type="button" class="btn ghost" data-pass="${sug.id}">Passar para ${esc(firstName(sug.name))}</button>`);
    }
    if (open && mineCard) btns.push(`<button type="button" class="btn" data-act="resolver">Resolvido</button>`, h.status !== "aguardando" ? `<button type="button" class="btn ghost" data-act="aguardar">Aguardando terceiros</button>` : "");
    if (open && others.length) btns.push(`<select class="passsel" data-passsel aria-label="Passar para"><option value="">Passar para…</option>${others.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>`);
    if (!open) btns.push(`<button type="button" class="btn ghost" data-act="reabrir">Reabrir</button>`);
    btns.push(`<button type="button" class="linkbtn" data-toggle="${esc(m.id)}" aria-expanded="${openId === m.id}">${openId === m.id ? "Fechar" : "Ver e-mail"}${h.notes ? ` · ${plural(h.notes, "nota", "notas")}` : ""}</button>`);
    return `<article class="pcard ${open ? "" : "done"} ${openId === m.id ? "open" : ""}" data-id="${esc(m.id)}">
      <div class="pc-top"><span class="pdot ${esc(t.prioridade || "")}" title="${esc(t.prioridade || "")}"></span><b>${esc(m.from_name || m.from_addr)}</b><time class="${late ? "late" : ""}">${late ? "esperando há " : "há "}${esc(ago(m))}</time></div>
      <div class="pc-subj">${esc(m.subject)}</div>
      <div class="pc-do">${t.tarefa ? `<b>${esc(t.tarefa)}</b> · ` : ""}<span>${who}</span>${state ? ` · <span>${state}</span>` : ""}${m.draft ? " · resposta pronta" : ""}</div>
      <div class="pc-act">${btns.join("")}</div>
      ${openId === m.id ? detail(m) : ""}
    </article>`;
  }

  function detail(m) {
    const { esc } = G(), t = m.triage || {};
    return `<div class="pc-detail">
      ${t.motivo ? `<p class="small muted">${esc(t.motivo)}${t.prazo ? ` · prazo ${esc(t.prazo)}` : ""}</p>` : ""}
      ${(t.divergencias || []).length ? `<div class="divg"><span class="cap">Divergências nos documentos</span><ul>${t.divergencias.map(d => `<li>${esc(d)}</li>`).join("")}</ul></div>` : ""}
      <pre class="mailbody">${esc(m.body)}</pre>${m.attachments.map(a => `<details class="orig"><summary>Anexo ${esc(a.name)}</summary><pre class="att">${esc(a.text || "(conteúdo não lido)")}</pre></details>`).join("")}
      ${m.draft ? `<details class="orig" ${D.personal ? "open" : ""}><summary>Resposta pronta (rascunho)</summary><pre>${esc(m.draft.assunto)}\n\n${esc(m.draft.corpo)}</pre></details>` : ""}
      ${D.personal ? "" : `<div class="qhist"><span class="cap">Histórico e notas da equipe</span><div id="hist-${esc(m.id)}" class="hist"><p class="small muted">Carregando…</p></div>
        <form class="noteform" data-note><input placeholder="Nota para a equipe (o cliente não vê)" aria-label="Nota interna" maxlength="2000"><button type="submit" class="btn ghost">Anotar</button></form></div>`}
    </div>`;
  }

  // ---------- configuração (administrador e gestor) ----------
  async function drawConfig() {
    const { esc, S } = G(), box = $("gCfgBox"); if (!box) return;
    box.innerHTML = `<div class="panel"><p class="muted small">Carregando…</p></div>`;
    try { people = (await G().api("GET", "/api/people")).people; } catch (e) { box.innerHTML = `<div class="panel"><p class="err">${esc(e.message)}</p></div>`; return; }
    const mem = new Map(D.members.map(m => [m.id, m])), acc = D.account, f = S.features;
    box.innerHTML = `<div class="panel cfg">
      <h3>Configurar grupo</h3>
      <div class="grid2"><div class="field"><label for="cgNome">Nome</label><input id="cgNome" value="${esc(D.group.name)}"></div>
        <div class="field"><label for="cgEnd">Endereço do grupo</label><input id="cgEnd" type="email" value="${esc(D.group.address)}" placeholder="operacional@suaempresa.com.br"></div></div>
      <label class="check"><input type="checkbox" id="cgAuto" ${D.group.autoAtribuir ? "checked" : ""}> A IA define o dono dos e-mails novos pela regra de cada pessoa</label>
      <details class="adv"><summary>Filtro avançado do Gmail</summary>
        <div class="field"><label for="cgFiltro">Busca que separa os e-mails do grupo</label><input id="cgFiltro" value="${esc(D.group.filtro)}" placeholder="vazio = tudo enviado para o endereço do grupo"></div>
        <p class="small muted">Use a mesma sintaxe da busca do Gmail, por exemplo <code>list:operacional@empresa.com.br</code> ou <code>label:operacional</code>.</p></details>
      <div class="actions"><button type="button" class="btn" id="cgSave">Salvar</button></div>

      <h3>Acesso pelo e-mail do grupo</h3>
      <p class="small muted">A equipe entra com <b>${esc(D.group.address || "o endereço do grupo")}</b> e esta senha e depois escolhe quem é. Membros entram só escolhendo o nome; administradores e gestores confirmam com a própria senha.</p>
      <div class="actions"><input id="cgPass" type="password" class="pillin" placeholder="${D.group.groupLogin ? "Nova senha do grupo (já existe uma)" : "Crie a senha do grupo"}" autocomplete="new-password" aria-label="Senha do grupo">
        <button type="button" class="btn" id="cgPassSave">${D.group.groupLogin ? "Trocar senha" : "Ativar acesso pelo grupo"}</button>
        ${D.group.groupLogin ? `<button type="button" class="btn ghost" id="cgPassOff">Desligar</button>` : ""}</div>

      <h3>Pessoas do grupo</h3>
      <p class="small muted">A GENCO IA encontra as pessoas sozinha: pelos membros do grupo no Google Workspace e por quem da equipe responde nas conversas do grupo. Aqui você ajusta o que cada pessoa cuida — a IA usa isso para definir o dono de cada e-mail.</p>
      ${acc ? `<div class="actions"><button type="button" class="btn ghost" id="cgDetect">Buscar pessoas do grupo agora</button></div>` : ""}
      <div class="mrows">${people.map(p => { const m = mem.get(p.id); return `<div class="mrow" data-p="${p.id}">
          <label class="check"><input type="checkbox" ${m ? "checked" : ""} data-in> <span><b>${esc(p.name)}${m && m.origem !== "manual" ? `<span class="pchip">detectado${m.origem === "google" ? " no Google" : ""}</span>` : ""}</b><small>${esc(p.email)}</small></span></label>
          <input data-regra value="${esc(m?.regra || "")}" placeholder="O que essa pessoa cuida no grupo" aria-label="Regra de ${esc(p.name)}">
          <label class="check small"><input type="radio" name="coord" data-coord ${m?.coordena ? "checked" : ""}> responsável</label></div>`; }).join("")}</div>
      <div class="actions"><button type="button" class="btn" id="cgMembers">Salvar membros</button></div>

      <h3>E-mail do grupo</h3>
      ${acc ? `<p>${acc.provider === "demo" ? "Caixa de demonstração" : `${({ gmail: "Gmail", outlook: "Outlook", imap: "IMAP" }[acc.provider] || acc.provider)} · <b>${esc(acc.address || "")}</b>`}</p>
          <div class="actions"><button type="button" class="btn ghost" id="cgOff">Desconectar</button></div>`
        : `<p class="small muted">Conecte a conta que recebe os e-mails do grupo. <b>Se o grupo for uma lista do Google Groups</b> (cada membro recebe uma cópia), conecte a conta de um dos membros e preencha o endereço do grupo acima: a GENCO IA lê só o que chega para o grupo e reconhece quando alguém da equipe já respondeu. <b>Se for uma caixa própria</b> (com senha), conecte a própria caixa. Funciona com Gmail, Outlook e qualquer outro provedor (Locaweb, UOL, Hostinger, Titan, domínio próprio…).</p>
          <div class="connect">
            <button type="button" class="conn" data-gconn="gmail" ${f.gmail ? "" : "disabled"}><b>Gmail</b><span>${f.gmail ? "Google Workspace" : "Ainda não configurado neste servidor"}</span></button>
            <button type="button" class="conn" data-gconn="outlook" ${f.outlook ? "" : "disabled"}><b>Outlook</b><span>${f.outlook ? "Microsoft 365 (caixa compartilhada)" : "Ainda não configurado neste servidor"}</span></button>
            <button type="button" class="conn" data-gconn="imap"><b>Outro provedor</b><span>Locaweb, UOL, Hostinger, Titan, domínio próprio…</span></button>
            <button type="button" class="conn" data-gconn="demo"><b>Demonstração</b><span>E-mails fictícios para testar o grupo</span></button>
          </div><div id="gImapBox"></div>`}
      ${S.me.role === "admin" ? `<h3>Excluir grupo</h3><p class="small muted">Apaga a fila, os donos, as notas e a conexão do grupo na GENCO IA. Os e-mails no Gmail não são apagados.</p><div class="actions"><button type="button" class="btn ghost danger" id="cgDel">Excluir grupo</button></div>` : ""}
    </div>`;

    $("cgSave").onclick = async () => {
      try { await G().api("PUT", "/api/groups/" + current, { nome: $("cgNome").value, endereco: $("cgEnd").value, filtro: $("cgFiltro").value, autoAtribuir: $("cgAuto").checked }); G().toast("Grupo salvo"); await G().refresh(); }
      catch (e) { G().toast(e.message); }
    };
    $("cgPassSave").onclick = async () => {
      try { await G().api("PUT", `/api/groups/${current}/access`, { senha: $("cgPass").value }); G().toast("Acesso pelo grupo ativado. A equipe já pode entrar com o e-mail do grupo."); await G().refresh(); }
      catch (e) { G().toast(e.message); }
    };
    $("cgPassOff") && ($("cgPassOff").onclick = async () => {
      try { await G().api("PUT", `/api/groups/${current}/access`, { senha: "" }); G().toast("Acesso pelo grupo desligado"); await G().refresh(); } catch (e) { G().toast(e.message); }
    });
    $("cgDetect") && ($("cgDetect").onclick = async () => {
      $("cgDetect").disabled = true; $("cgDetect").textContent = "Buscando…";
      try { const d = await G().api("POST", `/api/groups/${current}/detect`); G().toast(d.added.length ? `Encontrei ${d.added.length} pessoa${d.added.length > 1 ? "s" : ""}: ${d.added.join(", ")}` : "Nenhuma pessoa nova encontrada"); await reload(); }
      catch (e) { G().toast(e.message); $("cgDetect").disabled = false; }
    });
    $("cgMembers").onclick = async () => {
      const membros = [...box.querySelectorAll(".mrow")].filter(r => r.querySelector("[data-in]").checked).map(r => ({ user_id: Number(r.dataset.p), regra: r.querySelector("[data-regra]").value, coordena: r.querySelector("[data-coord]").checked }));
      try { await G().api("PUT", `/api/groups/${current}/members`, { membros }); G().toast("Membros salvos"); await G().refresh(); }
      catch (e) { G().toast(e.message); }
    };
    box.querySelectorAll("[data-gconn]").forEach(b => b.onclick = async () => {
      const p = b.dataset.gconn;
      if (p === "imap") { G().imapConnect($("gImapBox"), { grupo: current, onDone: async () => { configOpen = false; await G().refresh(); } }); return; }
      if (p !== "demo") { location.href = `/api/connect/${p}?grupo=${current}`; return; }
      b.disabled = true;
      try { await G().api("POST", `/api/groups/${current}/connect/demo`, { setor: S.company.sector }); configOpen = false; G().toast("Caixa de demonstração conectada ao grupo"); await G().refresh(); }
      catch (e) { G().toast(e.message); b.disabled = false; }
    });
    $("cgOff") && ($("cgOff").onclick = async () => {
      if ($("cgOff").dataset.c !== "1") { $("cgOff").dataset.c = "1"; $("cgOff").textContent = "Confirmar: desconectar e limpar a fila"; return; }
      try { await G().api("DELETE", `/api/groups/${current}/connect`); G().toast("E-mail do grupo desconectado"); await G().refresh(); } catch (e) { G().toast(e.message); }
    });
    $("cgDel") && ($("cgDel").onclick = async () => {
      if ($("cgDel").dataset.c !== "1") { $("cgDel").dataset.c = "1"; $("cgDel").textContent = "Confirmar exclusão do grupo"; return; }
      try { await G().api("DELETE", "/api/groups/" + current); current = null; D = null; configOpen = false; G().toast("Grupo excluído"); await G().refresh(); } catch (e) { G().toast(e.message); }
    });
  }

  // ---------- ações ----------
  const DONE_MSG = { assumir: "Agora está com você", resolver: "Marcado como resolvido", aguardar: "Marcado como aguardando terceiros", reabrir: "Reaberto", passar: "Passado para a pessoa" };
  async function act(ids, body, kind) {
    if (busy) return; busy = true;
    try { const d = await G().api("POST", current === 0 ? "/api/me/handling" : `/api/groups/${current}/handling`, { ids, ...body }); D.inbox = d.inbox; if (openId && ids.includes(openId) && kind !== "passar") openId = null; await reload(true); if (DONE_MSG[kind]) G().toast(DONE_MSG[kind]); }
    catch (e) { G().toast(e.message); }
    busy = false;
  }
  async function reload(keepScroll) {
    const y = $("v-grupos").scrollTop;
    D = await G().api("GET", boxUrl()); draw();
    if (keepScroll) $("v-grupos").scrollTop = y;
  }
  async function loadHistory(id) {
    const el = $("hist-" + id); if (!el) return;
    try {
      const d = await G().api("GET", `/api/groups/${current}/messages/${encodeURIComponent(id)}`);
      el.innerHTML = histHtml(d.history);
    } catch (e) { el.innerHTML = `<p class="err small">${G().esc(e.message)}</p>`; }
  }
  function histHtml(h) {
    const { esc } = G();
    if (!h.length) return `<p class="small muted">Nada registrado ainda.</p>`;
    return h.map(e => `<div class="hev ${e.kind}"><b>${esc(e.who)}</b> ${e.kind === "nota" ? `<span class="note">${esc(e.text)}</span>` : esc(e.text)} <time>${new Date(e.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></div>`).join("");
  }

  function wire() {
    const root = page();
    $("gSwitch") && ($("gSwitch").onchange = () => { current = Number($("gSwitch").value) || 0; openId = null; person = null; configOpen = false; showAll = false; render(); });
    root.querySelector("[data-newgroup]") && (root.querySelector("[data-newgroup]").onclick = () => { $("gCfgBox").innerHTML = createForm(); wireCreate(); $("gNome").focus(); });
    $("gSync") && ($("gSync").onclick = async () => {
      $("gSync").disabled = true; $("gSync").textContent = "Lendo…";
      try { const d = await G().api("POST", "/api/sync", current ? { grupo: current } : undefined); G().toast(d.added ? `${d.added} e-mail${d.added > 1 ? "s" : ""} novo${d.added > 1 ? "s" : ""}` : "Nenhum e-mail novo"); await reload(); }
      catch (e) { G().toast(e.message); $("gSync").disabled = false; $("gSync").textContent = "Atualizar"; }
    });
    $("gCfg") && ($("gCfg").onclick = () => { configOpen = !configOpen; draw(); if (configOpen) $("gCfgBox").scrollIntoView({ behavior: "smooth", block: "start" }); });
    $("gAll") && ($("gAll").onclick = () => { showAll = !showAll; draw(); });
    root.querySelectorAll("[data-person]").forEach(b => b.onclick = () => { person = Number(b.dataset.person) || null; openId = null; draw(); window.scrollTo?.(0, 0); $("v-grupos").scrollTop = 0; });
    root.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { openSections.add(b.dataset.open); draw(); });
    root.querySelectorAll("[data-reply]").forEach(b => b.onclick = async () => { await G().openChat(current || null); G().ask(`Prepare a resposta do e-mail ${b.dataset.reply}.`); });
    $("gAsk") && ($("gAsk").onsubmit = async ev => { ev.preventDefault(); const t = $("gAskIn").value.trim(); if (!t) return; const p = person && D.members.find(m => m.id === person); await G().openChat(current || null); G().ask(p ? `Sobre ${p.id === G().S.me.id ? "os meus e-mails" : "os e-mails de " + p.name}: ${t}` : t); });
    root.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => { openId = openId === b.dataset.toggle ? null : b.dataset.toggle; draw(); });
    root.querySelectorAll(".pcard").forEach(c => {
      const id = c.dataset.id;
      c.querySelectorAll("[data-act]").forEach(b => b.onclick = () => act([id], { assumir: { dono: "eu" }, resolver: { situacao: "resolvido" }, aguardar: { situacao: "aguardando" }, reabrir: { situacao: "andamento" } }[b.dataset.act], b.dataset.act));
      c.querySelectorAll("[data-pass]").forEach(b => b.onclick = () => act([id], { dono: Number(b.dataset.pass) }, "passar"));
      const sel = c.querySelector("[data-passsel]"); if (sel) sel.onchange = () => sel.value && act([id], { dono: Number(sel.value) }, "passar");
      const note = c.querySelector("[data-note]");
      if (note) note.onsubmit = async ev => {
        ev.preventDefault();
        const inp = ev.target.querySelector("input"), texto = inp.value.trim(); if (!texto) return;
        try {
          const d = await G().api("POST", `/api/groups/${current}/messages/${encodeURIComponent(id)}/notes`, { texto });
          inp.value = ""; $("hist-" + id).innerHTML = histHtml(d.history);
          const m = D.inbox.find(x => x.id === id); if (m) m.handling.notes++;
        } catch (e) { G().toast(e.message); }
      };
    });
    if (openId && !D.personal) loadHistory(openId);
  }

  window.GencoGrupos = { render };
})();
