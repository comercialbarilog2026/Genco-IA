// Carrega o .env (sem dependências) e expõe a configuração do app.
const fs = require("node:fs");
const path = require("node:path");

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = (k, d = "") => (process.env[k] ?? d).trim();
const num = (k, d) => { const n = Number(env(k, String(d))); return Number.isFinite(n) ? n : d; };

const config = {
  appUrl: env("APP_URL", "http://localhost:3000").replace(/\/$/, ""),
  port: num("PORT", 3000),
  secret: env("APP_SECRET"),
  dbPath: env("DATABASE_PATH", path.join(__dirname, "..", "data", "genco-ia.db")),
  ai: {
    provider: env("AI_PROVIDER", "mock").toLowerCase(),
    model: env("AI_MODEL"),
    anthropicKey: env("ANTHROPIC_API_KEY"),
    openaiKey: env("OPENAI_API_KEY"),
    monthlyLimitPerUser: num("AI_MONTHLY_LIMIT_PER_USER", 600)
  },
  google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
  microsoft: { clientId: env("MICROSOFT_CLIENT_ID"), clientSecret: env("MICROSOFT_CLIENT_SECRET") },
  stripe: { secretKey: env("STRIPE_SECRET_KEY"), priceId: env("STRIPE_PRICE_ID"), webhookSecret: env("STRIPE_WEBHOOK_SECRET") },
  // E-mails do próprio sistema (resumo diário, recuperação de senha). Opcional.
  smtp: { host: env("SMTP_HOST"), port: num("SMTP_PORT", 587), secure: env("SMTP_SECURE", "") ? env("SMTP_SECURE") === "true" : num("SMTP_PORT", 587) === 465,
    user: env("SMTP_USER"), pass: env("SMTP_PASS"), from: env("SMTP_FROM") },
  digestHour: num("DIGEST_HOUR", 8),          // hora padrão do resumo diário (horário de Brasília)
  trialDays: num("TRIAL_DAYS", 14),
  // Uso interno (sem cobrança): BILLING=on liga teste grátis e assinatura. Padrão: desligado.
  billing: env("BILLING", "off") === "on",
  // Só e-mails destes domínios podem criar conta (separados por vírgula). Vazio = qualquer domínio.
  allowedDomains: env("ALLOWED_DOMAINS", "").split(/[,\s]+/).map(d => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean),
  syncMinutes: num("SYNC_MINUTES", 15),
  autoTriage: env("AUTO_TRIAGE", "true") !== "false",
  production: env("NODE_ENV") === "production"
};

if (!config.secret || config.secret.length < 32) {
  if (config.production) {
    console.error("APP_SECRET ausente ou curto demais. Defina um segredo com pelo menos 32 caracteres no .env.");
    process.exit(1);
  }
  config.secret = "dev-secret-nao-use-em-producao-0123456789abcdef";
  console.warn("[aviso] APP_SECRET não definido: usando segredo de desenvolvimento. Não use assim em produção.");
}

config.features = {
  gmail: !!(config.google.clientId && config.google.clientSecret),
  outlook: !!(config.microsoft.clientId && config.microsoft.clientSecret),
  stripe: !!(config.stripe.secretKey && config.stripe.priceId),
  billing: config.billing,
  imap: true, // qualquer provedor por IMAP, sem configuração no servidor
  email: !!(env("SMTP_HOST") && env("SMTP_FROM"))
};

module.exports = config;
