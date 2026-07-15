import { loadConfig } from "./config.js";
import { createConnectorServer } from "./server.js";
import { WahaClient } from "./waha-client.js";
import { WahaProvider } from "./waha-provider.js";

const config = loadConfig();
const server = createConnectorServer(new WahaProvider(new WahaClient(config)));
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => { console.log(`[whatsapp-connector] Encerramento controlado por ${signal}.`); process.exit(0); });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
server.listen(config.port, config.host, () => console.log(`[whatsapp-connector] API local ativa em http://${config.host}:${config.port}.`));
