import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorApiClient, ConnectorApiError } from "./client";

test("cliente usa apenas os endpoints próprios do conector", async () => {
  const calls: string[] = [];
  const client = new ConnectorApiClient("http://127.0.0.1:3001", async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ id: "chatpro-main", status: "stopped" }), { status: 200, headers: { "Content-Type": "application/json" } }); });
  assert.equal((await client.getStatus("chatpro-main")).status, "stopped");
  assert.deepEqual(calls, ["http://127.0.0.1:3001/instances/chatpro-main/status"]);
});
test("cliente normaliza erro retornado pelo conector", async () => {
  const client = new ConnectorApiClient("http://127.0.0.1:3001", async () => new Response(JSON.stringify({ error: { code: "unavailable", message: "Indisponível" } }), { status: 503, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(client.health(), (error: unknown) => error instanceof ConnectorApiError && error.code === "unavailable");
});
