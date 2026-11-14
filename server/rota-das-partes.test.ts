import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A rota binária das partes (G5), pelo HTTP de verdade. A autenticação e o
 * recebimento são dublês injetados; o recebimento de verdade, no banco, está em
 * fatias-de-reuniao.integracao.test.ts. O express.json e o urlencoded vêm
 * DEPOIS, como no index.ts: o corpo binário tem de chegar inteiro à rota.
 */

const { registrarRotaDasPartes, tratarCorpoGrandeDasPartes } = await import("./_core/rota-das-partes");
const { FalhaPassageiraDaParte, RecusaDaParte, TAMANHO_MAXIMO_DA_PARTE } = await import("./fatias-de-reuniao");
const { BancoIndisponivel } = await import("./banco-indisponivel");

const autenticar = vi.fn();
const receber = vi.fn();
let servidor: Server;
let base = "";
const REUNIAO = "0b6f2c1e-1111-4222-8333-944445555666";

beforeAll(async () => {
  const app = express();
  registrarRotaDasPartes(app, { autenticar, receber });
  app.use(tratarCorpoGrandeDasPartes);
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ limit: "5mb", extended: true }));
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

let dona = 0;
beforeEach(() => {
  autenticar.mockReset();
  receber.mockReset();
  // Uma dona por teste: o teto de pedidos é por dona e vive no módulo.
  dona += 1;
  autenticar.mockResolvedValue({ openId: `dona-${dona}`, onboardingCompleted: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const enviar = (corpo: Buffer, caminho = `/api/reunioes/${REUNIAO}/partes/3`, tipo = "audio/mp4") =>
  fetch(`${base}${caminho}`, { method: "POST", headers: { "Content-Type": tipo }, body: corpo });

describe("POST /api/reunioes/{id}/partes/{seq}", () => {
  it("o corpo binário chega inteiro ao recebimento (o express.json depois não o lê), com a dona da sessão", async () => {
    receber.mockResolvedValue({ seq: 3, repetida: false });
    const audio = Buffer.from([0, 1, 2, 250, 251, 252, 0x7b, 0x7d]);
    const resposta = await enviar(audio, undefined, "audio/mp4");
    expect(resposta.status).toBe(201);
    expect(await resposta.json()).toEqual({ codigo: "RECEBIDA", seq: 3, repetida: false });
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    const chamada = receber.mock.calls[0][0];
    expect(chamada).toMatchObject({ ownerId: `dona-${dona}`, meetingId: REUNIAO, seq: 3, mimeType: "audio/mp4" });
    expect(Buffer.compare(chamada.bytes, audio)).toBe(0);
  });

  it("a mesma parte reenviada: 200, repetida", async () => {
    receber.mockResolvedValue({ seq: 3, repetida: true });
    const resposta = await enviar(Buffer.from("x"));
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toMatchObject({ repetida: true });
  });

  it("sem sessão: 401, sem receber nada; banco fora na sessão: 503", async () => {
    autenticar.mockRejectedValue(new Error("Invalid session cookie"));
    expect((await enviar(Buffer.from("x"))).status).toBe(401);
    autenticar.mockRejectedValue(new BancoIndisponivel());
    const fora = await enviar(Buffer.from("x"));
    expect(fora.status).toBe(503);
    expect(await fora.json()).toEqual({ codigo: "BANCO_INDISPONIVEL" });
    expect(receber).not.toHaveBeenCalled();
  });

  it("cadastro não concluído e sessão de cron: 403", async () => {
    autenticar.mockResolvedValue({ openId: "x", onboardingCompleted: false });
    expect(await (await enviar(Buffer.from("x"))).json()).toEqual({ codigo: "CADASTRO_INCOMPLETO" });
    autenticar.mockResolvedValue({ openId: "cron_x", onboardingCompleted: true, isCron: true });
    expect((await enviar(Buffer.from("x"))).status).toBe(403);
    expect(receber).not.toHaveBeenCalled();
  });

  it("id de reunião ou posição fora do formato: 400, sem ir ao banco", async () => {
    expect((await enviar(Buffer.from("x"), "/api/reunioes/nao-e-uuid/partes/1")).status).toBe(400);
    expect((await enviar(Buffer.from("x"), `/api/reunioes/${REUNIAO}/partes/-1`)).status).toBe(400);
    expect((await enviar(Buffer.from("x"), `/api/reunioes/${REUNIAO}/partes/12345`)).status).toBe(400);
    expect(receber).not.toHaveBeenCalled();
  });

  it.each([
    ["SEM_REUNIAO", 404], ["FORA_DO_ESTADO", 409], ["CONTEUDO_DIFERENTE", 409], ["GRANDE_DEMAIS", 413],
    ["LONGA_DEMAIS", 413], ["FORMATO", 415], ["SEM_DURACAO", 422], ["POSICAO", 400],
  ] as const)("recusa %s vira %i com o código, e a mensagem não sai", async (codigo, status) => {
    receber.mockRejectedValue(new RecusaDaParte(codigo, "frase interna"));
    const resposta = await enviar(Buffer.from("x"));
    expect(resposta.status).toBe(status);
    expect(await resposta.json()).toEqual({ codigo });
  });

  it("bucket fora e banco fora são passageiros (503); erro desconhecido é 500 sem detalhe", async () => {
    receber.mockRejectedValueOnce(new FalhaPassageiraDaParte("bucket"));
    expect(await (await enviar(Buffer.from("x"))).json()).toEqual({ codigo: "TENTE_DE_NOVO" });
    receber.mockRejectedValueOnce(new BancoIndisponivel());
    expect((await enviar(Buffer.from("x"))).status).toBe(503);
    receber.mockRejectedValueOnce(new Error("Failed query: select ... segredo"));
    const erro = await enviar(Buffer.from("x"));
    expect(erro.status).toBe(500);
    expect(JSON.stringify(await erro.json())).not.toContain("segredo");
  });

  it("corpo acima do teto: 413 em JSON, antes de chegar ao recebimento", async () => {
    const resposta = await enviar(Buffer.alloc(TAMANHO_MAXIMO_DA_PARTE + 2048));
    expect(resposta.status).toBe(413);
    expect(await resposta.json()).toEqual({ codigo: "GRANDE_DEMAIS" });
    expect(receber).not.toHaveBeenCalled();
  });

  it("teto de pedidos por dona: o 61º em 10 min é 429 e não recebe", async () => {
    receber.mockResolvedValue({ seq: 3, repetida: true });
    for (let i = 0; i < 60; i++) expect((await enviar(Buffer.from("x"))).status).toBe(200);
    const excedente = await enviar(Buffer.from("x"));
    expect(excedente.status).toBe(429);
    expect(await excedente.json()).toEqual({ codigo: "MUITOS_PEDIDOS" });
    expect(receber).toHaveBeenCalledTimes(60);
  });
});
