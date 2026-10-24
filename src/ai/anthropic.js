// Provedor Anthropic (Claude) via API REST.
const config = require("../config");

const MODEL = () => config.ai.model || "claude-sonnet-5-5";

async function call(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.ai.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("IA (Anthropic): " + (d.error?.message || res.status));
  return d;
}

// Laço de ferramentas: a IA pode chamar as funções do app várias vezes antes de responder.
async function run({ system, messages, tools, maxRounds = 6, maxTokens = 4096 }) {
  const msgs = messages.map(m => ({ role: m.role, content: m.content }));
  const defs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const usage = { input: 0, output: 0 };
  let text = "";
  for (let round = 0; round < maxRounds; round++) {
    const d = await call({ model: MODEL(), max_tokens: maxTokens, system, messages: msgs, tools: defs });
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
  return { text: text.trim(), usage, model: MODEL() };
}

async function extractPdf(base64) {
  const d = await call({
    model: MODEL(), max_tokens: 4000,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: "Transcreva o conteúdo útil deste documento em texto simples (números, quantidades, valores, pesos, partes, datas, descrições). Sem comentários." }
    ] }]
  });
  return { text: (d.content || []).filter(b => b.type === "text").map(b => b.text).join("\n"), usage: { input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 }, model: MODEL() };
}

module.exports = { run, extractPdf, ready: () => !!config.ai.anthropicKey };
