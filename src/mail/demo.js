// Caixa de demonstração: permite testar o produto inteiro sem conectar um e-mail real.
const { EXEMPLOS, EXEMPLOS_DIST } = require("./demo-data");

const SETS = { comex: EXEMPLOS, distribuicao: EXEMPLOS_DIST, geral: EXEMPLOS_DIST };

// Na demonstração de um grupo, simula as pessoas que respondem pelo grupo (detecção automática).
const DEMO_TEAM = [["Ana Souza", "ana.souza"], ["Bruno Lima", "bruno.lima"], ["Carla Mendes", "carla.mendes"], ["Diego Ramos", "diego.ramos"]];
async function fetchRecent(sector, { knownIds = new Set(), teamDomain = "" } = {}) {
  const base = Date.now();
  const out = (SETS[sector] || EXEMPLOS_DIST).map(e => knownIds.has("demo-" + e.id)
    ? { provider_id: "demo-" + e.id, known: true }
    : {
      provider_id: "demo-" + e.id, thread_id: "demo-t-" + e.id, internet_message_id: `<${e.id}@demo.genco-ia>`,
      from_name: e.fromName, from_addr: e.from, subject: e.subject, body: e.body,
      received_at: base - e.hoursAgo * 3600e3, replied: !!e.replied,
      attachments: (e.attachments || []).map(a => ({ name: a.name, mime: "application/pdf", size: a.text.length, text: a.text }))
    });
  out.teamSeen = teamDomain ? DEMO_TEAM.map(([name, user]) => ({ name, email: `${user}@${teamDomain}` })) : [];
  return out;
}

module.exports = { fetchRecent, createDraft: async () => null, updateDraft: async () => null, applyLabels: async () => {} };
