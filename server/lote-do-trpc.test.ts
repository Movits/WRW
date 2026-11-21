import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { initTRPC } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHAMADAS_POR_LOTE_MAX, CHAMADAS_POR_LOTE_NO_NAVEGADOR } from "@shared/lote-do-trpc";

/**
 * O teto do lote do tRPC (shared/lote-do-trpc.ts): o limite da API conta o
 * lote como um pedido, e sem teto um pedido levava centenas de chamadas a um
 * procedimento caro. Com HTTP de verdade e um router mínimo: o lote do tamanho
 * do teto passa, e o maior é recusado inteiro, sem rodar nenhuma chamada. E a
 * montagem: server/_core/index.ts passa o teto ao tRPC, e o navegador corta os
 * lotes dele abaixo do teto.
 */

const t = initTRPC.create();
let chamadas = 0;
const router = t.router({
  ping: t.procedure.query(() => {
    chamadas += 1;
    return "pong";
  }),
});

let servidor: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use("/api/trpc", createExpressMiddleware({ router, createContext: () => ({}), maxBatchSize: CHAMADAS_POR_LOTE_MAX }));
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (servidor) await new Promise(fim => servidor.close(fim));
});

const lote = (quantas: number) => fetch(`${base}/api/trpc/${Array.from({ length: quantas }, () => "ping").join(",")}?batch=1`);

describe("o teto do lote do tRPC", () => {
  it(`${CHAMADAS_POR_LOTE_MAX} chamadas num lote passam; uma a mais recusa o lote inteiro, sem rodar nenhuma`, async () => {
    chamadas = 0;
    const cheio = await lote(CHAMADAS_POR_LOTE_MAX);
    expect(cheio.status).toBe(200);
    expect(chamadas).toBe(CHAMADAS_POR_LOTE_MAX);

    chamadas = 0;
    const demais = await lote(CHAMADAS_POR_LOTE_MAX + 1);
    expect(demais.status).toBe(400);
    expect(chamadas).toBe(0);
  });

  it("server/_core/index.ts monta o tRPC com o teto, e o navegador corta o lote abaixo dele", () => {
    const doServidor = readFileSync(new URL("./_core/index.ts", import.meta.url), "utf8");
    expect(doServidor).toMatch(/createExpressMiddleware\(\{[^}]*maxBatchSize: CHAMADAS_POR_LOTE_MAX,/);
    const doNavegador = readFileSync(new URL("../client/src/main.tsx", import.meta.url), "utf8");
    expect(doNavegador).toMatch(/httpBatchLink\(\{[^}]*maxItems: CHAMADAS_POR_LOTE_NO_NAVEGADOR,/);
    // A aba aberta antes do deploy não corta o lote: o teto do servidor fica acima do corte do navegador.
    expect(CHAMADAS_POR_LOTE_NO_NAVEGADOR).toBeLessThan(CHAMADAS_POR_LOTE_MAX);
  });
});
