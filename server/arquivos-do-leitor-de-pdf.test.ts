import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARQUIVOS_DO_LEITOR_DE_PDF, arquivosDoLeitorDePdf, registrarArquivosDoLeitorDePdf } from "./_core/arquivos-do-leitor-de-pdf";

/**
 * Os arquivos do leitor de PDF (H12b) saem da node_modules por
 * /pdfjs/<versão>/...: os dois decodificadores de imagem, os mapas de
 * caracteres e as fontes padrão, só na versão instalada e sem sessão. Sem os
 * decodificadores, a página escaneada em preto e branco (JBIG2, CCITT) aparece
 * em branco; sem os mapas, o texto em chinês ou japonês de fonte não embutida.
 */
const requerer = createRequire(import.meta.url);
const { version: VERSAO } = requerer("pdfjs-dist/package.json") as { version: string };
const PASTA = path.dirname(requerer.resolve("pdfjs-dist/package.json"));

let servidor: Server;
let base = "";
beforeAll(async () => {
  const app = express();
  registrarArquivosDoLeitorDePdf(app);
  await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise(fim => servidor.close(fim)); });

describe("os arquivos do leitor de PDF", () => {
  it.each(ARQUIVOS_DO_LEITOR_DE_PDF)("%s sai inteiro, como JavaScript, com cache longo", async arquivo => {
    const resposta = await fetch(`${base}/pdfjs/${VERSAO}/${arquivo}`);
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(resposta.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(resposta.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await resposta.text()).toBe(fs.readFileSync(path.join(PASTA, "wasm", arquivo), "utf8"));
  });

  it("o pdf.js da tela pede exatamente estes nomes (se a biblioteca trocar, o teste acusa)", () => {
    const worker = fs.readFileSync(path.join(PASTA, "legacy", "build", "pdf.worker.mjs"), "utf8");
    for (const arquivo of ARQUIVOS_DO_LEITOR_DE_PDF) expect(worker).toContain(`"${arquivo}"`);
  });

  it("um mapa de caracteres do chinês e uma fonte padrão saem inteiros, como bytes", async () => {
    for (const nome of ["cmaps/UniGB-UCS2-H.bcmap", "standard_fonts/FoxitSerif.pfb", "standard_fonts/LiberationSans-Regular.ttf"]) {
      const resposta = await fetch(`${base}/pdfjs/${VERSAO}/${nome}`);
      expect(resposta.status, nome).toBe(200);
      expect(resposta.headers.get("content-type")).toBe("application/octet-stream");
      expect(resposta.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(Buffer.compare(Buffer.from(await resposta.arrayBuffer()), fs.readFileSync(path.join(PASTA, nome)))).toBe(0);
    }
  });

  it("o que a pasta tem e não é mapa nem fonte (as licenças), outra pasta, outra versão ou caminho para fora: 404", async () => {
    expect((await fetch(`${base}/pdfjs/0.0.1/${ARQUIVOS_DO_LEITOR_DE_PDF[0]}`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/0.0.1/cmaps/UniGB-UCS2-H.bcmap`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/openjpeg.wasm`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/wasm/openjpeg.wasm`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/cmaps/LICENSE`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/standard_fonts/LICENSE_FOXIT`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/legacy/build%2Fpdf.mjs`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/cmaps/..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/pdfjs/${VERSAO}/%2E%2E%2F%2E%2E%2Fpackage.json`)).status).toBe(404);
  });

  it("o nome pedido nunca vira caminho: só o que a leitura da pasta achou, com o nome no formato, entra no mapa", () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "leitor-de-pdf-"));
    try {
      fs.mkdirSync(path.join(pasta, "cmaps"));
      for (const nome of ["Adobe-Japan1-UCS2.bcmap", "LICENSE", "notas.txt", "x y.bcmap"]) fs.writeFileSync(path.join(pasta, "cmaps", nome), "x");
      // Sem a pasta das fontes: o leitor só fica sem elas.
      const mapa = arquivosDoLeitorDePdf({ pasta, versao: "1.0.0" });
      expect([...mapa.keys()].sort()).toEqual(["cmaps/Adobe-Japan1-UCS2.bcmap", ...ARQUIVOS_DO_LEITOR_DE_PDF].sort());
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });
});
