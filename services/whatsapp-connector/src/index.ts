const keepAlive = setInterval(() => undefined, 2_147_483_647);
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(keepAlive);
  console.log(`[whatsapp-connector] Encerramento controlado por ${signal}.`);
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

console.log(
  "[whatsapp-connector] Conector ativo; integração com WhatsApp ainda não implementada.",
);
