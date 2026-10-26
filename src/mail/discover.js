// Descobre sozinho o servidor IMAP a partir do e-mail. Ordem: provedores conhecidos pelo domínio,
// provedor da hospedagem pelo registro MX, configuração pública do Thunderbird (ISPDB) e, por fim,
// os nomes mais comuns (imap.dominio, mail.dominio).
const dns = require("node:dns").promises;

// Domínios de e-mail gratuito / provedores brasileiros mais comuns.
const BY_DOMAIN = {
  "gmail.com": { oauth: "gmail", host: "imap.gmail.com" }, "googlemail.com": { oauth: "gmail", host: "imap.gmail.com" },
  "outlook.com": { oauth: "outlook" }, "hotmail.com": { oauth: "outlook" }, "live.com": { oauth: "outlook" }, "msn.com": { oauth: "outlook" },
  "outlook.com.br": { oauth: "outlook" }, "hotmail.com.br": { oauth: "outlook" }, "live.com.br": { oauth: "outlook" },
  "yahoo.com": { host: "imap.mail.yahoo.com", appPassword: true }, "yahoo.com.br": { host: "imap.mail.yahoo.com", appPassword: true },
  "ymail.com": { host: "imap.mail.yahoo.com", appPassword: true }, "rocketmail.com": { host: "imap.mail.yahoo.com", appPassword: true },
  "icloud.com": { host: "imap.mail.me.com", appPassword: true }, "me.com": { host: "imap.mail.me.com", appPassword: true }, "mac.com": { host: "imap.mail.me.com", appPassword: true },
  "uol.com.br": { host: "imap.uol.com.br" }, "bol.com.br": { host: "imap.bol.com.br" }, "terra.com.br": { host: "imap.terra.com.br" },
  "ig.com.br": { host: "imap.ig.com.br" }, "zoho.com": { host: "imap.zoho.com" }, "zohomail.com": { host: "imap.zoho.com" },
  "aol.com": { host: "imap.aol.com", appPassword: true }, "gmx.com": { host: "imap.gmx.com" }, "proton.me": { bridge: true }, "protonmail.com": { bridge: true }
};
// Hospedagem identificada pelo MX do domínio da empresa.
const BY_MX = [
  [/(google|googlemail)\.com$/i, { oauth: "gmail", host: "imap.gmail.com" }],
  [/(outlook\.com|office365\.com|protection\.outlook\.com)$/i, { oauth: "outlook" }],
  [/locaweb\.com\.br$/i, { host: "email-ssl.com.br" }],
  [/titan\.email$/i, { host: "imap.titan.email" }],
  [/hostinger\.(com|com\.br|io)$/i, { host: "imap.hostinger.com" }],
  [/zoho\.(com|eu|in)$/i, { host: "imap.zoho.com" }],
  [/kinghost\.net$/i, { host: "imap.kinghost.net" }],
  [/(uhserver|uolhost)\.com(\.br)?$/i, { host: "imap.uhserver.com" }],
  [/yahoodns\.net$/i, { host: "imap.mail.yahoo.com", appPassword: true }],
  [/icloud\.com$/i, { host: "imap.mail.me.com", appPassword: true }],
  [/mailgun|sendgrid|amazonses/i, null]
];

async function ispdb(domain) {
  try {
    const ctl = AbortSignal.timeout(6000);
    const res = await fetch(`https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`, { signal: ctl });
    if (!res.ok) return null;
    const xml = await res.text();
    const block = (xml.match(/<incomingServer type="imap">([\s\S]*?)<\/incomingServer>/g) || [])
      .map(b => ({ host: (b.match(/<hostname>([^<]+)<\/hostname>/) || [])[1], port: Number((b.match(/<port>(\d+)<\/port>/) || [])[1]), sock: (b.match(/<socketType>([^<]+)<\/socketType>/) || [])[1] }))
      .find(b => b.host && (b.sock === "SSL" || b.sock === "STARTTLS"));
    return block ? { host: block.host.replace("%EMAILDOMAIN%", domain), port: block.port || (block.sock === "SSL" ? 993 : 143), secure: block.sock === "SSL" } : null;
  } catch { return null; }
}

async function mxHosts(domain) {
  try { return (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map(m => m.exchange.toLowerCase()); }
  catch { return []; }
}

// Resultado: { domain, oauth?: "gmail"|"outlook", candidates: [{host,port,secure}], appPassword?, bridge?, source }
async function discover(email) {
  const domain = String(email).split("@")[1]?.toLowerCase().trim();
  if (!domain) throw new Error("E-mail inválido.");
  const add = (list, c) => { if (!c?.host) return; const n = { port: 993, secure: true, ...c }; if (!list.some(x => x.host === n.host && x.port === n.port)) list.push(n); };
  const candidates = [];
  let info = BY_DOMAIN[domain], source = info ? "dominio" : null;
  if (!info) {
    const mx = await mxHosts(domain);
    for (const h of mx) { const hit = BY_MX.find(([re]) => re.test(h)); if (hit && hit[1]) { info = hit[1]; source = "mx"; break; } }
    if (!info) {
      const auto = await ispdb(domain) || (mx[0] ? await ispdb(mx[0].split(".").slice(-2).join(".")) : null);
      if (auto) { add(candidates, auto); source = "thunderbird"; }
    }
  }
  if (info?.host) add(candidates, { host: info.host });
  // Tentativas comuns de hospedagem própria (cPanel, Plesk etc.), só quando o provedor não é conhecido.
  if (!info?.host) for (const h of [`imap.${domain}`, `mail.${domain}`]) { add(candidates, { host: h }); add(candidates, { host: h, port: 143, secure: false }); }
  return { domain, oauth: info?.oauth || null, appPassword: !!info?.appPassword, bridge: !!info?.bridge, candidates, source: source || "tentativa" };
}

module.exports = { discover, BY_DOMAIN };
