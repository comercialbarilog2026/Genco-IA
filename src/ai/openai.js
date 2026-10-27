// Provedor OpenAI via API REST (Chat Completions com ferramentas). Mostra que o modelo é substituível.
const config = require("../config");

const MODEL = () => config.ai.model || "gpt-4.1";

async function call(body) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("IA (OpenAI): " + (d.error?.message || res.status));
  return d;
}

async function run({ system, messages, tools, maxRounds = 6, maxTokens = 4096, fast = false }) {
  const model = fast ? (config.ai.fastModel || "gpt-4.1-mini") : MODEL();
  const msgs = [{ role: "system", content: system }, ...messages.map(m => ({ role: m.role, content: m.content }))];
  const defs = tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  const usage = { input: 0, output: 0 };
  let text = "";
  for (let round = 0; round < maxRounds; round++) {
    const d = await call({ model, messages: msgs, tools: defs, max_completion_tokens: maxTokens });
    usage.input += d.usage?.prompt_tokens || 0; usage.output += d.usage?.completion_tokens || 0;
    const m = d.choices?.[0]?.message || {};
    text = m.content || "";
    if (!m.tool_calls?.length) break;
    msgs.push(m);
    for (const c of m.tool_calls) {
      const tool = tools.find(t => t.name === c.function?.name);
      let out;
      try { out = tool ? await tool.execute(JSON.parse(c.function.arguments || "{}")) : { erro: "ferramenta desconhecida" }; }
      catch (e) { out = "Erro: " + e.message; }
      msgs.push({ role: "tool", tool_call_id: c.id, content: typeof out === "string" ? out : JSON.stringify(out) });
    }
  }
  return { text: text.trim(), usage, model };
}

// Leitura de PDF não implementada para este provedor: o anexo segue só com o nome.
async function extractPdf() { return null; }

module.exports = { run, extractPdf, ready: () => !!config.ai.openaiKey };
