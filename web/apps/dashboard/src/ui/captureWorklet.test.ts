import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** Carrega o worklet de captura (JS puro de public/) com os globais do
 *  AudioWorklet stubados, para testar o comportamento do portão de ruído. */
const loadProcessor = () => {
  const code = readFileSync(join(process.cwd(), "public/worklets/capture-processor.js"), "utf8");
  let Processor: any;
  class AudioWorkletProcessorStub { port = { postMessage: vi.fn() }; }
  const registerProcessor = (_name: string, cls: any) => { Processor = cls; };
  new Function("registerProcessor", "AudioWorkletProcessor", code)(registerProcessor, AudioWorkletProcessorStub);
  return new Processor();
};

const block = (level: number) => new Float32Array(128).fill(level);
const run = (proc: any, input: Float32Array) => {
  proc.process([[input]]);
  const posted = proc.port.postMessage.mock.calls.at(-1)?.[0] as Float32Array;
  return posted;
};

describe("capture-processor (portão de ruído)", () => {
  it("fala acima do limiar passa (com fade-in) e abre o portão", () => {
    const proc = loadProcessor();
    const first = run(proc, block(0.2));
    // fade-in: o fim do bloco já está bem mais alto que o começo
    expect(Math.abs(first[127]!)).toBeGreaterThan(Math.abs(first[0]!));
    const second = run(proc, block(0.2));
    expect(second[64]).toBeGreaterThan(0.1); // fade-in ainda em curso
    for (let i = 0; i < 8; i += 1) run(proc, block(0.2)); // fade converge
    const steady = run(proc, block(0.2));
    expect(steady[64]).toBeGreaterThan(0.19); // portão aberto: passa intacto
  });

  it("silêncio nunca abre o portão: saída fica em zero", () => {
    const proc = loadProcessor();
    for (let i = 0; i < 20; i += 1) run(proc, block(0.001));
    const posted = run(proc, block(0.001));
    expect(Math.max(...posted.map(Math.abs))).toBeLessThan(0.0001);
  });

  it("ruído baixo entre CLOSE e OPEN não abre o portão (histerese)", () => {
    const proc = loadProcessor();
    for (let i = 0; i < 20; i += 1) run(proc, block(0.009)); // 0.007 < x < 0.012
    const posted = run(proc, block(0.2)); // agora fala de verdade: abre com fade
    expect(Math.abs(posted[127]!)).toBeGreaterThan(Math.abs(posted[0]!));
  });

  it("depois da fala, sustenta ~100 ms e fecha suavemente", () => {
    const proc = loadProcessor();
    run(proc, block(0.2));
    run(proc, block(0.2)); // portão aberto
    const sustentado = run(proc, block(0.001)); // dentro do hold: ainda passa
    expect(Math.abs(sustentado[64]!)).toBeGreaterThan(0.0005);
    for (let i = 0; i < 30; i += 1) run(proc, block(0.001)); // estoura o hold
    const fechado = run(proc, block(0.001));
    expect(Math.max(...fechado.map(Math.abs))).toBeLessThan(0.0001);
  });
});
