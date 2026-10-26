// GENCO IA — tela "Grupos": gestão da caixa compartilhada (fila, donos, situação, notas e configuração).
(() => {
  const G = () => window.Genco;
  const $ = id => document.getElementById(id);
  const PRI = ["urgente", "alta", "normal", "baixa"];
  const PRI_ORD = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
  const FILTERS = [["abertos", "Em aberto"], ["meus", "Meus"], ["semdono", "Sem dono"], ["atrasados", "Atrasados"], ["resolvidos", "Resolvidos"], ["todos", "Todos"]];

  const initialGroup = Number(new URLSearchParams(location.search).get("grupo")) || null;
  let current = initialGroup, D = null, filter = "abertos", owner = "", openId = null, configOpen = false, people = null, busy = false;

  const hrs = m => (Date.now() - m.received_at) / 36e5;
  const isOpen = m => m.handling.status !== "resolvido" && !(m.replied && m.handling.status === "novo");
  const isLate = m => isOpen(m) && !m.replied && hrs(m) >= Number(D.atraso || 4);
  const statusOf = m => m.handling.status === "novo" && m.replied ? "respondido" : m.handling.status;
  const page = () => $("grupos");

  async function render() {
    const { S, esc } = G();
    if (!S.groups.length) return renderEmpty();
    if (!current || !S.groups.some(g => g.id === current)) current = S.groups[0].id;
    if (!D || D.group.id !== current) page().innerHTML = `<h2>Grupos</h2><div class="panel"><p class="muted">Carregando…</p></div>`;
    try { D = await G().api("GET", "/api/groups/" + current); }
    catch (e) { page().innerHTML = `<h2>Grupos</h2><div class="panel"><p class="err">${esc(e.message)}</p></div>`; return; }
    draw();
  }

  // ---------- sem grupos ----------
  function renderEmpty() {
    const { S } = G(), manage = ["admin", "gestor"].includes(S.me.role);
    page().innerHTML = `<h2>Grupos de e-mail</h2>
      <p class="lead">Um grupo é uma caixa compartilhada, como operacional@ ou atendimento@, atendida por várias pessoas. A GENCO IA qualifica cada e-mail, indica quem deve cuidar e a equipe acompanha quem está com o quê, sem duas pessoas respondendo a mesma coisa.</p>
      ${manage ? createForm() : `<div class="panel"><p class="muted">Você ainda não participa de nenhum grupo. O administrador ou gestor da sua empresa pode incluir você.</p></div>`}`;
    if (manage) wireCreate();
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

  // ---------- tela do grupo ----------
  function draw() {
    const { S, esc } = G(), o = D.overview, acc = D.account;
    const tabs = S.groups.length > 1 || D.canManage
      ? `<div class="gtabs" role="tablist">${S.groups.map(g => `<button type="button" role="tab" data-g="${g.id}" aria-selected="${g.id === current}">${esc(g.name)}</button>`).join("")}${D.canManage ? `<button type="button" class="gadd" data-newgroup>+ Novo grupo</button>` : ""}</div>` : "";
    const conn = acc
      ? `<span class="chip">${acc.provider === "demo" ? "demonstração" : esc(acc.provider === "gmail" ? "Gmail" : "Outlook") + " · " + esc(acc.address || "")}</span>${acc.error ? ` <span class="err small">${esc(acc.error)}</span>` : ""}`
      : `<span class="chip warn">e-mail não conectado</span>`;
    page().innerHTML = `${tabs}
      <div class="ghead"><div><h2>${esc(D.group.name)}</h2><p class="small muted">${D.group.address ? esc(D.group.address) + " · " : ""}${conn}${acc?.lastSync ? ` · lido ${esc(G().ago({ received_at: acc.lastSync }))} atrás` : ""}</p></div>
        <div class="actions">${acc ? `<button type="button" class="btn ghost" id="gSync">Ler agora</button><button type="button" class="btn ghost" id="gChat">Perguntar à IA</button>` : ""}${D.canManage ? `<button type="button" class="btn ghost" id="gCfg" aria-expanded="${configOpen}">Configurar</button>` : ""}</div></div>
      <div id="gCfgBox"></div>
      ${acc ? `<div class="panel gstats">
          ${[["Em aberto", o.abertos, ""], ["Sem dono", o.semDono, o.semDono ? "hot" : ""], ["Atrasados", o.atrasados, o.atrasados ? "hot" : ""], ["Urgentes", o.urgentes, o.urgentes ? "crit" : ""], ["Resolvidos (7 dias)", o.resolvidos7d, "good"]]
            .map(([l, n, c]) => `<div class="${c}"><b>${n}</b><span class="cap">${l}</span></div>`).join("")}
        </div>
        <div class="glayout"><div class="gqueue">
          <div class="gfilters"><div class="seg2" role="group" aria-label="Filtro">${FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l}<span>${count(k)}</span></button>`).join("")}</div>
            <select id="gOwner" class="pillsel" aria-label="Filtrar por dono"><option value="">Todos os donos</option>${D.members.map(m => `<option value="${m.id}" ${String(m.id) === owner ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
          <div class="qlist" id="qlist">${rows()}</div></div>
          <aside class="gside">${loadPanel()}${membersPanel()}</aside></div>`
      : `<div class="panel"><p>${D.canManage ? "Conecte o e-mail que recebe as mensagens do grupo em <b>Configurar</b>." : "O e-mail deste grupo ainda não foi conectado. Fale com o administrador ou gestor."}</p></div>`}`;
    wire();
    if (configOpen && D.canManage) drawConfig();
  }

  function list(k = filter) {
    const me = G().S.me.id;
    let l = D.inbox.filter(m => ({
      abertos: isOpen(m), meus: isOpen(m) && m.handling.assignee_id === me, semdono: isOpen(m) && !m.handling.assignee_id && m.triage?.prioridade !== "baixa",
      atrasados: isLate(m), resolvidos: !isOpen(m), todos: true }[k]));
    if (owner && k !== "meus") l = l.filter(m => String(m.handling.assignee_id) === owner);
    if (k !== "resolvidos" && k !== "todos") l.sort((a, b) => (isLate(b) - isLate(a)) || (PRI_ORD[a.triage?.prioridade] ?? 9) - (PRI_ORD[b.triage?.prioridade] ?? 9) || a.received_at - b.received_at);
    return l;
  }
  const count = k => list(k).length;

  function rows() {
    const { esc, ago, initials } = G();
    const l = list();
    if (!l.length) return `<div class="qempty">${{ semdono: "Nenhum e-mail sem dono. Tudo tem alguém cuidando.", meus: "Nada com você agora.", atrasados: "Nenhum e-mail atrasado.", resolvidos: "Nenhum e-mail resolvido ainda." }[filter] || "Nada por aqui."}</div>`;
    return l.map(m => {
      const t = m.triage || {}, h = m.handling, st = statusOf(m), late = isLate(m);
      return `<article class="qrow ${openId === m.id ? "open" : ""} ${isOpen(m) ? "" : "done"}" data-id="${esc(m.id)}">
        <button type="button" class="qmain" data-toggle="${esc(m.id)}" aria-expanded="${openId === m.id}">
          <span class="pdot ${esc(t.prioridade || "")}" title="${esc(t.prioridade || "não qualificado")}"></span>
          <span class="qtxt"><span class="qtop"><b>${esc(m.from_name || m.from_addr)}</b><time class="${late ? "late" : ""}">${late ? "sem resposta há " : "há "}${esc(ago(m))}</time></span>
            <span class="qsubj">${esc(m.subject)}</span>
            ${t.tarefa || t.motivo ? `<span class="qwhy">${esc(t.tarefa || t.motivo)}</span>` : ""}</span>
        </button>
        <div class="qctl">
          <span class="qowner ${h.assignee ? "" : "none"}">${h.assignee ? `<span class="av sm">${esc(initials(h.assignee))}</span>${esc(h.assignee)}` : `sem dono${t.responsavel ? `<small>IA sugere ${esc(t.responsavel)}</small>` : ""}`}</span>
          <span class="st ${esc(st)}">${esc(st === "respondido" ? "Respondido" : D.statuses[st] || st)}</span>
          ${h.notes ? `<span class="qnotes" title="Notas internas">${h.notes}</span>` : ""}
        </div>
        ${openId === m.id ? detail(m) : ""}
      </article>`;
    }).join("");
  }

  function detail(m) {
    const { esc, S } = G(), t = m.triage || {}, h = m.handling, me = S.me.id;
    const quick = [];
    if (h.assignee_id !== me && isOpen(m)) quick.push(`<button type="button" class="btn" data-act="assumir">Assumir</button>`);
    if (isOpen(m)) quick.push(`<button type="button" class="btn ghost" data-act="resolver">Marcar como resolvido</button>`);
    else quick.push(`<button type="button" class="btn ghost" data-act="reabrir">Reabrir</button>`);
    return `<div class="qdetail">
      <div class="qedit">
        <div class="field"><label for="own-${esc(m.id)}">Dono</label><select id="own-${esc(m.id)}" data-own><option value="">Sem dono</option>${D.members.map(p => `<option value="${p.id}" ${p.id === h.assignee_id ? "selected" : ""}>${esc(p.name)}${p.id === me ? " (você)" : ""}</option>`).join("")}</select></div>
        <div class="field"><label for="sta-${esc(m.id)}">Situação</label><select id="sta-${esc(m.id)}" data-sta>${Object.entries(D.statuses).map(([k, v]) => `<option value="${k}" ${k === h.status ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>
        <div class="actions qquick">${quick.join("")}</div>
      </div>
      ${t.motivo ? `<p class="small"><span class="cap">Leitura da IA</span><br>${esc(t.motivo)}${t.prazo ? ` · prazo ${esc(t.prazo)}` : ""}${t.categoria ? ` · ${esc(t.categoria)}` : ""}</p>` : ""}
      ${(t.divergencias || []).length ? `<div class="divg"><span class="cap">Divergências nos documentos</span><ul>${t.divergencias.map(d => `<li>${esc(d)}</li>`).join("")}</ul></div>` : ""}
      <details class="orig" open><summary>E-mail de ${esc(m.from_addr)}</summary><pre>${esc(m.body)}</pre>${m.attachments.map(a => `<pre class="att">${esc(a.name)}\n\n${esc(a.text || "(conteúdo não lido)")}</pre>`).join("")}</details>
      ${m.draft ? `<details class="orig"><summary>Rascunho de resposta pronto</summary><pre>${esc(m.draft.assunto)}\n\n${esc(m.draft.corpo)}</pre></details>` : ""}
      <div class="qhist"><span class="cap">Histórico e notas da equipe</span><div id="hist-${esc(m.id)}" class="hist"><p class="small muted">Carregando…</p></div>
        <form class="noteform" data-note><input placeholder="Escreva uma nota para a equipe (o cliente não vê)" aria-label="Nota interna" maxlength="2000"><button type="submit" class="btn ghost">Anotar</button></form></div>
    </div>`;
  }

  function loadPanel() {
    const { esc } = G(), ps = D.overview.pessoas, max = Math.max(1, ...ps.map(p => p.abertos));
    if (!ps.length) return "";
    return `<div class="panel"><span class="cap">Carga por pessoa</span>
      <div class="people">${ps.map(p => `<button type="button" class="person pbtn" data-person="${p.id}" aria-pressed="${String(p.id) === owner}"><span>${esc(p.name)}</span><div class="bar"><i style="width:${Math.round(p.abertos / max * 100)}%"></i></div><b>${p.abertos}</b></button>
        ${p.atrasados || p.urgentes ? `<div class="psub">${p.urgentes ? `${p.urgentes} urgente${p.urgentes > 1 ? "s" : ""}` : ""}${p.urgentes && p.atrasados ? " · " : ""}${p.atrasados ? `<span class="late">${p.atrasados} atrasado${p.atrasados > 1 ? "s" : ""}</span>` : ""}</div>` : ""}`).join("")}</div>
      <p class="small muted">Resolvidos nos últimos 7 dias: ${ps.map(p => `${esc(p.name.split(" ")[0])} ${p.resolvidos7d}`).join(" · ")}</p></div>`;
  }
  function membersPanel() {
    const { esc } = G();
    return `<div class="panel"><span class="cap">Quem cuida do quê</span><dl class="mlist">${D.members.map(m => `<div><dt>${esc(m.name)}${m.coordena ? ' <span class="chip">responsável</span>' : ""}</dt><dd>${esc(m.regra || "Atende e-mails do grupo.")}</dd></div>`).join("") || `<p class="small muted">Nenhum membro ainda.</p>`}</dl>
      <p class="small muted">${D.group.autoAtribuir ? "A IA define o dono dos e-mails novos pela regra de cada pessoa." : "Os donos são definidos pela equipe."}</p></div>`;
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

      <h3>Membros</h3>
      <p class="small muted">Marque quem atende este grupo e escreva o que cada pessoa cuida. A IA usa isso para sugerir o dono de cada e-mail.</p>
      <div class="mrows">${people.map(p => { const m = mem.get(p.id); return `<div class="mrow" data-p="${p.id}">
          <label class="check"><input type="checkbox" ${m ? "checked" : ""} data-in> <span><b>${esc(p.name)}</b><small>${esc(p.email)}</small></span></label>
          <input data-regra value="${esc(m?.regra || "")}" placeholder="O que essa pessoa cuida no grupo" aria-label="Regra de ${esc(p.name)}">
          <label class="check small"><input type="radio" name="coord" data-coord ${m?.coordena ? "checked" : ""}> responsável</label></div>`; }).join("")}</div>
      <div class="actions"><button type="button" class="btn" id="cgMembers">Salvar membros</button></div>

      <h3>E-mail do grupo</h3>
      ${acc ? `<p>${acc.provider === "demo" ? "Caixa de demonstração" : `${acc.provider === "gmail" ? "Gmail" : "Outlook"} · <b>${esc(acc.address || "")}</b>`}</p>
          <div class="actions"><button type="button" class="btn ghost" id="cgOff">Desconectar</button></div>`
        : `<p class="small muted">Conecte a conta que recebe os e-mails do grupo. <b>Se o grupo for uma lista do Google Groups</b> (cada membro recebe uma cópia), conecte a conta de um dos membros e preencha o endereço do grupo acima: a GENCO IA lê só o que chega para o grupo e reconhece quando alguém da equipe já respondeu. <b>Se for uma caixa própria</b> (com senha), conecte a própria caixa.</p>
          <div class="connect">
            <button type="button" class="conn" data-gconn="gmail" ${f.gmail ? "" : "disabled"}><b>Gmail</b><span>${f.gmail ? "Google Workspace" : "Ainda não configurado neste servidor"}</span></button>
            <button type="button" class="conn" data-gconn="outlook" ${f.outlook ? "" : "disabled"}><b>Outlook</b><span>${f.outlook ? "Microsoft 365 (caixa compartilhada)" : "Ainda não configurado neste servidor"}</span></button>
            <button type="button" class="conn" data-gconn="demo"><b>Demonstração</b><span>E-mails fictícios para testar o grupo</span></button>
          </div>`}
      ${S.me.role === "admin" ? `<h3>Excluir grupo</h3><p class="small muted">Apaga a fila, os donos, as notas e a conexão do grupo na GENCO IA. Os e-mails no Gmail não são apagados.</p><div class="actions"><button type="button" class="btn ghost danger" id="cgDel">Excluir grupo</button></div>` : ""}
    </div>`;

    $("cgSave").onclick = async () => {
      try { await G().api("PUT", "/api/groups/" + current, { nome: $("cgNome").value, endereco: $("cgEnd").value, filtro: $("cgFiltro").value, autoAtribuir: $("cgAuto").checked }); G().toast("Grupo salvo"); await G().refresh(); }
      catch (e) { G().toast(e.message); }
    };
    $("cgMembers").onclick = async () => {
      const membros = [...box.querySelectorAll(".mrow")].filter(r => r.querySelector("[data-in]").checked).map(r => ({ user_id: Number(r.dataset.p), regra: r.querySelector("[data-regra]").value, coordena: r.querySelector("[data-coord]").checked }));
      try { await G().api("PUT", `/api/groups/${current}/members`, { membros }); G().toast("Membros salvos"); await G().refresh(); }
      catch (e) { G().toast(e.message); }
    };
    box.querySelectorAll("[data-gconn]").forEach(b => b.onclick = async () => {
      const p = b.dataset.gconn;
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
  async function act(ids, body) {
    if (busy) return; busy = true;
    try { const d = await G().api("POST", `/api/groups/${current}/handling`, { ids, ...body }); D.inbox = d.inbox; await reload(true); }
    catch (e) { G().toast(e.message); }
    busy = false;
  }
  async function reload(keepScroll) {
    const y = $("v-grupos").scrollTop;
    D = await G().api("GET", "/api/groups/" + current); draw();
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
    root.querySelectorAll("[data-g]").forEach(b => b.onclick = () => { current = Number(b.dataset.g); owner = ""; openId = null; configOpen = false; render(); });
    root.querySelector("[data-newgroup]") && (root.querySelector("[data-newgroup]").onclick = () => {
      $("gCfgBox").innerHTML = createForm(); wireCreate(); $("gNome").focus();
    });
    $("gSync") && ($("gSync").onclick = async () => {
      $("gSync").disabled = true; $("gSync").textContent = "Lendo…";
      try { const d = await G().api("POST", "/api/sync", { grupo: current }); G().toast(d.added ? `${d.added} e-mail${d.added > 1 ? "s" : ""} novo${d.added > 1 ? "s" : ""}` : "Nenhum e-mail novo"); await reload(); }
      catch (e) { G().toast(e.message); $("gSync").disabled = false; $("gSync").textContent = "Ler agora"; }
    });
    $("gChat") && ($("gChat").onclick = () => G().openChat(current));
    $("gCfg") && ($("gCfg").onclick = () => { configOpen = !configOpen; draw(); if (configOpen) $("gCfgBox").scrollIntoView({ behavior: "smooth", block: "start" }); });
    root.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { filter = b.dataset.f; openId = null; draw(); });
    $("gOwner") && ($("gOwner").onchange = () => { owner = $("gOwner").value; draw(); });
    root.querySelectorAll("[data-person]").forEach(b => b.onclick = () => { owner = owner === b.dataset.person ? "" : b.dataset.person; if (filter === "meus") filter = "abertos"; draw(); });
    root.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => { openId = openId === b.dataset.toggle ? null : b.dataset.toggle; draw(); });
    root.querySelectorAll(".qrow.open").forEach(row => {
      const id = row.dataset.id;
      row.querySelector("[data-own]").onchange = e => act([id], { dono: e.target.value || null });
      row.querySelector("[data-sta]").onchange = e => act([id], { situacao: e.target.value });
      row.querySelectorAll("[data-act]").forEach(b => b.onclick = () => act([id], { assumir: { dono: "eu" }, resolver: { situacao: "resolvido" }, reabrir: { situacao: "andamento" } }[b.dataset.act]));
      row.querySelector("[data-note]").onsubmit = async ev => {
        ev.preventDefault();
        const inp = ev.target.querySelector("input"), texto = inp.value.trim(); if (!texto) return;
        try {
          const d = await G().api("POST", `/api/groups/${current}/messages/${encodeURIComponent(id)}/notes`, { texto });
          inp.value = ""; $("hist-" + id).innerHTML = histHtml(d.history);
          const m = D.inbox.find(x => x.id === id); if (m) m.handling.notes++;
        } catch (e) { G().toast(e.message); }
      };
    });
    if (openId) loadHistory(openId);
  }

  window.GencoGrupos = { render };
})();
