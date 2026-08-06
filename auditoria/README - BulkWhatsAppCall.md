# 📞 Wavoip - Sistema de Ligações em Massa com Injeção Automática de Áudio

Um frontend moderno e compacto para **disparar ligações em massa** usando a [API Wavoip](https://wavoip.com/), com sistema de injeção automática de áudio em chamadas WhatsApp.

## 🎯 Objetivo Principal

Este projeto foi desenvolvido para **automatizar ligações em massa** através do WhatsApp, permitindo:
- ✅ **Disparar centenas de ligações** simultaneamente
- ✅ **Injetar áudio personalizado** automaticamente em cada chamada
- ✅ **Gerenciar múltiplos dispositivos** de forma centralizada
- ✅ **Monitorar todas as ligações** em tempo real
- ✅ **Escalar operações** de atendimento e marketing

## 🌟 Sobre o Wavoip

O [Wavoip](https://wavoip.com/) é uma plataforma que transforma a experiência do seu atendimento através de chamadas de voz no WhatsApp. É simples, moderno e oferece uma comunicação no WhatsApp com facilidade de uso, flexibilidade e total personalização para se adaptar às suas necessidades.

### 🚀 **Ideal para Ligações em Massa:**
- ✅ **API robusta** para automação de milhares de ligações
- ✅ **Múltiplas instâncias** simultâneas
- ✅ **Escalabilidade** para grandes volumes
- ✅ **Integração fácil** com sistemas existentes
- ✅ **Monitoramento em tempo real** de todas as operações

### 🚀 **Principais Benefícios:**
- ✅ **Comunicação direta** via WhatsApp Business
- ✅ **API robusta** para integração personalizada
- ✅ **Suporte a chamadas de voz** em tempo real
- ✅ **Flexibilidade total** para adaptação às suas necessidades
- ✅ **Comunidade ativa** e suporte técnico

### 💰 **Planos Disponíveis:**

#### 🆓 **Free**
- ✅ Acesso à comunidade
- ✅ 5 ligações diárias
- ✅ Sem suporte
- 💰 **R$ 0 mensal**

#### 🏢 **Enterprise**
- ✅ Suporte exclusivo
- ✅ Ligações ilimitadas
- ✅ Suporte na implementação da API
- 💰 **Falar com a equipe**

#### 🔄 **Revenda**
- ✅ Somente em grande volume
- ✅ Preço sob demanda
- ✅ Planos dinâmicos
- ✅ Instâncias dedicadas
- 💰 **Falar com a equipe**

### 🔗 **Links Úteis:**
- 🌐 **Site Oficial**: [wavoip.com](https://wavoip.com/)
- 📱 **App Web**: [app.wavoip.com](https://app.wavoip.com/)
- 📦 **NPM Package**: `npm install wavoip-api`
- 👥 **Comunidade**: Junte-se ao grupo oficial

## ✨ Funcionalidades para Ligações em Massa

### 🚀 **Sistema de Disparo em Massa**
- ✅ **Disparo simultâneo** de centenas de ligações
- ✅ **Gerenciamento de múltiplos dispositivos** WhatsApp
- ✅ **Fila inteligente** de ligações com controle de taxa
- ✅ **Distribuição automática** entre dispositivos disponíveis
- ✅ **Retry automático** para ligações que falharam

### 🎯 **Sistema de Injeção Automática de Áudio**
- ✅ **Injeção automática** em todas as ligações sem intervenção manual
- ✅ **Interceptação global** do `getUserMedia` para substituir microfone por áudio MP3
- ✅ **Timing perfeito** - stream preparado antes da chamada ser aceita
- ✅ **Dupla proteção** - interceptação principal + backup direto
- ✅ **Múltiplas estratégias** de injeção funcionando em paralelo

### 📞 **Gerenciamento Avançado de Chamadas**
- ✅ **Inicialização automática** de múltiplos dispositivos Wavoip
- ✅ **Chamadas em lote** para listas de números
- ✅ **Monitoramento em tempo real** de todas as ligações simultâneas
- ✅ **Controle centralizado** - aceitar, rejeitar, finalizar em massa
- ✅ **Relatórios detalhados** de sucesso/falha das ligações

### 🎵 **Sistema de Áudio Avançado**
- ✅ **Upload de arquivos** MP3, WAV, OGG, M4A, AAC
- ✅ **Reprodução automática** quando chamada é aceita
- ✅ **Substituição de microfone** por áudio do arquivo
- ✅ **Múltiplas estratégias** de captura e reprodução
- ✅ **Controle de volume** e qualidade de áudio

### 🎨 **Interface Moderna**
- ✅ **Design glassmorphism** com efeitos de vidro
- ✅ **Layout responsivo** com header dedicado
- ✅ **Interface compacta** otimizada para máxima eficiência
- ✅ **Logs em tempo real** com sistema de cores
- ✅ **Botões de ícone** para ações rápidas

## 🚀 Instalação

### Pré-requisitos
- Node.js 16+ 
- npm ou yarn
- Navegador moderno com suporte a WebRTC

### Instalação
```bash
# Clone o repositório
git clone https://github.com/seu-usuario/wavoip.git
cd wavoip

# Instale as dependências
npm install

# Inicie o servidor de desenvolvimento
npm start
```

O projeto estará disponível em `http://localhost:3000`

### 📦 **Instalação da API Wavoip**
```bash
# Instale o pacote oficial da API
npm install wavoip-api
```

### 🔌 **Exemplo de Uso da API**
```javascript
const Wavoip = require("wavoip-api");
const WAV = new Wavoip;
const whatsapp_instance = WAV.connect("my_token");

whatsapp_instance.socket.on("connect", () => {
  console.log("Successfully connected!");
  whatsapp_instance.callStart({
    whatsappid: "phone_number"
  });
});
```

## 📋 Como Usar para Ligações em Massa

### 1. **Configuração Inicial**
1. **Adicione múltiplos tokens** de dispositivos Wavoip (recomendado: 10+ dispositivos)
2. **Importe lista de números** em massa (CSV, TXT ou adicione manualmente)
3. **Faça upload do áudio** que será reproduzido em todas as ligações

### 2. **Inicialização dos Dispositivos**
1. Clique em **"Inicializar Conexões"** para todos os dispositivos
2. Aguarde todos os dispositivos ficarem **online**
3. Verifique o status na seção "Status dos Dispositivos"

### 3. **Disparo em Massa**
1. **Selecione todos os dispositivos** online disponíveis
2. **Configure a taxa de disparo** (ex: 5 ligações por minuto por dispositivo)
3. **Inicie o disparo em massa** - o sistema distribuirá automaticamente entre dispositivos
4. **Monitore o progresso** em tempo real nos logs

### 4. **Monitoramento Avançado**
- **Dashboard em tempo real** com estatísticas de todas as ligações
- **Status individual** de cada chamada (outcoming_calling → accept → terminate)
- **Relatórios de sucesso/falha** por dispositivo
- **Controle centralizado** para pausar/retomar operações em massa

## 🎯 Casos de Uso para Ligações em Massa

### 📢 **Marketing e Propaganda**
- ✅ **Campanhas promocionais** para milhares de clientes
- ✅ **Anúncios de produtos** com áudio personalizado
- ✅ **Convites para eventos** e lançamentos
- ✅ **Follow-up automático** após compras

### 🏢 **Atendimento ao Cliente**
- ✅ **Suporte proativo** para clientes com problemas
- ✅ **Lembretes de pagamento** e vencimentos
- ✅ **Confirmações de agendamento** em massa
- ✅ **Pesquisas de satisfação** automatizadas

### 💼 **Vendas e Prospecção**
- ✅ **Cold calling** automatizado com áudio profissional
- ✅ **Follow-up de leads** qualificados
- ✅ **Apresentação de produtos** via áudio
- ✅ **Agendamento de reuniões** comerciais

### 🚨 **Comunicação de Emergência**
- ✅ **Alertas de segurança** para funcionários
- ✅ **Avisos importantes** da empresa
- ✅ **Notificações de sistema** críticas
- ✅ **Comunicação de crise** rápida e eficiente

## 🔧 Funcionalidades Técnicas

### **Sistema de Interceptação**
```javascript
// Interceptação global do getUserMedia
navigator.mediaDevices.getUserMedia = async function(constraints) {
  if (constraints.audio && window.currentMP3Stream) {
    return window.currentMP3Stream; // Retorna stream do MP3
  }
  return window.originalGetUserMedia.call(this, constraints);
};
```

### **Injeção Automática**
- **Durante `outcoming_calling`**: Stream MP3 preparado
- **Durante `accept`**: Source iniciado automaticamente
- **Interceptação ativa**: Biblioteca recebe áudio do MP3

### **Múltiplas Estratégias**
1. **Interceptação global** (principal)
2. **Substituição direta** de microfone
3. **Captura forçada** com configurações específicas
4. **Reprodução simples** via AudioContext
5. **Reprodução HTML** otimizada

## 📁 Estrutura do Projeto

```
src/
├── App.js          # Componente principal com toda lógica
├── App.css         # Estilos modernos com glassmorphism
├── index.js        # Ponto de entrada da aplicação
└── index.css       # Estilos globais

public/
├── index.html      # Template HTML
└── manifest.json   # Manifesto PWA
```

## 🎨 Interface

### **Layout Principal**
- **Header fixo** com título e efeito glassmorphism
- **Painéis laterais** - controles à esquerda, logs à direita
- **Cards compactos** com informações organizadas

### **Seções Disponíveis**
1. **Upload de Arquivo** - Upload de áudio
2. **Tokens dos Dispositivos** - Gerenciamento de tokens
3. **Números de Telefone** - Lista de números
4. **Status dos Dispositivos** - Monitoramento em tempo real
5. **Informações da Chamada** - Detalhes da chamada ativa
6. **Logs** - Sistema de logs em tempo real

## 🔍 Logs e Debugging

### **Sistema de Logs Colorido**
- 🔵 **Info** - Informações gerais
- 🟢 **Success** - Operações bem-sucedidas  
- 🟡 **Warning** - Avisos importantes
- 🔴 **Error** - Erros que precisam atenção

### **Logs Importantes**
```
🎤 getUserMedia chamado pela interceptação
🎤 Interceptando getUserMedia - retornando stream do MP3
🎯 Source pendente iniciado - chamada aceita!
🎵 Áudio transmitido na ligação!
```

## ⚙️ Configurações

### **Variáveis de Ambiente**
Crie um arquivo `.env` na raiz do projeto:
```env
REACT_APP_WAVOIP_API_URL=https://sua-api-wavoip.com
REACT_APP_DEBUG_MODE=true
```

### **Configurações de Áudio**
- **Sample Rate**: 48000Hz
- **Channels**: 2 (estéreo)
- **Latency**: 0.01s
- **Formatos suportados**: MP3, WAV, OGG, M4A, AAC

## 🐛 Troubleshooting para Ligações em Massa

### **Problemas Comuns**

**1. Áudio não é transmitido em massa:**
- Verifique se a interceptação está ativa nos logs
- Confirme se o arquivo de áudio foi carregado
- Verifique se todos os dispositivos estão online
- Teste com um dispositivo primeiro antes de escalar

**2. Ligações em massa falhando:**
- Verifique se todos os tokens são válidos
- Confirme se os números estão no formato correto
- Verifique a conexão de internet estável
- Reduza a taxa de disparo se muitos falharem

**3. Limite de dispositivos atingido:**
- Verifique o plano do Wavoip (Free: 5 ligações/dia)
- Considere upgrade para Enterprise (ilimitado)
- Distribua as ligações ao longo do dia
- Use múltiplas contas se necessário

**4. Performance degradada com muitos dispositivos:**
- Feche outras abas do navegador
- Use um computador com mais RAM
- Considere usar múltiplas instâncias do sistema
- Monitore o uso de CPU e memória

**5. Erro de getUserMedia em massa:**
- Permita acesso ao microfone no navegador
- Verifique se o HTTPS está habilitado
- Teste em navegador diferente
- Reinicie o navegador se muitos erros ocorrerem

### **Logs de Debug**
Ative o modo debug para logs detalhados:
```javascript
// No console do navegador
localStorage.setItem('debug', 'true');
```

## 🤝 Contribuição

1. Fork o projeto
2. Crie uma branch para sua feature (`git checkout -b feature/AmazingFeature`)
3. Commit suas mudanças (`git commit -m 'Add some AmazingFeature'`)
4. Push para a branch (`git push origin feature/AmazingFeature`)
5. Abra um Pull Request

## 📄 Licença

Este projeto está sob a licença MIT. Veja o arquivo `LICENSE` para mais detalhes.

## 🙏 Agradecimentos

- **[Wavoip](https://wavoip.com/)** - Plataforma oficial de comunicação WhatsApp com API robusta
- **React** - Framework frontend moderno e eficiente
- **Lucide React** - Ícones modernos e consistentes
- **React Hot Toast** - Notificações elegantes e não-intrusivas
- **WebRTC** - Tecnologia para comunicação em tempo real

**Desenvolvido com ❤️ para automatizar ligações em massa com injeção de áudio no WhatsApp**

### 🚀 **Pronto para Escalar?**
- 📈 **Comece pequeno** com alguns dispositivos
- 🔄 **Teste e otimize** sua estratégia
- 📊 **Monitore resultados** em tempo real
- 🎯 **Escale gradualmente** conforme necessário

### 💡 **Dicas para Sucesso:**
- ✅ **Use áudios curtos** (30-60 segundos) para melhor engajamento
- ✅ **Teste horários** diferentes para encontrar o melhor momento
- ✅ **Monitore métricas** de aceitação e duração das chamadas
- ✅ **Mantenha backups** de seus áudios e listas de números
- ✅ **Respeite limites** do WhatsApp para evitar bloqueios