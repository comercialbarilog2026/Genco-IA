// Caixas de demonstração (e-mails fictícios) e regras de exemplo por setor.
const PADRAO = () => ({
  team: [
    { id: "m1", nome: "Analista Marítimo", regra: "Processos marítimos com chegada em Santos: chegada de navio, presença de carga, registro da declaração, canal, liberação e retirada do contêiner." },
    { id: "m2", nome: "Analista Aéreo", regra: "Processos aéreos (Viracopos e Guarulhos), amostras, courier e cargas urgentes por avião." },
    { id: "m3", nome: "Analista Documental", regra: "Conferência de invoice, packing list, BL/AWB e certificado de origem; pedidos de correção de documentos ao cliente ou exportador." },
    { id: "m4", nome: "Analista de Anuências", regra: "LPCO e órgãos anuentes: MAPA/SIF, Anvisa, Inmetro, Ibama; certificados sanitários e exigências desses órgãos." },
    { id: "m5", nome: "Analista Fiscal", regra: "Exigências da Receita Federal, canal amarelo e vermelho, retificações, impostos, numerário e armazenagem/free time." }
  ],
  coord: "Coordenação do Operacional",
  atraso: 4,
  urg: "Urgente: canal vermelho ou amarelo, exigência fiscal com prazo, free time ou armazenagem vencendo em até 48h, carga perecível parada, LPCO em exigência, cliente cobrando pela segunda vez.\nAlta: documentos com divergência antes do registro, solicitação de numerário para pagar tributos, chegada de navio nos próximos 3 dias.\nNormal: status de processo, agendamentos, pré-alertas.\nBaixa: informativos e newsletters, sem ação.",
  tom: "Português formal e cordial, direto ao ponto. Tratar o cliente pelo nome quando houver. Assinar como:\nEquipe Operacional\nBRCOMEXX Assessoria Aduaneira"
});

const EXEMPLOS = [
  { id: "e1", fromName: "Marcos Tavares", from: "marcos@pescadosatlantico.com.br", hoursAgo: 27, replied: false,
    subject: "Container MSCU 482190-3 – previsão de liberação?",
    body: "Bom dia,\n\nO contêiner MSCU 482190-3 (merluza congelada, BL MEDUA8834521) atracou em Santos na segunda. Até agora não recebi retorno sobre o registro. Preciso dar uma previsão para o meu cliente que está aguardando a mercadoria para o fim de semana.\n\nConseguem me passar o status hoje?\n\nAtt,\nMarcos Tavares\nPescados Atlântico" },
  { id: "e2", fromName: "Terminal Santos Brasil", from: "atendimento@terminalexemplo.com.br", hoursAgo: 3, replied: false,
    subject: "Aviso de vencimento de free time – MSCU 482190-3",
    body: "Prezados,\n\nInformamos que o período de armazenagem livre (free time) do contêiner reefer MSCU 482190-3 vence em 26/10 às 23h59. Após essa data será cobrada armazenagem do 2º período conforme tabela vigente, além de energia de reefer por dia.\n\nPara agendamento de retirada, utilize o portal do terminal.\n\nAtenciosamente,\nCentral de Atendimento" },
  { id: "e3", fromName: "Notificação Siscomex (encaminhado)", from: "robo.siscomex@brcomexx.com.br", hoursAgo: 1.5, replied: false,
    subject: "FW: DUIMP 26BR0001234567 parametrizada – CANAL VERMELHO",
    body: "Mensagem automática encaminhada pelo sistema interno.\n\nDUIMP: 26BR0001234567\nImportador: Pescados Atlântico Ltda.\nRecinto: Santos\nResultado da parametrização: VERMELHO\n\nA declaração foi selecionada para conferência documental e física. Aguardar distribuição para auditor fiscal." },
  { id: "e4", fromName: "Fabiana Rocha", from: "fabiana@lanobrasil-exemplo.com.br", hoursAgo: 6, replied: false,
    subject: "Documentos do embarque – filé de tilápia (EXPOL)",
    body: "Olá, boa tarde.\n\nSeguem os documentos do embarque que chega dia 30/10. Podem conferir para não termos problema no registro?\n\nObrigada,\nFabiana",
    attachments: [
      { name: "Invoice_EX-2291.pdf", text: "COMMERCIAL INVOICE EX-2291\nExporter: Aquavida Foods Co., Vietnam\nProduct: Frozen tilapia fillet IQF, 5-7oz\nQuantity: 2.400 cartons x 10 kg\nNet weight: 24.000 kg\nGross weight: 25.680 kg\nUnit price: USD 3.10/kg FOB\nTotal FOB: USD 74.400,00\nIncoterm: FOB Ho Chi Minh" },
      { name: "PackingList_EX-2291.pdf", text: "PACKING LIST EX-2291\nTotal: 2.380 cartons\nNet weight: 23.800 kg\nGross weight: 25.680 kg\nContainer: TGHU 771204-6 (40' RF)" },
      { name: "BL_HCMSSZ00918.pdf", text: "BILL OF LADING HCMSSZ00918\nShipper: Aquavida Foods Co.\nConsignee: Franzoni Importação e Exportação Ltda.\nNotify: EXPOL Comércio de Alimentos\nPort of loading: Ho Chi Minh\nPort of discharge: Santos\nDescription: 2.400 cartons frozen tilapia fillet\nGross weight: 25.680 kg\nFreight: Collect" }
    ] },
  { id: "e5", fromName: "SIGVIG / MAPA (encaminhado)", from: "anuencia@brcomexx.com.br", hoursAgo: 20, replied: false,
    subject: "LPCO I2600045871 em exigência – certificado sanitário",
    body: "Encaminho exigência registrada no LPCO I2600045871 (Horta Vitae – alho congelado, China):\n\n\"O número do lote informado no Certificado Fitossanitário não confere com o indicado na fatura comercial. Apresentar certificado retificado ou declaração do exportador.\"\n\nPrazo para cumprimento conforme sistema." },
  { id: "e6", fromName: "Auditor Fiscal (via Portal Único)", from: "notificacao@brcomexx.com.br", hoursAgo: 9, replied: false,
    subject: "Exigência fiscal – DUIMP 26BR0001198820",
    body: "Exigência registrada pela fiscalização na DUIMP 26BR0001198820 (Marconi Foods):\n\n1) Apresentar catálogo técnico ou ficha do produto com composição, para confirmação da classificação fiscal adotada (NCM 0304.89.30).\n2) Apresentar comprovante de pagamento do frete internacional.\n\nPrazo de 30 dias para cumprimento." },
  { id: "e7", fromName: "Barilog Internacional", from: "operacoes@barilog-exemplo.com.br", hoursAgo: 4.5, replied: false,
    subject: "Pré-alerta | MAERSK LIMA 642W | ETA Santos 29/10",
    body: "Prezados,\n\nSegue pré-alerta do embarque:\nNavio: MAERSK LIMA 642W\nETA Santos: 29/10\nContêiner: TGHU 771204-6 (40' reefer)\nCliente: EXPOL\nHBL: BRL-HB-20931\n\nDocumentos originais já liberados (telex release).\n\nAtt,\nOperações Barilog" },
  { id: "e8", fromName: "Rodrigo Marconi", from: "rodrigo@marconifoods-exemplo.com.br", hoursAgo: 30, replied: false,
    subject: "RE: Exigência na DUIMP – cobrando retorno",
    body: "Pessoal, segundo e-mail sobre isso. Ontem pedi para me explicarem a exigência da Receita na nossa DUIMP e o que eu preciso providenciar. Ainda não tive retorno. A mercadoria está parada e tenho pedido para entregar.\n\nRodrigo" },
  { id: "e9", fromName: "Financeiro BRCOMEXX", from: "financeiro@brcomexx.com.br", hoursAgo: 2, replied: false,
    subject: "Numerário pendente – Pescados Atlântico",
    body: "Operacional,\n\nO numerário para pagamento dos tributos da DUIMP 26BR0001234567 (Pescados Atlântico) ainda não foi depositado pelo cliente. Valor solicitado: R$ 186.420,55. Sem o depósito não conseguimos debitar os impostos.\n\nPodem reforçar com o cliente?\n\nFinanceiro" },
  { id: "e10", fromName: "Tainá Lopes", from: "taina@importadorapatagonia-exemplo.com.br", hoursAgo: 5, replied: true,
    subject: "Amostras de camarão – AWB 176-44820915",
    body: "Oi! As amostras de camarão (AWB 176-44820915) chegaram em Viracopos hoje. Vocês já receberam os documentos? Preciso de alguma coisa da minha parte?\n\nTainá" },
  { id: "e11", fromName: "Transportes Rodomar", from: "programacao@rodomar-exemplo.com.br", hoursAgo: 7, replied: false,
    subject: "Agendamento de retirada – reefer",
    body: "Boa tarde,\n\nTemos disponibilidade de cavalo e gerador para retirada de reefer em Santos na terça ou quarta. Assim que a carga for liberada, nos enviem o número do contêiner e o local de entrega para agendarmos.\n\nProgramação Rodomar" },
  { id: "e12", fromName: "Informativo Comex", from: "newsletter@informativo-exemplo.com.br", hoursAgo: 11, replied: false,
    subject: "Boletim semanal: atualizações da TEC e câmbio",
    body: "Confira as principais atualizações da semana: alterações pontuais na Tarifa Externa Comum, comportamento do dólar e agenda de eventos do setor. Leia a edição completa no site." }
];

/* ===== distribuidora (segundo setor de exemplo) ===== */
const PADRAO_DIST = () => ({
  team: [
    { id: "d1", nome: "Atendimento", regra: "Reclamações, dúvidas de clientes, trocas e devoluções, status de pedido." },
    { id: "d2", nome: "Comercial", regra: "Novos clientes, pedidos de tabela de preços, cotações, negociação e pedidos de compra." },
    { id: "d3", nome: "Financeiro", regra: "Boletos, segunda via, cobrança, notas fiscais com erro de valor, pedidos da contabilidade." },
    { id: "d4", nome: "Logística", regra: "Entregas, transportadoras, rotas, atrasos e avarias no transporte." },
    { id: "d5", nome: "Compras", regra: "Fornecedores, reajustes de preço, estoque baixo e reposição." }
  ],
  coord: "Gerência da Distribuidora",
  atraso: 4,
  urg: "Urgente: cliente cobrando pela segunda vez, entrega de cliente grande em risco no dia, nota fiscal ou cobrança com valor errado já emitida, ruptura de estoque de item de alto giro.\nAlta: reajuste de fornecedor com data próxima, divergência entre pedido e nota, novo cliente com potencial de compra recorrente.\nNormal: segunda via de boleto, pedidos de tabela, rotinas da contabilidade.\nBaixa: informativos, agradecimentos, sem ação.",
  tom: "Português cordial e objetivo. Tratar o cliente pelo nome quando houver. Assinar como:\nEquipe de Atendimento\nDistribuidora Vale Verde"
});
const EXEMPLOS_DIST = [
  { id: "v1", fromName: "Juliana Prado", from: "compras@superbomdia-exemplo.com.br", hoursAgo: 26, replied: false,
    subject: "RE: Pedido 48213 – entrega não chegou (2ª cobrança)",
    body: "Bom dia,\n\nEstou escrevendo pela segunda vez. O pedido 48213 estava previsto para ontem e não chegou. Estamos com a gôndola de laticínios vazia nas duas lojas. Preciso de uma posição ainda hoje, senão vou ter que comprar de outro fornecedor.\n\nJuliana Prado\nCompras – Supermercado Bom Dia" },
  { id: "v2", fromName: "Transportes Rota Sul", from: "sac@rotasul-exemplo.com.br", hoursAgo: 2, replied: false,
    subject: "Ocorrência – veículo da rota Campinas",
    body: "Prezados,\n\nO caminhão da rota Campinas (placa ABC1D23) teve pane mecânica na Anhanguera. As entregas desta tarde devem atrasar cerca de 4 horas. Estamos providenciando transbordo.\n\nSAC Rota Sul" },
  { id: "v3", fromName: "Ricardo Menezes", from: "financeiro@padariaestrela-exemplo.com.br", hoursAgo: 5, replied: false,
    subject: "Nota fiscal com valor diferente do pedido",
    body: "Olá,\n\nRecebemos a mercadoria e a nota, mas os valores não batem com o pedido que fizemos com o vendedor. Seguem os dois. Não vamos pagar o boleto até corrigirem.\n\nRicardo",
    attachments: [
      { name: "Pedido_Padaria_Estrela.pdf", text: "PEDIDO DE COMPRA 7781\nCliente: Padaria Estrela\nItem: Queijo muçarela fatiado 1 kg\nQuantidade: 100 un\nPreço unitário: R$ 38,90\nItem: Presunto cozido 1 kg\nQuantidade: 60 un\nPreço unitário: R$ 29,50\nTotal: R$ 5.660,00\nPrazo: 28 dias" },
      { name: "NF_000918.pdf", text: "NOTA FISCAL 000918\nDestinatário: Padaria Estrela\nQueijo muçarela fatiado 1 kg – 120 un x R$ 38,90 = R$ 4.668,00\nPresunto cozido 1 kg – 60 un x R$ 31,20 = R$ 1.872,00\nTotal da nota: R$ 6.540,00\nVencimento: 21 dias" }
    ] },
  { id: "v4", fromName: "Laticínios Serra Azul", from: "comercial@serraazul-exemplo.com.br", hoursAgo: 8, replied: false,
    subject: "Comunicado de reajuste – a partir de 01/11",
    body: "Prezado cliente,\n\nInformamos reajuste médio de 6,5% na linha de queijos a partir de 01/11, devido ao aumento do custo do leite. Pedidos colocados até 31/10 mantêm a tabela atual.\n\nDepartamento Comercial" },
  { id: "v5", fromName: "Sistema ERP", from: "alertas@valeverde-exemplo.com.br", hoursAgo: 1, replied: false,
    subject: "Alerta de estoque mínimo – Muçarela fatiada 1 kg",
    body: "Item: Muçarela fatiada 1 kg\nEstoque atual: 85 un\nEstoque mínimo: 300 un\nGiro médio: 140 un/dia\n\nMensagem automática do sistema." },
  { id: "v6", fromName: "Carla Nunes", from: "carla@bistrocentral-exemplo.com.br", hoursAgo: 6, replied: false,
    subject: "Tabela de preços para restaurante",
    body: "Oi, tudo bem? Abrimos um bistrô no centro e queremos conhecer a linha de vocês (frios, laticínios e congelados). Podem enviar a tabela e as condições para pedido mínimo e entrega?\n\nCarla Nunes – Bistrô Central" },
  { id: "v7", fromName: "Mercado Família", from: "adm@mercadofamilia-exemplo.com.br", hoursAgo: 3, replied: false,
    subject: "Segunda via do boleto – NF 000887",
    body: "Bom dia, perdemos o boleto da NF 000887. Podem enviar a segunda via?\n\nObrigado." },
  { id: "v8", fromName: "Contabilidade Prisma", from: "fiscal@prisma-exemplo.com.br", hoursAgo: 20, replied: false,
    subject: "Documentos fiscais de outubro",
    body: "Prezados,\n\nPara o fechamento de outubro, precisamos das notas de entrada e dos extratos bancários até o dia 05/11.\n\nAtenciosamente,\nDepartamento Fiscal" },
  { id: "v9", fromName: "Pedro Alves", from: "pedro@emporioalves-exemplo.com.br", hoursAgo: 9, replied: true,
    subject: "Obrigado pela entrega rápida",
    body: "Pessoal, só para agradecer: a entrega de ontem chegou antes do combinado e tudo certinho. Abraço, Pedro." },
  { id: "v10", fromName: "Informativo Varejo", from: "news@informativovarejo-exemplo.com.br", hoursAgo: 12, replied: false,
    subject: "Tendências do food service para 2027",
    body: "Confira as tendências do food service para o próximo ano e os eventos do setor. Leia no site." }
];


module.exports = { PADRAO, EXEMPLOS, PADRAO_DIST, EXEMPLOS_DIST };
