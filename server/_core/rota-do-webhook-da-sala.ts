import express, { type Express, type Request, type Response } from "express";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "../banco-indisponivel";
import { assinaturaDoAvisoConfere, configuracaoDoDaily, lerAvisoDoDaily } from "../daily";
import { receberAvisoDaSala } from "../sala-de-video";

/**
 * Os avisos do Daily sobre as salas de vídeo (V1 do estudo
 * docs/arquitetura/sala-de-video.md): quem entrou, quem saiu e o fim da sala,
 * para a conta do orçamento do mês (server/sala-de-video.ts). O Daily assina
 * cada aviso sobre o corpo CRU (HMAC-SHA256 com o segredo do webhook), então a
 * rota tem o próprio leitor de corpo (express.raw, até 64 KB) e é montada ANTES
 * do express.json (server/_core/index.ts), que senão leria e trocaria o corpo
 * primeiro. Guarda: server/agendados-autenticacao.test.ts confere a ordem no
 * index.ts real.
 *
 * Sem sessão: quem prova a origem é a assinatura, conferida antes de qualquer
 * efeito. Sem DAILY_WEBHOOK_SEGREDO (ou sem a sala configurada), 404: nada
 * entra. O corpo que não muda a conta (o pedido de teste que o Daily manda ao
 * criar o webhook, `{"test":"test"}`, e os outros tipos de aviso) responde 200
 * sem efeito, também para o webhook não ser desligado pelo Daily por falha.
 */

export const ROTA_DO_WEBHOOK_DA_SALA = "/api/sala-de-video/avisos";
const CORPO_MAXIMO = 64 * 1024;

type Dependencias = { receber: typeof receberAvisoDaSala };

export function registrarRotaDoWebhookDaSala(app: Express, deps: Dependencias = { receber: receberAvisoDaSala }) {
  app.post(
    ROTA_DO_WEBHOOK_DA_SALA,
    express.raw({ type: () => true, limit: CORPO_MAXIMO }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const configuracao = configuracaoDoDaily();
      if (!configuracao?.segredoDoWebhook) return res.status(404).json({ codigo: "SEM_WEBHOOK" });
      const corpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const cabecalho = (nome: string) => {
        const valor = req.headers[nome];
        return typeof valor === "string" ? valor : undefined;
      };
      const assinada = assinaturaDoAvisoConfere({
        corpo, assinatura: cabecalho("x-webhook-signature"), momento: cabecalho("x-webhook-timestamp"), segredo: configuracao.segredoDoWebhook,
      });
      const aviso = lerAvisoDoDaily(corpo);
      // O que não muda a conta não precisa de assinatura para ser ignorado (o teste do Daily ao criar o webhook vem assinado, mas nada depende disso).
      if (!aviso) return res.status(200).json({ codigo: "IGNORADO" });
      if (!assinada) return res.status(401).json({ codigo: "ASSINATURA" });
      try {
        const resultado = await deps.receber(aviso);
        return res.status(200).json({ codigo: resultado === "aplicado" ? "APLICADO" : "IGNORADO" });
      } catch (erro) {
        // Falha passageira: o Daily tenta de novo (o aviso repetido não soma duas vezes).
        if (ehErroDeBancoIndisponivel(erro)) return res.status(503).json({ codigo: "BANCO_INDISPONIVEL" });
        console.error("[Sala de vídeo] o aviso do Daily não foi gravado:", descreverErroDeBanco(erro));
        return res.status(500).json({ codigo: "ERRO" });
      }
    },
  );
}

/** O corpo maior que o teto: o express.raw recusa antes do handler; aqui sai o mesmo JSON, sem a página de erro. */
export function tratarCorpoGrandeDoWebhookDaSala(erro: unknown, req: Request, res: Response, next: (erro?: unknown) => void) {
  const tipo = (erro as { type?: string } | null)?.type;
  if (req.path === ROTA_DO_WEBHOOK_DA_SALA && tipo === "entity.too.large") return res.status(413).json({ codigo: "GRANDE_DEMAIS" });
  return next(erro);
}
