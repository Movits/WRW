import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A rota binária do documento (H12), pelo HTTP de verdade. A autenticação e o
 * recebimento são dublês injetados (o recebimento de verdade, no banco, está em
 * documento-da-reuniao.integracao.test.ts); a conferência do "%PDF-" e do corpo
 * vazio roda com o receberDocumento real, que recusa antes de tocar no banco. O
 * express.json e o urlencoded vêm DEPOIS, como no index.ts.
 */

const { registrarRotaDoDocumento } = await import("./_core/rota-do-documento");
const { tratarCorpoGrandeDasPartes } = await import("./_core/rota-das-partes");
const { FalhaPassageiraDoDocumento, RecusaDoDocumento, receberDocumento } = await import("./documento-da-reuniao");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { criarTeto } = await import("./assistente-de-texto");
const { DOCUMENTO_BYTES_MAX, DOCUMENTOS_POR_HORA } = await import("@shared/documento-da-reuniao");

const autenticar = vi.fn();
const receber = vi.fn();
const ler = vi.fn();
let teto = criarTeto(DOCUMENTOS_POR_HORA, 60 * 60_000, "teto");
let reservas = 0;
let servidor: Server;
let base = "";
let porta = 0;
const REUNIAO = "0b6f2c1e-1111-4222-8333-944445555666";
const CAMINHO = `/api/reunioes/${REUNIAO}/documento`;

beforeAll(async () => {
  const app = express();
  registrarRotaDoDocumento(app, { autenticar, receber, ler, teto: { reservar: chave => { reservas++; return teto.reservar(chave); } } });
  app.use(tratarCorpoGrandeDasPartes);
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ limit: "5mb", extended: true }));
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  porta = (servidor.address() as AddressInfo).port;
  base = `http://127.0.0.1:${porta}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

beforeEach(() => {
  autenticar.mockReset();
  receber.mockReset();
  ler.mockReset();
  teto = criarTeto(DOCUMENTOS_POR_HORA, 60 * 60_000, "teto");
  autenticar.mockResolvedValue({ openId: "dona-1", onboardingCompleted: true });
  receber.mockResolvedValue({ repetido: false, trabalho: Promise.resolve() });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const PDF = Buffer.from("%PDF-1.7\n% conteúdo de teste\n%%EOF\n");
const enviar = (corpo: Buffer, caminho = CAMINHO) =>
  fetch(`${base}${caminho}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: corpo });

/**
 * Um pedido que declara `declarado` bytes e manda só o começo, sem nunca
 * terminar o corpo. Se a rota esperasse o corpo para responder, a resposta não
 * viria: ela vir prova que a decisão saiu antes da leitura.
 */
function pedidoQueNaoTermina(declarado: number): Promise<{ status: number; corpo: Record<string, unknown> }> {
  return new Promise((resolver, rejeitar) => {
    const pedido = http.request({
      host: "127.0.0.1", port: porta, path: CAMINHO, method: "POST",
      headers: { "Content-Type": "application/pdf", "Content-Length": String(declarado) },
    }, resposta => {
      let texto = "";
      resposta.on("data", pedaco => { texto += pedaco; });
      resposta.on("end", () => { resolver({ status: resposta.statusCode ?? 0, corpo: JSON.parse(texto) }); pedido.destroy(); });
    });
    pedido.on("error", erro => { if ((erro as NodeJS.ErrnoException).code !== "ECONNRESET") rejeitar(erro); });
    pedido.write(PDF);
    setTimeout(() => rejeitar(new Error("a rota esperou o corpo para responder")), 3000).unref();
  });
}

/** Espera o servidor fechar a resposta do próximo pedido que chegar (a conexão caiu, ou a resposta saiu). */
function fechamentoDoProximoPedido(): Promise<void> {
  return new Promise(fechou => servidor.once("request", (_req, res) => res.once("close", () => fechou())));
}

/**
 * A dona manda o PDF inteiro e derruba a conexão com o recebimento ainda em
 * curso (o PDF subindo ao bucket, a transação): o celular que perde a rede, a
 * aba fechada, ou de propósito. O recebimento só termina, aceito, DEPOIS de o
 * servidor ver a conexão fechada.
 */
async function envioQueCaiNoRecebimento(soltarORecebimento: Array<() => void>) {
  const fechou = fechamentoDoProximoPedido();
  const antes = receber.mock.calls.length;
  const pedido = http.request({
    host: "127.0.0.1", port: porta, path: CAMINHO, method: "POST",
    headers: { "Content-Type": "application/pdf", "Content-Length": String(PDF.length) },
  });
  pedido.on("error", () => {});
  pedido.end(PDF);
  await vi.waitFor(() => expect(receber).toHaveBeenCalledTimes(antes + 1));
  pedido.destroy();
  await fechou;
  soltarORecebimento.shift()!();
  await new Promise(resolve => setImmediate(resolve));
}

/** A dona começa a mandar o PDF e a conexão cai no meio do corpo: nada chega ao recebimento. */
async function envioQueCaiNoMeioDoCorpo() {
  const fechou = fechamentoDoProximoPedido();
  const antes = reservas;
  const pedido = http.request({
    host: "127.0.0.1", port: porta, path: CAMINHO, method: "POST",
    headers: { "Content-Type": "application/pdf", "Content-Length": "100000" },
  });
  pedido.on("error", () => {});
  pedido.write(PDF);
  await vi.waitFor(() => expect(reservas).toBe(antes + 1));
  pedido.destroy();
  await fechou;
}

describe("POST /api/reunioes/{id}/documento", () => {
  it("o PDF chega inteiro ao recebimento, com a dona da sessão; aceito, responde 202 e a leitura segue sozinha", async () => {
    const resposta = await enviar(PDF);
    expect(resposta.status).toBe(202);
    expect(await resposta.json()).toEqual({ codigo: "RECEBIDO", repetido: false });
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    const [chamada] = receber.mock.calls[0];
    expect(chamada).toMatchObject({ ownerId: "dona-1", meetingId: REUNIAO });
    expect(Buffer.compare(chamada.bytes, PDF)).toBe(0);
  });

  it("o mesmo arquivo de novo: 200, repetido", async () => {
    receber.mockResolvedValue({ repetido: true, trabalho: null });
    const resposta = await enviar(PDF);
    expect(resposta.status).toBe(200);
    expect(await resposta.json()).toEqual({ codigo: "RECEBIDO", repetido: true });
  });

  describe("autentica ANTES de ler o corpo", () => {
    it("sem sessão: 401 sem esperar o corpo, e nada é recebido", async () => {
      autenticar.mockRejectedValue(new Error("Invalid session cookie"));
      expect(await pedidoQueNaoTermina(10 * 1024 * 1024)).toEqual({ status: 401, corpo: { codigo: "SEM_SESSAO" } });
      expect(receber).not.toHaveBeenCalled();
    });

    it("banco fora ao ler a sessão: 503; cadastro incompleto e sessão de cron: 403", async () => {
      autenticar.mockRejectedValue(new BancoIndisponivel());
      expect(await pedidoQueNaoTermina(1000)).toEqual({ status: 503, corpo: { codigo: "BANCO_INDISPONIVEL" } });
      autenticar.mockResolvedValue({ openId: "dona-1", onboardingCompleted: false });
      expect(await pedidoQueNaoTermina(1000)).toEqual({ status: 403, corpo: { codigo: "CADASTRO_INCOMPLETO" } });
      autenticar.mockResolvedValue({ openId: "cron_x", isCron: true, onboardingCompleted: true });
      expect(await pedidoQueNaoTermina(1000)).toEqual({ status: 403, corpo: { codigo: "SEM_SESSAO" } });
      expect(receber).not.toHaveBeenCalled();
    });

    it("id de reunião fora do formato: 404 sem ler o corpo", async () => {
      const resposta = await enviar(PDF, "/api/reunioes/nao-e-um-id/documento");
      expect(resposta.status).toBe(404);
      expect(await resposta.json()).toEqual({ codigo: "SEM_REUNIAO" });
      expect(receber).not.toHaveBeenCalled();
    });
  });

  describe("até 15 MB", () => {
    it("o Content-Length acima de 15 MB é recusado com 413 sem ler o corpo nem gastar vaga", async () => {
      expect(await pedidoQueNaoTermina(DOCUMENTO_BYTES_MAX + 1)).toEqual({ status: 413, corpo: { codigo: "GRANDE_DEMAIS" } });
      expect(receber).not.toHaveBeenCalled();
      // As 10 vagas continuam livres.
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
    });

    it("exatamente 15 MB passa inteiro", async () => {
      const grande = Buffer.alloc(DOCUMENTO_BYTES_MAX, 0x20);
      PDF.copy(grande);
      const resposta = await enviar(grande);
      expect(resposta.status).toBe(202);
      expect(receber.mock.calls[0][0].bytes.length).toBe(DOCUMENTO_BYTES_MAX);
    });

    it("o corpo sem Content-Length que passa de 15 MB no meio da leitura também volta 413 em JSON", async () => {
      const pedacos = [Buffer.alloc(8 * 1000 * 1000, 0x20), Buffer.alloc(8 * 1000 * 1000, 0x20)];
      const corpo = new ReadableStream({ pull(controle) { const proximo = pedacos.shift(); if (proximo) controle.enqueue(proximo); else controle.close(); } });
      const resposta = await fetch(`${base}${CAMINHO}`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: corpo, duplex: "half" } as RequestInit);
      expect(resposta.status).toBe(413);
      expect(await resposta.json()).toEqual({ codigo: "GRANDE_DEMAIS" });
      expect(receber).not.toHaveBeenCalled();
    });
  });

  describe("confere o \"%PDF-\" (com o receberDocumento real, que recusa antes do banco)", () => {
    it("arquivo que não é PDF: 415 FORMATO; corpo vazio: 400 VAZIO", async () => {
      receber.mockImplementation(receberDocumento);
      const naoPdf = await enviar(Buffer.from("PK\u0003\u0004 um zip disfarçado"));
      expect(naoPdf.status).toBe(415);
      expect(await naoPdf.json()).toEqual({ codigo: "FORMATO" });
      const vazio = await enviar(Buffer.alloc(0));
      expect(vazio.status).toBe(400);
      expect(await vazio.json()).toEqual({ codigo: "VAZIO" });
    });
  });

  describe("no máximo 10 por hora", () => {
    it("o 11º documento aceito na hora é 429, sem ler o corpo nem chamar o recebimento", async () => {
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
      expect(await pedidoQueNaoTermina(1000)).toEqual({ status: 429, corpo: { codigo: "MUITOS_PEDIDOS" } });
      expect(receber).toHaveBeenCalledTimes(DOCUMENTOS_POR_HORA);
    });

    it("recusa, falha passageira e o mesmo arquivo de novo devolvem a vaga: só o documento aceito conta", async () => {
      receber.mockRejectedValueOnce(new RecusaDoDocumento("FORMATO", "x"));
      receber.mockRejectedValueOnce(new FalhaPassageiraDoDocumento("bucket"));
      receber.mockResolvedValueOnce({ repetido: true, trabalho: null });
      expect((await enviar(PDF)).status).toBe(415);
      expect((await enviar(PDF)).status).toBe(503);
      expect((await enviar(PDF)).status).toBe(200);
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
      expect((await enviar(PDF)).status).toBe(429);
    });

    it("a conexão que cai depois de o corpo chegar não devolve a vaga: o documento que o recebimento aceita depois conta, e o 11º da hora é 429", async () => {
      const soltar: Array<() => void> = [];
      receber.mockImplementation(() => new Promise(aceitar => { soltar.push(() => aceitar({ repetido: false, trabalho: Promise.resolve() })); }));
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) await envioQueCaiNoRecebimento(soltar);
      expect(await pedidoQueNaoTermina(1000)).toEqual({ status: 429, corpo: { codigo: "MUITOS_PEDIDOS" } });
      expect(receber).toHaveBeenCalledTimes(DOCUMENTOS_POR_HORA);
    });

    it("a queda depois do corpo e o reenvio do mesmo arquivo pela tela (repetido): o documento gasta uma vaga, nem zero nem duas", async () => {
      const soltar: Array<() => void> = [];
      receber.mockImplementationOnce(() => new Promise(aceitar => { soltar.push(() => aceitar({ repetido: false, trabalho: Promise.resolve() })); }));
      await envioQueCaiNoRecebimento(soltar);
      receber.mockResolvedValueOnce({ repetido: true, trabalho: null });
      expect((await enviar(PDF)).status).toBe(200);
      receber.mockResolvedValue({ repetido: false, trabalho: Promise.resolve() });
      for (let i = 1; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
      expect(await pedidoQueNaoTermina(1000)).toEqual({ status: 429, corpo: { codigo: "MUITOS_PEDIDOS" } });
    });

    it("…e a recusa que chega depois da queda ainda devolve a vaga", async () => {
      const soltar: Array<() => void> = [];
      receber.mockImplementation(() => new Promise((_aceitar, recusar) => { soltar.push(() => recusar(new RecusaDoDocumento("FORA_DO_ESTADO", "x"))); }));
      await envioQueCaiNoRecebimento(soltar);
      receber.mockResolvedValue({ repetido: false, trabalho: Promise.resolve() });
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
    });

    it("a conexão que cai no meio do envio do corpo devolve a vaga: nada foi recebido", async () => {
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) await envioQueCaiNoMeioDoCorpo();
      expect(receber).not.toHaveBeenCalled();
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
    });

    it("o teto é por dona", async () => {
      for (let i = 0; i < DOCUMENTOS_POR_HORA; i++) expect((await enviar(PDF)).status).toBe(202);
      autenticar.mockResolvedValue({ openId: "dona-2", onboardingCompleted: true });
      expect((await enviar(PDF)).status).toBe(202);
    });
  });

  describe("as recusas saem como código, que a tela traduz", () => {
    it.each([
      ["SEM_REUNIAO", 404], ["FORA_DO_ESTADO", 409], ["CONTEUDO_DIFERENTE", 409], ["GRANDE_DEMAIS", 413], ["VAZIO", 400], ["FORMATO", 415],
    ] as const)("%s → %i", async (codigo, status) => {
      receber.mockRejectedValue(new RecusaDoDocumento(codigo, "frase do log"));
      const resposta = await enviar(PDF);
      expect(resposta.status).toBe(status);
      expect(await resposta.json()).toEqual({ codigo });
    });

    it("bucket fora: 503 TENTE_DE_NOVO; banco fora: 503 BANCO_INDISPONIVEL; o resto: 500 ERRO, sem a mensagem interna", async () => {
      receber.mockRejectedValueOnce(new FalhaPassageiraDoDocumento("bucket"));
      expect(await (await enviar(PDF)).json()).toEqual({ codigo: "TENTE_DE_NOVO" });
      receber.mockRejectedValueOnce(new BancoIndisponivel());
      const banco = await enviar(PDF);
      expect(banco.status).toBe(503);
      expect(await banco.json()).toEqual({ codigo: "BANCO_INDISPONIVEL" });
      receber.mockRejectedValueOnce(new Error("detalhe interno com a chave meetings/dona-1/x"));
      const erro = await enviar(PDF);
      expect(erro.status).toBe(500);
      expect(await erro.text()).toBe(JSON.stringify({ codigo: "ERRO" }));
    });
  });
});

describe("GET /api/reunioes/{id}/documento: o PDF guardado, só para a dona", () => {
  const ver = (caminho = CAMINHO) => fetch(`${base}${caminho}`);

  it("a dona recebe os bytes como PDF, na mesma origem, sem cache compartilhado", async () => {
    ler.mockResolvedValue(PDF);
    const resposta = await ver();
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("application/pdf");
    expect(resposta.headers.get("cache-control")).toBe("private, no-store");
    expect(resposta.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.compare(Buffer.from(await resposta.arrayBuffer()), PDF)).toBe(0);
    expect(ler).toHaveBeenCalledWith("dona-1", REUNIAO);
  });

  it("sem sessão: 401, e nada é lido do bucket", async () => {
    autenticar.mockRejectedValue(new Error("Invalid session cookie"));
    const resposta = await ver();
    expect(resposta.status).toBe(401);
    expect(await resposta.json()).toEqual({ codigo: "SEM_SESSAO" });
    expect(ler).not.toHaveBeenCalled();
  });

  it("cadastro incompleto: 403; id fora do formato: 404, sem leitura", async () => {
    autenticar.mockResolvedValue({ openId: "dona-1", onboardingCompleted: false });
    expect((await ver()).status).toBe(403);
    autenticar.mockResolvedValue({ openId: "dona-1", onboardingCompleted: true });
    expect((await ver("/api/reunioes/nao-e-um-id/documento")).status).toBe(404);
    expect(ler).not.toHaveBeenCalled();
  });

  it("vencido, excluído ou de outra dona (o leitor devolve null): 404 SEM_DOCUMENTO, sem dizer qual", async () => {
    ler.mockResolvedValue(null);
    const resposta = await ver();
    expect(resposta.status).toBe(404);
    expect(await resposta.json()).toEqual({ codigo: "SEM_DOCUMENTO" });
  });

  it("banco fora: 503 BANCO_INDISPONIVEL; bucket fora: 503 TENTE_DE_NOVO, sem a mensagem interna", async () => {
    ler.mockRejectedValueOnce(new BancoIndisponivel());
    const banco = await ver();
    expect(banco.status).toBe(503);
    expect(await banco.json()).toEqual({ codigo: "BANCO_INDISPONIVEL" });
    ler.mockRejectedValueOnce(new Error("detalhe do bucket com a chave meetings/dona-1/x"));
    const bucket = await ver();
    expect(bucket.status).toBe(503);
    expect(await bucket.text()).toBe(JSON.stringify({ codigo: "TENTE_DE_NOVO" }));
  });

  it("ler não gasta vaga do teto de envios", async () => {
    ler.mockResolvedValue(PDF);
    for (let i = 0; i < DOCUMENTOS_POR_HORA + 2; i++) expect((await ver()).status).toBe(200);
    expect((await enviar(PDF)).status).toBe(202);
  });
});
