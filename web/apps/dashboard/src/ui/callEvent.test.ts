import { describe, expect, it } from "vitest";
import { callEventText } from "./callEvent.js";

describe("callEventText", () => {
  it("mapeia os quatro desfechos", () => {
    expect(callEventText({ callOutcome: "completed", callDurationSeconds: 95 })).toBe("Ligação feita · 01:35");
    expect(callEventText({ callOutcome: "received", callDurationSeconds: 5 })).toBe("Ligação recebida · 00:05");
    expect(callEventText({ callOutcome: "unanswered", callDurationSeconds: 0 })).toBe("Ligação não atendida");
    expect(callEventText({ callOutcome: "missed", callDurationSeconds: 0 })).toBe("Ligação perdida");
  });

  it("sem duração não mostra relógio, e desfecho desconhecido cai no genérico", () => {
    expect(callEventText({ callOutcome: "completed", callDurationSeconds: 0 })).toBe("Ligação feita");
    expect(callEventText({})).toBe("Ligação de voz");
  });
});
