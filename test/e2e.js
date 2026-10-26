// Teste de ponta a ponta com IA simulada e caixa de demonstração.
// Uso: npm test
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert");

const dbFile = path.join(os.tmpdir(), `genco-ia-test-${Date.now()}.db`);
Object.assign(process.env, { DATABASE_PATH: dbFile, AI_PROVIDER: "mock", APP_URL: "http://localhost:0", STRIPE_WEBHOOK_SECRET: "whsec_test_123", APP_SECRET: "x".repeat(40) });
const { server } = require("../src/server");

let base;
const jar = {};
async function call(who, method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, redirect: "manual", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(";"), [k] = kv.split("="); const m = new Map((jar[who] || "").split("; ").filter(Boolean).map(c => [c.split("=")[0], c])); m.set(k, kv); jar[who] = [...m.values()].join("; "); }
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
const step = (n, ok = true) => console.log(`${ok ? "✔" : "✘"} ${n}`);

(async () => {
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  try {
    let r = await call("ana", "POST", "/api/signup", { empresa: "BRCOMEXX", setor: "comex", nome: "Ana Coordenadora", email: "ana@exemplo.com", senha: "senha-forte-1" });
    assert.equal(r.status, 201); step("Cadastro da empresa e da administradora");

    r = await call("ana", "GET", "/api/state");
    assert.equal(r.data.company.access.status, "trialing"); assert.equal(r.data.account, null); step("Teste grátis ativo, sem e-mail conectado");

    r = await call("ana", "POST", "/api/chat", { texto: "oi" });
    assert.equal(r.status, 400); step("Conversa bloqueada até conectar um e-mail");

    r = await call("ana", "POST", "/api/connect/demo", { setor: "comex" });
    assert.equal(r.data.inbox.length, 12); step("Caixa de demonstração conectada com 12 e-mails");

    r = await call("ana", "POST", "/api/chat", { texto: "O que é urgente hoje?" });
    assert.equal(r.status, 200); assert.ok(r.data.reply.text); assert.ok(r.data.reply.cards.some(c => c.t === "sum"));
    assert.ok(r.data.inbox.every(m => m.triage)); step(`IA qualificou a caixa (${r.data.inbox.filter(m => m.triage.prioridade === "urgente").length} urgentes) e mostrou cartões`);

    r = await call("ana", "POST", "/api/chat", { texto: "Prepare as respostas dos atrasados" });
    assert.ok(r.data.reply.cards.some(c => c.t === "draft")); assert.ok(r.data.inbox.some(m => m.draft)); step("Rascunhos criados pela IA");

    const draftId = r.data.inbox.find(m => m.draft).id;
    r = await call("ana", "PUT", "/api/drafts/" + draftId, { assunto: "Re: teste", corpo: "Texto editado" });
    assert.equal(r.status, 200); step("Rascunho editado pelo usuário");

    r = await call("ana", "PUT", "/api/rules", { team: [{ nome: "Bruno", regra: "Marítimo Santos" }, { nome: "Carla", regra: "Exigências e impostos" }], atraso: 6 });
    assert.equal(r.data.rules.team.length, 2); assert.equal(r.data.rules.atraso, 6); step("Regras e equipe atualizadas");

    r = await call("ana", "POST", "/api/users", { nome: "Bruno Analista", email: "bruno@exemplo.com", role: "membro" });
    assert.equal(r.status, 201); const token = new URL(r.data.link).searchParams.get("token"); step("Convite gerado para um funcionário");

    r = await call("bruno", "POST", "/api/invite/accept", { token, senha: "outra-senha-2" });
    assert.equal(r.status, 200);
    r = await call("bruno", "GET", "/api/state");
    assert.equal(r.data.me.role, "membro"); assert.equal(r.data.account, null); step("Funcionário entrou e tem a própria conta, sem acesso à caixa da gestora");

    r = await call("bruno", "GET", "/api/team/overview");
    assert.equal(r.status, 403); step("Membro não vê a visão da equipe");

    // ---------- grupo de e-mail (caixa compartilhada) ----------
    const anaId = (await call("ana", "GET", "/api/state")).data.me.id, brunoId = (await call("bruno", "GET", "/api/state")).data.me.id;
    r = await call("bruno", "POST", "/api/groups", { nome: "Operacional" });
    assert.equal(r.status, 403); step("Membro não cria grupo");
    r = await call("ana", "POST", "/api/groups", { nome: "Operacional", endereco: "operacional@brcomexx.com.br", membros: [
      { user_id: anaId, regra: "Exigências fiscais, LPCO, anuências, numerário e impostos", coordena: true },
      { user_id: brunoId, regra: "Processos marítimos em Santos: contêiner, navio, terminal e free time" }] });
    assert.equal(r.status, 201); const gid = r.data.group.id; step("Grupo Operacional criado com 2 membros");

    r = await call("ana", "GET", "/api/state");
    assert.equal(r.data.company.seats, 2); assert.equal(r.data.groups.length, 1); step("Caixa do grupo não conta como licença");

    r = await call("ana", "POST", `/api/groups/${gid}/connect/demo`, { setor: "comex" });
    assert.equal(r.status, 200);
    r = await call("bruno", "GET", `/api/groups/${gid}`);
    assert.equal(r.status, 200); assert.equal(r.data.inbox.length, 12); assert.ok(r.data.inbox.every(m => m.triage));
    const auto = r.data.inbox.filter(m => m.handling.assignee_id);
    assert.ok(auto.length > 0); assert.ok(auto.some(m => m.handling.assignee_id === brunoId));
    step(`E-mail do grupo lido e qualificado; IA atribuiu ${auto.length} e-mails pela regra de cada membro`);

    const semDono = r.data.inbox.find(m => !m.handling.assignee_id && !m.replied);
    r = await call("bruno", "POST", `/api/groups/${gid}/handling`, { ids: [semDono.id], dono: "eu" });
    let msg = r.data.inbox.find(m => m.id === semDono.id);
    assert.equal(msg.handling.assignee_id, brunoId); assert.equal(msg.handling.status, "andamento"); step("Membro assumiu um e-mail sem dono (passa para \"em andamento\")");

    r = await call("bruno", "POST", `/api/groups/${gid}/handling`, { ids: [semDono.id], dono: anaId });
    r = await call("bruno", "POST", `/api/groups/${gid}/messages/${semDono.id}/notes`, { texto: "Ana, cliente pediu retorno até 15h." });
    assert.equal(r.status, 201);
    r = await call("ana", "POST", `/api/groups/${gid}/handling`, { ids: [semDono.id], situacao: "resolvido" });
    r = await call("ana", "GET", `/api/groups/${gid}/messages/${semDono.id}`);
    assert.deepEqual(r.data.history.map(h => h.kind), ["dono", "dono", "nota", "situacao"]); step("Repasse, nota interna e resolução ficam no histórico");

    r = await call("ana", "POST", `/api/groups/${gid}/handling`, { ids: [semDono.id], situacao: "qualquer" });
    assert.equal(r.status, 400); step("Situação inválida é recusada");

    r = await call("bruno", "POST", "/api/chat", { texto: "O que está sem dono?", grupo: gid });
    assert.equal(r.status, 200); assert.ok(/sem dono/.test(r.data.reply.text)); step("Conversa com a IA sobre a caixa do grupo");
    r = await call("bruno", "GET", "/api/state");
    assert.ok(r.data.chat.every(c => !/sem dono/.test(c.text || ""))); step("Conversa do grupo separada da conversa pessoal");
    r = await call("bruno", "POST", "/api/chat", { texto: "Eu assumo os urgentes", grupo: gid });
    assert.ok(r.data.inbox.some(m => m.handling.assignee_id === brunoId && m.triage.prioridade === "urgente")); step("IA atribui e-mails do grupo pela conversa");

    r = await call("ana", "GET", "/api/team/overview");
    assert.equal(r.data.groups.length, 1); assert.ok("semDono" in r.data.groups[0]); step("Gestora vê indicadores do grupo na visão da equipe");

    r = await call("ana", "POST", "/api/users", { nome: "Carla Financeiro", email: "carla@exemplo.com", role: "membro" });
    const tokC = new URL(r.data.link).searchParams.get("token");
    await call("carla", "POST", "/api/invite/accept", { token: tokC, senha: "senha-carla-3" });
    r = await call("carla", "GET", `/api/groups/${gid}`); assert.equal(r.status, 404);
    r = await call("carla", "GET", "/api/state?grupo=" + gid); assert.equal(r.status, 404);
    r = await call("carla", "GET", "/api/groups"); assert.equal(r.data.groups.length, 0); step("Quem não é do grupo não vê a caixa do grupo");
    r = await call("ana", "GET", "/api/users"); assert.ok(r.data.users.every(u => !u.email.endsWith("@caixa.genco-ia"))); step("Caixa do grupo não aparece como pessoa");

    // Pessoas detectadas automaticamente + entrada pelo e-mail do grupo
    r = await call("ana", "GET", `/api/groups/${gid}`);
    const detected = r.data.members.filter(m => m.origem === "demo");
    assert.equal(detected.length, 4); step("Pessoas do grupo detectadas automaticamente (4 na demonstração)");
    r = await call("ana", "PUT", `/api/groups/${gid}/access`, { senha: "curta" }); assert.equal(r.status, 400);
    r = await call("ana", "PUT", `/api/groups/${gid}/access`, { senha: "grupo-senha-1" }); assert.equal(r.status, 200); step("Senha de acesso do grupo ativada");
    r = await call("equipe", "POST", "/api/login", { email: "operacional@brcomexx.com.br", senha: "errada-123" }); assert.equal(r.status, 401);
    r = await call("equipe", "POST", "/api/login", { email: "OPERACIONAL@brcomexx.com.br", senha: "grupo-senha-1" });
    assert.equal(r.data.grupo, true);
    r = await call("equipe", "GET", "/api/state"); assert.equal(r.status, 401); step("Login com o e-mail do grupo leva para \"quem está usando?\"");
    r = await call("equipe", "GET", "/api/group-login");
    assert.ok(r.data.members.length >= 6); const memberP = r.data.members.find(m => m.id === detected[0].id), adminP = r.data.members.find(m => m.id === anaId);
    assert.equal(memberP.needsPassword, false); assert.equal(adminP.needsPassword, true);
    r = await call("equipe", "POST", "/api/group-login/choose", { user_id: anaId }); assert.ok([401, 403].includes(r.status));
    r = await call("equipe", "POST", "/api/group-login/choose", { user_id: anaId, senha: "errada" }); assert.equal(r.status, 401); step("Gestora precisa confirmar com a própria senha");
    r = await call("equipe", "POST", "/api/group-login/choose", { user_id: memberP.id });
    assert.equal(r.data.grupo, gid);
    r = await call("equipe", "GET", "/api/state");
    assert.equal(r.data.me.id, memberP.id); assert.equal(r.data.groupLogin.id, gid); step(`${memberP.name} entrou pelo grupo escolhendo o nome`);
    r = await call("equipe", "GET", `/api/groups/${gid}`); assert.equal(r.status, 200); step("Pessoa que entrou pelo grupo vê as pendências do grupo");
    r = await call("ana", "PUT", `/api/groups/${gid}/members`, { membros: (await call("ana", "GET", `/api/groups/${gid}`)).data.members.filter(m => m.id !== detected[1].id).map(m => ({ user_id: m.id, regra: m.regra, coordena: m.coordena })) });
    r = await call("ana", "POST", `/api/groups/${gid}/detect`);
    assert.ok(!r.data.members.some(m => m.id === detected[1].id)); step("Quem o gestor tirou do grupo não volta na próxima detecção");
    await call("ana", "DELETE", "/api/users/" + (await call("ana", "GET", "/api/users")).data.users.find(u => u.email === "carla@exemplo.com").id);

    r = await call("bruno", "PUT", "/api/rules", { atraso: 1 });
    assert.equal(r.status, 403); step("Membro não altera as regras");

    r = await call("ana", "GET", "/api/team/overview");
    assert.ok(r.data.people.length >= 2); assert.ok(r.data.people.every(p => !("inbox" in p))); step("Gestora vê indicadores da equipe, sem conteúdo dos e-mails");

    r = await call("ana", "POST", "/api/billing/checkout");
    assert.equal(r.status, 503); step("Assinatura avisa que o Stripe ainda não foi configurado");

    // Webhook assinado: ativa a assinatura.
    const evt = JSON.stringify({ type: "checkout.session.completed", data: { object: { client_reference_id: "1", customer: "cus_123", subscription: "sub_123" } } });
    const t = Math.floor(Date.now() / 1000), sig = crypto.createHmac("sha256", "whsec_test_123").update(`${t}.${evt}`).digest("hex");
    r = await call("stripe", "POST", "/api/stripe/webhook", evt, { "Stripe-Signature": `t=${t},v1=${sig}`, "Content-Type": "application/json" });
    assert.equal(r.status, 200);
    r = await call("ana", "GET", "/api/state"); assert.equal(r.data.company.access.status, "active"); step("Webhook do Stripe validado e assinatura ativada");

    r = await call("stripe", "POST", "/api/stripe/webhook", evt, { "Stripe-Signature": `t=${t},v1=deadbeef`, "Content-Type": "application/json" });
    assert.equal(r.status, 400); step("Webhook com assinatura falsa é recusado");

    // Fim do teste grátis bloqueia o uso.
    const { run } = require("../src/db");
    run("UPDATE companies SET status = 'trialing', trial_ends_at = ? WHERE id = 1", Date.now() - 1000);
    r = await call("ana", "POST", "/api/chat", { texto: "oi" });
    assert.equal(r.status, 402); step("Fim do teste grátis bloqueia a IA até assinar");

    r = await call("ana", "POST", "/api/login", { email: "ana@exemplo.com", senha: "errada" });
    assert.equal(r.status, 401); step("Senha errada é recusada");

    console.log("\nTodos os testes passaram.");
  } catch (e) {
    console.error("\nFalhou:", e.message); process.exitCode = 1;
  } finally {
    server.close(); fs.rmSync(dbFile, { force: true }); ["-wal", "-shm"].forEach(s => fs.rmSync(dbFile + s, { force: true }));
    setTimeout(() => process.exit(), 50);
  }
})();
