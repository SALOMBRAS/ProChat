# Publicar de graça: o que serve e o que não serve

Avaliação de 03/08/2026. **Nada foi implantado.** Complementa
`deploy-avaliacao.md`, que decidiu a arquitetura; aqui a pergunta é onde ela cabe
sem custo.

Preços e termos de free tier mudam com frequência: os valores abaixo são
**estimativas de ordem de grandeza, não verificadas nesta data**. O que está
medido é o consumo do ChatPro, e esse é o número que decide.

---

## 1. O que o ChatPro exige, medido

| exigência | valor | por que é inegociável |
|---|---|---|
| **Memória para o Chromium da WAHA** | **~4 GB, em repouso** | 3 amostras: 4,13 / 4,13 / 3,94 GiB, com CPU a 1,3% |
| **API + worker** | ~150 MB + ~125 MB | processos Node |
| **Processo persistente** | contínuo | relógio de SLA a cada 60 s, limpeza de anexos, WebSocket |
| **Disco que sobrevive a restart** | dois caminhos | `.sessions` da WAHA e `CHATPRO_DATA_DIR` do worker |

Os ~4 GB são do **engine WEBJS**, que roda um Chromium de verdade. É o número que
elimina a maioria dos free tiers — não a CPU, que fica quase ociosa.

### Arquitetura da imagem: o detalhe que quase inverteu a recomendação

A tag em uso, `devlikeapro/waha:latest-2026.7.1`, é **`linux/amd64` e só**. Isso
parecia matar qualquer VPS ARM — inclusive o free tier mais generoso que existe.

Mas o projeto publica variantes ARM sob outro nome, e a mesma versão existe:

```
devlikeapro/waha:arm-2026.7.1   →  linux/arm64   ✅
```

Conferido com `docker manifest inspect`. **Sem essa tag, a recomendação abaixo
seria outra.**

Existem também `gows-*` e `noweb-*` — engines sem navegador, que derrubariam os
4 GB para uma fração. Ficam registradas como possibilidade e **não** como
recomendação: mudar de engine muda a forma do payload, e o entendimento que este
repositório tem do WEBJS (`_data`, `participant`, `from` de grupo, aliases de
sessão) foi construído a duras penas em cima dela. Trocar exigiria refazer essa
validação inteira.

---

## 2. As opções

### ✅ Oracle Cloud — Always Free (ARM Ampere A1)

**4 vCPU / 24 GB, permanente.** É a única da lista em que os 4 GB do Chromium
cabem com folga — sobram 20 GB.

| | |
|---|---|
| **Hiberna?** | **Não.** VM comum, roda continuamente |
| **Disco** | 200 GB de block storage, persistente |
| **Arquitetura** | ARM — exige a tag `arm-2026.7.1` |
| **Custo quando o free acabar** | **não acaba**: é "Always Free", não um teste |

**As pegadinhas, que são reais:**

- **Capacidade de A1 é escassa.** É comum receber "out of capacity" por dias ou
  semanas ao tentar criar a instância, dependendo da região. Escolher a região
  com menos disputa importa mais que a proximidade.
- **A Oracle recupera instância Always Free ociosa.** O critério publicado gira
  em torno de CPU muito baixa por semanas. O ChatPro fica em ~1,3% de CPU em
  repouso — **é exatamente o perfil de risco.** Mitigação: manter alguma carga
  real ou aceitar a possibilidade de recriar a VM. **Não identificado** se o
  critério atual continua o mesmo.
- **Exige cartão de crédito** para verificação, mesmo sem cobrança.
- **Upgrade acidental para pago** é possível se você exceder os limites; dá para
  travar mantendo a conta como Always Free.

### ❌ Fly.io

**Descartada por memória e por hibernação.**

O modelo atual não tem um "free tier" no sentido antigo — há crédito/alocação
pequena e cobrança por uso. Uma máquina com 4 GB de RAM contínuos é **serviço
pago**, e não barato. Além disso, o padrão da plataforma é **`auto_stop_machines`**:
a máquina dorme sem tráfego. Dá para desligar isso, mas aí você paga a máquina
ligada 24/7 — que é o oposto de "de graça".

Volumes persistentes existem e funcionam, então o problema não é o disco: é o
preço dos 4 GB e o fato de que desligar a hibernação remove o que a tornava
barata.

### ❌ Railway

**Descartada por custo contínuo.**

O free tier antigo virou crédito de teste; o plano de entrada é mensal e cobra
por uso de recurso. **4 GB de RAM rodando o mês inteiro consome o crédito de
entrada em poucos dias** — a conta não fecha em "de graça". A plataforma é boa e
o `docker-compose` mapeia bem para ela, mas não para este orçamento.

### ❌ Render (free), Koyeb (free), Heroku

**Descartadas por hibernação**, e vale explicar o que isso quebra aqui, porque
não é só lentidão no primeiro acesso:

1. **O relógio de SLA para.** O `setInterval` de 60 s é quem promove conversa a
   `expired`. Máquina dormindo = nenhuma conversa vence, e o painel passa a
   afirmar que está tudo dentro do prazo. **É mentira silenciosa**, não
   indisponibilidade visível.
2. **O webhook cai no vazio.** A WAHA entrega a mensagem por HTTP no momento em
   que ela chega. Se a API está dormindo, a entrega falha — e a WAHA registra
   isso do lado dela, não do seu. **Mensagem recebida e perdida, sem rastro na
   base.** Este repositório já tem o precedente de 10.372 eventos descartados
   sem sintoma visível.
3. **A sessão do WhatsApp cai.** O Chromium da WAHA mantém a conexão aberta.
   Dormir derruba, e reconectar nem sempre é automático.

Free tier que dorme é incompatível com um sistema cujo trabalho é **receber**,
não responder.

### ⚠️ Outras que considerei

- **Google Cloud e AWS free tier**: são de 12 meses, não permanentes, e a camada
  sempre-gratuita (e2-micro / t2.micro) tem **1 GB de RAM** — um quarto do
  necessário. Quando os 12 meses acabam, vira cobrança cheia.
- **Azure**: mesma forma, 12 meses.
- **PaaS de contêiner com free tier** (Koyeb, Northflank, Zeabur): as camadas
  gratuitas ficam entre 512 MB e 1 GB. Nenhuma acomoda 4 GB.
- **Máquina na sua própria rede** (a que já existe): custo zero de verdade,
  e o obstáculo não é técnico — é IP dinâmico, energia e o fato de que expor à
  internet esbarra no mesmo problema de autenticação da seção 5.

---

## 3. Quadro

| opção | 4 GB? | hiberna? | disco persistente? | custo quando o free acaba |
|---|---|---|---|---|
| **Oracle Always Free (ARM)** | ✅ 24 GB | ❌ não | ✅ 200 GB | **não acaba** |
| Fly.io | 💰 pago | ⚠️ padrão sim | ✅ volumes | ~US$ 25–40/mês |
| Railway | 💰 pago | ❌ não | ✅ volumes | ~US$ 20–40/mês |
| Render free | ❌ | ✅ sim | ❌ efêmero | n/a |
| GCP/AWS free 12m | ❌ 1 GB | ❌ não | ✅ | cobrança cheia após 12 meses |

**O que acontece com os dados quando o free acaba**, por plataforma: em todas as
pagas, a cobrança começa e nada é apagado enquanto você pagar. Se a conta ficar
inadimplente, o padrão do setor é **suspender e depois destruir volumes** — em
geral com aviso, em janelas de dias a semanas. Na Oracle o risco é outro e mais
sorrateiro: **recuperação por ociosidade**, que destrói a instância e o boot
volume. Em ambos os casos, o que salva é o mesmo: **o Supabase guarda conversas,
mensagens e contatos; o volume guarda só sessão e o mapa de aliases.** Perder o
volume custa um QR novo e o reconhecimento das sessões antigas — não o
histórico.

---

## 4. Recomendação e passo a passo

**Oracle Cloud Always Free, ARM Ampere A1, com a tag `arm-*` da WAHA.** É a única
que atende os quatro requisitos sem custo, e a única cujo "grátis" não tem prazo.

### O que cai no seu colo

1. **Criar a conta Oracle Cloud** (cartão de crédito para verificação; não há
   cobrança no Always Free). Escolher a **região** — e aqui vale pesquisar qual
   tem capacidade A1 disponível antes de decidir, porque migrar depois é recriar.
2. **Criar a instância**: shape `VM.Standard.A1.Flex`, 4 OCPU / 24 GB, imagem
   Ubuntu LTS. Se der "out of capacity", tentar de novo em outra hora ou região.
3. **Guardar a chave SSH** que a Oracle gera na criação.
4. **Decidir o acesso** (ver seção 5): enquanto não houver autenticação, nada de
   porta aberta. O caminho mais simples é **Tailscale** ou um túnel SSH.
5. **Me passar**: IP da instância, usuário SSH, e se optou por Tailscale.

### O que cai no meu

6. Adaptar o `deploy/docker-compose.prod.yml` para ARM — trocar a imagem para
   `devlikeapro/waha:arm-2026.7.1` e conferir se as imagens Node que construímos
   compilam em arm64 (o `better-sqlite3` compila do fonte no `npm ci`, então deve
   ir, mas **não foi testado em ARM**).
7. Escrever o procedimento de provisionamento: Docker, firewall, volumes,
   `.env.prod` com permissão 600.
8. Subir, parear a sessão com **um número descartável** e rodar as três
   conferências que ficaram pendentes: webhook com mensagem real, mídia, e
   `restart waha` sem pedir QR.
9. Configurar backup dos dois volumes.

### O que precisa ser decidido antes, e não é técnico

Qual número de WhatsApp. Parear o de produção numa instância nova consome um dos
quatro slots de dispositivo e reabre o risco de duas sessões no mesmo número —
que é exatamente o que causou o incidente dos aliases.

---

## 5. Autenticação: publicar hoje **não é seguro**

Direto: **não**. E não é "pouco seguro", é ausente.

- `middleware/context.ts:12` lê o workspace do header `x-workspace-id`, cru. O
  401 só dispara se ele **faltar** ou não casar com o formato.
- A API fala com o Supabase pela `SUPABASE_SERVICE_ROLE_KEY`, que **ignora RLS
  por definição**.
- RLS está habilitada em 4 tabelas, todas de contato. **Não está** em
  `conversations`, `whatsapp_messages`, `contacts`,
  `conversation_kanban_state`, `workspace_sla_config` nem
  `waha_webhook_events`.

Quem descobrir que o workspace se chama `default-workspace` lê todas as
conversas, todas as mensagens, todos os contatos — e **envia mensagem pelo
WhatsApp da empresa**. Um IP público é encontrado por varredura em horas, não em
meses.

### O mínimo aceitável, em duas camadas

**Camada 1 — antes de qualquer publicação, e é barata:** não exponha porta
nenhuma à internet. Concretamente:

- **Tailscale** (ou WireGuard) na instância e nas máquinas de quem usa. O
  dashboard responde só na rede privada. Custo zero, meia hora de configuração,
  e resolve *hoje*.
- Alternativa mais simples ainda: **túnel SSH** por sessão de uso.

Isso não é autenticação — é contenção. Mas transforma "qualquer um na internet"
em "quem tem credencial de VPN", o que já é uma fronteira real.

**Camada 2 — antes de abrir à internet, e é trabalho de dias:** autenticação de
verdade, com o `workspaceId` **derivado do token**, nunca do header. Enquanto o
`workspaceId` vier do cliente, qualquer sessão pode se declarar de outro
workspace, e nenhuma outra proteção fecha esse buraco.

Só **depois** da camada 2 vale habilitar RLS: com `service_role` no caminho, ela
não protege nada. E aí vira mudança de arquitetura — a API precisa passar a falar
com o banco por credencial de usuário —, não uma migration.

### A recomendação prática

Suba na Oracle **com Tailscale e sem porta pública**. Isso já tira o sistema da
sua máquina, que era o objetivo, e não cria exposição nova. A autenticação vira o
próximo trabalho, com o sistema já rodando e sem pressa de prazo.

---

## 6. O que esta avaliação não determinou

- **Preços atuais**: nenhum foi verificado hoje. Os números da seção 3 são de
  ordem de grandeza.
- **Se o critério de recuperação por ociosidade da Oracle continua o mesmo**, e
  se ~1,3% de CPU o dispara: **não identificado**. É o maior risco da opção
  recomendada.
- **Se as imagens do ChatPro compilam em arm64**: **não testado**. O
  `better-sqlite3` compila do fonte, o que costuma bastar, mas costume não é
  medição.
- **Se a sessão WEBJS restaura num host de arquitetura diferente**: **não
  identificado** — e é relevante se um dia houver migração entre amd64 e ARM.
- **Consumo de memória dos engines `gows` e `noweb`**: não medido. Se um dia a
  troca de engine for considerada, esse número é o primeiro a levantar.
