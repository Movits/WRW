import express, { type Express, type Request, type Response } from "express";
import { ehErroDeBancoIndisponivel, descreverErroDeBanco } from "../banco-indisponivel";
import { FalhaPassageiraDaParte, RecusaDaParte, receberParte, TAMANHO_MAXIMO_DA_PARTE, type CodigoDaRecusa } from "../fatias-de-reuniao";
import { criarTeto } from "../assistente-de-texto";
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
// gravações ao mesmo tempo, e barra quem martela a rota.
const tetoDasPartes = criarTeto(60, 10 * 60_000, "Muitas partes enviadas em pouco tempo.");

const ID_DA_REUNIAO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Dependencias = {
  autenticar: (req: Request) => Promise<{ openId: string; onboardingCompleted?: boolean | null; isCron?: boolean }>;
  receber: typeof receberParte;
};

export function registrarRotaDasPartes(app: Express, deps: Dependencias = { autenticar: req => sdk.authenticateRequest(req), receber: receberParte }) {
  app.post(
    ROTA_DAS_PARTES,
    express.raw({ type: () => true, limit: TAMANHO_MAXIMO_DA_PARTE + 1024 }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const responder = (status: number, corpo: Record<string, unknown>) => res.status(status).json(corpo);

      let usuaria: Awaited<ReturnType<Dependencias["autenticar"]>>;
      try {
        usuaria = await deps.autenticar(req);
      } catch (erro) {
        if (ehErroDeBancoIndisponivel(erro)) return responder(503, { codigo: "BANCO_INDISPONIVEL" });
        return responder(401, { codigo: "SEM_SESSAO" });
      }
      if (usuaria.isCron) return responder(403, { codigo: "SEM_SESSAO" });
      if (!usuaria.onboardingCompleted) return responder(403, { codigo: "CADASTRO_INCOMPLETO" });

      const meetingId = String(req.params.meetingId ?? "");
      const seq = Number(req.params.seq);
      if (!ID_DA_REUNIAO.test(meetingId) || !/^\d{1,4}$/.test(String(req.params.seq ?? ""))) return responder(400, { codigo: "POSICAO" });
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        tetoDasPartes.reservar(usuaria.openId);
      } catch {
        return responder(429, { codigo: "MUITOS_PEDIDOS" });
      }

      try {
        const resultado = await deps.receber({ ownerId: usuaria.openId, meetingId, seq, mimeType: String(req.headers["content-type"] ?? ""), bytes });
        return responder(resultado.repetida ? 200 : 201, { codigo: "RECEBIDA", seq: resultado.seq, repetida: resultado.repetida });
      } catch (erro) {
        if (erro instanceof RecusaDaParte) return responder(STATUS_DA_RECUSA[erro.codigo], { codigo: erro.codigo });
        if (erro instanceof FalhaPassageiraDaParte) return responder(503, { codigo: "TENTE_DE_NOVO" });
        if (ehErroDeBancoIndisponivel(erro)) return responder(503, { codigo: "BANCO_INDISPONIVEL" });
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
