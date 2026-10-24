// Modelos de regras por setor. A empresa escolhe um no cadastro e ajusta depois
// (pela tela de configurações ou conversando com a GENCO IA).
const { PADRAO, PADRAO_DIST } = require("./mail/demo-data");

const GERAL = () => ({
  team: [
    { id: "t1", nome: "Atendimento", regra: "Dúvidas e reclamações de clientes, status de pedidos e serviços." },
    { id: "t2", nome: "Comercial", regra: "Novos clientes, propostas, cotações e negociação." },
    { id: "t3", nome: "Financeiro", regra: "Cobranças, boletos, notas fiscais, pagamentos e contabilidade." },
    { id: "t4", nome: "Operações", regra: "Entregas, fornecedores, prazos de execução e logística." }
  ],
  coord: "Gestor da equipe",
  atraso: 4,
  urg: "Urgente: cliente cobrando pela segunda vez, prazo legal ou contratual vencendo em até 48h, cobrança ou documento emitido com erro, problema que para a operação do cliente.\nAlta: proposta ou cotação com data próxima, divergência em documentos, cliente novo com potencial relevante.\nNormal: pedidos de informação, agendamentos, rotinas administrativas.\nBaixa: informativos, newsletters e agradecimentos, sem ação.",
  tom: "Português cordial e profissional, direto ao ponto. Tratar o cliente pelo nome quando houver. Assinar com o nome da pessoa e da empresa."
});

const SECTORS = {
  geral: { nome: "Empresa em geral", descricao: "empresa de serviços ou comércio", docs: "nota fiscal, pedido, contrato, boleto", padrao: GERAL,
    cats: ["Reclamação de cliente", "Pedido de informação", "Comercial/proposta", "Financeiro", "Fornecedor", "Operação/entrega", "Interno", "Informativo"] },
  comex: { nome: "Comércio exterior / despacho aduaneiro", descricao: "empresa de comércio exterior e desembaraço aduaneiro no Brasil", docs: "invoice, packing list, BL/AWB, certificados", padrao: PADRAO,
    cats: ["Canal/parametrização", "Exigência fiscal", "Armazenagem/free time", "Documentação", "Anuência/LPCO", "Chegada de carga", "Numerário/financeiro", "Status para cliente", "Logística/transporte", "Informativo"] },
  distribuicao: { nome: "Distribuição e atacado", descricao: "distribuidora/atacadista que atende varejo e food service", docs: "pedido de compra, nota fiscal, boleto", padrao: PADRAO_DIST,
    cats: ["Reclamação de cliente", "Entrega/logística", "Divergência de pedido ou nota", "Cobrança/boleto", "Novo cliente/comercial", "Fornecedor/compras", "Estoque", "Contabilidade/fiscal", "Informativo"] }
};

function defaultRules(sector, companyName) {
  const s = SECTORS[sector] || SECTORS.geral;
  const r = s.padrao();
  if (sector === "geral" && companyName) r.tom = r.tom.replace("da empresa", `da ${companyName}`);
  return r;
}

module.exports = { SECTORS, defaultRules };
