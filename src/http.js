// Mini-roteador HTTP sem dependências: rotas, JSON, cookies e arquivos estáticos.
const fs = require("node:fs");
const path = require("node:path");

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

function parseCookies(header = "") {
  const out = {};
  header.split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new HttpError(413, "Conteúdo grande demais.")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, re, keys, handler, opts });
  };
  const router = {
    get: (p, h, o) => add("GET", p, h, o), post: (p, h, o) => add("POST", p, h, o),
    put: (p, h, o) => add("PUT", p, h, o), delete: (p, h, o) => add("DELETE", p, h, o),
    async handle(req, res, ctx) {
      const url = new URL(req.url, "http://x");
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re); if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const raw = ["POST", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : Buffer.alloc(0);
        let body = {};
        if (raw.length && !r.opts.raw) {
          if (!(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "Envie JSON.");
          try { body = JSON.parse(raw.toString("utf8")); } catch { throw new HttpError(400, "JSON inválido."); }
        }
        const cookies = parseCookies(req.headers.cookie);
        await r.handler({ req, res, url, params, body, raw, cookies, query: Object.fromEntries(url.searchParams), ...ctx });
        return true;
      }
      return false;
    }
  };
  return router;
}

function send(res, status, data, headers = {}) {
  if (res.headersSent) return;
  const isJson = typeof data !== "string" && !Buffer.isBuffer(data);
  res.writeHead(status, { "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", ...headers });
  res.end(isJson ? JSON.stringify(data) : data);
}
const redirect = (res, location, headers = {}) => { res.writeHead(302, { Location: location, ...headers }); res.end(); };

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
function serveStatic(root, req, res) {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  if (p === "/app" || p === "/app/") p = "/app.html";
  if (p === "/convite" || p === "/redefinir") p = "/index.html";
  if (p === "/quem") p = "/quem.html";
  const file = path.normalize(path.join(root, p));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"
};

module.exports = { createRouter, send, redirect, serveStatic, HttpError, SECURITY_HEADERS };
