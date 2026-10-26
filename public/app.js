// GENCO IA — aplicativo (conversa, visão da equipe e configurações).
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PRI = ["urgente", "alta", "normal", "baixa"];
  const STATUS_TXT = { novo: "Novo", andamento: "Em andamento", aguardando: "Aguardando terceiros", resolvido: "Resolvido" };
  let S = null, busy = false, view = "grupos", box = null; // abre em Pendências // box = id do grupo em uso na conversa (null = caixa pessoal)
  const boxQ = () => box ? "?grupo=" + box : "";

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = "/"; throw new Error("Sessão expirada."); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || "Algo deu errado. Tente de novo."); e.status = r.status; throw e; }
    return d;
  }
  function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 3200); }

  const NOW = () => Date.now();
  const hrs = m => (NOW() - m.received_at) / 36e5;
  const ago = m => { const h = hrs(m); if (h < 1) return Math.max(1, Math.round(h * 60)) + " min"; if (h < 24) return Math.round(h) + " h"; return Math.floor(h / 24) + " d " + Math.round(h % 24) + " h"; };
  const late = m => !m.replied && m.handling?.status !== "resolvido" && hrs(m) >= Number(S.rules.atraso || 4);
  const byId = id => S.inbox.find(m => m.id === id);
  const initials = s => String(s || "?").replace(/\(.*?\)/g, "").trim().split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const canRules = () => ["admin", "gestor"].includes(S.me.role);
  function md(src) {
    const lines = esc(src).split("\n"); let out = "", list = null, para = [];
    const inline = t => t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    const close = () => { if (list) { out += `</${list}>`; list = null; } };
    const flush = () => { if (para.length) { out += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
    lines.forEach(l => {
      const ul = l.match(/^\s*[-•]\s+(.*)/), ol = l.match(/^\s*\d+[.)]\s+(.*)/);
      if (ul || ol) { flush(); const k = ul ? "ul" : "ol"; if (list !== k) { close(); out += `<${k}>`; list = k; } out += `<li>${inline((ul || ol)[1])}</li>`; }
      else if (!l.trim()) { flush(); close(); } else { close(); para.push(l); }
    });
    flush(); close(); return out;
  }
  const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;

  // ---------- cartões ----------
  function mailCard(id) {
    const m = byId(id); if (!m) return "";
    const r = m.triage || {}, meta = [];
    if (r.prioridade) meta.push(`<span class="prio ${esc(r.prioridade)}"><i></i>${esc(r.prioridade)}</span>`);
    if (S.box) { const h = m.handling || {}; meta.push(h.assignee ? `<span class="owner"><i></i>${esc(h.assignee)}</span>` : m.replied || r.prioridade === "baixa" ? "" : `<span class="noowner">sem dono${r.responsavel ? " · IA sugere " + esc(r.responsavel) : ""}</span>`); if (h.status && h.status !== "novo") meta.push(`<span class="st ${esc(h.status)}">${esc(STATUS_TXT[h.status] || h.status)}</span>`); if (h.notes) meta.push(`<span>${h.notes} nota${h.notes > 1 ? "s" : ""}</span>`); }
    else if (r.responsavel) meta.push(`<span>${esc(r.responsavel)}</span>`);
    if (late(m)) meta.push(`<span class="late">sem resposta há ${esc(ago(m))}</span>`); else if (m.replied) meta.push(`<span>respondido</span>`);
    if (r.categoria) meta.push(`<span>${esc(r.categoria)}</span>`);
    if (m.attachments.length) meta.push(`<span>${m.attachments.length} anexo${m.attachments.length > 1 ? "s" : ""}</span>`);
    const div = (r.divergencias || []).length ? `<div class="divg"><span class="cap">Divergências nos documentos</span><ul>${r.divergencias.map(d => `<li>${esc(d)}</li>`).join("")}</ul></div>` : "";
    return `<div class="card mail"><span class="av">${esc(initials(m.from_name || m.from_addr))}</span><div class="mail-b">
      <div class="mail-top"><b>${esc(m.from_name || m.from_addr)}</b><time>há ${esc(ago(m))}</time></div>
      <div class="subj">${esc(m.subject)}</div>
      ${r.motivo ? `<div class="why">${esc(r.motivo)}${r.tarefa ? ` · <b>${esc(r.tarefa)}</b>` : ""}${r.prazo ? ` · prazo ${esc(r.prazo)}` : ""}</div>` : ""}
      <div class="meta">${meta.join("")}</div>${div}
      <details class="orig"><summary>Ver e-mail original</summary><pre>${esc(m.body)}</pre>${m.attachments.map(a => `<pre class="att">${esc(a.name)}\n\n${esc(a.text || "(conteúdo não lido)")}</pre>`).join("")}</details>
    </div></div>`;
  }
  function draftCard(id) {
    const m = byId(id); if (!m || !m.draft) return "";
    const demo = S.account?.provider === "demo";
    return `<div class="card draft" data-draft="${esc(id)}">
      <div class="draft-h"><span class="cap">Resposta para ${esc(m.from_name || m.from_addr)}</span><button type="button" class="btn" data-copy="${esc(id)}">Copiar resposta</button></div>
      <input id="ds-${esc(id)}" value="${esc(m.draft.assunto)}" aria-label="Assunto">
      <textarea id="db-${esc(id)}" aria-label="Texto da resposta">${esc(m.draft.corpo)}</textarea>
      <div class="draft-f"><span id="dst-${esc(id)}">${demo ? "Caixa de demonstração: o rascunho fica só aqui." : m.draft.saved ? `<span class="saved-tag">Salvo como rascunho ${S.box ? "em " + esc(S.account?.address || "na caixa do grupo") : "no seu e-mail"}</span>` : "Não foi possível salvar no e-mail; copie a resposta."}</span></div></div>`;
  }
  function summaryCard() {
    const tri = S.inbox.filter(m => m.triage); if (!tri.length) return "";
    const c = Object.fromEntries(PRI.map(p => [p, tri.filter(m => m.triage.prioridade === p).length]));
    const people = S.rules.team.map(t => [t.nome, tri.filter(m => (S.box ? m.handling?.assignee === t.nome && m.handling.status !== "resolvido" : m.triage.responsavel === t.nome) && m.triage.prioridade !== "baixa" && !m.replied).length]);
    const max = Math.max(1, ...people.map(p => p[1]));
    return `<div class="card sum"><span class="cap">Caixa qualificada · ${tri.length} de ${S.inbox.length} e-mails</span>
      <div class="counts">${PRI.map(p => `<div class="${p}"><b>${c[p]}</b><span class="cap">${p}</span></div>`).join("")}</div>
      <div class="people"><span class="cap">${S.box ? "Em aberto por dono" : "Pendências por responsável"}</span>${people.map(([n, k]) => `<div class="person"><span>${esc(n)}</span><div class="bar"><i style="width:${Math.round(k / max * 100)}%"></i></div><b>${k}</b></div>`).join("")}</div></div>`;
  }
  function rulesCard() {
    return `<div class="card rules"><span class="cap">Equipe e regras em uso</span><dl>${S.rules.team.map(t => `<div><dt>${esc(t.nome)}</dt><dd>${esc(t.regra)}</dd></div>`).join("")}</dl>
      <div class="foot">Atraso a partir de ${esc(S.rules.atraso)} h sem resposta · resumo para ${esc(S.rules.coord)}</div></div>`;
  }
  const renderCards = cards => (cards || []).map(k => k.t === "mail" ? mailCard(k.id) : k.t === "draft" ? draftCard(k.id) : k.t === "sum" ? summaryCard() : k.t === "rules" ? rulesCard() : "").join("");

  // ---------- conversa ----------
  const TILES_GRUPO = [["O que está sem dono?", "E-mails do grupo que ninguém assumiu"], ["Quais são os meus?", "O que está com você no grupo"], ["Eu assumo os urgentes", "A IA passa os urgentes sem dono para você"], ["O que está atrasado no grupo?", "Clientes esperando além do prazo"]];
  const TILES = [["O que é urgente hoje?", "Prioridades da caixa, com motivo"], ["Quem está sem resposta?", "Clientes esperando além do prazo"], ["Prepare as respostas dos atrasados", "Rascunhos no seu e-mail para revisar"], ["Algum documento com divergência?", "Anexos conferidos entre si"]];
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite"; };
  function connectBlock(title) {
    const f = S.features;
    return `<section class="hello"><span class="cap">Primeiro passo</span><h2>${esc(title)}</h2>
      <p class="lead">A GENCO IA funciona com Gmail, Outlook e qualquer outro provedor de e-mail. Ela cria rascunhos, mas nunca envia nada por você. Você pode desconectar quando quiser.</p>
      <div class="connect">
        <button type="button" class="conn" data-connect="gmail" ${f.gmail ? "" : "disabled"}><b>Gmail</b><span>${f.gmail ? "Google Workspace ou Gmail" : "Ainda não configurado neste servidor"}</span></button>
        <button type="button" class="conn" data-connect="outlook" ${f.outlook ? "" : "disabled"}><b>Outlook</b><span>${f.outlook ? "Microsoft 365 ou Outlook.com" : "Ainda não configurado neste servidor"}</span></button>
        <button type="button" class="conn" data-connect="imap"><b>Outro provedor</b><span>Locaweb, UOL, Hostinger, Yahoo, domínio próprio…</span></button>
        <button type="button" class="conn" data-connect="demo"><b>Caixa de demonstração</b><span>E-mails fictícios do seu ramo, para conhecer</span></button>
      </div><div id="imapBox"></div></section>`;
  }
  function hello() {
    if (S.box && !S.account) return `<section class="hello"><span class="cap">Grupo ${esc(S.box.name)}</span><h2>O e-mail deste grupo ainda não foi conectado.</h2>
      <p class="lead">${canRules() ? "Conecte a conta que recebe os e-mails do grupo na tela Grupos." : "Peça ao administrador ou gestor para conectar o e-mail do grupo."}</p>
      ${canRules() ? `<div class="actions"><button type="button" class="btn" data-goto="grupos">Abrir Grupos</button></div>` : ""}</section>`;
    if (!S.account) return connectBlock(`${greeting()}, ${S.me.name.split(" ")[0]}. Conecte seu e-mail para começar.`);
    if (S.box) {
      const open = S.inbox.filter(m => m.handling.status !== "resolvido" && !(m.replied && m.handling.status === "novo"));
      const sem = open.filter(m => !m.handling.assignee_id && m.triage?.prioridade !== "baixa").length, mine = open.filter(m => m.handling.assignee_id === S.me.id).length;
      return `<section class="hello"><span class="cap">Grupo ${esc(S.box.name)}${S.box.address ? " · " + esc(S.box.address) : ""}</span>
        <h2>${greeting()}, ${esc(S.me.name.split(" ")[0])}. O grupo tem ${open.length} e-mails em aberto: <em>${sem} sem dono</em>${mine ? ` e ${mine} com você` : ""}.</h2>
        <p class="lead">Pergunte sobre a caixa do grupo. Eu mostro o que está sem dono, passo e-mails para quem deve cuidar, registro notas para a equipe e preparo as respostas.</p>
        <div class="tiles">${TILES_GRUPO.map(([t, d]) => `<button type="button" class="tile" data-q="${esc(t)}"><b>${esc(t)}</b><span>${esc(d)}</span></button>`).join("")}</div></section>`;
    }
    const l = S.inbox.filter(late).length;
    const day = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
    return `<section class="hello"><span class="cap">${esc(S.account.address || "")} · ${esc(day)}</span>
      <h2>${greeting()}, ${esc(S.me.name.split(" ")[0])}. ${S.inbox.length ? `Sua caixa tem ${S.inbox.length} e-mails recentes, <em>${l} esperando resposta</em> além do prazo.` : "Sua caixa está sendo lida. Em instantes aparecem os e-mails."}</h2>
      <p class="lead">Pergunte o que precisar. Eu qualifico os e-mails, indico quem deve cuidar de cada um, confiro anexos e deixo as respostas prontas no seu e-mail.</p>
      <div class="tiles">${TILES.map(([t, d]) => `<button type="button" class="tile" data-q="${esc(t)}"><b>${esc(t)}</b><span>${esc(d)}</span></button>`).join("")}</div></section>`;
  }
  function aiBlock(m) {
    return `<div class="msg ai"><div class="sig"><i></i><span class="cap">GENCO IA</span></div><div class="cards">${renderCards(m.cards)}</div>
      ${m.text ? `<div class="text">${md(m.text)}</div>` : ""}${m.error ? `<div class="err">${esc(m.error)}</div>` : ""}</div>`;
  }
  function renderPulse() {
    const has = S.account && S.chat.length;
    $("pulse").hidden = !has; if (!has) return;
    const tri = S.inbox.filter(m => m.triage), urg = tri.filter(m => m.triage.prioridade === "urgente" && !m.replied).length;
    const sem = S.box ? S.inbox.filter(m => !m.handling.assignee_id && m.handling.status !== "resolvido" && !m.replied && m.triage?.prioridade !== "baixa").length : 0;
    $("pulseIn").innerHTML = `<div><b>${S.inbox.length}</b>e-mails</div><div class="hot"><b>${S.inbox.filter(late).length}</b>atrasados</div><div class="${urg ? "hot" : ""}"><b>${tri.length ? urg : "–"}</b>urgentes</div>${S.box ? `<div class="${sem ? "hot" : ""}"><b>${sem}</b>sem dono</div>` : `<div><b>${S.inbox.filter(m => m.draft).length}</b>respostas prontas</div>`}<div class="sync"><button type="button" id="bSync">Atualizar caixa</button></div>`;
    $("bSync").onclick = syncNow;
  }
  function renderChat() {
    $("log").innerHTML = !S.chat.length ? hello() : S.chat.map(m => m.role === "user" ? `<div class="msg me"><div class="text">${esc(m.text)}</div></div>` : aiBlock(m)).join("");
    $("composer").hidden = !S.account;
    $("input").placeholder = S.box ? `Pergunte sobre a caixa do grupo ${S.box.name}` : "Pergunte o que precisa saber sobre a sua caixa";
    wire($("log")); renderPulse(); $("chat").scrollTop = $("chat").scrollHeight;
  }
  function wire(root) {
    root.querySelectorAll("[data-q]").forEach(b => b.onclick = () => send(b.dataset.q));
    root.querySelectorAll("[data-connect]").forEach(b => b.onclick = () => connect(b.dataset.connect));
    root.querySelectorAll("[data-goto]").forEach(b => b.onclick = () => show(b.dataset.goto));
    root.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
      const id = b.dataset.copy;
      try { await navigator.clipboard.writeText($("ds-" + id).value + "\n\n" + $("db-" + id).value); toast("Resposta copiada"); } catch { toast("Não foi possível copiar. Selecione o texto."); }
    });
    root.querySelectorAll("[data-draft]").forEach(c => {
      const id = c.dataset.draft; let t;
      const save = () => { clearTimeout(t); t = setTimeout(async () => {
        try {
          const r = await api("PUT", "/api/drafts/" + encodeURIComponent(id) + boxQ(), { assunto: $("ds-" + id).value, corpo: $("db-" + id).value });
          const m = byId(id); if (m) m.draft = { assunto: $("ds-" + id).value, corpo: $("db-" + id).value, saved: r.saved };
          const st = $("dst-" + id); if (st && r.saved) st.innerHTML = `<span class="saved-tag">Alteração salva ${S.box ? "na caixa do grupo" : "no seu e-mail"}</span>`;
        } catch (e) { toast(e.message); }
      }, 1200); };
      $("ds-" + id).oninput = save; $("db-" + id).oninput = save;
    });
  }

  async function send(text) {
    text = String(text || "").trim(); if (!text || busy) return;
    busy = true; $("send").disabled = true;
    S.chat.push({ role: "user", text });
    renderChat();
    const node = document.createElement("div"); node.className = "msg ai";
    node.innerHTML = `<div class="sig"><i></i><span class="cap">GENCO IA</span></div><div class="text"><span class="dots"><i></i><i></i><i></i></span><span class="step">Lendo a caixa e pensando…</span></div>`;
    $("log").appendChild(node); $("chat").scrollTop = $("chat").scrollHeight;
    try {
      const d = await api("POST", "/api/chat", { texto: text, grupo: box || undefined });
      S.inbox = d.inbox; S.rules = d.rules;
      S.chat.push({ role: "assistant", text: d.reply.text, cards: d.reply.cards, error: d.reply.error });
    } catch (e) {
      S.chat.push({ role: "assistant", text: "", cards: [], error: e.message });
      if (e.status === 402) refresh();
    }
    busy = false; $("send").disabled = false; renderChat();
  }
  async function syncNow() {
    try { const d = await api("POST", "/api/sync", box ? { grupo: box } : undefined); S.inbox = d.inbox; toast(d.added ? `${d.added} e-mail${d.added > 1 ? "s" : ""} novo${d.added > 1 ? "s" : ""}` : "Nenhum e-mail novo"); renderChat(); }
    catch (e) { toast(e.message); }
  }
  async function connect(p) {
    if (p === "imap") { imapConnect($("imapBox")); return; }
    if (p === "demo") {
      try { await api("POST", "/api/connect/demo", { setor: S.company.sector }); await refresh(); toast("Caixa de demonstração conectada"); } catch (e) { toast(e.message); }
      return;
    }
    location.href = "/api/connect/" + p;
  }

  // ---------- equipe (gestor) ----------
  async function renderEquipe() {
    $("equipe").innerHTML = `<h2>Equipe</h2><p class="lead">Pendências de cada pessoa, sem expor o conteúdo dos e-mails.</p><div class="panel"><p class="muted">Carregando…</p></div>`;
    try {
      const d = await api("GET", "/api/team/overview");
      $("equipe").innerHTML = `<h2>Equipe</h2><p class="lead">Pendências de cada pessoa, sem expor o conteúdo dos e-mails. Atraso a partir de ${esc(d.atraso)} h sem resposta.</p>
        <div class="panel tbl"><table><thead><tr><th>Pessoa</th><th>E-mail conectado</th><th style="text-align:right">Urgentes</th><th style="text-align:right">Atrasados</th><th style="text-align:right">Respostas prontas</th><th style="text-align:right">A qualificar</th></tr></thead><tbody>
        ${d.people.map(p => `<tr><td><b>${esc(p.name)}</b><div class="small muted">${esc(p.email)}${p.pending ? " · convite pendente" : ""}</div></td>
          <td>${p.connected ? `<span class="chip">${esc(p.connected)}</span>` : '<span class="muted small">não conectado</span>'}</td>
          <td class="n ${p.urgent ? "hot" : ""}">${p.urgent}</td><td class="n ${p.late ? "hot" : ""}">${p.late}</td><td class="n">${p.drafts}</td><td class="n">${p.untriaged}</td></tr>`).join("")}
        </tbody></table></div>`;
    } catch (e) { $("equipe").querySelector(".panel").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  // ---------- configurações ----------
  function teamRows(team) {
    return team.map((t, i) => `<div class="teamrow" data-i="${i}"><input id="tn${i}" value="${esc(t.nome)}" placeholder="Nome ou área" aria-label="Nome"><input id="tr${i}" value="${esc(t.regra)}" placeholder="O que essa pessoa cuida" aria-label="Regra"><button type="button" class="iconbtn" data-rm="${i}" aria-label="Remover">×</button></div>`).join("");
  }
  async function renderConfig() {
    const a = S.myAccount, acc = S.company.access, admin = S.me.role === "admin";
    const statusTxt = { active: "Assinatura ativa", trialing: `Teste grátis · ${acc.daysLeft} dia${acc.daysLeft === 1 ? "" : "s"} restante${acc.daysLeft === 1 ? "" : "s"}`, past_due: "Pagamento pendente", trial_ended: "Teste encerrado", canceled: "Assinatura cancelada" }[acc.status] || acc.status;
    $("config").innerHTML = `<h2>Configurações</h2>
      <div class="panel"><h3>Seu e-mail</h3>
        ${a ? `<p>${a.provider === "demo" ? `Caixa de demonstração · <b>${esc((S.sectors || {})[a.demoSector] || "e-mails fictícios")}</b>` : `${({ gmail: "Gmail", outlook: "Outlook", imap: "IMAP" }[a.provider] || a.provider)} · <b>${esc(a.address || "")}</b>`}</p>
          <p class="small muted">${a.lastSync ? "Última leitura: " + new Date(a.lastSync).toLocaleString("pt-BR") : "Ainda não lido"}${a.error ? ` · <span class="err">${esc(a.error)}</span>` : ""}</p>
          <div class="actions"><button type="button" class="btn ghost" id="cSync">Ler agora</button><button type="button" class="btn ghost" id="cSwap">Trocar de e-mail</button><button type="button" class="btn ghost" id="cOff">Desconectar</button></div>`
        : `<p class="muted">Nenhum e-mail conectado.</p><div class="actions"><button type="button" class="btn" id="cSwap">Conectar e-mail</button></div>`}
      </div>
      ${window.GencoPWA && !window.GencoPWA.installed ? `<div class="panel" id="installPanel"></div>` : ""}
      <div class="panel" id="digestPanel"><h3>Resumo diário por e-mail</h3><p class="muted small">Carregando…</p></div>
      <div class="panel"><h3>Equipe e regras</h3>
        <p class="small muted">A GENCO IA usa estas regras para qualificar e indicar o responsável de cada e-mail. ${canRules() ? "Você também pode mudar conversando com ela." : "Só administradores e gestores podem alterar."}</p>
        <div id="teamRows" style="display:grid;gap:8px">${teamRows(S.rules.team)}</div>
        ${canRules() ? `<div class="actions"><button type="button" class="btn ghost" id="cAddT">Adicionar pessoa ou área</button></div>` : ""}
        <div class="grid2"><div class="field"><label for="cCoord">Quem recebe o resumo</label><input id="cCoord" value="${esc(S.rules.coord)}"></div>
          <div class="field"><label for="cAtraso">Atrasado após (horas sem resposta)</label><input id="cAtraso" type="number" min="1" max="168" value="${esc(S.rules.atraso)}"></div></div>
        <div class="field"><label for="cUrg">Critérios de prioridade</label><textarea id="cUrg">${esc(S.rules.urg)}</textarea></div>
        <div class="field"><label for="cTom">Tom e assinatura das respostas</label><textarea id="cTom">${esc(S.rules.tom)}</textarea></div>
        ${canRules() ? `<div class="actions"><button type="button" class="btn" id="cSaveRules">Salvar regras</button></div>` : ""}
      </div>
      ${admin ? `<div class="panel"><h3>Pessoas</h3><div id="users" class="tbl"><p class="muted small">Carregando…</p></div>
        <div class="grid2"><div class="field"><label for="uNome">Nome</label><input id="uNome"></div><div class="field"><label for="uEmail">E-mail</label><input id="uEmail" type="email"></div></div>
        <div class="actions"><select id="uRole" class="pillsel" aria-label="Perfil"><option value="membro">Membro</option><option value="gestor">Gestor</option><option value="admin">Administrador</option></select><button type="button" class="btn" id="uInvite">Convidar</button></div>
        <div id="inviteOut"></div>
        <p class="small muted">Cada pessoa conecta o próprio e-mail e vê só a própria caixa. Gestores veem os indicadores da equipe.</p></div>
      <div class="panel"><h3>Assinatura</h3><p><b>${esc(statusTxt)}</b> · ${S.company.seats} usuário${S.company.seats === 1 ? "" : "s"}</p>
        <p class="small muted">Cobrança mensal por usuário. ${S.features.stripe ? "" : "A cobrança ainda não foi configurada neste servidor."}</p>
        <div class="actions">${S.company.hasSubscription ? `<button type="button" class="btn ghost" id="bPortal">Gerenciar assinatura e pagamento</button>` : `<button type="button" class="btn brand" id="bCheckout" ${S.features.stripe ? "" : "disabled"}>Assinar a GENCO IA</button>`}</div>
        <p class="small muted">Uso neste mês: ${S.usage.month} de ${S.usage.limit} mensagens para a IA.</p></div>` : ""}`;

    loadDigest(); renderInstall();
    const ro = !canRules();
    $("config").querySelectorAll("#teamRows input, #cCoord, #cAtraso, #cUrg, #cTom").forEach(el => el.disabled = ro);
    $("cSwap") && ($("cSwap").onclick = async () => { box = null; await refresh(); S.account = null; S.chat = []; show("conversa"); renderChat(); });
    $("cSync") && ($("cSync").onclick = async () => { try { const d = await api("POST", "/api/sync"); toast(d.added ? `${d.added} e-mail(s) novo(s)` : "Nenhum e-mail novo"); await refresh(); } catch (e) { toast(e.message); } });
    $("cOff") && ($("cOff").onclick = async () => { try { await api("DELETE", "/api/connect"); await refresh(); toast("E-mail desconectado"); } catch (e) { toast(e.message); } });
    const readTeam = () => [...$("teamRows").querySelectorAll(".teamrow")].map(r => ({ nome: r.children[0].value, regra: r.children[1].value }));
    $("teamRows").onclick = ev => { const b = ev.target.closest("[data-rm]"); if (!b || ro) return; const t = readTeam(); t.splice(+b.dataset.rm, 1); $("teamRows").innerHTML = teamRows(t); };
    $("cAddT") && ($("cAddT").onclick = () => { const t = readTeam(); t.push({ nome: "", regra: "" }); $("teamRows").innerHTML = teamRows(t); });
    $("cSaveRules") && ($("cSaveRules").onclick = async () => {
      try { const d = await api("PUT", "/api/rules", { team: readTeam(), coord: $("cCoord").value, atraso: Number($("cAtraso").value), urg: $("cUrg").value, tom: $("cTom").value }); S.rules = d.rules; toast("Regras salvas"); renderConfig(); }
      catch (e) { toast(e.message); }
    });
    if (admin) {
      loadUsers();
      $("uInvite").onclick = async () => {
        try {
          const d = await api("POST", "/api/users", { nome: $("uNome").value, email: $("uEmail").value, role: $("uRole").value });
          $("inviteOut").innerHTML = `<p class="small">Envie este link para a pessoa criar a senha:</p><div class="linkbox"><code id="invLink">${esc(d.link)}</code><button type="button" class="btn ghost" id="copyInv">Copiar</button></div>`;
          $("copyInv").onclick = async () => { try { await navigator.clipboard.writeText(d.link); toast("Link copiado"); } catch { toast("Selecione o link e copie."); } };
          $("uNome").value = ""; $("uEmail").value = ""; loadUsers(); S.company.seats++;
        } catch (e) { toast(e.message); }
      };
      $("bCheckout") && ($("bCheckout").onclick = async () => { try { location.href = (await api("POST", "/api/billing/checkout")).url; } catch (e) { toast(e.message); } });
      $("bPortal") && ($("bPortal").onclick = async () => { try { location.href = (await api("POST", "/api/billing/portal")).url; } catch (e) { toast(e.message); } });
    }
  }
  // ---------- instalar o app (computador e celular) ----------
  function renderInstall() {
    const box = $("installPanel"), P = window.GencoPWA; if (!box || !P) return;
    const where = { ios: "iPhone ou iPad", android: "celular Android", windows: "computador (Windows)", mac: "Mac", outro: "dispositivo" }[P.platform];
    box.innerHTML = `<h3>Instalar a GENCO IA</h3>
      <p class="small muted">Instale como aplicativo no seu ${where}: ícone próprio, abre em janela própria e mostra no ícone quantas pendências você tem. Repita em cada computador e celular que for usar.</p>
      ${P.canPrompt ? `<div class="actions"><button type="button" class="btn brand" id="cInstall">Instalar agora</button></div>`
        : `<ol class="steps">${P.steps().map(s => `<li>${esc(s)}</li>`).join("")}</ol>`}`;
    $("cInstall") && ($("cInstall").onclick = installNow);
  }
  async function installNow() { const ok = await window.GencoPWA.install(); if (ok) toast("GENCO IA instalada. Procure o ícone na sua área de trabalho ou tela inicial."); syncInstall(); }
  function syncInstall() {
    const P = window.GencoPWA; if (!P) return;
    $("bInstall").hidden = !P.canPrompt || P.installed;
    if (view === "config") renderInstall();
  }
  if (window.GencoPWA) { window.GencoPWA.onChange(syncInstall); $("bInstall").onclick = installNow; }

  async function loadDigest() {
    const box = $("digestPanel"); if (!box) return;
    try {
      const d = await api("GET", "/api/digest");
      const hours = [6, 7, 8, 9, 10, 11, 12, 13, 14];
      box.innerHTML = `<h3>Resumo diário por e-mail</h3>
        <p class="small muted">Nos dias úteis, a GENCO IA manda para <b>${esc(d.email)}</b> o que está pendente: o que responder primeiro, o que está com você nos grupos e, para o responsável de um grupo, a situação de cada pessoa.</p>
        <div class="actions"><label class="check"><input type="checkbox" id="dgOn" ${d.on ? "checked" : ""}> Receber o resumo</label>
          <select id="dgHour" class="pillsel" aria-label="Horário">${hours.map(h => `<option value="${h}" ${h === d.hour ? "selected" : ""}>às ${h}h</option>`).join("")}</select>
          <button type="button" class="btn ghost" id="dgSave">Salvar</button></div>
        <div class="actions"><button type="button" class="btn ghost" id="dgPrev">Ver como fica o de hoje</button>
          <button type="button" class="btn ghost" id="dgSend" ${d.enabled ? "" : "disabled"}>Enviar para mim agora</button></div>
        ${d.enabled ? "" : `<p class="small muted">O envio de e-mails ainda não foi configurado neste servidor. O administrador do sistema precisa preencher o SMTP.</p>`}
        <div id="dgView"></div>`;
      $("dgSave").onclick = async () => { try { await api("PUT", "/api/digest", { on: $("dgOn").checked, hour: Number($("dgHour").value) }); toast($("dgOn").checked ? `Resumo diário às ${$("dgHour").value}h` : "Resumo diário desligado"); } catch (e) { toast(e.message); } };
      $("dgPrev").onclick = () => {
        const v = $("dgView");
        if (v.innerHTML) { v.innerHTML = ""; $("dgPrev").textContent = "Ver como fica o de hoje"; return; }
        v.innerHTML = `<p class="small"><b>Assunto:</b> ${esc(d.subject)}</p><iframe class="dgframe" title="Prévia do resumo" sandbox></iframe>`;
        v.querySelector("iframe").srcdoc = d.html; $("dgPrev").textContent = "Fechar prévia";
      };
      $("dgSend").onclick = async () => { $("dgSend").disabled = true; try { const r = await api("POST", "/api/digest/send"); toast("Resumo enviado para " + r.email); } catch (e) { toast(e.message); } $("dgSend").disabled = false; };
    } catch (e) { box.innerHTML = `<h3>Resumo diário por e-mail</h3><p class="err">${esc(e.message)}</p>`; }
  }

  async function loadUsers() {
    try {
      const d = await api("GET", "/api/users");
      $("users").innerHTML = `<table><thead><tr><th>Pessoa</th><th>Perfil</th><th></th></tr></thead><tbody>${d.users.map(u => `<tr>
        <td><b>${esc(u.name)}</b><div class="small muted">${esc(u.email)}${u.pending ? " · convite pendente" : ""}</div></td>
        <td><select data-role="${u.id}" ${u.id === S.me.id ? "disabled" : ""}>${["membro", "gestor", "admin"].map(r => `<option value="${r}" ${u.role === r ? "selected" : ""}>${{ membro: "Membro", gestor: "Gestor", admin: "Administrador" }[r]}</option>`).join("")}</select></td>
        <td style="text-align:right">${u.id === S.me.id ? '<span class="small muted">você</span>' : `<button type="button" class="btn ghost" data-del="${u.id}">Remover</button>`}</td></tr>`).join("")}</tbody></table>`;
      $("users").querySelectorAll("[data-role]").forEach(s => s.onchange = async () => { try { await api("PUT", "/api/users/" + s.dataset.role, { role: s.value }); toast("Perfil alterado"); } catch (e) { toast(e.message); } });
      $("users").querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
        if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirmar remoção"; setTimeout(() => { b.dataset.confirm = ""; b.textContent = "Remover"; }, 4000); return; }
        try { await api("DELETE", "/api/users/" + b.dataset.del); S.company.seats--; loadUsers(); toast("Pessoa removida"); } catch (e) { toast(e.message); }
      });
    } catch (e) { $("users").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  // ---------- estrutura ----------
  function renderBanner() {
    const a = S.company.access, admin = S.me.role === "admin";
    let msg = "", btn = "";
    if (!a.ok) { msg = a.status === "trial_ended" ? "Seu período de teste terminou. Assine para continuar usando a GENCO IA." : "A assinatura não está ativa."; btn = admin ? `<button type="button" class="btn brand" id="banBuy">Assinar agora</button>` : "<span class='small'>Fale com o administrador da sua empresa.</span>"; }
    else if (a.status === "past_due") { msg = a.warning; btn = admin ? `<button type="button" class="btn ghost" id="banPortal">Atualizar pagamento</button>` : ""; }
    else if (a.status === "trialing" && a.daysLeft <= 5) { msg = `Seu teste grátis termina em ${a.daysLeft} dia${a.daysLeft === 1 ? "" : "s"}.`; btn = admin ? `<button type="button" class="btn ghost" id="banBuy">Assinar</button>` : ""; }
    $("banner").hidden = !msg;
    $("bannerIn").innerHTML = msg ? `<span>${esc(msg)}</span>${btn}` : "";
    $("banBuy") && ($("banBuy").onclick = () => { show("config"); });
    $("banPortal") && ($("banPortal").onclick = async () => { try { location.href = (await api("POST", "/api/billing/portal")).url; } catch (e) { toast(e.message); } });
  }
  function show(v) {
    view = v;
    document.querySelectorAll("#nav [data-view]").forEach(b => b.setAttribute("aria-current", b.dataset.view === v ? "page" : "false"));
    $("v-conversa").style.display = v === "conversa" ? "contents" : "none";
    $("v-equipe").hidden = v !== "equipe"; $("v-config").hidden = v !== "config"; $("v-grupos").hidden = v !== "grupos";
    $("bNew").hidden = v !== "conversa"; $("boxSel").hidden = v !== "conversa" || !S.groups.length;
    if (v === "grupos") window.GencoGrupos.render();
    if (v === "equipe") renderEquipe();
    if (v === "config") renderConfig();
    if (v === "conversa") renderChat();
  }
  async function refresh() {
    try { S = await api("GET", "/api/state" + boxQ()); }
    catch (e) { if (e.status === 404 && box) { box = null; S = await api("GET", "/api/state"); } else throw e; }
    $("who").textContent = S.groupLogin ? `${S.me.name} · Grupo ${S.groupLogin.name}` : `${S.me.name} · ${S.company.name}`;
    $("bSwap").hidden = !S.groupLogin;
    // Quem usa sozinho (um único e-mail) não vê a aba Equipe.
    document.querySelector('#nav [data-view="equipe"]').hidden = !canRules() || (S.company.people < 2 && !S.groups.length);
    document.querySelector('#nav [data-view="grupos"]').hidden = false;
    $("boxSel").innerHTML = `<option value="">Minha caixa</option>` + S.groups.map(g => `<option value="${g.id}" ${g.id === box ? "selected" : ""}>Grupo ${esc(g.name)}</option>`).join("");
    renderBanner(); show(view);
  }

  $("nav").onclick = ev => { const b = ev.target.closest("[data-view]"); if (b) show(b.dataset.view); };
  $("bLogout").onclick = async () => { try { await api("POST", "/api/logout"); } catch {} location.href = "/"; };
  $("bSwap").onclick = () => { location.href = "/quem"; };
  $("boxSel").onchange = async () => { box = Number($("boxSel").value) || null; try { await refresh(); } catch (e) { toast(e.message); } };
  $("bNew").onclick = async () => { if (busy) return; try { await api("DELETE", "/api/chat" + boxQ()); S.chat = []; renderChat(); } catch (e) { toast(e.message); } };
  $("send").innerHTML = ICON_SEND;
  $("form").addEventListener("submit", ev => { ev.preventDefault(); const t = $("input").value; $("input").value = ""; grow(); send(t); });
  $("input").addEventListener("keydown", ev => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $("form").requestSubmit(); } });
  const grow = () => { const t = $("input"); t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; };
  $("input").addEventListener("input", grow);

  // ---------- "Outro provedor": qualquer e-mail com IMAP (Locaweb, UOL, Hostinger, Titan, Yahoo...) ----------
  function imapConnect(container, { grupo = null, onDone } = {}) {
    const id = "im" + Math.random().toString(36).slice(2, 7), el = s => $(id + s);
    container.innerHTML = `<form class="panel imapf" id="${id}">
      <h3>Conectar outro provedor</h3>
      <p class="small muted">Locaweb, UOL, Hostinger, Titan, Zoho, Yahoo, KingHost, iCloud ou o e-mail do domínio da sua empresa. Digite o e-mail e a senha: eu encontro o servidor sozinho.</p>
      <div class="grid2"><div class="field"><label for="${id}E">E-mail</label><input id="${id}E" type="email" autocomplete="email" required></div>
        <div class="field"><label for="${id}S">Senha do e-mail</label><input id="${id}S" type="password" autocomplete="current-password" required></div></div>
      <p class="small" id="${id}H" aria-live="polite"></p>
      <details class="adv" id="${id}A"><summary>Configurações avançadas (servidor IMAP)</summary>
        <div class="grid2"><div class="field"><label for="${id}V">Servidor IMAP</label><input id="${id}V" placeholder="ex.: imap.suaempresa.com.br"></div>
          <div class="field"><label for="${id}P">Porta</label><input id="${id}P" type="number" value="993"></div></div>
        <label class="check small"><input type="checkbox" id="${id}T" checked> Conexão segura (SSL/TLS)</label>
        <p class="small muted">Os dados ficam nas configurações de e-mail do seu provedor ou da sua hospedagem (procure por "IMAP").</p></details>
      <p class="formerr" id="${id}R" role="alert"></p>
      <div class="actions"><button type="submit" class="btn" id="${id}B">Conectar</button><button type="button" class="btn ghost" id="${id}C">Cancelar</button></div>
      <p class="small muted">A senha fica guardada criptografada e só é usada para ler os e-mails e salvar as respostas na sua pasta Rascunhos. A GENCO IA nunca envia e-mails.</p>
    </form>`;
    el("C").onclick = () => { container.innerHTML = ""; };
    el("E").onchange = async () => {
      const email = el("E").value.trim(); if (!email.includes("@")) return;
      try {
        const d = await api("POST", "/api/connect/imap/discover", { email });
        el("H").innerHTML = d.oauth === "gmail" ? `Este e-mail é do Google. O botão <b>Gmail</b> é mais seguro (sem senha). Se preferir por aqui, use uma <b>senha de app</b> do Google.`
          : d.oauth === "outlook" ? `Este e-mail é da Microsoft. Use o botão <b>Outlook</b>: a Microsoft não aceita mais conexão por senha.`
          : d.bridge ? `Este provedor só funciona com o aplicativo de ponte dele (Proton Bridge). Informe o servidor em Configurações avançadas.`
          : d.appPassword ? `Este provedor pede uma <b>senha de app</b> (gerada nas configurações de segurança da conta), não a senha normal.`
          : d.host && d.source !== "tentativa" ? `Servidor encontrado: <b>${esc(d.host)}</b>.` : "";
      } catch { el("H").textContent = ""; }
    };
    el("").onsubmit = async ev => {
      ev.preventDefault(); el("R").textContent = ""; el("B").disabled = true; el("B").textContent = "Conectando e lendo os e-mails…";
      const adv = el("V").value.trim();
      try {
        await api("POST", "/api/connect/imap", { email: el("E").value, senha: el("S").value, grupo: grupo || undefined, ...(adv ? { servidor: adv, porta: Number(el("P").value) || 993, seguro: el("T").checked } : {}) });
        toast("E-mail conectado"); container.innerHTML = ""; if (onDone) await onDone(); else await refresh();
      } catch (e) {
        el("R").textContent = e.message; el("B").disabled = false; el("B").textContent = "Conectar";
        if (/servidor|Configurações avançadas/i.test(e.message)) el("A").open = true;
      }
    };
    el("E").focus();
  }

  // Ponte para a tela Grupos (grupos.js).
  window.Genco = { api, toast, esc, ago, initials, md, get S() { return S; }, refresh, show, ask: t => send(t), imapConnect,
    openChat: async id => { box = id; await refresh(); show("conversa"); } };

  const q = new URLSearchParams(location.search);

  const notes = { ok: "E-mail conectado. Lendo a caixa…", cancelada: "Conexão cancelada.", expirada: "O pedido de conexão expirou. Tente de novo.", erro: "Não foi possível conectar o e-mail. Tente de novo." };
  refresh().then(() => {
    if (q.get("conexao")) { toast(notes[q.get("conexao")] || ""); if (q.get("conexao") === "ok") setTimeout(refresh, 5000); }
    if (q.get("assinatura") === "ok") toast("Assinatura confirmada. Obrigado!");
    if (q.toString()) history.replaceState(null, "", "/app");
  }).catch(e => { if (!S) offline(e); });

  // Sem internet (ou servidor fora do ar): mensagem clara e nova tentativa automática quando a conexão voltar.
  function offline(e) {
    const off = !navigator.onLine || e instanceof TypeError;
    $("v-conversa").style.display = "contents"; $("composer").hidden = true; $("pulse").hidden = true;
    $("log").innerHTML = `<section class="hello"><span class="cap">GENCO IA</span><h2>${off ? "Sem conexão com a internet." : "Não consegui falar com o servidor agora."}</h2>
      <p class="lead">${off ? "Assim que a conexão voltar, as pendências aparecem de novo." : esc(e.message || "")}</p>
      <div class="actions"><button type="button" class="btn" id="bRetry">Tentar de novo</button></div></section>`;
    $("bRetry").onclick = () => refresh().catch(offline);
  }
  addEventListener("online", () => { if (!S) refresh().catch(offline); });
})();
