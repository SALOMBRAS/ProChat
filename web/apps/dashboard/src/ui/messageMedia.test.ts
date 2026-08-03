import { describe, expect, it } from "vitest";
import type { InboxMessage } from "../api/inbox.js";
import {
  bodyRepeatsCard,
  contactCards,
  documentKind,
  durationLabel,
  isVoiceNote,
  mediaDuration,
  mediaFilename,
  mediaSize,
  parseVcard,
  phoneDigits,
  phoneDisplay,
  voiceWaveform,
  wahaData,
} from "./messageMedia.js";

/**
 * Leitura do payload cru que a WAHA entrega em `metadata`.
 *
 * Os números citados aqui foram medidos na base de produção: as colunas
 * dedicadas chegam nulas na maioria das linhas e o payload tem o dado. Cada
 * teste prende um desses casos.
 */
const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  id: "m-1", direction: "inbound", content: null, timestamp: "2026-07-29T12:00:00.000Z",
  status: "received", messageType: "audio", chatId: "5511999990001@c.us", metadata: {}, ...over,
});
/** O waveform chega como objeto de chaves numéricas, não como array. */
const waveObject = (values: number[]) => Object.fromEntries(values.map((value, index) => [String(index), value]));
const sixtyFour = Array.from({ length: 64 }, (_, index) => (index % 2 ? 80 : 20));

describe("nota de voz versus arquivo de áudio", () => {
  it("reconhece a nota pelo messageType que a #57 passou a gravar", () => {
    expect(isVoiceNote(message({ messageType: "ptt" }))).toBe(true);
  });

  it("reconhece a nota histórica, que ficou como audio sem backfill", () => {
    // 114 linhas na base estão assim: messageType 'audio' e _data.type 'ptt'.
    expect(isVoiceNote(message({ messageType: "audio", metadata: { _data: { type: "ptt" } } }))).toBe(true);
  });

  it("não confunde arquivo de música com nota", () => {
    expect(isVoiceNote(message({ messageType: "audio", metadata: { _data: { type: "audio" } } }))).toBe(false);
    expect(isVoiceNote(message({ messageType: "audio" }))).toBe(false);
  });
});

describe("forma de onda", () => {
  it("lê as 64 amplitudes e normaliza para 0–1", () => {
    const wave = voiceWaveform(message({ metadata: { _data: { waveform: waveObject(sixtyFour) } } }))!;
    expect(wave).toHaveLength(64);
    expect(Math.max(...wave)).toBeCloseTo(0.8, 5);
    expect(Math.min(...wave)).toBeCloseTo(0.2, 5);
  });

  it("mantém a ordem numérica das chaves, e não a alfabética", () => {
    // Se a leitura fosse alfabética, "10" viria antes de "2" e o desenho sairia
    // embaralhado; `Object.keys` já entrega índice inteiro em ordem crescente.
    const wave = voiceWaveform(message({ metadata: { _data: { waveform: waveObject([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) } } }))!;
    expect(wave[10]).toBeCloseTo(1, 5);
    expect(wave[2]).toBeCloseTo(0.2, 5);
  });

  it("aceita array também, e não estoura se a escala passar de 100", () => {
    const wave = voiceWaveform(message({ metadata: { _data: { waveform: [0, 128, 255, 64, 32, 16, 8, 200] } } }))!;
    expect(Math.max(...wave)).toBeLessThanOrEqual(1);
    expect(wave[2]).toBeCloseTo(1, 5);
  });

  it("devolve indefinido quando não há onda para desenhar", () => {
    expect(voiceWaveform(message())).toBeUndefined();
    expect(voiceWaveform(message({ metadata: { _data: { waveform: waveObject([1, 2, 3]) } } }))).toBeUndefined();
    expect(voiceWaveform(message({ metadata: { _data: { waveform: "nada" } } }))).toBeUndefined();
  });
});

describe("duração, tamanho e nome que as colunas não trazem", () => {
  it("cai no payload quando a coluna de duração vem nula", () => {
    // Medido: duration nula em 100% dos áudios e vídeos da base.
    expect(mediaDuration(message({ duration: null, metadata: { _data: { duration: "19" } } }))).toBe(19);
    expect(mediaDuration(message({ duration: 7, metadata: { _data: { duration: "19" } } }))).toBe(7);
    expect(mediaDuration(message())).toBeUndefined();
  });

  it("cai no payload quando a coluna de tamanho vem nula", () => {
    // Medido: media_size nula em 89 de 89 documentos; _data.size presente nos 89.
    expect(mediaSize(message({ mediaSize: null, metadata: { _data: { size: 98301 } } }))).toBe(98301);
    expect(mediaSize(message({ mediaSize: null, metadata: { _data: { fileLength: "2048" } } }))).toBe(2048);
    expect(mediaSize(message())).toBeUndefined();
  });

  it("ignora o rótulo do protocolo usado como nome de arquivo", () => {
    // 'image', 'audio' e 'video' são o que o WhatsApp põe quando não há nome.
    expect(mediaFilename(message({ mediaFilename: "audio" }))).toBeUndefined();
    expect(mediaFilename(message({ mediaFilename: "image.jpg" }))).toBeUndefined();
    // `attachment` é o que o `sanitizeFilename` do servidor devolve quando o nome
    // some; visto na tela como "attachment · 0:35" no rodapé de um vídeo.
    expect(mediaFilename(message({ mediaFilename: "attachment" }))).toBeUndefined();
    expect(mediaFilename(message({ mediaFilename: "contrato.pdf" }))).toBe("contrato.pdf");
    expect(mediaFilename(message({ mediaFilename: null, metadata: { _data: { filename: "nota.pdf" } } }))).toBe("nota.pdf");
  });

  it("formata a duração em minutos e segundos", () => {
    expect(durationLabel(0)).toBe("0:00");
    expect(durationLabel(19)).toBe("0:19");
    expect(durationLabel(125)).toBe("2:05");
    expect(durationLabel(undefined)).toBe("0:00");
  });
});

describe("etiqueta do documento", () => {
  it.each([
    ["contrato.pdf", null, "PDF"],
    ["planilha.xlsx", null, "XLS"],
    ["proposta.docx", null, "DOC"],
    ["slides.pptx", null, "PPT"],
    ["backup.zip", null, "ZIP"],
    ["leia.txt", null, "TXT"],
  ])("reconhece %s", (name, mime, label) => {
    expect(documentKind(name, mime).label).toBe(label);
  });

  it("reconhece pelo mime quando não há extensão — o caso real da base", () => {
    // Há documento gravado com _data.mimetype 'image/jpeg' e nenhum filename.
    expect(documentKind(undefined, "image/jpeg").label).toBe("IMG");
    expect(documentKind(undefined, "application/pdf").label).toBe("PDF");
    expect(documentKind(undefined, "audio/ogg").label).toBe("AUD");
    expect(documentKind(undefined, null).label).toBe("ARQ");
  });
});

describe("telefone do cartão de contato", () => {
  it("deixa legível o número brasileiro", () => {
    expect(phoneDisplay("5511999990001")).toBe("+55 (11) 99999-0001");
    expect(phoneDisplay("551133330001")).toBe("+55 (11) 3333-0001");
  });

  it("não inventa formato para número que não é do padrão", () => {
    expect(phoneDisplay("+1 415 555 2671")).toBe("+1 415 555 2671");
    expect(phoneDisplay(null)).toBe("Sem telefone");
  });

  it("reduz a dígitos para o tel: e para a busca no CRM", () => {
    expect(phoneDigits("+55 (11) 99999-0001")).toBe("+5511999990001");
    expect(phoneDigits("5511999990001")).toBe("5511999990001");
  });

  it("lê os cartões guardados no payload", () => {
    const cards = contactCards(message({ metadata: { contacts: [{ fullName: "Ana", phoneNumber: "5511999990001" }] } }));
    expect(cards).toHaveLength(1);
    expect(cards[0].fullName).toBe("Ana");
    expect(contactCards(message())).toHaveLength(0);
  });
});

describe("corpo que repete o cartão", () => {
  it("reconhece o título da localização repetido abaixo do cartão", () => {
    // O corpo guardado de uma localização é o próprio título.
    expect(bodyRepeatsCard(message({ messageType: "location", content: "Loja centro", metadata: { location: { latitude: -7, longitude: -34, title: "Loja centro" } } }))).toBe(true);
  });

  it("reconhece o nome do contato repetido abaixo do cartão", () => {
    expect(bodyRepeatsCard(message({ messageType: "contact", content: "Ana", metadata: { contacts: [{ fullName: "Ana" }] } }))).toBe(true);
    expect(bodyRepeatsCard(message({ messageType: "contact", content: "Ana e mais 2", metadata: { contacts: [{ fullName: "Ana" }, { fullName: "Bia" }, { fullName: "Caio" }] } }))).toBe(true);
  });

  it("não esconde legenda que diz outra coisa", () => {
    expect(bodyRepeatsCard(message({ messageType: "location", content: "chego em 10 min", metadata: { location: { latitude: -7, longitude: -34, title: "Loja centro" } } }))).toBe(false);
    expect(bodyRepeatsCard(message({ messageType: "image", content: "olha isto" }))).toBe(false);
    expect(bodyRepeatsCard(message({ messageType: "contact", content: "" }))).toBe(false);
  });
});

describe("acesso ao payload", () => {
  it("devolve objeto vazio em vez de explodir quando não há _data", () => {
    expect(wahaData(message())).toEqual({});
    expect(wahaData(message({ metadata: { _data: null as never } }))).toEqual({});
  });
});

/** Cartões de contato RECEBIDOS. O WEBJS manda `vCards` — lista de strings no
 *  formato vCard — e nunca `contacts`, que é o formato dos nossos envios. Antes
 *  desta leitura, classificar a mensagem como `contact` deixava o cartão vazio.
 *  Os exemplos abaixo são a forma real medida na base, com os dígitos trocados. */
describe("cartão de contato recebido do WhatsApp", () => {
  const vcard = (body: string) => ({ messageType: "contact", content: body, metadata: { vCards: [body] } }) as never;

  it("lê nome e telefone de um vCard recebido, preferindo o waid", () => {
    const raw = "BEGIN:VCARD\nVERSION:3.0\nN:Souza;Rodrigo;;;\nFN:Rodrigo Souza\nitem1.TEL;waid=5585999990000:+55 85 99999-0000\nitem1.X-ABLabel:Celular\nEND:VCARD";
    expect(contactCards({ metadata: { vCards: [raw] } } as never)).toEqual([
      { fullName: "Rodrigo Souza", phoneNumber: "5585999990000", organization: undefined },
    ]);
  });

  it("cai no telefone formatado quando não há waid", () => {
    const raw = "BEGIN:VCARD\nVERSION:3.0\nFN:Suporte\nTEL;type=CELL:+55 85 3333-0000\nEND:VCARD";
    expect(contactCards({ metadata: { vCards: [raw] } } as never)[0]).toMatchObject({ fullName: "Suporte", phoneNumber: "+55 85 3333-0000" });
  });

  it("usa o nome comercial quando o vCard não tem FN", () => {
    const raw = "BEGIN:VCARD\nVERSION:3.0\nX-WA-BIZ-NAME:Pizza da Esquina\nTEL;waid=5585988880000:+55 85 98888-0000\nEND:VCARD";
    expect(contactCards({ metadata: { vCards: [raw] } } as never)[0]?.fullName).toBe("Pizza da Esquina");
  });

  it("ignora ORG vazio em vez de mostrar string em branco", () => {
    const raw = "BEGIN:VCARD\nVERSION:3.0\nFN:Suporte\nORG:\nTEL;waid=5585977770000:+55\nEND:VCARD";
    expect(contactCards({ metadata: { vCards: [raw] } } as never)[0]?.organization).toBeUndefined();
  });

  it("não deixa o vCard cru — nem a foto em base64 dentro dele — virar texto na conversa", () => {
    const raw = `BEGIN:VCARD\nVERSION:3.0\nFN:Bê\nitem1.TEL;waid=5585966660000:+55 85 96666-0000\nPHOTO;BASE64:/9j/4AAQSkZJRgABAQAAAQABAAD${"A".repeat(3000)}\nEND:VCARD`;
    expect(contactCards({ metadata: { vCards: [raw] } } as never)[0]?.fullName).toBe("Bê");
    // O corpo é o vCard inteiro; se ele for renderizado, o base64 da foto aparece.
    expect(bodyRepeatsCard(vcard(raw))).toBe(true);
  });

  it("continua preferindo `contacts` quando a mensagem foi enviada por nós", () => {
    const sent = { metadata: { contacts: [{ fullName: "Enviado por nós", phoneNumber: "5585911110000" }], vCards: ["BEGIN:VCARD\nFN:Ignorado\nEND:VCARD"] } } as never;
    expect(contactCards(sent)).toEqual([{ fullName: "Enviado por nós", phoneNumber: "5585911110000" }]);
  });

  it("devolve lista vazia para payload sem cartão, sem estourar", () => {
    expect(contactCards({ metadata: {} } as never)).toEqual([]);
    expect(contactCards({ metadata: { vCards: "não é lista" } } as never)).toEqual([]);
    expect(parseVcard("isto não é um vCard")).toBeUndefined();
  });
});
