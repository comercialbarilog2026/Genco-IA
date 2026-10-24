# GENCO IA

Assistente de e-mails com IA para equipes, com **assinatura própria**. Cada funcionário conecta o próprio Gmail ou Outlook e conversa com a GENCO IA: ela qualifica os e-mails por urgência, indica quem deve cuidar de cada um, confere anexos e deixa respostas prontas como rascunho no próprio e-mail. O gestor vê os indicadores da equipe sem acessar o conteúdo dos e-mails.

O cliente paga apenas a assinatura da GENCO IA. O modelo de IA é contratado pela empresa por API, e esse custo entra no preço da assinatura. Nenhum cliente precisa de conta no Claude, ChatGPT ou similar.

---

## O que já está pronto

| Área | O que faz |
| --- | --- |
| Contas | Cadastro da empresa, login, convite de funcionários por link, perfis (administrador, gestor, membro) |
| Assinatura | Teste grátis (14 dias, sem cartão), checkout e portal do Stripe, cobrança por usuário, bloqueio automático quando a assinatura não está ativa |
| E-mail | Conexão oficial com Gmail e Outlook (OAuth), leitura periódica, marcação de "já respondido", leitura de anexos, rascunhos na mesma conversa, etiquetas/categorias "GENCO IA/…" |
| IA | Conversa em português, qualificação automática dos e-mails novos, rascunhos, conferência de documentos, aprende equipe e critérios pela conversa |
| Troca de modelo | `AI_PROVIDER=anthropic`, `openai` ou `mock` (simulado). Trocar de fornecedor é mudar uma linha do `.env` |
| Gestor | Tela "Equipe" com urgentes, atrasados, respostas prontas e e-mails a qualificar por pessoa |
| Controle de custo | Registro de uso da IA por empresa e usuário, limite mensal de mensagens por usuário |
| Demonstração | Caixas de e-mail fictícias (comércio exterior e distribuição) para testar sem conectar e-mail real |

Tudo roda **sem dependências externas**: só Node.js 22.13 ou superior (banco SQLite nativo, criptografia nativa, chamadas diretas às APIs).

---

## Rodar no computador (teste)

```bash
cp .env.example .env        # deixe AI_PROVIDER=mock para testar sem chave
npm start                   # abre em http://localhost:3000
npm test                    # teste automático de ponta a ponta
```

Crie uma conta, escolha **Caixa de demonstração** e converse. No modo `mock` as respostas são simuladas. Para a IA de verdade, preencha `AI_PROVIDER` e a chave correspondente.

---

## Colocar em produção — passo a passo

### 1. Servidor
Qualquer serviço que rode Node.js ou Docker: Railway, Render, Fly.io, DigitalOcean, AWS, Google Cloud.
- Use o `Dockerfile` incluído, ou `npm start`.
- Monte um **disco persistente** em `/data` (é onde fica o banco).
- Configure um domínio com **https** (ex.: `app.gencoia.com.br`) e coloque em `APP_URL`.
- Gere o `APP_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` e defina `NODE_ENV=production`.

### 2. Inteligência artificial
- Crie a conta da empresa no **Anthropic Console** (console.anthropic.com), gere uma chave de API e defina `AI_PROVIDER=anthropic` e `ANTHROPIC_API_KEY`.
- `AI_MODEL` é opcional (o padrão está em `src/ai/anthropic.js`).
- Para usar outro fornecedor: `AI_PROVIDER=openai` e `OPENAI_API_KEY`.

### 3. Gmail (Google)
1. No Google Cloud Console, crie um projeto e ative a **Gmail API**.
2. Em **Tela de consentimento OAuth**, preencha nome (GENCO IA), logo, domínio, política de privacidade e termos.
3. Em **Credenciais**, crie um **ID do cliente OAuth** do tipo *Aplicativo da Web*, com o redirecionamento `{APP_URL}/oauth/gmail/callback`.
4. Copie para `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.
5. **Importante:** enquanto o app estiver em modo de teste, só os e-mails cadastrados como "usuários de teste" conseguem conectar. Para abrir a clientes, o Google exige a **verificação do app** e, por usar o escopo `gmail.modify`, uma **avaliação de segurança anual feita por empresa credenciada**. Planeje prazo e custo para isso antes de vender.

### 4. Outlook (Microsoft 365)
1. No portal Azure (Microsoft Entra ID), em **Registros de aplicativo**, crie um registro para "contas em qualquer diretório organizacional e contas pessoais".
2. Em **Autenticação**, adicione a plataforma *Web* com o redirecionamento `{APP_URL}/oauth/outlook/callback`.
3. Em **Certificados e segredos**, crie um segredo do cliente.
4. Em **Permissões de API**, adicione do Microsoft Graph (delegadas): `User.Read`, `Mail.ReadWrite`, `offline_access`.
5. Copie para `MICROSOFT_CLIENT_ID` e `MICROSOFT_CLIENT_SECRET`.
6. Para vender a outras empresas, faça a **verificação de publicador**. Algumas empresas clientes exigem que o administrador de TI delas aprove o app.

### 5. Stripe (assinatura)
1. No Dashboard do Stripe, crie o produto **GENCO IA** com um **preço recorrente mensal por usuário** (em BRL). Copie o ID do preço para `STRIPE_PRICE_ID`.
2. Copie a chave secreta para `STRIPE_SECRET_KEY`.
3. Em **Desenvolvedores > Webhooks**, crie um endpoint `{APP_URL}/api/stripe/webhook` com os eventos `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` e `invoice.payment_failed`. Copie o segredo de assinatura para `STRIPE_WEBHOOK_SECRET`.
4. Ative o **Portal do cliente** (Configurações > Faturamento > Portal do cliente) para que o administrador troque cartão, veja faturas e cancele sozinho.
5. Escolha no Stripe os meios de pagamento aceitos e a emissão de recibos. Nota fiscal de serviço (NFS-e) não é emitida pelo Stripe: use o sistema da contabilidade ou uma integração de NFS-e.

A quantidade da assinatura acompanha o número de usuários: convidar ou remover alguém ajusta a cobrança automaticamente, com valor proporcional.

---

## Como o sistema está organizado

```
src/
  server.js        rotas da API, páginas e agendador de leitura
  config.js        lê o .env
  db.js            banco SQLite (empresas, usuários, contas de e-mail, mensagens, qualificações, rascunhos, conversas, uso)
  security.js      senhas (scrypt), sessões, criptografia AES-256-GCM dos tokens de e-mail
  billing.js       Stripe: checkout, portal, webhook, licenças por usuário, liberação de acesso
  agent.js         a GENCO IA: contexto, ferramentas (qualificar, mostrar, rascunhar, equipe, critérios)
  templates.js     regras iniciais por ramo (geral, comércio exterior, distribuição)
  ai/              camada de troca de modelo (anthropic, openai, mock)
  mail/            conectores gmail, outlook e demonstração + orquestração
public/            site, login e aplicativo (conversa, equipe, configurações)
test/e2e.js        teste automático do fluxo completo
```

## Segurança e privacidade
- Tokens de acesso ao e-mail ficam **criptografados** no banco. Senhas usam scrypt.
- A GENCO IA **nunca envia e-mails**: só cria rascunhos e etiquetas.
- Cada usuário vê apenas a própria caixa. O gestor vê números, não conteúdo.
- Pela LGPD, a empresa que vende a GENCO IA é **operadora** dos dados dos clientes, e o fornecedor do modelo de IA é **suboperador**. Inclua isso no contrato, na política de privacidade e nos termos de uso, e revise os termos comerciais do fornecedor de IA sobre retenção de dados.
- Antes de lançar: revisão de segurança por um desenvolvedor, backups diários do banco e monitoramento de erros.

## Próximos passos recomendados para o desenvolvedor
1. Migrar o banco para PostgreSQL quando houver muitos clientes (as tabelas já estão prontas para isso).
2. Fila de processamento para a leitura das caixas, em vez do agendador em memória, se houver centenas de usuários.
3. Resumo diário por e-mail para o gestor (envio por um serviço transacional).
4. Painel lateral dentro do Gmail e do Outlook (add-in), reaproveitando a mesma API.
5. Página de preços, termos de uso e política de privacidade.
6. Recuperação de senha por e-mail.
