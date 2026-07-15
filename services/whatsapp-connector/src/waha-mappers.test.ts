import assert from "node:assert/strict";
import test from "node:test";
import { mapWahaError, mapWahaQrCode, mapWahaStatus } from "./waha-mappers.js";

test("normaliza estados WAHA para o contrato ChatPro", () => {
  assert.equal(mapWahaStatus("SCAN_QR"), "qr_ready"); assert.equal(mapWahaStatus("WORKING"), "connected"); assert.equal(mapWahaStatus("FAILED"), "disconnected"); assert.equal(mapWahaStatus("novo_estado"), "unknown");
});
test("normaliza QR Code sem expor formato WAHA", () => {
  assert.deepEqual(mapWahaQrCode("qa", { value: "temporary-value" }), { instanceId: "qa", status: "available", qrCode: "temporary-value" }); assert.deepEqual(mapWahaQrCode("qa", {}), { instanceId: "qa", status: "unavailable" });
});
test("normaliza erros WAHA", () => { assert.equal(mapWahaError(401).code, "unauthorized"); assert.equal(mapWahaError(404).code, "not_found"); assert.equal(mapWahaError(500).code, "unavailable"); });
