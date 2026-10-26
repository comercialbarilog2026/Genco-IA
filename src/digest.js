// Resumo diário por e-mail: o que está pendente para cada pessoa (caixa própria e grupos), e para o
// responsável do grupo a visão da equipe. Montado sem IA (rápido e sem custo), a partir da qualificação já feita.
const config = require("./config");
const { one, all, run, now } = require("./db");
const mail = require("./mail");
const groups = require("./groups");
const agent = require("./agent");
const billing = require("./billing");
const smtp = require("./smtp");

const TZ = "America/Sao_Paulo";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const PRI_ORD = { urgente: 0, alta: 1, normal: 2, baixa: 3 };
function ago(t) { const h = (now() - t) / 36e5; return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 24 ? `${Math.round(h)} h` : `${Math.floor(h / 24)} d ${Math.round(h % 24)} h`; }
const isOpen = m => m.handling.status !== "resolvido" && !(m.replied && m.handling.status === "novo");
const byUrgency = late => (a, b) => (late(b) - late(a)) || (PRI_ORD[a.triage?.prioridade] ?? 9) - (PRI_ORD[b.triage?.prioridade] ?? 9) || a.received_at - b.received_at;
const firstName = n => String(n || "").split(" ")[0];

// Seções do resumo de uma pessoa: [{ title, items:[msg], note }]
function build(user) {
  const company = one("SELECT * FROM companies WHERE id = ?", user.company_id);
  const rules = agent.rulesOf(company);
  const sections = [];
  let total = 0, lateTotal = 0;

  // Caixa própria
  if (mail.account(user.id)) {
    const late = m => agent.isLate(m, rules);
    const box = mail.inbox(user.id, 200).filter(isOpen).filter(m => !m.replied && m.handling.status !== "aguardando");
    const now_ = box.filter(m => m.triage?.prioridade === "urgente" || late(m) || m.triage?.prioridade === "alta").sort(byUrgency(late));
    const ready = mail.inbox(user.id, 200).filter(isOpen).filter(m => m.draft && !m.replied);
    if (now_.length) sections.push({ title: "Sua caixa: responda primeiro", items: now_.slice(0, 10), more: now_.length - 10, late });
    if (ready.length) sections.push({ title: `${plural(ready.length, "resposta pronta", "respostas prontas")} no seu e-mail para revisar`, items: ready.slice(0, 5), more: ready.length - 5, late });
    total += now_.length; lateTotal += now_.filter(late).length;
  }

  // Grupos de que a pessoa participa
  const myGroups = all("SELECT group_id, coordena FROM group_members WHERE user_id = ?", user.id);
  for (const gm of myGroups) {
    const g = groups.byBox(gm.group_id); if (!g || !mail.account(g.user_id)) continue;
    const r = groups.rulesFor(g, rules), late = m => agent.isLate(m, r);
    const open = mail.inbox(g.user_id, 200).filter(isOpen);
    const mine = open.filter(m => m.handling.assignee_id === user.id && m.handling.status !== "aguardando").sort(byUrgency(late));
    const noOwner = open.filter(m => !m.handling.assignee_id && m.triage?.prioridade !== "baixa").sort(byUrgency(late));
    if (mine.length) sections.push({ title: `Grupo ${g.name}: com você`, items: mine.slice(0, 10), more: mine.length - 10, late });
    if (noOwner.length) sections.push({ title: `Grupo ${g.name}: sem ninguém cuidando`, items: noOwner.slice(0, 8), more: noOwner.length - 8, late, note: "Se for com você, assuma no app." });
    total += mine.length + (gm.coordena ? noOwner.length : 0); lateTotal += mine.filter(late).length + (gm.coordena ? noOwner.filter(late).length : 0);
    // Visão da equipe para o responsável pelo grupo
    if (gm.coordena) {
      const per = groups.members(g.user_id).filter(p => p.id !== user.id).map(p => {
        const theirs = open.filter(m => m.handling.assignee_id === p.id);
        return { name: p.name, open: theirs.length, late: theirs.filter(late).length };
      }).filter(p => p.open);
      if (per.length) sections.push({ title: `Grupo ${g.name}: equipe`, team: per });
      lateTotal += per.reduce((a, p) => a + p.late, 0);
    }
  }
  return { company, sections, total, lateTotal };
}

function render(user, d) {
  const url = config.appUrl + "/app";
  const day = new Date().toLocaleDateString("pt-BR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  const subject = d.total ? `GENCO IA · ${plural(d.total, "pendência", "pendências")} hoje${d.lateTotal ? ` (${plural(d.lateTotal, "atrasada", "atrasadas")})` : ""}` : "GENCO IA · tudo em dia hoje";
  const h = localNow().hour, hello = h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  const head = d.total ? `${hello}, ${firstName(user.name)}. ${plural(d.total, "coisa precisa", "coisas precisam")} de atenção hoje.` : `${hello}, ${firstName(user.name)}. Está tudo em dia.`;
  const line = (m, late) => `${m.triage?.prioridade === "urgente" ? "[URGENTE] " : ""}${m.from_name || m.from_addr} — ${m.subject}${late(m) ? ` (esperando há ${ago(m.received_at)})` : ""}${m.handling?.assignee && m.handling.assignee_id !== user.id ? ` · com ${m.handling.assignee}` : ""}`;
  const text = [head, day, "",
    ...d.sections.flatMap(s => [s.title.toUpperCase(),
      ...(s.items ? s.items.map(m => "• " + line(m, s.late)) : s.team.map(p => `• ${p.name}: ${plural(p.open, "em aberto", "em aberto")}${p.late ? `, ${plural(p.late, "atrasado", "atrasados")}` : ""}`)),
      ...(s.more > 0 ? [`• e mais ${s.more}`] : []), ...(s.note ? [s.note] : []), ""]),
    `Abrir a GENCO IA: ${url}`, "", "Você recebe este resumo nos dias úteis. Para mudar o horário ou desligar, vá em Configurações no app."].join("\n");

  const dot = p => ({ urgente: "#c2202e", alta: "#a0660a", normal: "#22764a", baixa: "#80828c" }[p] || "#c9cad0");
  const item = (m, late) => `<tr><td style="padding:8px 0;border-top:1px solid #ececf0;vertical-align:top;width:14px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot(m.triage?.prioridade)};margin-top:6px"></span></td>
    <td style="padding:8px 0;border-top:1px solid #ececf0"><b style="color:#131418">${esc(m.from_name || m.from_addr)}</b>${late(m) ? ` <span style="color:#d5001a;font-size:13px">esperando há ${esc(ago(m.received_at))}</span>` : ""}<br>
    <span style="color:#3b3d45">${esc(m.subject)}</span>${m.triage?.tarefa ? `<br><span style="color:#73757f;font-size:13px">${esc(m.triage.tarefa)}${m.handling?.assignee && m.handling.assignee_id !== user.id ? ` · com ${esc(m.handling.assignee)}` : ""}</span>` : ""}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f6;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#131418">
  <div style="max-width:620px;margin:0 auto;padding:28px 18px">
    <div style="font-weight:700;letter-spacing:.22em;font-size:14px"><span style="display:inline-block;width:8px;height:8px;background:#d5001a;margin-right:8px"></span>GENCO <span style="color:#73757f;font-weight:500">IA</span></div>
    <p style="color:#73757f;font-size:12px;letter-spacing:.12em;text-transform:uppercase;margin:24px 0 6px">${esc(day)}</p>
    <h1 style="font-size:24px;font-weight:500;line-height:1.3;margin:0 0 20px">${esc(head)}</h1>
    ${d.sections.map(s => `<div style="background:#fff;border:1px solid #e3e3e8;border-radius:14px;padding:14px 18px;margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:4px">${esc(s.title)}</div>
      ${s.items ? `<table style="width:100%;border-collapse:collapse;font-size:14.5px">${s.items.map(m => item(m, s.late)).join("")}</table>${s.more > 0 ? `<div style="color:#73757f;font-size:13px;padding-top:6px">e mais ${s.more}</div>` : ""}`
        : `<table style="width:100%;border-collapse:collapse;font-size:14.5px">${s.team.map(p => `<tr><td style="padding:7px 0;border-top:1px solid #ececf0">${esc(p.name)}</td><td style="padding:7px 0;border-top:1px solid #ececf0;text-align:right">${p.open} em aberto${p.late ? ` · <span style="color:#d5001a">${p.late} atrasado${p.late > 1 ? "s" : ""}</span>` : ""}</td></tr>`).join("")}</table>`}
      ${s.note ? `<div style="color:#73757f;font-size:13px;padding-top:6px">${esc(s.note)}</div>` : ""}</div>`).join("")}
    <p style="margin:22px 0"><a href="${esc(url)}" style="background:#d5001a;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:600;display:inline-block">Abrir a GENCO IA</a></p>
    <p style="color:#73757f;font-size:12px">Você recebe este resumo nos dias úteis. Para mudar o horário ou desligar, vá em Configurações no app. A GENCO IA nunca envia e-mails aos seus clientes.</p>
  </div></body></html>`;
  return { subject, text, html };
}

function preview(user) { const d = build(user); return { ...render(user, d), total: d.total, sections: d.sections.length }; }

async function sendTo(user, { force = false } = {}) {
  const d = build(user);
  if (!d.sections.length && !force) return { sent: false, reason: "nada pendente" };
  await smtp.sendMail({ to: user.email, ...render(user, d) });
  return { sent: true, total: d.total };
}

// Chamado periodicamente: envia uma vez por dia útil, na hora escolhida por cada pessoa (horário de Brasília).
function localNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: parts.weekday };
}
async function runDue() {
  if (!smtp.enabled()) return 0;
  const t = localNow();
  if (t.weekday === "Sat" || t.weekday === "Sun") return 0;
  const due = all(`SELECT * FROM users WHERE kind = 'pessoa' AND digest_on = 1 AND COALESCE(last_digest_day, '') != ? AND COALESCE(digest_hour, ?) <= ?`, t.day, config.digestHour, t.hour);
  let n = 0;
  for (const u of due) {
    const c = one("SELECT * FROM companies WHERE id = ?", u.company_id);
    run("UPDATE users SET last_digest_day = ? WHERE id = ?", t.day, u.id); // marca antes: nunca manda duas vezes
    if (!billing.access(c).ok) continue;
    try { if ((await sendTo(u)).sent) n++; } catch (e) { console.error("[resumo]", u.email, e.message); }
  }
  return n;
}

module.exports = { build, render, preview, sendTo, runDue, localNow };
