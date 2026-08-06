/** Texto da notificação de chamada na timeline (messageType "call").
 *  O resultado sai do metadata gravado pelo CallLogService: feita/recebida
 *  com duração, não atendida e perdida sem. */
export const callEventText = (metadata: Record<string, unknown>): string => {
  const seconds = typeof metadata.callDurationSeconds === "number" ? metadata.callDurationSeconds : 0;
  const duration = seconds > 0 ? ` · ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : "";
  switch (metadata.callOutcome) {
    case "completed": return `Ligação feita${duration}`;
    case "unanswered": return "Ligação não atendida";
    case "received": return `Ligação recebida${duration}`;
    case "missed": return "Ligação perdida";
    default: return "Ligação de voz";
  }
};
