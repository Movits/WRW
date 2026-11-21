import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAMINHO_DO_ASSETLINKS, IMPRESSOES_DO_APP, PACOTE_DO_APP, registrarAssetLinks } from "./assetlinks";

/**
 * O Digital Asset Links (server/assetlinks.ts): o Android só libera as chaves de
 * acesso do site dentro do app (M1) se este arquivo disser que o app é da WRW.
 * Ele precisa sair como JSON, com 200 e sem passar pelo index.html.
 */

let servidor: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  registrarAssetLinks(app);
  // O que vem depois no servidor de verdade: o estático, com o index.html para todo o resto.
  app.use("*", (_req, res) => res.type("text/html").send("<!doctype html>"));
  servidor = createServer(app);
  await new Promise<void>(resolve => servidor.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(resolve => servidor.close(() => resolve())));

describe("o assetlinks.json", () => {
  it("sai como JSON, com 200 e sem redirecionar, antes do index.html", async () => {
    const resposta = await fetch(`${base}${CAMINHO_DO_ASSETLINKS}`, { redirect: "manual" });
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toMatch(/^application\/json/);
    const corpo = await resposta.json();
    expect(Array.isArray(corpo)).toBe(true);
  });

  it("associa o app org.wrwglobal.app às credenciais do site", async () => {
    const [declaracao] = await (await fetch(`${base}${CAMINHO_DO_ASSETLINKS}`)).json();
    expect(declaracao.relation).toContain("delegate_permission/common.get_login_creds");
    expect(declaracao.target).toEqual({
      namespace: "android_app",
      package_name: "org.wrwglobal.app",
      sha256_cert_fingerprints: IMPRESSOES_DO_APP,
    });
  });

  // A pasta mobile/ nasce na #180: até ela chegar à main, este caso se pula.
  const APP_JSON = new URL("../mobile/app.json", import.meta.url);
  it.skipIf(!existsSync(APP_JSON))("o pacote é o mesmo do app.json do app", () => {
    const appJson = JSON.parse(readFileSync(APP_JSON, "utf8"));
    expect(PACOTE_DO_APP).toBe(appJson.expo.android.package);
  });

  it("toda impressão digital tem o formato que o Android aceita: 32 pares hexadecimais em maiúsculas", () => {
    expect(IMPRESSOES_DO_APP.length).toBeGreaterThan(0);
    for (const impressao of IMPRESSOES_DO_APP) {
      expect(impressao).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
    expect(new Set(IMPRESSOES_DO_APP).size).toBe(IMPRESSOES_DO_APP.length);
  });
});
