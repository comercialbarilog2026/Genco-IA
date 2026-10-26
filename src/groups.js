// Grupos de e-mail: caixa compartilhada (ex.: operacional@empresa.com.br) atendida por várias pessoas.
// Cada e-mail do grupo tem um dono e uma situação; a equipe registra notas internas e o gestor
// acompanha a carga de cada um. A IA qualifica, sugere o dono e pode atribuir automaticamente.
const { one, all, run, now, json } = require("./db");
const sec = require("./security");

const STATUS = { novo: "Novo", andamento: "Em andamento", aguardando: "Aguardando terceiros", resolvido: "Resolvido" };
const OPEN = ["novo", "andamento", "aguardando"];

const get = (companyId, groupId) => one(`SELECT g.*, u.name FROM groups g JOIN users u ON u.id = g.user_id WHERE g.user_id = ? AND g.company_id = ?`, Number(groupId), companyId);
const byBox = boxId => one(`SELECT g.*, u.name FROM groups g JOIN users u ON u.id = g.user_id WHERE g.user_id = ?`, Number(boxId));
const isMember = (groupId, userId) => !!one("SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?", groupId, userId);
const canSee = (user, g) => !!g && (user.role === "admin" || user.role === "gestor" || isMember(g.user_id, user.id));
const canManage = user => user.role === "admin" || user.role === "gestor";

function members(groupId) {
  return all(`SELECT u.id, u.name, u.email, gm.regra, gm.coordena FROM group_members gm JOIN users u ON u.id = gm.user_id
              WHERE gm.group_id = ? ORDER BY gm.coordena DESC, u.name`, groupId).map(m => ({ ...m, coordena: !!m.coordena }));
}

function list(user) {
  const rows = canManage(user)
    ? all("SELECT g.*, u.name FROM groups g JOIN users u ON u.id = g.user_id WHERE g.company_id = ? ORDER BY u.name", user.company_id)
    : all("SELECT g.*, u.name FROM groups g JOIN users u ON u.id = g.user_id JOIN group_members gm ON gm.group_id = g.user_id WHERE gm.user_id = ? ORDER BY u.name", user.id);
  return rows.map(publicGroup);
}
const publicGroup = g => ({ id: g.user_id, name: g.name, address: g.address || "", filtro: g.filtro || "", autoAtribuir: !!g.auto_atribuir });

function create(company, { nome, endereco, filtro }) {
  const u = run("INSERT INTO users (company_id, name, email, password_hash, role, kind, created_at) VALUES (?, ?, ?, NULL, 'membro', 'grupo', ?)",
    company.id, nome, `grupo-${sec.randomToken(9)}@caixa.genco-ia`, now());
  const id = Number(u.lastInsertRowid);
  run("INSERT INTO groups (user_id, company_id, address, filtro, auto_atribuir, created_at) VALUES (?, ?, ?, ?, 1, ?)", id, company.id, endereco || null, filtro || null, now());
  return get(company.id, id);
}

function update(g, { nome, endereco, filtro, autoAtribuir }) {
  if (nome != null) run("UPDATE users SET name = ? WHERE id = ?", nome, g.user_id);
  run("UPDATE groups SET address = ?, filtro = ?, auto_atribuir = ? WHERE user_id = ?",
    endereco ?? g.address, filtro ?? g.filtro, autoAtribuir == null ? g.auto_atribuir : (autoAtribuir ? 1 : 0), g.user_id);
}

function remove(g) {
  ["handling", "events"].forEach(t => run(`DELETE FROM ${t} WHERE box_id = ?`, g.user_id));
  ["messages", "triage", "drafts", "chats"].forEach(t => run(`DELETE FROM ${t} WHERE user_id = ?`, g.user_id));
  run("DELETE FROM chats WHERE box_id = ?", g.user_id);
  run("DELETE FROM users WHERE id = ? AND kind = 'grupo'", g.user_id); // cascata: groups, group_members, mail_accounts
}

function setMembers(g, list) {
  const valid = new Set(all("SELECT id FROM users WHERE company_id = ? AND kind = 'pessoa'", g.company_id).map(r => r.id));
  run("DELETE FROM group_members WHERE group_id = ?", g.user_id);
  for (const m of list) {
    const id = Number(m.user_id);
    if (!valid.has(id)) continue;
    run("INSERT OR IGNORE INTO group_members (group_id, user_id, regra, coordena) VALUES (?, ?, ?, ?)", g.user_id, id, String(m.regra || "").slice(0, 400), m.coordena ? 1 : 0);
  }
}

// Regras usadas pela IA no grupo: critérios e tom da empresa, equipe = membros do grupo.
function rulesFor(g, companyRules) {
  const ms = members(g.user_id);
  const coord = ms.find(m => m.coordena);
  return {
    ...companyRules,
    team: ms.length ? ms.map(m => ({ id: "u" + m.id, nome: m.name, regra: m.regra || "Atende e-mails do grupo." })) : companyRules.team,
    coord: coord ? coord.name : companyRules.coord
  };
}

// ---------- atendimento ----------
function handlingOf(boxId, messageId) {
  return one("SELECT * FROM handling WHERE box_id = ? AND message_id = ?", boxId, messageId) || { assignee_id: null, status: "novo" };
}
function log(boxId, messageId, userId, kind, text) {
  run("INSERT INTO events (box_id, message_id, user_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?, ?)", boxId, messageId, userId, kind, text, now());
}
const nameOf = id => id ? (one("SELECT name FROM users WHERE id = ?", id)?.name || "pessoa removida") : null;

// Muda dono e/ou situação. byUserId = null quando é a GENCO IA.
function setHandling(g, messageIds, { assigneeId, status }, byUserId) {
  const changed = [];
  const okAssignee = assigneeId === undefined || assigneeId === null || isMember(g.user_id, Number(assigneeId)) || !!one("SELECT 1 FROM users WHERE id = ? AND company_id = ? AND kind = 'pessoa'", Number(assigneeId), g.company_id);
  if (!okAssignee) throw new Error("Essa pessoa não faz parte da empresa.");
  if (status !== undefined && !STATUS[status]) throw new Error("Situação inválida.");
  for (const mid of messageIds) {
    if (!one("SELECT 1 FROM messages WHERE user_id = ? AND id = ?", g.user_id, mid)) continue;
    const cur = handlingOf(g.user_id, mid);
    let next = { assignee_id: cur.assignee_id, status: cur.status };
    if (assigneeId !== undefined && (assigneeId || null) !== (cur.assignee_id || null)) {
      next.assignee_id = assigneeId ? Number(assigneeId) : null;
      const who = nameOf(next.assignee_id);
      log(g.user_id, mid, byUserId, "dono", !who ? "deixou o e-mail sem dono" : byUserId && byUserId === next.assignee_id ? "assumiu o atendimento" : `passou o atendimento para ${who}`);
      if (next.assignee_id && next.status === "novo" && status === undefined) next.status = "andamento";
    }
    if (status !== undefined && status !== cur.status) {
      next.status = status;
      log(g.user_id, mid, byUserId, "situacao", `mudou a situação para "${STATUS[status]}"`);
    }
    if (next.assignee_id === (cur.assignee_id || null) && next.status === cur.status) continue;
    run(`INSERT INTO handling (box_id, message_id, assignee_id, status, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(box_id, message_id) DO UPDATE SET assignee_id = excluded.assignee_id, status = excluded.status, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      g.user_id, mid, next.assignee_id, next.status, byUserId, now());
    changed.push(mid);
  }
  return changed;
}

function addNote(g, messageId, userId, text) {
  if (!one("SELECT 1 FROM messages WHERE user_id = ? AND id = ?", g.user_id, messageId)) throw new Error("E-mail não encontrado.");
  log(g.user_id, messageId, userId, "nota", String(text).trim().slice(0, 2000));
}

function history(g, messageId) {
  return all(`SELECT e.kind, e.text, e.created_at, e.user_id, u.name FROM events e LEFT JOIN users u ON u.id = e.user_id
              WHERE e.box_id = ? AND e.message_id = ? ORDER BY e.id`, g.user_id, messageId)
    .map(e => ({ kind: e.kind, text: e.text, at: e.created_at, who: e.user_id ? (e.name || "pessoa removida") : "GENCO IA" }));
}

// Depois da qualificação: e-mails sem dono recebem o responsável sugerido pela IA, se ele for membro.
function autoAssign(g) {
  if (!g.auto_atribuir) return [];
  const byName = new Map(members(g.user_id).map(m => [m.name.trim().toLowerCase(), m.id]));
  const rows = all(`SELECT t.message_id, t.responsavel FROM triage t
                    LEFT JOIN handling h ON h.box_id = t.user_id AND h.message_id = t.message_id
                    JOIN messages m ON m.user_id = t.user_id AND m.id = t.message_id
                    WHERE t.user_id = ? AND h.assignee_id IS NULL AND COALESCE(h.status, 'novo') = 'novo' AND m.replied = 0 AND t.prioridade != 'baixa'`, g.user_id);
  const done = [];
  for (const r of rows) {
    const id = byName.get(String(r.responsavel || "").trim().toLowerCase());
    if (!id) continue;
    run(`INSERT INTO handling (box_id, message_id, assignee_id, status, updated_by, updated_at) VALUES (?, ?, ?, 'novo', NULL, ?)
         ON CONFLICT(box_id, message_id) DO UPDATE SET assignee_id = excluded.assignee_id, updated_at = excluded.updated_at`, g.user_id, r.message_id, id, now());
    log(g.user_id, r.message_id, null, "dono", `atribuiu a ${nameOf(id)} pela regra do grupo`);
    done.push(r.message_id);
  }
  return done;
}

// Situação efetiva: e-mail já respondido e ainda "novo" conta como resolvido pela resposta.
const effective = m => m.handling.status === "novo" && m.replied ? "respondido" : m.handling.status;
const isOpen = m => OPEN.includes(m.handling.status) && !(m.replied && m.handling.status === "novo");

// Indicadores do grupo e carga por pessoa.
function overview(g, inbox, isLate) {
  const open = inbox.filter(isOpen);
  const ms = members(g.user_id);
  const weekAgo = now() - 7 * 864e5;
  const resolvedBy = all(`SELECT h.assignee_id AS id, COUNT(*) AS n FROM handling h WHERE h.box_id = ? AND h.status = 'resolvido' AND h.updated_at >= ? GROUP BY h.assignee_id`, g.user_id, weekAgo);
  const rmap = new Map(resolvedBy.map(r => [r.id, r.n]));
  return {
    total: inbox.length,
    abertos: open.length,
    semDono: open.filter(m => !m.handling.assignee_id && m.triage?.prioridade !== "baixa").length, // informativos não precisam de dono
    atrasados: open.filter(isLate).length,
    urgentes: open.filter(m => m.triage?.prioridade === "urgente").length,
    resolvidos7d: resolvedBy.reduce((a, r) => a + r.n, 0),
    pessoas: ms.map(m => {
      const mine = open.filter(x => x.handling.assignee_id === m.id);
      return { id: m.id, name: m.name, abertos: mine.length, atrasados: mine.filter(isLate).length, urgentes: mine.filter(x => x.triage?.prioridade === "urgente").length, resolvidos7d: rmap.get(m.id) || 0 };
    })
  };
}

module.exports = { STATUS, OPEN, get, byBox, list, publicGroup, create, update, remove, members, setMembers, rulesFor, canSee, canManage, isMember,
  handlingOf, setHandling, addNote, history, autoAssign, overview, effective, isOpen };
