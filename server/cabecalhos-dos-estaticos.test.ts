import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheDoEstatico, serveStatic } from "./_core/vite";

/**
 * OS CABEÇALHOS DOS ARQUIVOS ESTÁTICOS EM PRODUÇÃO (serveStatic).
 *
 * O manifest do app instalável (client/public/manifest.webmanifest) diz onde o
 * app abre e quais ícones ele usa. Com o max-age de 1 h dos demais estáticos,
 * uma mudança nele chegaria uma hora depois a quem já abriu o site; por isso
 * sai com no-cache, que revalida pelo ETag. O tipo dele é
 * application/manifest+json, que o express.static já manda: o teste prende os
 * dois para uma atualização não os trocar sem ninguém ver.
 *
 * O teste sobe o serveStatic de verdade sobre uma pasta temporária, com o
 * manifest real, e lê os cabeçalhos da resposta HTTP.
 */

const MANIFEST = readFileSync(
  fileURLToPath(
    new URL("../client/public/manifest.webmanifest", import.meta.url)
  ),
  "utf8"
);

let pasta: string;
let servidor: Server;
let base: string;

beforeAll(async () => {
  pasta = mkdtempSync(join(tmpdir(), "wrw-estaticos-"));
  mkdirSync(join(pasta, "assets"));
  mkdirSync(join(pasta, "brand"));
  writeFileSync(join(pasta, "index.html"), "<!doctype html><title>WRW</title>");
  writeFileSync(join(pasta, "manifest.webmanifest"), MANIFEST);
  writeFileSync(join(pasta, "assets", "index-abc123.js"), "export {};");
  writeFileSync(join(pasta, "brand", "icon-192.png"), "png");
  writeFileSync(join(pasta, "robots.txt"), "User-agent: *");

  const app = express();
  serveStatic(app, pasta);
  servidor = createServer(app);
  await new Promise<void>(resolve => servidor.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => servidor.close(() => resolve()));
  rmSync(pasta, { recursive: true, force: true });
});

describe("o manifest do app instalável", () => {
  it("sai como application/manifest+json, sem cache longo e com o conteúdo de client/public", async () => {
    const resposta = await fetch(`${base}/manifest.webmanifest`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toMatch(
      /^application\/manifest\+json(;|$)/
    );
    expect(resposta.headers.get("cache-control")).toBe("no-cache");
    expect(resposta.headers.get("etag")).toBeTruthy();
    expect(await resposta.json()).toEqual(JSON.parse(MANIFEST));
  });

  it("revalida pelo ETag: a segunda visita recebe 304, sem baixar de novo", async () => {
    const primeira = await fetch(`${base}/manifest.webmanifest`);
    await primeira.arrayBuffer();
    const etag = primeira.headers.get("etag")!;
    // O Cache-Control explícito é por causa do fetch do Node: com If-None-Match
    // e sem ele, o fetch acrescenta "Cache-Control: no-cache" ao pedido, e um
    // pedido assim nunca recebe 304. O navegador revalida sem isso.
    const segunda = await fetch(`${base}/manifest.webmanifest`, {
      headers: { "If-None-Match": etag, "Cache-Control": "max-age=0" },
    });
    expect(segunda.status).toBe(304);
  });
});

describe("o cache dos demais estáticos continua o mesmo", () => {
  it.each([
    ["/assets/index-abc123.js", "public, max-age=31536000, immutable"],
    ["/brand/icon-192.png", "no-cache"],
    ["/robots.txt", "public, max-age=3600"],
    // O app instalado abre em /gravar: é o index.html, que nunca fica preso.
    ["/gravar", "no-cache"],
  ])("%s sai com %s", async (caminho, esperado) => {
    const resposta = await fetch(`${base}${caminho}`);
    await resposta.arrayBuffer();
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("cache-control")).toBe(esperado);
  });
});

describe("cacheDoEstatico", () => {
  it.each([
    "/app/dist/public/index.html",
    "/app/dist/public/manifest.webmanifest",
    "C:\\app\\dist\\public\\manifest.webmanifest",
    "/app/dist/public/brand/icon-512.png",
    "C:\\app\\dist\\public\\images\\hero-globo.webp",
  ])("%s: no-cache", caminho => {
    expect(cacheDoEstatico(caminho)).toBe("no-cache");
  });

  it.each([
    "/app/dist/public/robots.txt",
    "/app/dist/public/brand-nova.png",
    "/app/dist/public/manifest.json",
  ])("%s: vale o max-age de 1 h", caminho => {
    expect(cacheDoEstatico(caminho)).toBeUndefined();
  });
});
