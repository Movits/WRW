import express from "express";
import type { NextFunction, Request, Response } from "express";

// Procedimentos que recebem arquivo em base64 no corpo (até 10 MB de arquivo,
// ~14 MB no JSON). Os recortes por caminho em server/_core/index.ts
// ("/api/trpc/dealRoom.uploadDocument") só casam com a chamada isolada: o
// httpBatchLink do client junta chamadas simultâneas numa URL só
// ("/api/trpc/dealRoom.uploadDocument,dealRoom.listDocuments"), o mount por
// prefixo não reconhece a lista, e o corpo caía no parser global de 5 MB, que
// devolvia 413 cru antes de o tRPC validar. Achado da revisão de 05/09 (PR #59).
export const PROCEDIMENTOS_COM_ARQUIVO = new Set([
  // As fotos e os desenhos do resumo (H4g e H4h).
  "meetings.anexarAoResumo",
  "contexts.uploadMedia",
  "network.uploadPhoto",
  "network.uploadCard",
  "dealRoom.uploadDocument",
  "sivc.uploadDocument",
]);

const PREFIXO = "/api/trpc/";
const jsonGrande = express.json({ limit: "15mb" });

/** Procedimentos de uma URL do tRPC, simples ("a") ou em lote ("a,b,c"). */
export function procedimentosDaUrl(caminho: string): string[] {
  if (!caminho.startsWith(PREFIXO)) return [];
  const resto = caminho.slice(PREFIXO.length).split("?")[0];
  return resto.split(",").map(p => p.trim()).filter(Boolean);
}

/**
 * Aplica o parser de 15 MB quando a URL do tRPC inclui um procedimento com
 * arquivo, esteja ele sozinho ou dentro de um lote. Depois de parseado, o
 * body-parser marca o pedido e os parsers seguintes (inclusive o global de
 * 5 MB) não o leem de novo.
 */
export function corpoGrandeParaUploads(req: Request, res: Response, next: NextFunction) {
  const procedimentos = procedimentosDaUrl(req.path);
  if (procedimentos.some(p => PROCEDIMENTOS_COM_ARQUIVO.has(p))) return jsonGrande(req, res, next);
  next();
}
