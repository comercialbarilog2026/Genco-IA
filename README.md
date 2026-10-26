# GENCO IA

Assistente de e-mails com IA para equipes, com **assinatura própria**. Cada funcionário conecta o próprio Gmail ou Outlook e conversa com a GENCO IA: ela qualifica os e-mails por urgência, indica quem deve cuidar de cada um, confere anexos e deixa respostas prontas como rascunho no próprio e-mail. O gestor vê os indicadores da equipe sem acessar o conteúdo dos e-mails.

O cliente paga apenas a assinatura da GENCO IA. O modelo de IA é contratado pela empresa por API, e esse custo entra no preço da assinatura. Nenhum cliente precisa de conta no Claude, ChatGPT ou similar.

---

## O que já está pronto

| Área | O que faz |
| --- | --- |
| Contas | Cadastro da empresa, login, convite de funcionários por link, perfis (administrador, gestor, membro) |
| Assinatura | Teste grátis (14 dias, sem cartão), checkout e portal do Stripe, cobrança por usuário, bloqueio automático quando a assinatura não está ativa |
| E-mail | Gmail e Outlook pelo acesso oficial (OAuth) e **qualquer outro provedor por IMAP** (Locaweb, UOL, Hostinger, Titan, Zoho, Yahoo, KingHost, iCloud, domínio próprio), com descoberta automática do servidor; leitura periódica, marcação de "já respondido", leitura de anexos, rascunhos na mesma conversa, etiquetas/categorias "GENCO IA/…" |
| IA | Conversa em português, qualificação automática dos e-mails novos, rascunhos, conferência de documentos, aprende equipe e critérios pela conversa |
| Troca de modelo | `AI_PROVIDER=anthropic`, `openai` ou `mock` (simulado). Trocar de fornecedor é mudar uma linha do `.env` |
| Gestor | Tela "Equipe" com urgentes, atrasados, respostas prontas e e-mails a qualificar por pessoa |
| Grupos de e-mail | Caixa compartilhada (ex.: operacional@) atendida por várias pessoas: fila única, dono e situação de cada e-mail, notas internas, histórico, carga por pessoa e atribuição automática pela IA |
| Controle de custo | Registro de uso da IA por empresa e usuário, limite mensal de mensagens por usuário |
| Resumo diário | Nos dias úteis, cada pessoa recebe por e-mail o que está pendente (caixa própria e grupos); o responsável do grupo recebe também a situação de cada pessoa. Horário ajustável ou desligável por pessoa, com prévia no app |
| Senha | "Esqueci minha senha" com link por e-mail (vale 1 hora, uma vez); também serve para quem foi detectado no grupo criar a própria senha |
| Demonstração | Caixas de e-mail fictícias (comércio exterior e distribuição) para testar sem conectar e-mail real |

Tudo roda **sem dependências externas**: só Node.js 22.13 ou superior (banco SQLite nativo, criptografia nativa, chamadas diretas às APIs).

---

## Aplicativo instalável (computador e celular)

A GENCO IA se instala como aplicativo (PWA), direto do endereço do app, sem loja:
- **Windows e Mac:** no Chrome ou no Edge, botão **Instalar app** no topo do app (ou o ícone de instalar na barra de endereço). Ganha ícone na área de trabalho e no menu Iniciar e abre em janela própria.
- **Android:** menu do navegador > **Instalar app**.
- **iPhone e iPad:** no Safari, **Compartilhar > Adicionar à Tela de Início**.
- Em **Configurações > Instalar a GENCO IA** aparece o passo a passo certo para cada aparelho.
- O ícone mostra o número de pendências (o que está com a pessoa ou sem dono), onde o sistema permite (Windows, Mac, Android e iPhone com o app instalado).
- Sem internet, o app abre e avisa que está sem conexão; volta sozinho quando a conexão retorna. Os e-mails nunca ficam guardados no aparelho.
- Atualizações chegam sozinhas: cada nova versão publicada no Render é carregada na próxima abertura. Ao mudar as telas de forma grande, aumente `VERSION` em `public/sw.js`.
- Requisito: o app precisa estar em **https** (o Render já entrega assim).

---

## Para uma pessoa só ou para equipes

No cadastro a empresa escolhe **"Só eu"** (uma pessoa, um e-mail) ou **"Minha equipe"** (e-mail de grupo ou várias pessoas). As duas formas usam a mesma tela **Pendências**:

- **Só eu:** a pessoa conecta o próprio Gmail ou Outlook (inclusive @gmail.com comum) e a IA avisa o que precisa de resposta: o que responder primeiro, respostas prontas para revisar, e-mails importantes do dia e o que está aguardando terceiros. Cada aviso tem os botões **Preparar resposta**, **Resolvido** e **Aguardando terceiros**. Não aparece nada de equipe, grupo ou membros, e a assinatura conta 1 usuário.
- **Minha equipe:** o app começa pedindo para criar o grupo (ex.: operacional@) e funciona como descrito abaixo.
- Quem começou sozinho pode passar a usar com equipe a qualquer momento (**Usar com equipe**), e quem participa de grupo continua com a própria caixa em **Minha caixa**.

---

## Grupos de e-mail (caixa compartilhada)

Para e-mails que chegam num endereço da equipe, como `operacional@empresa.com.br`, atendido por várias pessoas.

**Como funciona**
- O administrador ou gestor cria o grupo na tela **Grupos**, marca os membros e escreve o que cada um cuida (ex.: "Processos marítimos em Santos", "Exigências fiscais e numerário"). Um membro pode ser marcado como responsável pelo grupo.
- A GENCO IA lê os e-mails do grupo, qualifica cada um e **define o dono** pela regra de cada pessoa (pode ser desligado).
- Cada e-mail tem **dono** e **situação**: novo, em andamento, aguardando terceiros ou resolvido. Qualquer membro pode assumir, passar para outra pessoa ou resolver. Tudo fica no histórico.
- **Notas internas**: a equipe comenta o e-mail sem responder ao cliente.
- Filtros: em aberto, meus, sem dono, atrasados, resolvidos e por pessoa. Indicadores do grupo e carga de cada pessoa.
- Na **Conversa**, o seletor no topo troca entre "Minha caixa" e a caixa do grupo. Ex.: "o que está sem dono?", "eu assumo os urgentes", "passa o e-mail do Rodrigo para a Ana".
- Se um e-mail já tem outro dono, a IA avisa antes de preparar resposta, para duas pessoas não responderem a mesma coisa.
- A caixa do grupo **não conta como licença** na assinatura. Quem não é membro (nem administrador ou gestor) não vê o grupo.

**Entrada pelo e-mail do grupo e pessoas detectadas automaticamente**
- Em **Pendências > Configurar**, o gestor cria a **senha do grupo**. A equipe entra no app com o endereço do grupo (ex.: `operacional@brcomexx.com.br`) e essa senha, e escolhe o próprio nome na tela **"Quem está usando?"**. O app abre direto na aba daquela pessoa.
- Membros entram só escolhendo o nome. Administradores e gestores confirmam com a própria senha, para ninguém entrar como gestor pela senha do grupo.
- O app **encontra as pessoas do grupo sozinho**: pelos membros do grupo no Google Workspace (permissão de leitura de grupos pedida ao conectar o Gmail do grupo) e por quem do mesmo domínio responde nas conversas do grupo. Quem o gestor tirar do grupo não volta na próxima busca.
- Pessoas novas entram sem função. O app avisa o gestor para dizer o que cada uma cuida; ao salvar, a IA requalifica o que está sem dono e já divide os e-mails entre elas.
- Cada pessoa detectada passa a contar como usuário na assinatura.
- Para a leitura de membros, ative a **Cloud Identity API** no mesmo projeto do Google Cloud e inclua o escopo `cloud-identity.groups.readonly` na tela de consentimento. A conta conectada precisa poder ver os membros do grupo (configuração do grupo no Google Admin). Sem isso, o app usa só a detecção pelas respostas.

**Como conectar o e-mail do grupo (Google Workspace)**
- **Grupo do Google Groups** (cada membro recebe uma cópia): conecte o Gmail de um dos membros e preencha o **endereço do grupo**. A GENCO IA lê só o que chega para esse endereço (`to`, `cc`, `list`, `deliveredto`) e considera respondido quando alguém da equipe responde na mesma conversa, mesmo pelo próprio e-mail. Os rascunhos ficam no Gmail da conta conectada.
- **Caixa própria** (o endereço tem senha e caixa de entrada): conecte a própria caixa. Nesse caso não é preciso filtro.
- Em "Filtro avançado" dá para usar qualquer busca do Gmail, por exemplo `label:operacional`.
- No Outlook/Microsoft 365, conecte a caixa compartilhada diretamente (o filtro por endereço vale só para Gmail nesta versão).

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

> **O aplicativo é independente.** Ele roda no servidor da empresa (Render), com login próprio, cobrança própria (Stripe) e IA contratada por chave de API no Anthropic Console. Não depende de conta ou assinatura do Claude: o GitHub é só onde o código fica e de onde o Render publica.

### 1. Servidor (Render, direto do GitHub)
1. No Render: **New > Blueprint** e escolha o repositório `Genco-IA`. O arquivo `render.yaml` já cria o serviço, o disco de 5 GB em `/data` e o `APP_SECRET`.
2. O Render pede as chaves marcadas como secretas: `APP_URL` (o endereço do app, ex.: `https://genco-ia.onrender.com`), `ANTHROPIC_API_KEY`, Google, Microsoft e Stripe. Pode deixar Microsoft e Stripe em branco no começo.
3. Cada envio para a branch `main` no GitHub publica uma nova versão automaticamente. Durante a troca de versão o app fica fora do ar por alguns segundos.
4. Banco e cópias: o banco fica no disco `/data`. O Render tira um snapshot do disco por dia (guarda 7 dias) e o próprio app grava uma cópia diária em `/data/backups` (guarda 7 dias).
5. **Não troque o `APP_SECRET` depois de criado**: ele criptografa os acessos ao e-mail e todos teriam de reconectar.

Também roda em qualquer serviço com Node.js ou Docker (Railway, Fly.io, DigitalOcean, AWS, Google Cloud).
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

### Qualquer outro provedor (IMAP) — nada a configurar no servidor
- A pessoa clica em **Outro provedor**, digita o e-mail e a senha. O app descobre o servidor sozinho: provedores conhecidos (UOL, BOL, Terra, Yahoo, iCloud, Zoho…), a hospedagem pelo registro MX do domínio (Locaweb, Titan, Hostinger, KingHost, Google, Microsoft), a configuração pública do Thunderbird e, por fim, `imap.dominio` e `mail.dominio`. Se não achar, pede o servidor em "Configurações avançadas".
- Lê a caixa de entrada, reconhece os respondidos (pasta Enviados e marcação "respondido" do servidor) e grava as respostas na pasta **Rascunhos** da própria conta, na mesma conversa. Nunca envia.
- A senha fica criptografada no banco (AES-256-GCM, com o `APP_SECRET`). Só conexões seguras (SSL/TLS ou STARTTLS) são aceitas.
- Yahoo, iCloud e contas com verificação em duas etapas pedem **senha de app**. Microsoft 365 e Outlook.com não aceitam mais senha por IMAP: use o botão Outlook.
- Funciona também para grupos: conecta a conta de um membro e o app lê só o que foi enviado para o endereço do grupo.
- O cliente IMAP e o leitor de e-mails são próprios (sem dependências) e testados com um servidor IMAP simulado (`test/fake-imap.js`).

### 4. Outlook (Microsoft 365)
1. No portal Azure (Microsoft Entra ID), em **Registros de aplicativo**, crie um registro para "contas em qualquer diretório organizacional e contas pessoais".
2. Em **Autenticação**, adicione a plataforma *Web* com o redirecionamento `{APP_URL}/oauth/outlook/callback`.
3. Em **Certificados e segredos**, crie um segredo do cliente.
4. Em **Permissões de API**, adicione do Microsoft Graph (delegadas): `User.Read`, `Mail.ReadWrite`, `offline_access`.
5. Copie para `MICROSOFT_CLIENT_ID` e `MICROSOFT_CLIENT_SECRET`.
6. Para vender a outras empresas, faça a **verificação de publicador**. Algumas empresas clientes exigem que o administrador de TI delas aprove o app.

### E-mails do sistema (SMTP) — resumo diário e "esqueci minha senha"
1. Use qualquer conta SMTP. Para começar, uma caixa como `nao-responda@suaempresa.com.br` no próprio provedor da empresa resolve (Locaweb, Google Workspace com senha de app, Microsoft 365). Para volume maior, um serviço transacional (SendGrid, Resend, Amazon SES).
2. Preencha `SMTP_HOST`, `SMTP_PORT` (587 com STARTTLS ou 465 com SSL), `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM`.
3. Configure SPF e DKIM do domínio de envio no provedor de DNS, para os resumos não caírem no spam.
4. Sem SMTP, o app funciona normalmente; só ficam desligados o resumo por e-mail e a recuperação de senha (a prévia do resumo continua em Configurações).

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
  agent.js         a GENCO IA: contexto, ferramentas (qualificar, mostrar, rascunhar, equipe, critérios, atribuir, situação, notas)
  groups.js        grupos de e-mail: membros, dono e situação, notas, histórico, atribuição automática, indicadores
  templates.js     regras iniciais por ramo (geral, comércio exterior, distribuição)
  ai/              camada de troca de modelo (anthropic, openai, mock)
  mail/            conectores gmail, outlook, imap (qualquer provedor) e demonstração + orquestração
                   imap-client.js (cliente IMAP), mime.js (leitura de e-mails), discover.js (descoberta do servidor)
public/            site, login e aplicativo (conversa, equipe, configurações)
test/e2e.js        teste automático do fluxo completo
```

## Segurança e privacidade
- Tokens de acesso ao e-mail ficam **criptografados** no banco. Senhas usam scrypt.
- A GENCO IA **nunca envia e-mails**: só cria rascunhos e etiquetas.
- Cada usuário vê apenas a própria caixa. O gestor vê números, não conteúdo das caixas pessoais.
- A caixa de um grupo é visível para os membros do grupo, administradores e gestores, porque é e-mail da empresa atendido em conjunto.
- Pela LGPD, a empresa que vende a GENCO IA é **operadora** dos dados dos clientes, e o fornecedor do modelo de IA é **suboperador**. Inclua isso no contrato, na política de privacidade e nos termos de uso, e revise os termos comerciais do fornecedor de IA sobre retenção de dados.
- Antes de lançar: revisão de segurança por um desenvolvedor, backups diários do banco e monitoramento de erros.

## Próximos passos recomendados para o desenvolvedor
1. Migrar o banco para PostgreSQL quando houver muitos clientes (as tabelas já estão prontas para isso).
2. Fila de processamento para a leitura das caixas, em vez do agendador em memória, se houver centenas de usuários.
4. Painel lateral dentro do Gmail e do Outlook (add-in), reaproveitando a mesma API.
5. Página de preços, termos de uso e política de privacidade.
