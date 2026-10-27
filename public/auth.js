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
  // ---------- entrar com a conta do provedor ----------
  fetch("/api/health").then(r => r.json()).then(h => {
    const off = (el, txt) => { el.classList.add("off"); el.removeAttribute("href"); el.setAttribute("aria-disabled", "true"); el.querySelector("small").textContent = txt; el.onclick = ev => { ev.preventDefault(); $("eSso").textContent = ""; }; };
    if (!h.features?.gmail) off($("ssoGoogle"), "Em breve. Por enquanto, use \"Entrar com outro e-mail\" com uma senha de app do Google.");
    if (!h.features?.outlook) off($("ssoMs"), "Em breve.");
  }).catch(() => {});
  $("ssoOther").onclick = () => { $("fSsoImap").hidden = !$("fSsoImap").hidden; if (!$("fSsoImap").hidden) $("oEmail").focus(); };
  $("oEmail").addEventListener("change", async () => {
    const d = (($("oEmail").value.split("@")[1]) || "").toLowerCase();
    $("oHint").textContent = /^(gmail|googlemail)\./.test(d) ? "Gmail: use uma senha de app (myaccount.google.com > Segurança > Senhas de app), não a senha normal."
      : /^(outlook|hotmail|live|msn)\./.test(d) ? "Outlook/Hotmail: use o botão Entrar com Microsoft."
      : /^(yahoo|ymail|icloud|me|mac|aol)\./.test(d) ? "Este provedor pede uma senha de app, gerada nas configurações de segurança da conta." : "";
  });
  $("fSsoImap").addEventListener("submit", async ev => {
    ev.preventDefault(); $("eSso").textContent = "";
    const btn = $("fSsoImap").querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Conferindo no seu provedor…";
    try {
      const adv = $("oServ").value.trim();
      await post("/api/auth/imap", { email: $("oEmail").value, senha: $("oSenha").value, ...(adv ? { servidor: adv, porta: Number($("oPorta").value) || 993 } : {}) });
      location.href = "/app?conexao=ok";
    } catch (e) {
      $("eSso").textContent = e.message; btn.disabled = false; btn.textContent = "Entrar";
      if (/servidor|avançadas/i.test(e.message)) $("oAdv").open = true;
    }
  });
  const erro = new URLSearchParams(location.search).get("erro");
  if (erro) {
    const msg = { "google-indisponivel": "A entrada com Google ainda não foi ativada neste servidor.", "microsoft-indisponivel": "A entrada com Microsoft ainda não foi ativada neste servidor.", cancelado: "Entrada cancelada.", expirado: "O pedido de entrada expirou. Tente de novo.", provedor: "Não foi possível entrar com o provedor. Tente de novo.", dominio: "A GENCO IA é de uso interno do grupo. Entre com o seu e-mail da empresa." }[erro];
    if (msg) { $("fSsoImap").hidden = true; $("eSso").textContent = msg; $("fSsoImap").hidden = false; $("fSsoImap").querySelector("button[type=submit]").hidden = false; }
    history.replaceState(null, "", "/");
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
  wire($("fSignup"), "eSignup", () => post("/api/signup", { empresa: $("sEmpresa").value, setor: $("sSetor").value, modo: "individual", nome: $("sNome").value, email: $("sEmail").value, senha: $("sSenha").value }));
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
