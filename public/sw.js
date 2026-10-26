// GENCO IA — service worker: permite instalar o app e abrir a tela mesmo sem internet.
// Os dados (e-mails, pendências) nunca ficam guardados aqui: tudo que é /api vai sempre direto ao servidor.
const VERSION = "genco-ia-v3"; // troque a cada mudança grande nas telas
const SHELL = ["/app", "/", "/quem", "/styles.css", "/app.js", "/grupos.js", "/auth.js", "/quem.js", "/offline.html",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/favicon.ico", "/brand/genco-escuro.png", "/brand/genco-branco.png"];

self.addEventListener("install", ev => {
  ev.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", ev => {
  const req = ev.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/oauth/")) return; // nunca guarda dados
  // Rede primeiro (sempre a versão mais nova); sem internet, usa a cópia da tela.
  ev.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(url.pathname === "/app" ? "/app" : req, copy)); }
    return res;
  }).catch(async () => {
    const isApp = url.pathname === "/app" || url.pathname === "/app/";
    const hit = await caches.match(isApp ? "/app" : req, { ignoreSearch: isApp });
    return hit || (req.mode === "navigate" ? caches.match("/offline.html") : Response.error());
  }));
});
