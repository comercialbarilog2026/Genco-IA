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
  const sc = r.headers.get("set-cookie"); if (sc) jar[who] = sc.split(";")[0];
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

    r = await call("bruno", "PUT", "/api/rules", { atraso: 1 });
    assert.equal(r.status, 403); step("Membro não altera as regras");

    r = await call("ana", "GET", "/api/team/overview");
    assert.equal(r.data.people.length, 2); assert.ok(r.data.people.every(p => !("inbox" in p))); step("Gestora vê indicadores da equipe, sem conteúdo dos e-mails");

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
