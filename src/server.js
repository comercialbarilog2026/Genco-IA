// GENCO IA — servidor principal.
const http = require("node:http");
const path = require("node:path");
const config = require("./config");
const { one, all, run, now, json } = require("./db");
const sec = require("./security");
const { createRouter, send, redirect, serveStatic, HttpError, SECURITY_HEADERS } = require("./http");
const billing = require("./billing");
const mail = require("./mail");
const ai = require("./ai");
const agent = require("./agent");
const groups = require("./groups");
const smtp = require("./smtp");
const digest = require("./digest");
const { SECTORS, defaultRules } = require("./templates");

const router = createRouter();
const PUBLIC = path.join(__dirname, "..", "public");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- utilidades ----------
function auth(ctx) {
  const u = sec.sessionUser(ctx.cookies.genco_sess);
  if (!u) throw new HttpError(401, "Faça login para continuar.");
  const company = one("SELECT * FROM companies WHERE id = ?", u.company_id);
  return { user: u, company };
}
const requireRole = (user, ...roles) => { if (!roles.includes(user.role)) throw new HttpError(403, "Seu perfil não tem permissão para isso."); };
function requireAccess(company) {
  const a = billing.access(company);
  if (!a.ok) throw new HttpError(402, a.status === "trial_ended" ? "O período de teste terminou. Assine para continuar usando a GENCO IA." : "A assinatura não está ativa. Regularize para continuar.", { access: a });
  return a;
}
const attempts = new Map();
function throttle(key, max = 8, windowMs = 15 * 60e3) {
  const t = now(), a = (attempts.get(key) || []).filter(x => t - x < windowMs);
  if (a.length >= max) throw new HttpError(429, "Muitas tentativas. Aguarde alguns minutos.");
  a.push(t); attempts.set(key, a);
}
const ip = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const pdfReader = (user, company) => ({ extractPdf: b => ai.extractPdf(b, { companyId: company.id, userId: user.kind === "grupo" ? null : user.id }) });
// Caixa da requisição: ?grupo=ID (ou "grupo" no corpo) usa a caixa do grupo; senão, a pessoal.
function boxOf(ctx, user) {
  const gid = ctx.query.grupo || ctx.body?.grupo;
  try { return agent.boxFor(user, gid ? Number(gid) : null); } catch { throw new HttpError(404, "Grupo não encontrado ou você não faz parte dele."); }
}
function groupOf(ctx, user, { manage = false } = {}) {
  const g = groups.get(user.company_id, Number(ctx.params.id));
  if (!groups.canSee(user, g)) throw new HttpError(404, "Grupo não encontrado ou você não faz parte dele.");
  if (manage && !groups.canManage(user)) throw new HttpError(403, "Só administradores e gestores podem configurar grupos.");
  return g;
}
const boxUser = g => one("SELECT * FROM users WHERE id = ?", g.user_id);

// ---------- cadastro e login ----------
router.post("/api/signup", async ({ req, res, body }) => {
  throttle("signup:" + ip(req), 5);
  const empresa = String(body.empresa || "").trim(), nome = String(body.nome || "").trim(), email = String(body.email || "").trim().toLowerCase(), senha = String(body.senha || "");
  const setor = SECTORS[body.setor] ? body.setor : "geral";
  const modo = body.modo === "individual" ? "individual" : "equipe";
  if (!empresa || !nome) throw new HttpError(400, "Informe o nome da empresa e o seu nome.");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "E-mail inválido.");
  if (senha.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
  if (one("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "Já existe uma conta com este e-mail. Entre com sua senha.");
  const c = run("INSERT INTO companies (name, sector, modo, status, trial_ends_at, rules_json, created_at) VALUES (?, ?, ?, 'trialing', ?, ?, ?)",
    empresa, setor, modo, now() + config.trialDays * 864e5, JSON.stringify(defaultRules(setor, empresa)), now());
  const u = run("INSERT INTO users (company_id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)", c.lastInsertRowid, nome, email, sec.hashPassword(senha), now());
  send(res, 201, { ok: true }, { "Set-Cookie": sec.sessionCookie(sec.createSession(Number(u.lastInsertRowid))) });
});

router.post("/api/login", async ({ req, res, body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  throttle("login:" + ip(req) + ":" + email);
  const u = one("SELECT * FROM users WHERE email = ? AND kind = 'pessoa'", email);
  // Entrada pelo e-mail do grupo (ex.: operacional@): depois a pessoa escolhe quem ela é.
  const grp = !u && groups.byAddress(email);
  if (grp) {
    if (!sec.verifyPassword(String(body.senha || ""), grp.password_hash)) throw new HttpError(401, "E-mail ou senha incorretos.");
    return send(res, 200, { ok: true, grupo: true }, { "Set-Cookie": sec.groupCookie(sec.createGroupSession(grp.user_id)) });
  }
  if (!u || !sec.verifyPassword(String(body.senha || ""), u.password_hash)) throw new HttpError(401, "E-mail ou senha incorretos.");
  send(res, 200, { ok: true }, { "Set-Cookie": sec.sessionCookie(sec.createSession(u.id)) });
});

router.post("/api/logout", async ({ res, cookies }) => {
  sec.destroySession(cookies.genco_sess);
  sec.destroyGroupSession(cookies.genco_grp);
  res.setHeader("Set-Cookie", [sec.sessionCookie("", 0), sec.groupCookie("", 0)]);
  send(res, 200, { ok: true });
});

// ---------- entrada pelo e-mail do grupo: "quem está usando?" ----------
function groupFromCookie(ctx) {
  const gid = sec.groupSession(ctx.cookies.genco_grp);
  const g = gid && groups.byBox(gid);
  if (!g || !g.password_hash) throw new HttpError(401, "Entre com o e-mail do grupo para continuar.");
  return g;
}
// Membros (perfil "membro") entram só escolhendo o nome; administradores e gestores confirmam com a própria senha.
const needsPassword = m => m.role !== "membro";
router.get("/api/group-login", async (ctx) => {
  const g = groupFromCookie(ctx);
  const company = one("SELECT name FROM companies WHERE id = ?", g.company_id);
  send(ctx.res, 200, { group: { name: g.name, address: g.address }, company: company.name,
    members: groups.members(g.user_id).map(m => ({ id: m.id, name: m.name, regra: m.regra, needsPassword: needsPassword(m), canUsePassword: m.has_password })) });
});
router.post("/api/group-login/choose", async (ctx) => {
  const g = groupFromCookie(ctx);
  throttle("choose:" + ip(ctx.req), 20);
  const m = groups.members(g.user_id).find(x => x.id === Number(ctx.body.user_id));
  if (!m) throw new HttpError(404, "Pessoa não encontrada no grupo.");
  if (needsPassword(m)) {
    const u = one("SELECT password_hash FROM users WHERE id = ?", m.id);
    if (!u.password_hash) throw new HttpError(403, "Administradores e gestores entram com a própria senha. Use o convite para criar a sua.");
    if (!sec.verifyPassword(String(ctx.body.senha || ""), u.password_hash)) throw new HttpError(401, "Senha incorreta.");
  }
  sec.destroySession(ctx.cookies.genco_sess);
  send(ctx.res, 200, { ok: true, grupo: g.user_id }, { "Set-Cookie": sec.sessionCookie(sec.createSession(m.id)) });
});

router.get("/api/invite/:token", async ({ res, params }) => {
  const u = one("SELECT u.name, u.email, c.name AS empresa FROM users u JOIN companies c ON c.id = u.company_id WHERE u.invite_token = ?", params.token);
  if (!u) throw new HttpError(404, "Convite inválido ou já usado.");
  send(res, 200, u);
});
router.post("/api/invite/accept", async ({ req, res, body }) => {
  throttle("invite:" + ip(req));
  const u = one("SELECT * FROM users WHERE invite_token = ?", String(body.token || ""));
  if (!u) throw new HttpError(404, "Convite inválido ou já usado.");
  if (String(body.senha || "").length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
  run("UPDATE users SET password_hash = ?, invite_token = NULL WHERE id = ?", sec.hashPassword(String(body.senha)), u.id);
  send(res, 200, { ok: true }, { "Set-Cookie": sec.sessionCookie(sec.createSession(u.id)) });
});

// ---------- recuperação de senha ----------
router.post("/api/password/forgot", async ({ req, res, body }) => {
  throttle("forgot:" + ip(req), 5);
  const email = String(body.email || "").trim().toLowerCase();
  const u = one("SELECT * FROM users WHERE email = ? AND kind = 'pessoa'", email);
  // Resposta igual exista ou não a conta (não revela quem tem cadastro).
  const okMsg = { ok: true, message: "Se houver uma conta com este e-mail, enviamos um link para criar uma nova senha. Ele vale por 1 hora." };
  if (!smtp.enabled()) throw new HttpError(503, "A recuperação por e-mail ainda não foi configurada neste servidor. Peça ao administrador da sua empresa um novo convite.");
  if (u) {
    const token = sec.randomToken(24);
    run("UPDATE users SET reset_token_hash = ?, reset_expires = ? WHERE id = ?", sec.sha(token), now() + 3600e3, u.id);
    const link = `${config.appUrl}/redefinir?token=${token}`;
    smtp.sendMail({ to: u.email, subject: "GENCO IA · criar nova senha",
      text: `Olá, ${u.name.split(" ")[0]}.\n\nPara criar uma nova senha na GENCO IA, abra o link abaixo (vale por 1 hora):\n${link}\n\nSe você não pediu, ignore este e-mail.`,
      html: `<p>Olá, ${u.name.split(" ")[0].replace(/[<>&]/g, "")}.</p><p>Para criar uma nova senha na GENCO IA, use o botão abaixo. Ele vale por 1 hora.</p><p><a href="${link}" style="background:#d5001a;color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">Criar nova senha</a></p><p style="color:#73757f;font-size:13px">Se você não pediu, ignore este e-mail.</p>` })
      .catch(e => console.error("[senha]", e.message));
  }
  send(res, 200, okMsg);
});
router.post("/api/password/reset", async ({ req, res, body }) => {
  throttle("reset:" + ip(req), 10);
  const u = one("SELECT * FROM users WHERE reset_token_hash = ? AND kind = 'pessoa'", sec.sha(String(body.token || "")));
  if (!u || !u.reset_expires || u.reset_expires < now()) throw new HttpError(400, "Link inválido ou expirado. Peça um novo.");
  if (String(body.senha || "").length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
  run("UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_expires = NULL, invite_token = NULL WHERE id = ?", sec.hashPassword(String(body.senha)), u.id);
  run("DELETE FROM sessions WHERE user_id = ?", u.id); // derruba sessões antigas
  send(res, 200, { ok: true }, { "Set-Cookie": sec.sessionCookie(sec.createSession(u.id)) });
});

// ---------- resumo diário por e-mail ----------
router.get("/api/digest", async (ctx) => {
  const { user } = auth(ctx);
  const p = digest.preview(user);
  send(ctx.res, 200, { on: !!user.digest_on, hour: user.digest_hour ?? config.digestHour, email: user.email, enabled: smtp.enabled(), subject: p.subject, html: p.html, total: p.total });
});
router.put("/api/digest", async (ctx) => {
  const { user } = auth(ctx);
  const hour = Math.min(20, Math.max(5, Number(ctx.body.hour) || config.digestHour));
  run("UPDATE users SET digest_on = ?, digest_hour = ? WHERE id = ?", ctx.body.on ? 1 : 0, hour, user.id);
  send(ctx.res, 200, { on: !!ctx.body.on, hour });
});
router.post("/api/digest/send", async (ctx) => {
  const { user } = auth(ctx);
  throttle("digest:" + user.id, 5, 60 * 60e3);
  if (!smtp.enabled()) throw new HttpError(503, "O envio de e-mails ainda não foi configurado neste servidor (SMTP).");
  try { await digest.sendTo(user, { force: true }); } catch (e) { throw new HttpError(502, "Não consegui enviar: " + e.message); }
  send(ctx.res, 200, { ok: true, email: user.email });
});

// ---------- estado do app ----------
router.get("/api/state", async (ctx) => {
  const { user, company } = auth(ctx);
  const box = boxOf(ctx, user);
  const acc = mail.account(box.id);
  const rules = agent.boxRules(company, box);
  const boxKey = box.group ? box.id : null;
  const gl = (gid => { const g = gid && groups.byBox(gid); return g && g.company_id === company.id && groups.isMember(g.user_id, user.id) ? { id: g.user_id, name: g.name } : null; })(sec.groupSession(ctx.cookies.genco_grp));
  send(ctx.res, 200, {
    groupLogin: gl,
    me: publicUser(user),
    company: { name: company.name, sector: company.sector, modo: company.modo, people: one("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND kind = 'pessoa'", company.id).n, sectorName: (SECTORS[company.sector] || SECTORS.geral).nome, access: billing.access(company), seats: billing.seats(company.id), hasSubscription: !!company.stripe_subscription_id },
    features: { ...config.features, ai: ai.name() },
    account: acc ? { provider: acc.provider, address: acc.address, demoSector: acc.demo_sector, lastSync: acc.last_sync_at, error: acc.last_error } : null,
    myAccount: (a => a ? { provider: a.provider, address: a.address, demoSector: a.demo_sector, lastSync: a.last_sync_at, error: a.last_error } : null)(mail.account(user.id)),
    inbox: mail.inbox(box.id),
    groups: groups.list(user),
    box: box.group ? { ...groups.publicGroup(box.group), members: groups.members(box.id).map(m => ({ id: m.id, name: m.name })) } : null,
    chat: all("SELECT role, text, cards_json, error, created_at FROM chats WHERE user_id = ? AND box_id IS ? ORDER BY id DESC LIMIT 60", user.id, boxKey).reverse().map(r => ({ role: r.role, text: r.text, cards: json(r.cards_json, []), error: r.error })),
    rules, sectors: Object.fromEntries(Object.entries(SECTORS).map(([k, s]) => [k, s.nome])),
    usage: { month: ai.monthlyCount(user.id), limit: config.ai.monthlyLimitPerUser }
  });
});

// ---------- conversa ----------
router.post("/api/chat", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const text = String(ctx.body.texto || "").trim().slice(0, 4000);
  if (!text) throw new HttpError(400, "Escreva uma mensagem.");
  const box = boxOf(ctx, user);
  if (!mail.account(box.id)) throw new HttpError(400, box.group ? "O e-mail deste grupo ainda não foi conectado." : "Conecte um e-mail antes de conversar com a GENCO IA.");
  if (ai.monthlyCount(user.id) >= config.ai.monthlyLimitPerUser) throw new HttpError(429, "Você atingiu o limite de mensagens do mês no seu plano.");
  if (!mail.inbox(box.id, 1).length) await mail.sync(box.id, { ai: pdfReader(box.group ? boxUser(box.group) : user, company) });
  const r = await agent.chat(user, company, text, box);
  send(ctx.res, 200, { reply: r, inbox: mail.inbox(box.id), rules: agent.boxRules(one("SELECT * FROM companies WHERE id = ?", company.id), box) });
});
router.delete("/api/chat", async (ctx) => {
  const { user } = auth(ctx); const box = boxOf(ctx, user);
  run("DELETE FROM chats WHERE user_id = ? AND box_id IS ?", user.id, box.group ? box.id : null);
  send(ctx.res, 200, { ok: true });
});

router.post("/api/sync", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const box = boxOf(ctx, user);
  const owner = box.group ? boxUser(box.group) : user;
  const r = await mail.sync(box.id, { ai: pdfReader(owner, company) });
  if (r.error) throw new HttpError(502, "Não foi possível ler o e-mail: " + r.error);
  if (r.added.length && config.autoTriage) await agent.autoTriage(owner, company).catch(e => console.error("[triagem]", e.message));
  send(ctx.res, 200, { added: r.added.length, newPeople: r.newPeople || [], inbox: mail.inbox(box.id) });
});

router.put("/api/drafts/:id", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const box = boxOf(ctx, user);
  const r = await mail.saveDraft(box.id, ctx.params.id, { assunto: String(ctx.body.assunto || ""), corpo: String(ctx.body.corpo || "") });
  send(ctx.res, 200, r);
});

// ---------- conexão de e-mail ----------
router.get("/api/connect/:provider", async (ctx) => {
  const { user } = auth(ctx);
  let target = user;
  if (ctx.query.grupo) {
    const box = boxOf(ctx, user);
    if (!groups.canManage(user)) throw new HttpError(403, "Só administradores e gestores conectam o e-mail do grupo.");
    target = boxUser(box.group);
  }
  const p = ctx.params.provider;
  if (!mail.PROVIDERS[p]) throw new HttpError(404, "Provedor desconhecido.");
  if (!config.features[p]) throw new HttpError(503, p === "gmail" ? "Conexão com Gmail ainda não configurada (GOOGLE_CLIENT_ID)." : "Conexão com Outlook ainda não configurada (MICROSOFT_CLIENT_ID).");
  const state = sec.randomToken(24);
  run("DELETE FROM oauth_states WHERE created_at < ?", now() - 15 * 60e3);
  run("INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES (?, ?, ?, ?)", state, target.id, p, now());
  redirect(ctx.res, mail.PROVIDERS[p].authUrl(state, { group: target.id !== user.id }));
});
router.get("/oauth/:provider/callback", async (ctx) => {
  const p = ctx.params.provider, q = ctx.query;
  const st = one("SELECT * FROM oauth_states WHERE state = ? AND provider = ?", String(q.state || ""), p);
  if (!st || now() - st.created_at > 15 * 60e3) return redirect(ctx.res, "/app?conexao=expirada");
  run("DELETE FROM oauth_states WHERE state = ?", st.state);
  const owner = one("SELECT * FROM users WHERE id = ?", st.user_id);
  const back = owner?.kind === "grupo" ? `&grupo=${owner.id}` : "";
  if (q.error || !q.code) return redirect(ctx.res, "/app?conexao=cancelada" + back);
  try {
    const t = await mail.PROVIDERS[p].exchange(String(q.code));
    mail.saveAccount(st.user_id, p, t);
    const user = one("SELECT * FROM users WHERE id = ?", st.user_id), company = one("SELECT * FROM companies WHERE id = ?", user.company_id);
    mail.sync(user.id, { ai: pdfReader(user, company) }).then(r => r.added.length && config.autoTriage && billing.access(company).ok && agent.autoTriage(user, company)).catch(e => console.error("[sync]", e.message));
    redirect(ctx.res, "/app?conexao=ok" + back);
  } catch (e) {
    console.error("[oauth]", e.message);
    redirect(ctx.res, "/app?conexao=erro" + back);
  }
});
// ---------- qualquer outro provedor (IMAP: e-mail + senha) ----------
router.post("/api/connect/imap/discover", async (ctx) => {
  auth(ctx);
  try {
    const d = await mail.discover(String(ctx.body.email || ""));
    send(ctx.res, 200, { oauth: d.oauth, appPassword: d.appPassword, bridge: d.bridge, host: d.candidates[0]?.host || null, source: d.source });
  } catch (e) { throw new HttpError(400, e.message); }
});
router.post("/api/connect/imap", async (ctx) => {
  const { user, company } = auth(ctx);
  throttle("imap:" + user.id, 10);
  let owner = user;
  if (ctx.body.grupo) {
    const box = boxOf(ctx, user);
    if (!groups.canManage(user)) throw new HttpError(403, "Só administradores e gestores conectam o e-mail do grupo.");
    owner = boxUser(box.group);
  }
  const b = ctx.body;
  try { await mail.connectImap(owner.id, { email: b.email, senha: b.senha, host: b.servidor || null, port: b.porta, secure: b.seguro !== false }); }
  catch (e) { throw new HttpError(e.status || 400, e.message, e.needsAdvanced ? { needsAdvanced: true } : undefined); }
  const r = await mail.sync(owner.id, { ai: pdfReader(owner, company) });
  if (r.error) throw new HttpError(502, "Conectei, mas não consegui ler os e-mails: " + r.error);
  if (config.autoTriage && billing.access(company).ok) await agent.autoTriage(owner, company).catch(e => console.error("[triagem]", e.message));
  send(ctx.res, 200, { ok: true, added: r.added.length });
});

router.post("/api/connect/demo", async (ctx) => {
  const { user, company } = auth(ctx);
  const setor = SECTORS[ctx.body.setor] ? ctx.body.setor : company.sector;
  mail.saveAccount(user.id, "demo", { address: "caixa de demonstração" }, { demoSector: setor });
  await mail.sync(user.id);
  if (config.autoTriage && billing.access(company).ok) await agent.autoTriage(user, company).catch(e => console.error("[triagem]", e.message));
  send(ctx.res, 200, { ok: true, inbox: mail.inbox(user.id) });
});
router.delete("/api/connect", async (ctx) => { const { user } = auth(ctx); mail.disconnect(user.id); send(ctx.res, 200, { ok: true }); });

// ---------- regras e equipe ----------
router.put("/api/rules", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin", "gestor");
  const b = ctx.body, cur = agent.rulesOf(company);
  const team = Array.isArray(b.team) ? b.team.filter(m => m && String(m.nome || "").trim()).map((m, i) => ({ id: "t" + i, nome: String(m.nome).trim().slice(0, 60), regra: String(m.regra || "").trim().slice(0, 400) })) : cur.team;
  if (!team.length) throw new HttpError(400, "A equipe precisa ter pelo menos uma pessoa ou área.");
  const rules = { team, coord: String(b.coord ?? cur.coord).slice(0, 80), atraso: Math.min(168, Math.max(1, Number(b.atraso ?? cur.atraso) || 4)), urg: String(b.urg ?? cur.urg).slice(0, 3000), tom: String(b.tom ?? cur.tom).slice(0, 2000) };
  agent.saveRules(company.id, rules);
  send(ctx.res, 200, { rules });
});

router.get("/api/users", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin");
  send(ctx.res, 200, { users: all("SELECT id, name, email, role, invite_token IS NOT NULL AS pending FROM users WHERE company_id = ? AND kind = 'pessoa' ORDER BY id", company.id) });
});
router.post("/api/users", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin");
  const nome = String(ctx.body.nome || "").trim(), email = String(ctx.body.email || "").trim().toLowerCase();
  const role = ["admin", "gestor", "membro"].includes(ctx.body.role) ? ctx.body.role : "membro";
  if (!nome || !EMAIL_RE.test(email)) throw new HttpError(400, "Informe nome e e-mail válidos.");
  if (one("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "Este e-mail já tem conta na GENCO IA.");
  const token = sec.randomToken(24);
  run("INSERT INTO users (company_id, name, email, role, invite_token, created_at) VALUES (?, ?, ?, ?, ?, ?)", company.id, nome, email, role, token, now());
  billing.syncSeats(company.id);
  send(ctx.res, 201, { link: `${config.appUrl}/convite?token=${token}` });
});
router.put("/api/users/:id", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin");
  const role = ["admin", "gestor", "membro"].includes(ctx.body.role) ? ctx.body.role : null;
  if (!role) throw new HttpError(400, "Perfil inválido.");
  if (Number(ctx.params.id) === user.id && role !== "admin") throw new HttpError(400, "Você não pode tirar o seu próprio perfil de administrador.");
  run("UPDATE users SET role = ? WHERE id = ? AND company_id = ? AND kind = 'pessoa'", role, Number(ctx.params.id), company.id);
  send(ctx.res, 200, { ok: true });
});
router.delete("/api/users/:id", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin");
  if (Number(ctx.params.id) === user.id) throw new HttpError(400, "Você não pode remover a própria conta.");
  run("DELETE FROM users WHERE id = ? AND company_id = ? AND kind = 'pessoa'", Number(ctx.params.id), company.id);
  billing.syncSeats(company.id);
  send(ctx.res, 200, { ok: true });
});

// Visão do gestor: só indicadores, nunca o conteúdo dos e-mails de cada pessoa.
router.get("/api/team/overview", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin", "gestor");
  const rules = agent.rulesOf(company);
  const people = all("SELECT id, name, email, role, invite_token IS NOT NULL AS pending FROM users WHERE company_id = ? AND kind = 'pessoa' ORDER BY name", company.id).map(p => {
    const acc = mail.account(p.id), box = acc ? mail.inbox(p.id, 200) : [];
    return { name: p.name, email: p.email, role: p.role, pending: !!p.pending, connected: acc ? (acc.provider === "demo" ? "demonstração" : acc.provider) : null, lastSync: acc?.last_sync_at || null,
      total: box.length, late: box.filter(m => agent.isLate(m, rules)).length, urgent: box.filter(m => m.triage?.prioridade === "urgente" && !m.replied).length,
      drafts: box.filter(m => m.draft).length, untriaged: box.filter(m => !m.triage).length };
  });
  const groupStats = groups.list(user).map(gp => {
    const g = groups.get(company.id, gp.id), r = groups.rulesFor(g, rules), box = mail.inbox(g.user_id, 200);
    const o = groups.overview(g, box, m => agent.isLate(m, r));
    return { id: gp.id, name: gp.name, address: gp.address, connected: !!mail.account(g.user_id), abertos: o.abertos, semDono: o.semDono, atrasados: o.atrasados, urgentes: o.urgentes, resolvidos7d: o.resolvidos7d };
  });
  send(ctx.res, 200, { people, groups: groupStats, atraso: rules.atraso });
});

// ---------- grupos de e-mail (caixas compartilhadas) ----------
const cleanGroupInput = b => ({
  nome: b.nome != null ? String(b.nome).trim().slice(0, 80) : undefined,
  endereco: b.endereco != null ? String(b.endereco).trim().toLowerCase().slice(0, 160) : undefined,
  filtro: b.filtro != null ? String(b.filtro).trim().slice(0, 400) : undefined,
  autoAtribuir: b.autoAtribuir != null ? !!b.autoAtribuir : undefined
});
// ---------- pendências da caixa pessoal (quem usa sozinho, com um único e-mail) ----------
router.get("/api/me/box", async (ctx) => {
  const { user, company } = auth(ctx);
  const rules = agent.rulesOf(company);
  const acc = mail.account(user.id);
  send(ctx.res, 200, {
    personal: true, group: { id: 0, name: "Minha caixa", address: acc?.address || "", autoAtribuir: false, groupLogin: false },
    canManage: false, isMember: false, members: [], statuses: groups.STATUS, atraso: rules.atraso,
    account: acc ? { provider: acc.provider, address: acc.address, lastSync: acc.last_sync_at, error: acc.last_error } : null,
    inbox: mail.inbox(user.id, 200)
  });
});
router.post("/api/me/handling", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : [ctx.body.id]).filter(Boolean).map(String).slice(0, 200);
  try { groups.setHandling({ user_id: user.id, company_id: company.id }, ids, { status: String(ctx.body.situacao) }, user.id); } catch (e) { throw new HttpError(400, e.message); }
  send(ctx.res, 200, { inbox: mail.inbox(user.id, 200) });
});

router.get("/api/people", async (ctx) => {
  const { user, company } = auth(ctx);
  if (!groups.canManage(user)) throw new HttpError(403, "Seu perfil não tem permissão para isso.");
  send(ctx.res, 200, { people: all("SELECT id, name, email FROM users WHERE company_id = ? AND kind = 'pessoa' ORDER BY name", company.id) });
});
router.get("/api/groups", async (ctx) => { const { user } = auth(ctx); send(ctx.res, 200, { groups: groups.list(user) }); });
router.post("/api/groups", async (ctx) => {
  const { user, company } = auth(ctx);
  if (!groups.canManage(user)) throw new HttpError(403, "Só administradores e gestores criam grupos.");
  const b = cleanGroupInput(ctx.body);
  if (!b.nome) throw new HttpError(400, "Dê um nome ao grupo (ex.: Operacional).");
  if (b.endereco && !EMAIL_RE.test(b.endereco)) throw new HttpError(400, "Endereço do grupo inválido.");
  const g = groups.create(company, b);
  if (Array.isArray(ctx.body.membros)) groups.setMembers(g, ctx.body.membros);
  send(ctx.res, 201, { group: groups.publicGroup(g) });
});
router.get("/api/groups/:id", async (ctx) => {
  const { user, company } = auth(ctx);
  const g = groupOf(ctx, user);
  const rules = groups.rulesFor(g, agent.rulesOf(company));
  const inbox = mail.inbox(g.user_id, 200);
  const acc = mail.account(g.user_id);
  send(ctx.res, 200, {
    group: groups.publicGroup(g), canManage: groups.canManage(user), isMember: groups.isMember(g.user_id, user.id),
    members: groups.members(g.user_id), statuses: groups.STATUS,
    account: acc ? { provider: acc.provider, address: acc.address, lastSync: acc.last_sync_at, error: acc.last_error } : null,
    inbox, overview: groups.overview(g, inbox, m => agent.isLate(m, rules)), atraso: rules.atraso, team: rules.team
  });
});
router.put("/api/groups/:id", async (ctx) => {
  const { user } = auth(ctx);
  const g = groupOf(ctx, user, { manage: true });
  const b = cleanGroupInput(ctx.body);
  if (b.nome === "") throw new HttpError(400, "O grupo precisa de um nome.");
  if (b.endereco && !EMAIL_RE.test(b.endereco)) throw new HttpError(400, "Endereço do grupo inválido.");
  groups.update(g, b);
  send(ctx.res, 200, { group: groups.publicGroup(groups.get(user.company_id, g.user_id)) });
});
router.delete("/api/groups/:id", async (ctx) => {
  const { user } = auth(ctx);
  requireRole(user, "admin");
  groups.remove(groupOf(ctx, user, { manage: true }));
  send(ctx.res, 200, { ok: true });
});
router.put("/api/groups/:id/members", async (ctx) => {
  const { user } = auth(ctx);
  const g = groupOf(ctx, user, { manage: true });
  groups.setMembers(g, Array.isArray(ctx.body.membros) ? ctx.body.membros : []);
  // Com as funções novas, a IA requalifica o que ainda está sem dono e já divide entre as pessoas.
  groups.requalifyUnassigned(g);
  const company = one("SELECT * FROM companies WHERE id = ?", g.company_id);
  if (config.autoTriage && billing.access(company).ok) await agent.autoTriage(boxUser(g), company).catch(e => console.error("[triagem]", e.message));
  send(ctx.res, 200, { members: groups.members(g.user_id) });
});
router.post("/api/groups/:id/connect/demo", async (ctx) => {
  const { user, company } = auth(ctx);
  const g = groupOf(ctx, user, { manage: true });
  mail.saveAccount(g.user_id, "demo", { address: "caixa de demonstração" }, { demoSector: SECTORS[ctx.body.setor] ? ctx.body.setor : company.sector });
  await mail.sync(g.user_id);
  if (config.autoTriage && billing.access(company).ok) await agent.autoTriage(boxUser(g), company).catch(e => console.error("[triagem]", e.message));
  send(ctx.res, 200, { ok: true });
});
// Senha de acesso pelo e-mail do grupo (vazia = desliga).
router.put("/api/groups/:id/access", async (ctx) => {
  const { user } = auth(ctx);
  const g = groupOf(ctx, user, { manage: true });
  const senha = String(ctx.body.senha || "");
  if (senha && !g.address) throw new HttpError(400, "Informe primeiro o endereço do grupo (ex.: operacional@empresa.com.br).");
  if (senha && senha.length < 8) throw new HttpError(400, "A senha do grupo precisa ter pelo menos 8 caracteres.");
  if (senha && one("SELECT 1 FROM users WHERE email = ? AND kind = 'pessoa'", String(g.address).toLowerCase())) throw new HttpError(409, "Já existe uma pessoa com o e-mail do grupo como login.");
  groups.setPassword(g, senha);
  send(ctx.res, 200, { groupLogin: !!senha });
});
// Busca agora as pessoas do grupo (Google Grupos e respostas da equipe).
// Adiciona pessoas ao grupo colando os e-mails (ex.: a lista de membros do Google Grupos).
// Aceita "Nome <email>", "email" ou "email, Nome", separados por vírgula, ponto e vírgula ou linha.
router.post("/api/groups/:id/members/add", async (ctx) => {
  const { user } = auth(ctx);
  const g = groupOf(ctx, user, { manage: true });
  const text = String(ctx.body.lista || "").slice(0, 20000);
  const found = [];
  for (const part of text.split(/[\n;]+|,(?=\s*[^,]*@)/)) {
    const m = part.match(/([^\s<>,;"]+@[^\s<>,;"]+\.[^\s<>,;"]+)/); if (!m) continue;
    const email = m[1].toLowerCase();
    const name = part.replace(m[0], "").replace(/[<>",;()]/g, " ").replace(/\s+/g, " ").trim();
    found.push({ email, name: name && !name.includes("@") ? name.slice(0, 80) : "" });
  }
  if (!found.length) throw new HttpError(400, "Não encontrei nenhum e-mail no que foi colado.");
  // quem o gestor adiciona de propósito sai da lista de excluídos
  for (const f of found) run("DELETE FROM group_excluded WHERE group_id = ? AND email = ?", g.user_id, f.email);
  const added = groups.addDetected(g, found, "manual");
  if (added.length) billing.syncSeats(g.company_id);
  const otherCompany = found.filter(f => { const u = one("SELECT company_id FROM users WHERE email = ?", f.email); return u && u.company_id !== g.company_id; }).map(f => f.email);
  send(ctx.res, 200, { added, ignored: otherCompany, members: groups.members(g.user_id) });
});

router.post("/api/groups/:id/detect", async (ctx) => {
  const { user } = auth(ctx);
  const g = groupOf(ctx, user, { manage: true });
  const acc = mail.account(g.user_id);
  if (!acc) throw new HttpError(400, "Conecte primeiro o e-mail do grupo.");
  const r = await mail.sync(g.user_id);
  send(ctx.res, 200, { added: r.newPeople || [], members: groups.members(g.user_id) });
});
router.delete("/api/groups/:id/connect", async (ctx) => {
  const { user } = auth(ctx);
  mail.disconnect(groupOf(ctx, user, { manage: true }).user_id);
  send(ctx.res, 200, { ok: true });
});
// Atendimento: assumir, passar para alguém, mudar situação (um ou vários e-mails).
router.post("/api/groups/:id/handling", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const g = groupOf(ctx, user);
  const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : [ctx.body.id]).filter(Boolean).map(String).slice(0, 200);
  const patch = {};
  if ("dono" in ctx.body) patch.assigneeId = ctx.body.dono === "eu" ? user.id : (ctx.body.dono ? Number(ctx.body.dono) : null);
  if ("situacao" in ctx.body) patch.status = String(ctx.body.situacao);
  let changed;
  try { changed = groups.setHandling(g, ids, patch, user.id); } catch (e) { throw new HttpError(400, e.message); }
  if ("assigneeId" in patch) mail.labelMessages(g.user_id, changed);
  send(ctx.res, 200, { changed: changed.length, inbox: mail.inbox(g.user_id, 200) });
});
router.get("/api/groups/:id/messages/:mid", async (ctx) => {
  const { user } = auth(ctx);
  const g = groupOf(ctx, user);
  send(ctx.res, 200, { history: groups.history(g, ctx.params.mid) });
});
router.post("/api/groups/:id/messages/:mid/notes", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const g = groupOf(ctx, user);
  const texto = String(ctx.body.texto || "").trim();
  if (!texto) throw new HttpError(400, "Escreva a nota.");
  try { groups.addNote(g, ctx.params.mid, user.id, texto); } catch (e) { throw new HttpError(404, e.message); }
  send(ctx.res, 201, { history: groups.history(g, ctx.params.mid) });
});

// ---------- assinatura ----------
router.post("/api/billing/checkout", async (ctx) => { const { user, company } = auth(ctx); requireRole(user, "admin"); send(ctx.res, 200, { url: await billing.checkout(company, user) }); });
router.post("/api/billing/portal", async (ctx) => { const { user, company } = auth(ctx); requireRole(user, "admin"); send(ctx.res, 200, { url: await billing.portal(company) }); });
router.post("/api/stripe/webhook", async ({ res, raw, req }) => {
  const evt = billing.verifyWebhook(raw, req.headers["stripe-signature"]);
  billing.handleEvent(evt);
  send(res, 200, { received: true });
}, { raw: true });

router.get("/api/health", async ({ res }) => send(res, 200, { ok: true, ai: ai.name(), features: config.features }));

// ---------- servidor ----------
const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    if (await router.handle(req, res, {})) return;
    if (req.method === "GET" && serveStatic(PUBLIC, req, res)) return;
    send(res, 404, req.url.startsWith("/api/") ? { error: "Não encontrado." } : "Página não encontrada.");
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && !e.status) console.error(e);
    send(res, status, { error: status >= 500 && !e.status ? "Erro interno. Tente de novo." : e.message, ...(e.extra || {}) });
  }
});

// Leitura automática das caixas + qualificação dos e-mails novos.
async function tick() {
  const rows = all("SELECT a.user_id FROM mail_accounts a");
  for (const r of rows) {
    const user = one("SELECT * FROM users WHERE id = ?", r.user_id); if (!user) continue;
    const company = one("SELECT * FROM companies WHERE id = ?", user.company_id);
    if (!billing.access(company).ok) continue;
    try {
      const s = await mail.sync(user.id, { ai: pdfReader(user, company) });
      if (s.added.length && config.autoTriage) await agent.autoTriage(user, company);
    } catch (e) { console.error("[agendador]", user.email, e.message); }
  }
}

// Cópia diária do banco no próprio disco (mantém 7 dias). Complementa os snapshots do servidor,
// com uma cópia consistente do SQLite mesmo com o banco em uso.
const fs = require("node:fs");
function backup() {
  const { db } = require("./db");
  const dir = path.join(path.dirname(config.dbPath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `genco-ia-${day}.db`);
  if (fs.existsSync(file)) return;
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(f => /^genco-ia-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -7);
  old.forEach(f => fs.rmSync(path.join(dir, f), { force: true }));
  console.log("[backup] cópia do banco criada:", path.basename(file));
}

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`GENCO IA no ar em ${config.appUrl} (porta ${config.port}) · IA: ${ai.name()} · Gmail: ${config.features.gmail ? "sim" : "não"} · Outlook: ${config.features.outlook ? "sim" : "não"} · Stripe: ${config.features.stripe ? "sim" : "não"}`);
  });
  setInterval(() => tick().catch(e => console.error("[agendador]", e.message)), Math.max(1, config.syncMinutes) * 60e3);
  const safeBackup = () => { try { backup(); } catch (e) { console.error("[backup]", e.message); } };
  setTimeout(safeBackup, 60e3); setInterval(safeBackup, 60 * 60e3);
  // Resumo diário: confere a cada 10 minutos quem já deve receber hoje.
  setInterval(() => digest.runDue().then(n => n && console.log(`[resumo] ${n} enviado(s)`)).catch(e => console.error("[resumo]", e.message)), 10 * 60e3);
  // Desligamento limpo a cada nova versão publicada (o Render envia SIGTERM).
  const stop = () => { server.close(); try { require("./db").db.close(); } catch {} process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

module.exports = { server, tick, backup };
