// GENCO IA como aplicativo instalável (computador e celular): registra o service worker,
// guarda o convite de instalação do navegador e mostra o número de pendências no ícone.
(() => {
  if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  let prompt = null;
  const ua = navigator.userAgent;
  const standalone = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches || navigator.standalone === true;
  const platform = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "ios"
    : /Android/.test(ua) ? "android" : /Mac/.test(ua) ? "mac" : /Win/.test(ua) ? "windows" : "outro";
  const browser = /Edg\//.test(ua) ? "edge" : /SamsungBrowser/.test(ua) ? "samsung" : /Chrome\//.test(ua) ? "chrome" : /Firefox\//.test(ua) ? "firefox" : /Safari\//.test(ua) ? "safari" : "outro";
  const listeners = new Set();
  const notify = () => listeners.forEach(f => { try { f(); } catch {} });
  addEventListener("beforeinstallprompt", e => { e.preventDefault(); prompt = e; notify(); });
  addEventListener("appinstalled", () => { prompt = null; notify(); });

  // Passo a passo quando o navegador não oferece o botão de instalar direto.
  function steps() {
    if (platform === "ios") return browser === "safari"
      ? ["Toque no botão Compartilhar (quadrado com a seta para cima), na barra do Safari.", "Escolha \"Adicionar à Tela de Início\".", "Toque em \"Adicionar\". O ícone da GENCO IA aparece junto dos outros apps."]
      : ["No iPhone e no iPad, abra este endereço no Safari.", "Toque em Compartilhar e escolha \"Adicionar à Tela de Início\"."];
    if (platform === "android") return ["Toque no menu do navegador (⋮), no canto superior direito.", "Escolha \"Instalar app\" ou \"Adicionar à tela inicial\".", "Confirme. O ícone da GENCO IA aparece junto dos outros apps."];
    if (browser === "firefox") return ["O Firefox no computador não instala aplicativos.", "Abra este endereço no Google Chrome ou no Microsoft Edge e use o botão de instalar."];
    if (browser === "safari") return ["No Safari do Mac, abra o menu Arquivo (ou Compartilhar).", "Escolha \"Adicionar ao Dock\"."];
    return [`No ${browser === "edge" ? "Edge" : "Chrome"}, clique no ícone de instalar no fim da barra de endereço (um monitor com uma seta).`, "Ou abra o menu do navegador e escolha \"Instalar GENCO IA\".", "O app abre em janela própria e ganha um ícone na área de trabalho e no menu Iniciar."];
  }

  window.GencoPWA = {
    get installed() { return standalone; },
    get canPrompt() { return !!prompt; },
    platform, browser, steps,
    onChange(f) { listeners.add(f); },
    async install() { if (!prompt) return false; prompt.prompt(); const r = await prompt.userChoice.catch(() => null); prompt = null; notify(); return r?.outcome === "accepted"; },
    badge(n) { try { if (!("setAppBadge" in navigator)) return; n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch {} }
  };
})();
