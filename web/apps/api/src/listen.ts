import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import type { RealtimeHub } from './realtime.js';
import { attachWebSocket } from './websocket.js';

/** Sobe um servidor HTTP por endereço, cada um com o seu WebSocket.
 *
 * São servidores distintos porque `listen` aceita **um** endereço: escutar em
 * dois exige dois. Eles compartilham o mesmo `app` e o mesmo `RealtimeHub`, de
 * modo que um evento publicado chega a quem estiver conectado por qualquer um.
 *
 * O caso que motiva isto é o webhook: o contêiner da WAHA alcança o host pelo
 * gateway da bridge (`host.docker.internal`), não pelo loopback. Escutar só em
 * `127.0.0.1` calaria a ingestão; escutar em `0.0.0.0` publica na rede local uma
 * API que não tem autenticação nenhuma.
 */
export async function listenOn(app: Express, hub: RealtimeHub, hosts: readonly string[], port: number): Promise<Server[]> {
  const servers: Server[] = [];
  for (const host of hosts) {
    const server = createServer(app);
    // O WebSocket entra só depois do `listen` dar certo: anexado antes, ele
    // observa um servidor que vai falhar, e o erro de bind escapa como não
    // tratado em vez de derrubar o arranque com a mensagem certa.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(new Error(`falha ao escutar em ${host}:${port} — ${error.message}`));
      server.once('error', onError);
      server.listen(port, host, () => { server.off('error', onError); resolve(); });
    });
    attachWebSocket(server, hub);
    servers.push(server);
  }
  return servers;
}
