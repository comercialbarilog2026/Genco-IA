// Camada de troca de modelo: o resto do app só fala com esta interface.
// Para trocar de fornecedor, mude AI_PROVIDER no .env (anthropic | openai | mock) ou adicione um novo arquivo aqui.
const config = require("../config");
const { run: dbRun, one, now } = require("../db");

const PROVIDERS = { anthropic: require("./anthropic"), openai: require("./openai"), mock: require("./mock") };

function provider() {
  const p = PROVIDERS[config.ai.provider];
  if (!p) throw new Error(`AI_PROVIDER inválido: ${config.ai.provider}`);
  if (!p.ready()) throw new Error(`Chave do provedor de IA "${config.ai.provider}" não configurada no .env.`);
  return p;
}

function recordUsage({ companyId, userId, kind, model, usage }) {
  dbRun("INSERT INTO usage (company_id, user_id, kind, provider, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    companyId, userId || null, kind, config.ai.provider, model || null, usage?.input || 0, usage?.output || 0, now());
}

// Controle de custo: limite mensal de mensagens à IA por usuário.
function monthlyCount(userId) {
  const d = new Date(); const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return one("SELECT COUNT(*) AS n FROM usage WHERE user_id = ? AND kind = 'chat' AND created_at >= ?", userId, start).n;
}

const ready = () => { const p = PROVIDERS[config.ai.provider]; return !!p && p.ready(); };

module.exports = {
  name: () => config.ai.provider,
  ready,
  // fallback: sem chave de IA, a qualificação automática usa regras simples (palavras-chave e função de cada pessoa)
  // para os e-mails já aparecerem separados; a conversa continua avisando que falta a chave.
  async run(opts) { if (opts.allowFallback && !ready()) return PROVIDERS.mock.run(opts); return provider().run(opts); },
  async extractPdf(base64, { companyId, userId } = {}) {
    const p = provider();
    const r = await p.extractPdf(base64);
    if (!r) return null;
    if (companyId) recordUsage({ companyId, userId, kind: "pdf", model: r.model, usage: r.usage });
    return r.text;
  },
  recordUsage, monthlyCount
};
