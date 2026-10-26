// Página inicial: criar conta, entrar e aceitar convite.
(() => {
  const $ = id => document.getElementById(id);
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Algo deu errado. Tente de novo.");
    return d;
  }
  function tab(which) {
    $("fSignup").hidden = which !== "signup"; $("fLogin").hidden = which !== "login"; $("fInvite").hidden = which !== "invite";
    $("fForgot").hidden = which !== "forgot"; $("fReset").hidden = which !== "reset";
    $("tabSignup").setAttribute("aria-pressed", String(which === "signup"));
    $("tabLogin").setAttribute("aria-pressed", String(which === "login"));
    $("seg").hidden = ["invite", "forgot", "reset"].includes(which);
  }
  $("tabSignup").onclick = () => tab("signup");
  $("tabLogin").onclick = () => tab("login");

  // Já logado? vai direto para o app.
  fetch("/api/state").then(r => {
    if (location.search.includes("token=")) return;
    if (r.ok) location.href = "/app";
    // Aparelho que entrou pelo e-mail do grupo: volta direto para "Quem está usando?".
    else fetch("/api/group-login").then(g => { if (g.ok) location.href = "/quem"; }).catch(() => {});
  }).catch(() => {});

  function wire(form, errEl, fn) {
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      const btn = form.querySelector("button[type=submit]"); btn.disabled = true; $(errEl).textContent = "";
      try { const d = await fn(); location.href = d && d.grupo ? "/quem" : "/app"; }
      catch (e) { $(errEl).textContent = e.message; btn.disabled = false; }
    });
  }
  wire($("fSignup"), "eSignup", () => post("/api/signup", { empresa: $("sEmpresa").value, setor: $("sSetor").value, modo: (document.querySelector('input[name="sModo"]:checked') || {}).value, nome: $("sNome").value, email: $("sEmail").value, senha: $("sSenha").value }));
  wire($("fLogin"), "eLogin", () => post("/api/login", { email: $("lEmail").value, senha: $("lSenha").value }));

  $("toForgot").onclick = () => { $("fEmail").value = $("lEmail").value; tab("forgot"); $("fEmail").focus(); };
  $("backLogin").onclick = () => tab("login");
  $("fForgot").addEventListener("submit", async ev => {
    ev.preventDefault(); $("eForgot").textContent = "";
    const btn = $("fForgot").querySelector("button[type=submit]"); btn.disabled = true;
    try { const d = await post("/api/password/forgot", { email: $("fEmail").value }); $("fForgot").querySelector("p").textContent = d.message; btn.hidden = true; }
    catch (e) { $("eForgot").textContent = e.message; btn.disabled = false; }
  });

  const token = new URLSearchParams(location.search).get("token");
  if (token && location.pathname === "/redefinir") {
    tab("reset");
    wire($("fReset"), "eReset", () => post("/api/password/reset", { token, senha: $("rSenha").value }));
  } else if (token) {
    tab("invite");
    fetch("/api/invite/" + encodeURIComponent(token)).then(r => r.json().then(d => ({ ok: r.ok, d }))).then(({ ok, d }) => {
      if (!ok) { $("inviteText").textContent = d.error || "Convite inválido."; $("fInvite").querySelector("button").disabled = true; return; }
      $("inviteText").textContent = `Olá, ${d.name}. Você foi convidado para a equipe da ${d.empresa} na GENCO IA (${d.email}).`;
    });
    wire($("fInvite"), "eInvite", () => post("/api/invite/accept", { token, senha: $("iSenha").value }));
  }
})();
