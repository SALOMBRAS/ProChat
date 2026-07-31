import { describe, expect, it } from "vitest";

/**
 * Varredura de mojibake em todo o código do dashboard.
 *
 * A PR #66 corrigiu duas frases corrompidas em `MessageMedia.tsx` e deixou um
 * teste de componente para guardá-las. A mesma frase estava **duplicada** no
 * cliente da API (`client.ts`, na `ApiError` que `blob()` lança), e um teste que
 * renderiza um componente não tinha como alcançá-la — foi assim que a ocorrência
 * escapou.
 *
 * Este teste não olha componente nenhum: lê o código-fonte. É a única forma de a
 * próxima ocorrência não depender de existir um teste que passe por ela.
 *
 * ## Como se reconhece mojibake sem acusar português legítimo
 *
 * Texto UTF-8 lido como Latin-1 produz sempre o mesmo formato: o primeiro byte
 * (`0xC3` ou `0xC2`) vira `Ã` ou `Â`, e o byte de continuação (`0x80`–`0xBF`)
 * vira um caractere do bloco Latin-1 Supplement. Então **`Ã` ou `Â` seguido de
 * um caractere em U+0080–U+00BF** é a assinatura, e ela não acontece por acaso:
 *
 * - `GESTÃO`, `OPERAÇÃO`, `OBSERVAÇÃO` — `Ã` seguido de `O` (U+004F). Passa.
 * - `Âmbar` — `Â` seguido de `m` (U+006D). Passa.
 * - `NÃ£o`, `possÃ­vel`, `mantÃ©m` — `Ã` seguido de U+00A3/U+00AD/U+00A9. Pega.
 *
 * `â€` cobre a pontuação (`…`, `“`, `—`), que chega como `â` + U+0080.
 *
 * Repare no caso mais traiçoeiro: em `mÃ­dia` o segundo caractere é U+00AD, o
 * hífen suave — **invisível**. Na tela lia-se `mÃdia`, e procurar por `mÃ­dia`
 * literal não encontrava nada.
 */
const MOJIBAKE = /[ÃÂ][-¿]|â€/;

/** O código-fonte inteiro do dashboard, lido como texto. */
const sources = import.meta.glob("../**/*.{ts,tsx,css}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("acentuação do código do dashboard", () => {
  it("varre a fonte inteira, não só o que algum componente renderiza", () => {
    // A varredura só vale se estiver mesmo lendo os arquivos.
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    expect(Object.keys(sources).some((path) => path.endsWith("/api/client.ts"))).toBe(true);
  });

  it("não há nenhuma frase com UTF-8 lido como Latin-1", () => {
    const hits: string[] = [];
    for (const [path, content] of Object.entries(sources))
      content.split("\n").forEach((line, index) => {
        // Uma linha que documenta o defeito antigo se declara — é o caso do teste
        // de regressão da #66, que cita os bytes corrompidos de propósito.
        if (line.includes("mojibake-esperado")) return;
        if (MOJIBAKE.test(line)) hits.push(`${path}:${index + 1}  ${line.trim().slice(0, 120)}`);
      });
    expect(hits).toEqual([]);
  });

  it("o detector reconhece o defeito e absolve o português legítimo", () => {
    // Sem estas duas metades o teste acima passaria por estar cego, não por o
    // código estar limpo.
    expect(MOJIBAKE.test("NÃ£o foi possÃ\xadvel carregar a mÃ\xaddia.")).toBe(true);
    expect(MOJIBAKE.test("mantÃ©m uma resposta 200 com JSON vÃ¡lido")).toBe(true);
    expect(MOJIBAKE.test("Carregando mÃ\xaddiaâ€¦")).toBe(true);
    for (const legitimate of ["GESTÃO", "OPERAÇÃO DA CONVERSA", "OBSERVAÇÃO INTERNA", "Âmbar", "Não foi possível carregar a mídia.", "Carregando mídia…"])
      expect(MOJIBAKE.test(legitimate)).toBe(false);
  });

  it("os arquivos são UTF-8 de verdade, não Latin-1 disfarçado", () => {
    // Um arquivo gravado em Latin-1 é outro defeito com o mesmo sintoma, e a
    // correção é reencodar o arquivo, não editar o texto.
    for (const [path, content] of Object.entries(sources))
      expect(content, path).not.toContain("�");
  });
});
