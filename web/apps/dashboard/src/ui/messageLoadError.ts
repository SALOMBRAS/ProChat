/** O que o operador lê quando as mensagens de uma conversa não carregam.
 *
 *  ## O que estava errado
 *
 *  A falha caía no `error` da Inbox, que é um estado só, renderizado no **topo da
 *  lista de conversas**. Duas coisas davam errado de uma vez:
 *
 *  1. O texto era `error.message` inteiro, e o transporte anexa um diagnóstico
 *     entre colchetes quando roda em desenvolvimento:
 *     `A API demorou para responder. [TIMEOUT 0 /api/v1/inbox/conversations/…/messages?page=1&pageSize=50; AbortError: signal is aborted without reason]`
 *     Isso é para quem está depurando, não para quem está atendendo.
 *  2. Aparecia na coluna da lista, longe da conversa que falhou — e ficava lá
 *     mesmo depois de o operador abrir outra conversa.
 *
 *  ## O que este módulo faz
 *
 *  Traduz a falha para uma frase e uma dica, pelo **código** do erro, sem nunca
 *  repassar `message` cru. É função pura de propósito: a redação é a parte que
 *  pede teste, e ela não precisa de DOM.
 *
 *  Não mexe no tempo limite em si — isso é do servidor.
 */
import { ApiError } from "../api/client.js";

export type LoadFailure = {
  /** A frase principal. Diz o que não aconteceu, na língua do operador. */
  text: string;
  /** O que fazer, ou por que aconteceu. Vazio quando não há nada útil a dizer. */
  hint: string;
};

/** O diagnóstico que o cliente anexa em desenvolvimento:
 *  ` [TIMEOUT 0 /caminho; AbortError: motivo]`.
 *
 *  Removido em vez de descartar a mensagem inteira porque, no `REQUEST_FAILED`, o
 *  que vem antes do colchete é a frase que o **servidor** escreveu para o
 *  operador — e essa vale mais do que qualquer texto genérico daqui. */
const DIAGNOSTIC = /\s*\[(?:TIMEOUT|REQUEST_FAILED|API_UNAVAILABLE|PARSE)\s[^\]]*\]\s*$/;

export const withoutDiagnostics = (message: string): string => message.replace(DIAGNOSTIC, "").trim();

/** A explicação em português de gente para o caso mais comum: a sincronização do
 *  histórico está ocupando a mesma conexão com o WhatsApp, e a leitura da conversa
 *  fica na fila. Não é erro do operador e não adianta insistir no mesmo segundo. */
const SYNCING_HINT =
  "A sincronização do histórico está ocupando a conexão com o WhatsApp. Espere alguns instantes e tente de novo.";

export const messageLoadFailure = (error: unknown, syncing: boolean): LoadFailure => {
  if (!(error instanceof ApiError))
    return { text: "Não foi possível carregar as mensagens desta conversa.", hint: "" };

  if (error.code === "TIMEOUT")
    return {
      text: "As mensagens desta conversa demoraram demais para chegar.",
      hint: syncing ? SYNCING_HINT : "A conexão demorou mais do que o esperado.",
    };

  if (error.code === "API_UNAVAILABLE")
    return {
      text: "Não foi possível falar com o servidor do ChatPro.",
      hint: "Verifique sua conexão e tente de novo.",
    };

  // `REQUEST_FAILED` carrega a frase do servidor, que é escrita para o operador.
  const server = withoutDiagnostics(error.message);
  return {
    text: server || "Não foi possível carregar as mensagens desta conversa.",
    hint: syncing ? SYNCING_HINT : "",
  };
};
