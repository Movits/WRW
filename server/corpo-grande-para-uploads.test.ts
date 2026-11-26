import express from "express";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corpoGrandeParaUploads, PROCEDIMENTOS_COM_ARQUIVO, procedimentosDaUrl } from "./_core/corpo-grande-para-uploads";

// A URL de lote do httpBatchLink ("a,b") não casa com o mount por caminho
// ("/api/trpc/a"): sem este middleware, um upload dentro de um lote caía no
// parser global de 5 MB e voltava 413 antes de o tRPC validar.

describe("procedimentosDaUrl", () => {
  it("lê o procedimento isolado e a lista do lote", () => {
    expect(procedimentosDaUrl("/api/trpc/dealRoom.uploadDocument")).toEqual(["dealRoom.uploadDocument"]);
    expect(procedimentosDaUrl("/api/trpc/dealRoom.uploadDocument,dealRoom.listDocuments")).toEqual([
      "dealRoom.uploadDocument",
      "dealRoom.listDocuments",
    ]);
  });

  it("ignora o que não é rota do tRPC", () => {
    expect(procedimentosDaUrl("/manus-storage/x")).toEqual([]);
    expect(procedimentosDaUrl("/")).toEqual([]);
  });
});

describe("corpoGrandeParaUploads", () => {
  let servidor: Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    // Mesma ordem de server/_core/index.ts: o recorte antes do parser global.
    app.use(corpoGrandeParaUploads);
    app.use(express.json({ limit: "5mb" }));
    app.post("/api/trpc/*", (req, res) => {
      res.json({ bytes: JSON.stringify(req.body).length });
    });
    servidor = createServer(app);
    await new Promise<void>(resolve => servidor.listen(0, "127.0.0.1", resolve));
    const endereco = servidor.address();
    base = typeof endereco === "object" && endereco ? `http://127.0.0.1:${endereco.port}` : "";
  });

  afterAll(async () => {
    await new Promise<void>(resolve => servidor.close(() => resolve()));
  });

  const corpoDe = (megabytes: number) => JSON.stringify({ json: { fileBase64: "a".repeat(megabytes * 1024 * 1024) } });

  const enviar = (caminho: string, corpo: string) =>
    fetch(base + caminho, { method: "POST", headers: { "content-type": "application/json" }, body: corpo });

  it("aceita 7 MB num lote que contém um procedimento com arquivo", async () => {
    const r = await enviar("/api/trpc/dealRoom.uploadDocument,dealRoom.listDocuments", corpoDe(7));
    expect(r.status).toBe(200);
  });

  it("aceita 7 MB no procedimento com arquivo sozinho", async () => {
    const r = await enviar("/api/trpc/sivc.uploadDocument", corpoDe(7));
    expect(r.status).toBe(200);
  });

  it("mantém os 5 MB do parser global para os demais procedimentos", async () => {
    const r = await enviar("/api/trpc/dealRoom.listDocuments", corpoDe(7));
    expect(r.status).toBe(413);
  });
});

// Os SEIS procedimentos de upload em base64 (server/CLAUDE.md, "Boot e
// uploads"): os mesmos no recorte por caminho de server/_core/index.ts e na
// lista do lote. O meetings.submitRecording (o envio único) saiu dos dois na
// G14, parte 2 (25/11/2026): o áudio da reunião chega só pela rota binária das partes.
describe("os procedimentos de upload", () => {
  const indice = readFileSync(path.resolve(process.cwd(), "server/_core/index.ts"), "utf8");
  const recortes = Array.from(indice.matchAll(/app\.use\("\/api\/trpc\/([\w.]+)", express\.json\(\{ limit: "15mb" \}\)\)/g), m => m[1]).sort();

  it("são seis, os mesmos na lista do lote e nos recortes por caminho", () => {
    expect([...PROCEDIMENTOS_COM_ARQUIVO].sort()).toEqual([
      "contexts.uploadMedia", "dealRoom.uploadDocument", "meetings.anexarAoResumo", "network.uploadCard", "network.uploadPhoto", "sivc.uploadDocument",
    ]);
    expect(recortes).toEqual([...PROCEDIMENTOS_COM_ARQUIVO].sort());
  });

  it("o envio único não tem mais o parser de 15 MB, nem sozinho nem no lote", () => {
    expect(indice).not.toContain("meetings.submitRecording");
    expect(PROCEDIMENTOS_COM_ARQUIVO.has("meetings.submitRecording")).toBe(false);
  });
});
