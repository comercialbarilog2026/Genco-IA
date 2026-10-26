// Teste de ponta a ponta com IA simulada e caixa de demonstração.
// Uso: npm test
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const assert = require("node:assert");

const dbFile = path.join(os.tmpdir(), `genco-ia-test-${Date.now()}.db`);
const fakeSmtp = require("./fake-smtp");
let smtpBox, server;

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
  smtpBox = await fakeSmtp.start();
  Object.assign(process.env, { DATABASE_PATH: dbFile, AI_PROVIDER: "mock", APP_URL: "http://localhost:0", STRIPE_WEBHOOK_SECRET: "whsec_test_123", APP_SECRET: "x".repeat(40),
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpBox.port), SMTP_SECURE: "false", SMTP_USER: "app", SMTP_PASS: "x", SMTP_FROM: "GENCO IA <nao-responda@genco-ia.com.br>" });
  ({ server } = require("../src/server"));
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
    assert.equal(r.status, 200); assert.ok(r.data.reply.text); assert.ok(r.data.reply.cards.length);
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
    r = await call("ana", "POST", `/api/groups/${gid}/members/add`, { lista: "Paula Reis <paula.reis@brcomexx.com.br>\nlucas@brcomexx.com.br, Marina Alves <marina@brcomexx.com.br>; " + detected[1].email });
    assert.deepEqual(r.data.added.sort(), ["Lucas", "Marina Alves", "Paula Reis", detected[1].name].sort());
    r = await call("ana", "POST", `/api/groups/${gid}/members/add`, { lista: "sem email aqui" }); assert.equal(r.status, 400);
    step("Gestor adiciona pessoas ao grupo colando a lista de e-mails");
    await call("ana", "DELETE", "/api/users/" + (await call("ana", "GET", "/api/users")).data.users.find(u => u.email === "carla@exemplo.com").id);

    r = await call("bruno", "PUT", "/api/rules", { atraso: 1 });
    assert.equal(r.status, 403); step("Membro não altera as regras");

    r = await call("ana", "GET", "/api/team/overview");
    assert.ok(r.data.people.length >= 2); assert.ok(r.data.people.every(p => !("inbox" in p))); step("Gestora vê indicadores da equipe, sem conteúdo dos e-mails");

    // ---------- empresa de uma pessoa só (um único e-mail) ----------
    r = await call("solo", "POST", "/api/signup", { empresa: "Despachante Silva", setor: "comex", modo: "individual", nome: "João Silva", email: "joao@silva.com.br", senha: "senha-solo-1" });
    assert.equal(r.status, 201);
    r = await call("solo", "GET", "/api/state"); assert.equal(r.data.company.modo, "individual"); assert.equal(r.data.groups.length, 0);
    r = await call("solo", "GET", "/api/me/box"); assert.equal(r.data.personal, true); assert.equal(r.data.account, null); step("Cadastro de uma pessoa só, sem grupo");
    await call("solo", "POST", "/api/connect/demo", { setor: "comex" });
    r = await call("solo", "GET", "/api/me/box");
    assert.equal(r.data.inbox.length, 12); assert.ok(r.data.inbox.every(m => m.triage)); step("Caixa pessoal lida e qualificada ao conectar");
    const pid = r.data.inbox.find(m => !m.replied).id;
    r = await call("solo", "POST", "/api/me/handling", { ids: [pid], situacao: "resolvido" });
    assert.equal(r.data.inbox.find(m => m.id === pid).handling.status, "resolvido");
    r = await call("solo", "POST", "/api/me/handling", { ids: [pid], situacao: "invalida" }); assert.equal(r.status, 400); step("Pessoa sozinha marca e-mail como resolvido");
    r = await call("solo", "GET", "/api/team/overview"); assert.equal(r.data.people.length, 1); step("Empresa de uma pessoa conta 1 licença");

    // ---------- qualquer provedor por IMAP (servidor IMAP simulado) ----------
    const fake = await require("./fake-imap").start();
    const imapLogin = { email: "caio@brcomexx.com.br", servidor: "127.0.0.1", porta: fake.port, seguro: false };
    r = await call("imap", "POST", "/api/signup", { empresa: "BRCOMEXX IMAP", setor: "comex", modo: "equipe", nome: "Caio Pepe", email: "caio@brcomexx.com.br", senha: "senha-forte-9" });
    assert.equal(r.status, 201);
    r = await call("imap", "POST", "/api/connect/imap", { ...imapLogin, senha: "errada" });
    assert.equal(r.status, 400); assert.ok(/recusad/.test(r.data.error)); step("IMAP: senha errada é recusada com mensagem clara");
    r = await call("imap", "POST", "/api/connect/imap", { ...imapLogin, senha: fake.pass });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await call("imap", "GET", "/api/me/box");
    let box = r.data.inbox;
    assert.equal(r.data.account.provider, "imap"); assert.equal(box.length, 6);
    const joao = box.find(m => m.from_addr === "joao@cliente.com.br");
    assert.equal(joao.from_name, "João Conceição"); assert.equal(joao.subject, "Contêiner parado - segunda vez"); assert.ok(/perecível/.test(joao.body));
    assert.equal(joao.attachments[0].name, "Invoice 2291.pdf"); step("IMAP: e-mails lidos com acentos, anexo e remetente corretos");
    assert.ok(box.find(m => m.subject === "Status do embarque").replied); assert.ok(box.find(m => m.subject === "Obrigada").replied); assert.ok(!joao.replied);
    step("IMAP: respondidos reconhecidos pela pasta Enviados e pela marcação do servidor");
    assert.ok(box.every(m => m.triage)); step("IMAP: caixa qualificada pela IA ao conectar");
    r = await call("imap", "PUT", "/api/drafts/" + joao.id, { assunto: "Re: Contêiner parado", corpo: "Olá, João. Verificando agora." });
    assert.equal(r.data.saved, true);
    r = await call("imap", "PUT", "/api/drafts/" + joao.id, { assunto: "Re: Contêiner parado", corpo: "Olá, João. Liberação prevista hoje." });
    assert.equal(fake.boxes.Rascunhos.msgs.length, 1);
    const draftRaw = fake.boxes.Rascunhos.msgs[0].raw.toString();
    assert.ok(/In-Reply-To: <m1@cliente.com.br>/.test(draftRaw)); assert.ok(Buffer.from(draftRaw.split("\r\n\r\n")[1].replace(/\s/g, ""), "base64").toString().includes("Liberação prevista"));
    step("IMAP: resposta gravada na pasta Rascunhos (na mesma conversa) e substituída ao editar");
    r = await call("imap", "POST", "/api/me/handling", { ids: [joao.id], situacao: "resolvido" }); assert.equal(r.status, 200);

    // grupo lido pela conta de um membro: só o que vai para operacional@
    const caioId = (await call("imap", "GET", "/api/state")).data.me.id;
    r = await call("imap", "POST", "/api/groups", { nome: "Operacional", endereco: "operacional@brcomexx.com.br", membros: [{ user_id: caioId, coordena: true, regra: "Coordenação" }] });
    const gImap = r.data.group.id;
    r = await call("imap", "POST", "/api/connect/imap", { ...imapLogin, senha: fake.pass, grupo: gImap }); assert.equal(r.status, 200);
    r = await call("imap", "GET", `/api/groups/${gImap}`);
    const subjects = r.data.inbox.map(m => m.subject).sort();
    assert.deepEqual(subjects, ["Agendamento", "Contêiner parado - segunda vez", "Obrigada", "Status do embarque"]);
    assert.ok(r.data.inbox.find(m => m.subject === "Agendamento").replied); step("IMAP no grupo: lê só o que foi para operacional@ e reconhece a resposta da equipe");
    assert.ok(r.data.members.some(m => m.email === "rafael.costa@brcomexx.com.br" && m.name === "Rafael Costa" && m.origem === "email")); step("IMAP no grupo: Rafael detectado automaticamente pela resposta dele");
    // Entrou com a própria caixa do grupo: "Qual é o e-mail do grupo?" usa a caixa já conectada
    r = await call("imap", "POST", "/api/groups/connect-start", { endereco: "CAIO@brcomexx.com.br" });
    assert.equal(r.data.adopted, true); assert.equal(r.data.connected, true); assert.equal(r.data.group.name, "Caio");
    const adoptedId = r.data.group.id;
    r = await call("imap", "GET", `/api/groups/${adoptedId}`); assert.equal(r.data.inbox.length, 6); assert.ok(r.data.inbox.some(m => m.subject === "Contêiner parado - segunda vez"));
    r = await call("imap", "GET", "/api/me/box"); assert.equal(r.data.account, null);
    r = await call("imap", "POST", "/api/groups/connect-start", { endereco: "caio@brcomexx.com.br" }); assert.equal(r.data.group.id, adoptedId); assert.equal(r.data.adopted, false);
    step("E-mail do grupo: a caixa já conectada vira a caixa do grupo, com tudo o que já foi lido");
    r = await call("imap", "DELETE", `/api/groups/${adoptedId}`); assert.equal(r.status, 200);
    await call("imap", "POST", "/api/connect/imap", { ...imapLogin, senha: fake.pass });

    // Entrar com a conta do provedor (sem senha da GENCO IA)
    r = await call("sso1", "POST", "/api/auth/imap", { ...imapLogin, senha: "errada" }); assert.equal(r.status, 400);
    r = await call("sso1", "POST", "/api/auth/imap", { ...imapLogin, senha: fake.pass });
    assert.equal(r.status, 200); assert.equal(r.data.novo, false);
    r = await call("sso1", "GET", "/api/state"); assert.equal(r.data.me.email, "caio@brcomexx.com.br"); assert.equal(r.data.myAccount.provider, "imap");
    r = await call("sso1", "GET", "/api/me/box"); assert.ok(r.data.inbox.length >= 6 && r.data.inbox.some(m => m.triage)); step("Entrar com outro e-mail: conta existente entra pela senha do provedor, sem perder o que já foi lido");
    const fake2 = await require("./fake-imap").start({ user: "joana@transportes-rapidos.com.br", pass: "senha-da-joana" });
    r = await call("sso2", "POST", "/api/auth/imap", { email: "joana@transportes-rapidos.com.br", senha: "senha-da-joana", servidor: "127.0.0.1", porta: fake2.port, seguro: false });
    assert.equal(r.data.novo, true);
    r = await call("sso2", "GET", "/api/state");
    assert.equal(r.data.me.role, "admin"); assert.equal(r.data.company.name, "Transportes-rapidos"); assert.equal(r.data.company.modo, "individual"); assert.equal(r.data.myAccount.address, "joana@transportes-rapidos.com.br");
    step("Entrar com outro e-mail: conta nova criada a partir do provedor, com a caixa já conectada");
    fake2.server.close();
    r = await call("anon", "GET", "/auth/google"); assert.equal(r.status, 302); step("Entrar com Google avisa quando ainda não foi ativado no servidor");
    fake.server.close();

    // ---------- resumo diário e recuperação de senha (SMTP simulado) ----------
    r = await call("ana", "GET", "/api/digest");
    assert.equal(r.data.enabled, true); assert.ok(r.data.total > 0); assert.ok(/Grupo Operacional: equipe/.test(r.data.html)); step(`Resumo diário montado (${r.data.subject})`);
    r = await call("ana", "POST", "/api/digest/send"); assert.equal(r.status, 200);
    let sent = smtpBox.inbox.at(-1); assert.equal(sent.to, "ana@exemplo.com"); assert.ok(/precisam de atenção/.test(fakeSmtp.bodyText(sent.raw))); step("Resumo enviado por e-mail para a responsável");
    const digest = require("../src/digest"), { run: dbRun } = require("../src/db");
    dbRun("UPDATE users SET digest_hour = 0, last_digest_day = NULL"); dbRun("UPDATE users SET digest_on = 0 WHERE email != 'ana@exemplo.com'");
    const wd = digest.localNow().weekday;
    if (wd !== "Sat" && wd !== "Sun") { assert.equal(await digest.runDue(), 1); assert.equal(await digest.runDue(), 0); step("Resumo automático sai uma vez por dia útil"); }
    r = await call("ana", "PUT", "/api/digest", { on: false, hour: 9 }); assert.equal(r.data.on, false); step("Pessoa desliga o resumo nas configurações");

    const before = smtpBox.inbox.length;
    r = await call("anon", "POST", "/api/password/forgot", { email: "ninguem@exemplo.com" }); assert.equal(r.status, 200);
    r = await call("anon", "POST", "/api/password/forgot", { email: "bruno@exemplo.com" }); assert.equal(r.status, 200);
    await new Promise(res => setTimeout(res, 300));
    assert.equal(smtpBox.inbox.length, before + 1); sent = smtpBox.inbox.at(-1); assert.equal(sent.to, "bruno@exemplo.com");
    const resetToken = fakeSmtp.bodyText(sent.raw).match(/token=([\w-]+)/)[1]; step("Esqueci a senha: link enviado só para quem tem conta");
    r = await call("anon", "POST", "/api/password/reset", { token: resetToken, senha: "nova-senha-77" }); assert.equal(r.status, 200);
    r = await call("anon", "POST", "/api/password/reset", { token: resetToken, senha: "nova-senha-78" }); assert.equal(r.status, 400);
    r = await call("bruno2", "POST", "/api/login", { email: "bruno@exemplo.com", senha: "nova-senha-77" }); assert.equal(r.status, 200);
    r = await call("bruno", "GET", "/api/state"); assert.equal(r.status, 401); step("Nova senha funciona, link vale uma vez e sessões antigas caem");

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
    console.error("\nFalhou:", e.message, (e.stack || "").split("\n").find(l => l.includes("e2e.js"))); process.exitCode = 1;
  } finally {
    server.close(); smtpBox?.server.close(); fs.rmSync(dbFile, { force: true }); ["-wal", "-shm"].forEach(s => fs.rmSync(dbFile + s, { force: true }));
    setTimeout(() => process.exit(), 50);
  }
})();
