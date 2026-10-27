// Provedor Anthropic (Claude) via API REST.
const config = require("../config");

const MODEL = () => config.ai.model || "claude-sonnet-5-5";
const FAST = () => config.ai.fastModel || "claude-haiku-5-5";
const pick = fast => fast ? FAST() : MODEL();
const modelError = e => e.status === 404 || e.type === "not_found_error" || (e.status === 400 && /model/i.test(e.message));

// Limite de uso por minuto (429) ou servidor ocupado (529): espera e tenta de novo, até 3 vezes.
async function call(body, attempt = 0) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.ai.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if ((res.status === 429 || res.status === 529) && attempt < 3) {
    const wait = Math.min(60, Number(res.headers.get("retry-after")) || 10 * (attempt + 1));
    await new Promise(r => setTimeout(r, wait * 1000));
    return call(body, attempt + 1);
  }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("IA (Anthropic): " + (d.error?.message || res.status)), { status: res.status, type: d.error?.type });
  return d;
}
// Modelo rápido indisponível na conta: cai para o modelo principal, sem parar o trabalho.
let fastBroken = false;
async function callModel(body, fast) {
  if (fast && fastBroken) fast = false;
  try { return { d: await call({ ...body, model: pick(fast) }), model: pick(fast) }; }
  catch (e) { if (!fast || !modelError(e)) throw e; fastBroken = true; console.error("[ia] modelo rápido indisponível, usando o principal:", e.message); return { d: await call({ ...body, model: MODEL() }), model: MODEL() }; }
}

// Laço de ferramentas: a IA pode chamar as funções do app várias vezes antes de responder.
async function run({ system, messages, tools, maxRounds = 6, maxTokens = 4096, fast = false }) {
  const msgs = messages.map(m => ({ role: m.role, content: m.content }));
  const defs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const usage = { input: 0, output: 0 };
  let text = "", used = pick(fast);
  for (let round = 0; round < maxRounds; round++) {
    const r = await callModel({ max_tokens: maxTokens, system, messages: msgs, tools: defs }, fast); const d = r.d; used = r.model;
    usage.input += d.usage?.input_tokens || 0; usage.output += d.usage?.output_tokens || 0;
    const texts = (d.content || []).filter(b => b.type === "text").map(b => b.text);
    if (texts.length) text = (text ? text + "\n\n" : "") + texts.join("\n");
    const calls = (d.content || []).filter(b => b.type === "tool_use");
    if (d.stop_reason !== "tool_use" || !calls.length) break;
    msgs.push({ role: "assistant", content: d.content });
    const results = [];
    for (const c of calls) {
      const tool = tools.find(t => t.name === c.name);
      let out, isError = false;
      try { out = tool ? await tool.execute(c.input || {}) : { erro: "ferramenta desconhecida" }; }
      catch (e) { out = "Erro: " + e.message; isError = true; }
      results.push({ type: "tool_result", tool_use_id: c.id, content: typeof out === "string" ? out : JSON.stringify(out), is_error: isError });
    }
    msgs.push({ role: "user", content: results });
    text = ""; // o texto final é o da última rodada
  }
  return { text: text.trim(), usage, model: used };
}

async function extractPdf(base64) {
  const { d, model } = await callModel({
    max_tokens: 4000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Transcreva o conteúdo útil deste documento em texto simples (números, quantidades, valores, pesos, partes, datas, descrições). Sem comentários." }
    ] }]
  }, true);
  return { text: (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"), usage: { input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 }, model };
}

module.exports = { run, extractPdf, ready: () => !!config.ai.anthropicKey };
