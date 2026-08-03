/** O microfone antes de gravar: permissão, dispositivo e sinal.
 *
 *  São TRÊS causas de áudio mudo, e só a primeira é permissão:
 *
 *  1. o operador negou (ou ignorou) o pedido do navegador;
 *  2. permitiu, mas o navegador está captando de outro dispositivo — a webcam
 *     desligada, o fone que saiu da mesa;
 *  3. o dispositivo certo está mudo no sistema ou com o cabo solto.
 *
 *  A 1 falha visivelmente hoje: `getUserMedia` rejeita e a gravação não começa.
 *  A 2 e a 3 não falham — o MediaRecorder grava silêncio com o mesmo tamanho e o
 *  mesmo formato de uma nota de voz de verdade, e o arquivo é anexado e enviado.
 *  É por isso que este módulo tem um medidor: sem olhar o sinal, não há como
 *  distinguir "gravou" de "gravou nada".
 *
 *  Tudo aqui é função pura ou envoltório fino sobre a API do navegador, para o
 *  teste não precisar de microfone. */

export type MicrophoneState = "granted" | "denied" | "prompt" | "unknown";

/** O estado ANTES de pedir. `getUserMedia` só responde depois de perguntar (ou de
 *  falhar em silêncio quando já foi negado), e é tarde demais para explicar.
 *
 *  Devolve `unknown` — e não `prompt` — quando a API não existe ou não conhece o
 *  nome `microphone`: Firefox e Safari não implementam essa consulta. Tratar o
 *  desconhecido como `prompt` mostraria o modal a quem já concedeu, toda vez. */
export const microphoneState = async (): Promise<MicrophoneState> => {
  const permissions = navigator.permissions;
  if (!permissions?.query) return "unknown";
  try {
    const status = await permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" || status.state === "denied" || status.state === "prompt"
      ? status.state
      : "unknown";
  } catch {
    // Navegador que não conhece o nome `microphone` lança em vez de responder.
    return "unknown";
  }
};

/** Os microfones que o navegador enumera.
 *
 *  Antes de a permissão ser concedida os rótulos vêm VAZIOS — é a defesa do
 *  navegador contra impressão digital. Por isso o seletor só faz sentido depois
 *  de permitir, e é lá que ele é mostrado: uma lista de "" não ajuda ninguém a
 *  escolher. */
export const audioInputs = async (): Promise<MediaDeviceInfo[]> => {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput");
  } catch {
    return [];
  }
};

/** Rótulo de dispositivo que serve para escolher.
 *
 *  Sem permissão o `label` é vazio; sem rótulo, o `deviceId` é um hash que não
 *  diz nada a ninguém e que a regra 6 do projeto proíbe mostrar. Então o que
 *  aparece é a posição na lista. */
export const deviceLabel = (device: MediaDeviceInfo, index: number): string =>
  device.label.trim() || `Microfone ${index + 1}`;

/** A mensagem por causa, no lugar do `message` cru do navegador — que varia por
 *  fabricante e não é para o operador. Mesmo tratamento que a câmera e a
 *  geolocalização já recebem neste arquivo. */
export const microphoneErrorMessage = (error: unknown): string => {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Permissão de microfone negada.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError")
    return "Nenhum microfone encontrado neste dispositivo.";
  if (name === "NotReadableError" || name === "TrackStartError")
    return "O microfone está em uso por outro aplicativo. Feche o outro programa e tente de novo.";
  if (name === "OverconstrainedError")
    return "O microfone escolhido não está mais disponível. Escolha outro.";
  return "Não foi possível acessar o microfone.";
};

/** Como reverter uma negação, que é o que falta em "permissão negada".
 *
 *  Depois de negar, o navegador NÃO pergunta de novo: `getUserMedia` rejeita na
 *  hora, sem diálogo. Quem não souber onde fica o botão fica preso, e é o caso em
 *  que dizer só "negada" é o mesmo que não dizer nada.
 *
 *  O texto é do Chrome porque é o navegador do operador aqui. Firefox e Safari
 *  põem o controle em outro lugar — **não identificado** qual, e não afirmo. */
export const MICROPHONE_RECOVERY =
  "Clique no ícone de cadeado na barra de endereço, ative o microfone e recarregue a página.";

/* ─── O medidor de sinal, para a causa 3 ─────────────────────────────────── */

/** Abaixo disto a captação é silêncio para o que interessa aqui. É calibração,
 *  não medição: `0.01` de RMS numa escala 0–1 deixa passar ruído de sala e barra
 *  microfone mudo. Se der falso positivo no seu caso, mexa sem cerimônia. */
export const SILENCE_RMS = 0.01;
/** Quantos segundos de silêncio contínuo antes de avisar. Três é tempo de quem
 *  começou a falar e ainda não disse nada; abaixo disso a mensagem apareceria na
 *  respiração antes da primeira palavra. Arbitrário. */
export const SILENCE_SECONDS = 3;

/** RMS de um bloco de amostras em ponto flutuante (`getFloatTimeDomainData`),
 *  numa escala 0–1. Separado do `AnalyserNode` de propósito: é a única conta do
 *  medidor, e assim ela é testável sem `AudioContext` — que o jsdom não tem. */
export const signalLevel = (samples: Float32Array | readonly number[]): number => {
  const values = samples as ArrayLike<number>;
  if (!values.length) return 0;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) sum += values[index] * values[index];
  return Math.sqrt(sum / values.length);
};

/** Decide se já é hora de avisar, a partir da série de níveis observados.
 *
 *  Conta o silêncio do FIM para trás: um pico no meio da gravação zera a conta,
 *  porque a pergunta é "está mudo agora?", não "esteve mudo alguma vez". Sem
 *  isso, quem falou, parou e voltou a falar veria o aviso. */
export const silentFor = (levels: readonly number[], threshold = SILENCE_RMS): number => {
  let count = 0;
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    if (levels[index] > threshold) break;
    count += 1;
  }
  return count;
};

export const isSilent = (levels: readonly number[], seconds = SILENCE_SECONDS): boolean =>
  silentFor(levels) >= seconds;

/** O aviso da causa 3. Não interrompe a gravação: o operador pode estar gravando
 *  um trecho de silêncio de propósito, e derrubar a captação por suspeita seria
 *  pior que o problema. Diz o que houve e deixa a decisão com ele. */
export const SILENCE_WARNING =
  "Nenhum som detectado. Verifique se o microfone certo está selecionado e se não está mudo no sistema.";
