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
const pdfReader = (user, company) => ({ extractPdf: b => ai.extractPdf(b, { companyId: company.id, userId: user.id }) });

// ---------- cadastro e login ----------
router.post("/api/signup", async ({ req, res, body }) => {
  throttle("signup:" + ip(req), 5);
  const empresa = String(body.empresa || "").trim(), nome = String(body.nome || "").trim(), email = String(body.email || "").trim().toLowerCase(), senha = String(body.senha || "");
  const setor = SECTORS[body.setor] ? body.setor : "geral";
  if (!empresa || !nome) throw new HttpError(400, "Informe o nome da empresa e o seu nome.");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "E-mail inválido.");
  if (senha.length < 8) throw new HttpError(400, "A senha precisa ter pelo menos 8 caracteres.");
  if (one("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "Já existe uma conta com este e-mail. Entre com sua senha.");
  const c = run("INSERT INTO companies (name, sector, status, trial_ends_at, rules_json, created_at) VALUES (?, ?, 'trialing', ?, ?, ?)",
    empresa, setor, now() + config.trialDays * 864e5, JSON.stringify(defaultRules(setor, empresa)), now());
  const u = run("INSERT INTO users (company_id, name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)", c.lastInsertRowid, nome, email, sec.hashPassword(senha), now());
  send(res, 201, { ok: true }, { "Set-Cookie": sec.sessionCookie(sec.createSession(Number(u.lastInsertRowid))) });
});

router.post("/api/login", async ({ req, res, body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  throttle("login:" + ip(req) + ":" + email);
  const u = one("SELECT * FROM users WHERE email = ?", email);
  if (!u || !sec.verifyPassword(String(body.senha || ""), u.password_hash)) throw new HttpError(401, "E-mail ou senha incorretos.");
  send(res, 200, { ok: true }, { "Set-Cookie": sec.sessionCookie(sec.createSession(u.id)) });
});

router.post("/api/logout", async ({ res, cookies }) => {
  sec.destroySession(cookies.genco_sess);
  send(res, 200, { ok: true }, { "Set-Cookie": sec.sessionCookie("", 0) });
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

// ---------- estado do app ----------
router.get("/api/state", async (ctx) => {
  const { user, company } = auth(ctx);
  const acc = mail.account(user.id);
  const rules = agent.rulesOf(company);
  send(ctx.res, 200, {
    me: publicUser(user),
    company: { name: company.name, sector: company.sector, sectorName: (SECTORS[company.sector] || SECTORS.geral).nome, access: billing.access(company), seats: billing.seats(company.id), hasSubscription: !!company.stripe_subscription_id },
    features: { ...config.features, ai: ai.name() },
    account: acc ? { provider: acc.provider, address: acc.address, demoSector: acc.demo_sector, lastSync: acc.last_sync_at, error: acc.last_error } : null,
    inbox: mail.inbox(user.id),
    chat: all("SELECT role, text, cards_json, error, created_at FROM chats WHERE user_id = ? ORDER BY id DESC LIMIT 60", user.id).reverse().map(r => ({ role: r.role, text: r.text, cards: json(r.cards_json, []), error: r.error })),
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
  if (!mail.account(user.id)) throw new HttpError(400, "Conecte um e-mail antes de conversar com a GENCO IA.");
  if (ai.monthlyCount(user.id) >= config.ai.monthlyLimitPerUser) throw new HttpError(429, "Você atingiu o limite de mensagens do mês no seu plano.");
  if (!mail.inbox(user.id, 1).length) await mail.sync(user.id, { ai: pdfReader(user, company) });
  const r = await agent.chat(user, company, text);
  send(ctx.res, 200, { reply: r, inbox: mail.inbox(user.id), rules: agent.rulesOf(one("SELECT * FROM companies WHERE id = ?", company.id)) });
});
router.delete("/api/chat", async (ctx) => { const { user } = auth(ctx); run("DELETE FROM chats WHERE user_id = ?", user.id); send(ctx.res, 200, { ok: true }); });

router.post("/api/sync", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const r = await mail.sync(user.id, { ai: pdfReader(user, company) });
  if (r.error) throw new HttpError(502, "Não foi possível ler o e-mail: " + r.error);
  send(ctx.res, 200, { added: r.added.length, inbox: mail.inbox(user.id) });
});

router.put("/api/drafts/:id", async (ctx) => {
  const { user, company } = auth(ctx);
  requireAccess(company);
  const r = await mail.saveDraft(user.id, ctx.params.id, { assunto: String(ctx.body.assunto || ""), corpo: String(ctx.body.corpo || "") });
  send(ctx.res, 200, r);
});

// ---------- conexão de e-mail ----------
router.get("/api/connect/:provider", async (ctx) => {
  const { user } = auth(ctx);
  const p = ctx.params.provider;
  if (!mail.PROVIDERS[p]) throw new HttpError(404, "Provedor desconhecido.");
  if (!config.features[p]) throw new HttpError(503, p === "gmail" ? "Conexão com Gmail ainda não configurada (GOOGLE_CLIENT_ID)." : "Conexão com Outlook ainda não configurada (MICROSOFT_CLIENT_ID).");
  const state = sec.randomToken(24);
  run("DELETE FROM oauth_states WHERE created_at < ?", now() - 15 * 60e3);
  run("INSERT INTO oauth_states (state, user_id, provider, created_at) VALUES (?, ?, ?, ?)", state, user.id, p, now());
  redirect(ctx.res, mail.PROVIDERS[p].authUrl(state));
});
router.get("/oauth/:provider/callback", async (ctx) => {
  const p = ctx.params.provider, q = ctx.query;
  const st = one("SELECT * FROM oauth_states WHERE state = ? AND provider = ?", String(q.state || ""), p);
  if (!st || now() - st.created_at > 15 * 60e3) return redirect(ctx.res, "/app?conexao=expirada");
  run("DELETE FROM oauth_states WHERE state = ?", st.state);
  if (q.error || !q.code) return redirect(ctx.res, "/app?conexao=cancelada");
  try {
    const t = await mail.PROVIDERS[p].exchange(String(q.code));
    mail.saveAccount(st.user_id, p, t);
    const user = one("SELECT * FROM users WHERE id = ?", st.user_id), company = one("SELECT * FROM companies WHERE id = ?", user.company_id);
    mail.sync(user.id, { ai: pdfReader(user, company) }).then(r => r.added.length && config.autoTriage && billing.access(company).ok && agent.autoTriage(user, company)).catch(e => console.error("[sync]", e.message));
    redirect(ctx.res, "/app?conexao=ok");
  } catch (e) {
    console.error("[oauth]", e.message);
    redirect(ctx.res, "/app?conexao=erro");
  }
});
router.post("/api/connect/demo", async (ctx) => {
  const { user, company } = auth(ctx);
  const setor = SECTORS[ctx.body.setor] ? ctx.body.setor : company.sector;
  mail.saveAccount(user.id, "demo", { address: "caixa de demonstração" }, { demoSector: setor });
  await mail.sync(user.id);
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
  send(ctx.res, 200, { users: all("SELECT id, name, email, role, invite_token IS NOT NULL AS pending FROM users WHERE company_id = ? ORDER BY id", company.id) });
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
  run("UPDATE users SET role = ? WHERE id = ? AND company_id = ?", role, Number(ctx.params.id), company.id);
  send(ctx.res, 200, { ok: true });
});
router.delete("/api/users/:id", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin");
  if (Number(ctx.params.id) === user.id) throw new HttpError(400, "Você não pode remover a própria conta.");
  run("DELETE FROM users WHERE id = ? AND company_id = ?", Number(ctx.params.id), company.id);
  billing.syncSeats(company.id);
  send(ctx.res, 200, { ok: true });
});

// Visão do gestor: só indicadores, nunca o conteúdo dos e-mails de cada pessoa.
router.get("/api/team/overview", async (ctx) => {
  const { user, company } = auth(ctx);
  requireRole(user, "admin", "gestor");
  const rules = agent.rulesOf(company);
  const people = all("SELECT id, name, email, role, invite_token IS NOT NULL AS pending FROM users WHERE company_id = ? ORDER BY name", company.id).map(p => {
    const acc = mail.account(p.id), box = acc ? mail.inbox(p.id, 200) : [];
    return { name: p.name, email: p.email, role: p.role, pending: !!p.pending, connected: acc ? (acc.provider === "demo" ? "demonstração" : acc.provider) : null, lastSync: acc?.last_sync_at || null,
      total: box.length, late: box.filter(m => agent.isLate(m, rules)).length, urgent: box.filter(m => m.triage?.prioridade === "urgente" && !m.replied).length,
      drafts: box.filter(m => m.draft).length, untriaged: box.filter(m => !m.triage).length };
  });
  send(ctx.res, 200, { people, atraso: rules.atraso });
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

if (require.main === module) {
  server.listen(config.port, () => {
    console.log(`GENCO IA no ar em ${config.appUrl} (porta ${config.port}) · IA: ${ai.name()} · Gmail: ${config.features.gmail ? "sim" : "não"} · Outlook: ${config.features.outlook ? "sim" : "não"} · Stripe: ${config.features.stripe ? "sim" : "não"}`);
  });
  setInterval(() => tick().catch(e => console.error("[agendador]", e.message)), Math.max(1, config.syncMinutes) * 60e3);
}

module.exports = { server, tick };
