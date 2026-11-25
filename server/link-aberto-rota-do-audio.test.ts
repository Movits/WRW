import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As rotas Express do link aberto, pelo HTTP de verdade: o áudio pelo token
 * (307 para a URL assinada, sem sessão) e a página /r/{token} fora dos
 * buscadores. A busca da chave e a assinatura são dublês injetados; a busca de
 * verdade, no banco, está em link-aberto-da-reuniao.integracao.test.ts.
 */

const { registrarRotasDoLinkAberto } = await import("./link-aberto-da-reuniao");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { MENSAGEM_BANCO_INDISPONIVEL } = await import("@shared/const");

const acharChave = vi.fn<(token: string) => Promise<string | null>>();
const assinar = vi.fn<(chave: string) => Promise<string>>();
let servidor: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  registrarRotasDoLinkAberto(app, { acharChave, assinar });
  // A página da SPA, servida depois, como o Vite e o estático fazem.
  app.get("/r/:token", (_req, res) => { res.send("pagina"); });
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });
beforeEach(() => {
  acharChave.mockReset();
  assinar.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const pedir = (caminho: string) => fetch(`${base}${caminho}`, { redirect: "manual" });

describe("GET /reuniao-aberta/{token}/audio", () => {
  it("link ligado com gravação: 307 para a URL assinada, sem cache e fora dos buscadores", async () => {
    acharChave.mockResolvedValue("meetings/dona/m-1/recording.mp4");
    assinar.mockResolvedValue("https://bucket.exemplo/assinada?x=1");
    const resposta = await pedir(`/reuniao-aberta/${"A".repeat(32)}/audio`);
    expect(resposta.status).toBe(307);
    expect(resposta.headers.get("location")).toBe("https://bucket.exemplo/assinada?x=1");
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(resposta.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(acharChave).toHaveBeenCalledWith("A".repeat(32), undefined);
    expect(assinar).toHaveBeenCalledWith("meetings/dona/m-1/recording.mp4");
  });

  it("a reunião em partes toca cada parte por ?parte; valor estranho vale a primeira (D1)", async () => {
    acharChave.mockResolvedValue("meetings/dona/m-1/partes/0002-abc.m4a");
    assinar.mockResolvedValue("https://bucket.exemplo/p2");
    const resposta = await pedir(`/reuniao-aberta/${"A".repeat(32)}/audio?parte=2`);
    expect(resposta.status).toBe(307);
    expect(acharChave).toHaveBeenCalledWith("A".repeat(32), 2);
    await pedir(`/reuniao-aberta/${"A".repeat(32)}/audio?parte=../../x`);
    expect(acharChave).toHaveBeenLastCalledWith("A".repeat(32), undefined);
  });

  it("link desligado, sem gravação ou vencido: 404, sem assinar nada", async () => {
    acharChave.mockResolvedValue(null);
    const resposta = await pedir("/reuniao-aberta/qualquer/audio");
    expect(resposta.status).toBe(404);
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(assinar).not.toHaveBeenCalled();
  });

  it("banco fora do ar não é 'link desligado': 503 com a frase do banco", async () => {
    acharChave.mockRejectedValue(new BancoIndisponivel());
    const resposta = await pedir(`/reuniao-aberta/${"A".repeat(32)}/audio`);
    expect(resposta.status).toBe(503);
    expect(await resposta.text()).toBe(MENSAGEM_BANCO_INDISPONIVEL);
    expect(assinar).not.toHaveBeenCalled();
  });

  it("outra falha na busca: 500, não 404", async () => {
    acharChave.mockRejectedValue(new Error("falha qualquer"));
    expect((await pedir(`/reuniao-aberta/${"A".repeat(32)}/audio`)).status).toBe(500);
  });

  it("storage fora do ar na assinatura: 503", async () => {
    acharChave.mockResolvedValue("meetings/dona/m-1/recording.mp4");
    assinar.mockRejectedValue(new Error("STORAGE_* ausente"));
    expect((await pedir(`/reuniao-aberta/${"A".repeat(32)}/audio`)).status).toBe(503);
  });
});

describe("a página /r/{token}", () => {
  it("segue para a aplicação, marcada para os buscadores não guardarem", async () => {
    const resposta = await pedir(`/r/${"A".repeat(32)}`);
    expect(resposta.status).toBe(200);
    expect(await resposta.text()).toBe("pagina");
    expect(resposta.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("o convite (/convite/{token}) e a reunião compartilhada (R1b) também ganham a marca", async () => {
    for (const caminho of [`/convite/${"B".repeat(32)}`, "/reunioes-compartilhadas/00000000-0000-4000-8000-000000000000"]) {
      const resposta = await pedir(caminho);
      expect(resposta.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("o convite da equipe (/convite-da-equipe/{token}) e as páginas da equipe (R2) também ganham a marca", async () => {
    for (const caminho of [`/convite-da-equipe/${"C".repeat(32)}`, "/equipes/00000000-0000-4000-8000-000000000000", "/equipes/00000000-0000-4000-8000-000000000000/reunioes/00000000-0000-4000-8000-000000000001"]) {
      const resposta = await pedir(caminho);
      expect(resposta.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });

  it("outras páginas não ganham a marca", async () => {
    const app = express();
    registrarRotasDoLinkAberto(app, { acharChave, assinar });
    app.get("/rede", (_req, res) => { res.send("ok"); });
    const outro = await new Promise<Server>(pronto => { const s = app.listen(0, "127.0.0.1", () => pronto(s)); });
    try {
      const resposta = await fetch(`http://127.0.0.1:${(outro.address() as AddressInfo).port}/rede`);
      expect(resposta.headers.get("x-robots-tag")).toBeNull();
    } finally {
      await new Promise(fim => outro.close(fim));
    }
  });
});

describe("o log da rota do áudio não leva o token", () => {
  it("o erro da consulta traz o token nos parâmetros e na mensagem; o log só a descrição, sem ele", async () => {
    const token = "Tk".repeat(16);
    // Como o DrizzleQueryError: a mensagem cita os parâmetros, e o SQL fica em `query`.
    const consulta = Object.assign(new Error(`Failed query: select ... where share_token = ?\nparams: ${token}`), {
      query: "select ... where share_token = ?",
      params: [token],
      cause: Object.assign(new Error("Table 'meetings' is marked as crashed"), { code: "ER_CRASHED_ON_USAGE" }),
    });
    acharChave.mockRejectedValue(consulta);
    expect((await pedir(`/reuniao-aberta/${token}/audio`)).status).toBe(500);
    const registrado = vi.mocked(console.error).mock.calls.map(c => c.map(String).join(" ")).join("\n");
    expect(registrado).toContain("[LinkAberto]");
    expect(registrado).toContain("ER_CRASHED_ON_USAGE");
    expect(registrado).not.toContain(token);
  });
});

describe("a credencial da participante (R1b) na rota do áudio", () => {
  it("a conta logada chega à busca da chave pelo contexto do pedido; sem ela, nada (o 404 do link desligado)", async () => {
    const { leitoraDoPedido } = await import("./senha-do-link-aberto");
    const app = express();
    const vistas: Array<unknown> = [];
    const lerLeitora = vi.fn(async (_req: unknown, token: string) => (token.startsWith("participante:") ? { id: 7, openId: "conta-7" } : null));
    registrarRotasDoLinkAberto(app, {
      acharChave: async () => { vistas.push(leitoraDoPedido()); return vistas.length === 1 ? "meetings/dona/m-1/recording.mp4" : null; },
      assinar: async () => "https://bucket.exemplo/assinada",
      lerLeitora,
    });
    const outro = await new Promise<Server>(pronto => { const s = app.listen(0, "127.0.0.1", () => pronto(s)); });
    try {
      const em = `http://127.0.0.1:${(outro.address() as AddressInfo).port}`;
      const credencial = "participante:8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
      expect((await fetch(`${em}/reuniao-aberta/${credencial}/audio`, { redirect: "manual" })).status).toBe(307);
      expect((await fetch(`${em}/reuniao-aberta/${"A".repeat(32)}/audio`, { redirect: "manual" })).status).toBe(404);
      expect(vistas).toEqual([{ id: 7, openId: "conta-7" }, null]);
      expect(lerLeitora.mock.calls.map(([, token]) => token)).toEqual([credencial, "A".repeat(32)]);
    } finally {
      await new Promise(fim => outro.close(fim));
    }
  });
});
