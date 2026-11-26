import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A rota dos avisos do Daily (sala de vídeo, V1), pelo HTTP de verdade. O
 * recebimento é um dublê injetado (o de verdade, no banco, está em
 * sala-de-video.integracao.test.ts). O express.json vem DEPOIS, como no
 * index.ts: a assinatura é conferida sobre o corpo cru, que tem de chegar
 * intacto à rota.
 */

const { ROTA_DO_WEBHOOK_DA_SALA, registrarRotaDoWebhookDaSala, tratarCorpoGrandeDoWebhookDaSala } = await import("./_core/rota-do-webhook-da-sala");
const { BancoIndisponivel } = await import("./banco-indisponivel");

const SEGREDO = Buffer.from("segredo-do-webhook-de-teste-32by").toString("base64");
const receber = vi.fn();
let servidor: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  registrarRotaDoWebhookDaSala(app, { receber });
  app.use(tratarCorpoGrandeDoWebhookDaSala);
  app.use(express.json({ limit: "5mb" }));
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

const ambienteAntes = { ...process.env };
beforeEach(() => {
  receber.mockReset();
  process.env.DAILY_API_KEY = "chave-de-teste";
  process.env.DAILY_DOMINIO = "marquesa";
  process.env.DAILY_WEBHOOK_SEGREDO = SEGREDO;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const nome of ["DAILY_API_KEY", "DAILY_DOMINIO", "DAILY_WEBHOOK_SEGREDO"]) {
    if (ambienteAntes[nome] === undefined) delete process.env[nome];
    else process.env[nome] = ambienteAntes[nome];
  }
  vi.restoreAllMocks();
});

// O corpo exatamente como o Daily manda, com espaços: a assinatura é sobre ESTES bytes.
const SAIU = '{ "version": "1.0.0", "type": "participant.left", "id": "e-1", "payload": { "room": "sala-abc", "session_id": "s-1", "user_id": "p-1", "joined_at": 1708972279.96, "duration": 125 }, "event_ts": 1708972405 }';

function assinar(corpo: string, momento = String(Math.floor(Date.now() / 1000)), segredo = SEGREDO) {
  const assinatura = crypto.createHmac("sha256", Buffer.from(segredo, "base64")).update(`${momento}.${corpo}`).digest("base64");
  return { "X-Webhook-Signature": assinatura, "X-Webhook-Timestamp": momento };
}
const enviar = (corpo: string, cabecalhos: Record<string, string> = assinar(corpo)) =>
  fetch(`${base}${ROTA_DO_WEBHOOK_DA_SALA}`, { method: "POST", headers: { "Content-Type": "application/json", ...cabecalhos }, body: corpo });

describe(`POST ${"/api/sala-de-video/avisos"}`, () => {
  it("o aviso assinado chega lido ao recebimento, com o corpo cru intacto (o express.json depois não o troca)", async () => {
    receber.mockResolvedValue("aplicado");
    const resposta = await enviar(SAIU);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ codigo: "APLICADO" });
    expect(receber).toHaveBeenCalledWith({ tipo: "saiu", sala: "sala-abc", pessoa: "p-1", sessao: "s-1", em: 1708972404960, segundos: 125 });
  });

  it("assinatura errada, de outro segredo ou ausente: 401 e nada muda", async () => {
    const outro = Buffer.from("outro-segredo-de-teste-com-32-by").toString("base64");
    for (const cabecalhos of [assinar(SAIU, undefined, outro), {}, { ...assinar(SAIU), "X-Webhook-Signature": "xx" }]) {
      const resposta = await enviar(SAIU, cabecalhos);
      expect(resposta.status).toBe(401);
      expect(await resposta.json()).toEqual({ codigo: "ASSINATURA" });
    }
    // O corpo trocado depois de assinado também.
    const resposta = await enviar(SAIU.replace("125", "9999"), assinar(SAIU));
    expect(resposta.status).toBe(401);
    expect(receber).not.toHaveBeenCalled();
  });

  it("o aviso velho (reenvio fora de 10 minutos) é recusado", async () => {
    const resposta = await enviar(SAIU, assinar(SAIU, String(Math.floor(Date.now() / 1000) - 11 * 60)));
    expect(resposta.status).toBe(401);
    expect(receber).not.toHaveBeenCalled();
  });

  it("o teste do Daily ao criar o webhook e os outros tipos de aviso: 200 sem efeito", async () => {
    for (const corpo of ['{"test":"test"}', '{"type":"recording.started","payload":{"room":"sala-abc"}}']) {
      const resposta = await enviar(corpo);
      expect(resposta.status).toBe(200);
      expect(await resposta.json()).toEqual({ codigo: "IGNORADO" });
    }
    expect(receber).not.toHaveBeenCalled();
  });

  it("sem DAILY_WEBHOOK_SEGREDO (ou sem a sala configurada): 404, nada entra", async () => {
    delete process.env.DAILY_WEBHOOK_SEGREDO;
    expect((await enviar(SAIU)).status).toBe(404);
    process.env.DAILY_WEBHOOK_SEGREDO = SEGREDO;
    delete process.env.DAILY_API_KEY;
    expect((await enviar(SAIU)).status).toBe(404);
    expect(receber).not.toHaveBeenCalled();
  });

  it("banco fora do ar é 503 (o Daily tenta de novo); outro erro é 500, sem detalhe", async () => {
    receber.mockRejectedValueOnce(new BancoIndisponivel());
    const fora = await enviar(SAIU);
    expect(fora.status).toBe(503);
    expect(await fora.json()).toEqual({ codigo: "BANCO_INDISPONIVEL" });
    receber.mockRejectedValueOnce(new Error("SELECT secreto"));
    const quebrou = await enviar(SAIU);
    expect(quebrou.status).toBe(500);
    expect(await quebrou.json()).toEqual({ codigo: "ERRO" });
  });

  it("corpo acima de 64 KB: 413 em JSON", async () => {
    const corpo = JSON.stringify({ type: "participant.left", payload: { room: "sala-abc", lixo: "x".repeat(70 * 1024) } });
    const resposta = await enviar(corpo);
    expect(resposta.status).toBe(413);
    expect(await resposta.json()).toEqual({ codigo: "GRANDE_DEMAIS" });
    expect(receber).not.toHaveBeenCalled();
  });
});
