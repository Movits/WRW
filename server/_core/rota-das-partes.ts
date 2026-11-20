import express, { type Express, type Request, type Response } from "express";
import { ehErroDeBancoIndisponivel, descreverErroDeBanco } from "../banco-indisponivel";
import { FalhaPassageiraDaParte, RecusaDaParte, receberParte, TAMANHO_MAXIMO_DA_PARTE, type CodigoDaRecusa } from "../fatias-de-reuniao";
import { criarTeto } from "../assistente-de-texto";
import { TRPCError } from "@trpc/server";
import { sdk } from "./sdk";

/**
 * A rota binária das partes da reunião gravada em partes (G5 do desenho do
 * gravador): `POST /api/reunioes/{meetingId}/partes/{seq}`, com o áudio cru no
 * corpo e o tipo no Content-Type. Base64 dentro do JSON do tRPC custaria um
 * terço a mais de rede e a memória do processo inteiro; por isso a rota é
 * Express e é montada ANTES do express.json (server/_core/index.ts), que senão
 * leria o corpo primeiro.
 *
 * A resposta é sempre JSON `{ codigo, ... }`, e o `codigo` é o que a tela (G9)
 * traduz: as mensagens daqui são para o log. Falha passageira (bucket, banco,
 * teto de pedidos) é 429 ou 503, e a tela reenvia a mesma parte depois; recusa
 * definitiva é 4xx, e reenviar não muda nada.
 */

export const ROTA_DAS_PARTES = "/api/reunioes/:meetingId/partes/:seq";

const STATUS_DA_RECUSA: Record<CodigoDaRecusa, number> = {
  SEM_REUNIAO: 404,
  FORA_DO_ESTADO: 409,
  CONTEUDO_DIFERENTE: 409,
  GRANDE_DEMAIS: 413,
  LONGA_DEMAIS: 413,
  FORMATO: 415,
  SEM_DURACAO: 422,
  POSICAO: 400,
};

// Uma parte a cada ~10 min por gravação; o teto cobre reenvios e algumas
// gravações ao mesmo tempo, e barra quem martela a rota. O MP3 importado em
// partes (H9a) manda as partes uma atrás da outra, na velocidade da rede: o de
// 12 h a 320 kbps tem 118 partes de 14 MB, e por isso o teto é de 120 (eram 60).
export const PARTES_POR_DONA_EM_10_MIN = 120;
const tetoDasPartes = criarTeto(PARTES_POR_DONA_EM_10_MIN, 10 * 60_000, "Muitas partes enviadas em pouco tempo.");

const ID_DA_REUNIAO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Dependencias = {
  autenticar: (req: Request) => Promise<{ openId: string; onboardingCompleted?: boolean | null; isCron?: boolean }>;
  receber: typeof receberParte;
};

export function registrarRotaDasPartes(app: Express, deps: Dependencias = { autenticar: req => sdk.authenticateRequest(req), receber: receberParte }) {
  app.post(
    ROTA_DAS_PARTES,
    // Autentica ANTES de ler o corpo: quem não tem sessão recebe 401 sem que o
    // servidor guarde 16 MB na memória por pedido. A usuária segue em res.locals.
    async (req: Request, res: Response, next: () => void) => {
      res.setHeader("Cache-Control", "no-store");
      let usuaria: Awaited<ReturnType<Dependencias["autenticar"]>>;
      try {
        usuaria = await deps.autenticar(req);
      } catch (erro) {
        if (ehErroDeBancoIndisponivel(erro)) return res.status(503).json({ codigo: "BANCO_INDISPONIVEL" });
        return res.status(401).json({ codigo: "SEM_SESSAO" });
      }
      if (usuaria.isCron) return res.status(403).json({ codigo: "SEM_SESSAO" });
      if (!usuaria.onboardingCompleted) return res.status(403).json({ codigo: "CADASTRO_INCOMPLETO" });
      res.locals.usuaria = usuaria;
      next();
    },
    express.raw({ type: () => true, limit: TAMANHO_MAXIMO_DA_PARTE + 1024 }),
    async (req: Request, res: Response) => {
      const responder = (status: number, corpo: Record<string, unknown>) => res.status(status).json(corpo);
      const usuaria = res.locals.usuaria as Awaited<ReturnType<Dependencias["autenticar"]>>;

      const meetingId = String(req.params.meetingId ?? "");
      const seq = Number(req.params.seq);
      if (!ID_DA_REUNIAO.test(meetingId) || !/^\d{1,4}$/.test(String(req.params.seq ?? ""))) return responder(400, { codigo: "POSICAO" });
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      let liberarVaga: () => void;
      try {
        liberarVaga = tetoDasPartes.reservar(usuaria.openId);
      } catch (erro) {
        if (!(erro instanceof TRPCError) || erro.code !== "TOO_MANY_REQUESTS") throw erro;
        return responder(429, { codigo: "MUITOS_PEDIDOS" });
      }

      try {
        const resultado = await deps.receber({ ownerId: usuaria.openId, meetingId, seq, mimeType: String(req.headers["content-type"] ?? ""), bytes });
        return responder(resultado.repetida ? 200 : 201, { codigo: "RECEBIDA", seq: resultado.seq, repetida: resultado.repetida });
      } catch (erro) {
        if (erro instanceof RecusaDaParte) return responder(STATUS_DA_RECUSA[erro.codigo], { codigo: erro.codigo });
        // Falha passageira devolve a vaga: o reenvio da mesma parte não pode
        // gastar o teto enquanto o bucket ou o banco estão fora.
        if (erro instanceof FalhaPassageiraDaParte) { liberarVaga(); return responder(503, { codigo: "TENTE_DE_NOVO" }); }
        if (ehErroDeBancoIndisponivel(erro)) { liberarVaga(); return responder(503, { codigo: "BANCO_INDISPONIVEL" }); }
        console.error("[Reuniões] a parte não foi recebida:", descreverErroDeBanco(erro));
        return responder(500, { codigo: "ERRO" });
      }
    },
  );
}

/**
 * O corpo maior que o teto: o express.raw recusa antes do handler e cai no
 * tratador de erros do Express, que responderia HTML. Este tratador, montado
 * logo depois da rota, devolve o mesmo JSON da recusa.
 */
export function tratarCorpoGrandeDasPartes(erro: unknown, req: Request, res: Response, next: (erro?: unknown) => void) {
  const tipo = (erro as { type?: string } | null)?.type;
  if (req.path.startsWith("/api/reunioes/") && tipo === "entity.too.large") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(413).json({ codigo: "GRANDE_DEMAIS" });
  }
  return next(erro);
}
