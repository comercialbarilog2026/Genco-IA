// Entrada pelo e-mail do grupo: cada pessoa escolhe quem é (membros entram direto; gestores confirmam com a própria senha).
(() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const initials = s => String(s || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  let D = null, chosen = null;
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 && method === "GET") { location.href = "/"; throw new Error(""); }
    if (!r.ok) throw new Error(d.error || "Algo deu errado. Tente de novo.");
    return d;
  }
  async function choose(m, senha) {
    const d = await api("POST", "/api/group-login/choose", { user_id: m.id, senha });
    location.href = "/app?grupo=" + d.grupo;
  }
  function render() {
    $("qCap").textContent = `${D.company} · Grupo ${D.group.name}${D.group.address ? " · " + D.group.address : ""}`;
    $("qGrid").innerHTML = D.members.length
      ? D.members.map(m => `<button type="button" class="qperson" data-id="${m.id}"><span class="av lg">${esc(initials(m.name))}</span><b>${esc(m.name)}</b><span>${esc(m.regra || "Atende e-mails do grupo")}</span></button>`).join("")
      : `<p class="muted">Ainda não há pessoas neste grupo. Peça ao gestor para conectar o e-mail do grupo: a GENCO IA encontra as pessoas automaticamente.</p>`;
    $("qGrid").querySelectorAll("[data-id]").forEach(b => b.onclick = async () => {
      const m = D.members.find(x => x.id === Number(b.dataset.id)); $("qErr2").textContent = "";
      if (!m.needsPassword) { try { await choose(m); } catch (e) { $("qErr2").textContent = e.message; } return; }
      chosen = m; $("qGrid").hidden = true; $("qPass").hidden = false;
      $("qPassTxt").innerHTML = `<b>${esc(m.name)}</b>, você tem perfil de gestão. Confirme com a sua senha pessoal.`;
      $("qSenha").focus();
    });
  }
  $("qPass").onsubmit = async ev => {
    ev.preventDefault(); $("qErr").textContent = "";
    try { await choose(chosen, $("qSenha").value); } catch (e) { $("qErr").textContent = e.message; }
  };
  $("qBack").onclick = () => { chosen = null; $("qPass").hidden = true; $("qGrid").hidden = false; $("qSenha").value = ""; };
  $("bOut").onclick = async () => { try { await api("POST", "/api/logout"); } catch {} location.href = "/"; };
  api("GET", "/api/group-login").then(d => { D = d; render(); }).catch(e => { if (e.message) $("qErr2").textContent = e.message; });
})();
