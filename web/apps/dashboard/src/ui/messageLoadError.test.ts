import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { messageLoadFailure, withoutDiagnostics } from "./messageLoadError.js";

/** A mensagem exata que chegava à tela do operador, montada por client.ts:27
 *  quando `import.meta.env.DEV` está ligado. */
const REPORTED =
  "A API demorou para responder. [TIMEOUT 0 /api/v1/inbox/conversations/11111111-1111-4111-8111-111111111111/messages?page=1&pageSize=50; AbortError: signal is aborted without reason]";

describe("o diagnóstico entre colchetes", () => {
  it("sai da frase, com caminho, código e nome do erro juntos", () => {
    expect(withoutDiagnostics(REPORTED)).toBe("A API demorou para responder.");
  });

  it("não estraga uma frase que nunca teve colchete", () => {
    expect(withoutDiagnostics("Não foi possível concluir a operação.")).toBe("Não foi possível concluir a operação.");
  });

  it("tira também os outros três formatos que o transporte anexa", () => {
    expect(withoutDiagnostics("A API está indisponível. [API_UNAVAILABLE 0 /x; TypeError: fetch failed]")).toBe("A API está indisponível.");
    expect(withoutDiagnostics("Resposta inválida da API. [PARSE 200 /x]")).toBe("Resposta inválida da API.");
    expect(withoutDiagnostics("Telefone já existe. [REQUEST_FAILED 409 /x]")).toBe("Telefone já existe.");
  });
});

describe("o que o operador lê quando as mensagens não carregam", () => {
  it("o tempo esgotado vira frase de gente, sem nada técnico", () => {
    const failure = messageLoadFailure(new ApiError("TIMEOUT", REPORTED, { status: 0 }), false);
    expect(failure.text).toBe("As mensagens desta conversa demoraram demais para chegar.");
    // Nada de código, caminho, UUID ou nome de exceção.
    for (const leak of ["TIMEOUT", "AbortError", "/api/v1", "[", "]", "11111111"])
      expect(`${failure.text} ${failure.hint}`).not.toContain(leak);
  });

  it("com a sincronização rodando, explica a disputa em português de gente", () => {
    const failure = messageLoadFailure(new ApiError("TIMEOUT", REPORTED, { status: 0 }), true);
    expect(failure.hint).toBe("A sincronização do histórico está ocupando a conexão com o WhatsApp. Espere alguns instantes e tente de novo.");
    // Sem "WAHA": é nome de peça interna, não de coisa que o operador conhece.
    expect(failure.hint).not.toContain("WAHA");
  });

  it("sem sincronização, não inventa uma causa que não observou", () => {
    const failure = messageLoadFailure(new ApiError("TIMEOUT", REPORTED, { status: 0 }), false);
    expect(failure.hint).toBe("A conexão demorou mais do que o esperado.");
    expect(failure.hint).not.toContain("sincronização");
  });

  it("servidor fora do ar é outra frase, com outra saída", () => {
    const failure = messageLoadFailure(new ApiError("API_UNAVAILABLE", "A API está indisponível. [API_UNAVAILABLE 0 /x; TypeError: fetch failed]", {}), false);
    expect(failure.text).toBe("Não foi possível falar com o servidor do ChatPro.");
    expect(failure.hint).toBe("Verifique sua conexão e tente de novo.");
  });

  it("a frase que o servidor escreveu é preservada, só sem o diagnóstico", () => {
    // No `REQUEST_FAILED` quem redigiu foi o servidor, para o operador. Trocar por
    // um texto genérico daqui perderia a única informação específica que havia.
    const failure = messageLoadFailure(new ApiError("REQUEST_FAILED", "Esta conversa foi arquivada. [REQUEST_FAILED 409 /x]", {}), false);
    expect(failure.text).toBe("Esta conversa foi arquivada.");
  });

  it("um erro que não é da API ainda diz o que não aconteceu", () => {
    expect(messageLoadFailure(new TypeError("boom"), false).text).toBe("Não foi possível carregar as mensagens desta conversa.");
    expect(messageLoadFailure(undefined, false).text).toBe("Não foi possível carregar as mensagens desta conversa.");
  });

  it("nenhum caminho deixa passar o colchete de diagnóstico", () => {
    const errors = [
      new ApiError("TIMEOUT", REPORTED, {}),
      new ApiError("API_UNAVAILABLE", "A API está indisponível. [API_UNAVAILABLE 0 /x; TypeError: fetch failed]", {}),
      new ApiError("REQUEST_FAILED", "Falhou. [REQUEST_FAILED 500 /x]", {}),
      new TypeError("boom"),
    ];
    for (const error of errors)
      for (const syncing of [true, false]) {
        const failure = messageLoadFailure(error, syncing);
        expect(`${failure.text} ${failure.hint}`).not.toMatch(/\[|\]/);
      }
  });
});
