import express, { type Express, type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import { DOCUMENTO_BYTES_MAX, type CodigoDaRecusaDoDocumento } from "@shared/documento-da-reuniao";
import { descreverErroDeBanco, ehErroDeBancoIndisponivel } from "../banco-indisponivel";
import { FalhaPassageiraDoDocumento, lerDocumentoGuardado, RecusaDoDocumento, receberDocumento, tetoDosDocumentos } from "../documento-da-reuniao";
import { sdk } from "./sdk";

/**
 * A rota binária do documento da reunião (H12 e H12b do desenho do gravador):
 * `POST /api/reunioes/{meetingId}/documento`, com o PDF cru no corpo (as fotos
 * de um texto chegam já juntas num PDF, montado no aparelho). Base64 no JSON do
 * tRPC custaria um terço a mais de rede e a memória do processo, como nas
 * partes da gravação (rota-das-partes.ts); por isso a rota é Express e é
 * montada ANTES do express.json (server/_core/index.ts).
 *
 * A ordem dos passos protege o servidor:
 * 1. autentica pelo cookie ANTES de ler o corpo: quem não tem sessão recebe 401
 *    sem que o servidor guarde 15 MB na memória;
 * 2. o Content-Length acima do teto é recusado sem ler o corpo (413);
 * 3. o teto de DOCUMENTOS_POR_HORA (10) por dona também vem antes do corpo
 *    (429). A vaga só fica gasta quando o documento é aceito para a leitura: a
 *    recusa, a falha e o reenvio do mesmo arquivo a devolvem, e a conexão que
 *    cai ANTES de o corpo chegar inteiro também. Chegado o corpo, quem decide
 *    é o desfecho do recebimento, nunca a conexão: a que cai durante o
 *    recebimento (o PDF subindo ao bucket, a transação) não devolve a vaga de
 *    um documento que acaba aceito e lido pela IA;
 * 4. só então o corpo (express.raw, até 15 MB) e a conferência dele
 *    (receberDocumento: começa por "%PDF-", a reunião espera documento).
 *
 * A resposta é sempre JSON `{ codigo }`, e o código é o que a tela traduz: as
 * mensagens daqui são para o log. 202: aceito, a leitura segue em segundo
 * plano; 200: o mesmo arquivo de novo; 4xx: recusa definitiva; 429 e 503:
 * passageira, e a tela pode reenviar.
 *
 * O `GET` do mesmo endereço devolve o PDF guardado à dona, para a tela mostrar
 * as páginas (H12b). O leitor de PDF da tela busca o arquivo por fetch, e o
 * proxy do storage responde 307 para o bucket, que não manda CORS; daqui ele
 * sai na mesma origem. Só a sessão da dona abre: o link aberto não tem o
 * arquivo. Vencido, excluído ou de outra dona: 404, sem dizer qual.
 */

export const ROTA_DO_DOCUMENTO = "/api/reunioes/:meetingId/documento";

const STATUS_DA_RECUSA: Record<CodigoDaRecusaDoDocumento, number> = {
  SEM_REUNIAO: 404,
  FORA_DO_ESTADO: 409,
  CONTEUDO_DIFERENTE: 409,
  GRANDE_DEMAIS: 413,
  VAZIO: 400,
  FORMATO: 415,
};

const ID_DA_REUNIAO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// O teto por dona (tetoDosDocumentos) mora em server/documento-da-reuniao.ts:
// meetings.iniciarDocumento o confere antes de a reunião nascer.
export { tetoDosDocumentos };

type Usuaria = { openId: string; onboardingCompleted?: boolean | null; isCron?: boolean };

type Dependencias = {
  autenticar: (req: Request) => Promise<Usuaria>;
  receber: typeof receberDocumento;
  ler: typeof lerDocumentoGuardado;
  teto: { reservar: (chave: string) => () => void };
};

/**
 * A sessão da dona, antes de tudo: sem ela, 401 (ou 503 com o banco fora), e o
 * cron e o cadastro incompleto não passam. Devolve null quando já respondeu.
 */
async function donaDaSessao(req: Request, res: Response, autenticar: Dependencias["autenticar"]): Promise<Usuaria | null> {
  let usuaria: Usuaria;
  try {
    usuaria = await autenticar(req);
  } catch (erro) {
    if (ehErroDeBancoIndisponivel(erro)) res.status(503).json({ codigo: "BANCO_INDISPONIVEL" });
    else res.status(401).json({ codigo: "SEM_SESSAO" });
    return null;
  }
  if (usuaria.isCron) { res.status(403).json({ codigo: "SEM_SESSAO" }); return null; }
  if (!usuaria.onboardingCompleted) { res.status(403).json({ codigo: "CADASTRO_INCOMPLETO" }); return null; }
  if (!ID_DA_REUNIAO.test(String(req.params.meetingId ?? ""))) { res.status(404).json({ codigo: "SEM_REUNIAO" }); return null; }
  return usuaria;
}

export function registrarRotaDoDocumento(
  app: Express,
  deps: Dependencias = { autenticar: req => sdk.authenticateRequest(req), receber: receberDocumento, ler: lerDocumentoGuardado, teto: tetoDosDocumentos },
) {
  app.get(ROTA_DO_DOCUMENTO, async (req: Request, res: Response) => {
    // Os bytes são só da dona: nenhum cache compartilhado guarda, e o navegador
    // não guarda além da tela aberta.
    res.setHeader("Cache-Control", "private, no-store");
    const usuaria = await donaDaSessao(req, res, deps.autenticar);
    if (!usuaria) return;
    try {
      const bytes = await deps.ler(usuaria.openId, String(req.params.meetingId));
      if (!bytes) return res.status(404).json({ codigo: "SEM_DOCUMENTO" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="documento.pdf"');
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(bytes);
    } catch (erro) {
      if (ehErroDeBancoIndisponivel(erro)) return res.status(503).json({ codigo: "BANCO_INDISPONIVEL" });
      console.error("[Documento] o PDF guardado não foi lido:", descreverErroDeBanco(erro));
      return res.status(503).json({ codigo: "TENTE_DE_NOVO" });
    }
  });

  app.post(
    ROTA_DO_DOCUMENTO,
    async (req: Request, res: Response, next: () => void) => {
      res.setHeader("Cache-Control", "no-store");
      const usuaria = await donaDaSessao(req, res, deps.autenticar);
      if (!usuaria) return;
      const declarado = Number(req.headers["content-length"]);
      if (Number.isFinite(declarado) && declarado > DOCUMENTO_BYTES_MAX) return res.status(413).json({ codigo: "GRANDE_DEMAIS" });

      let liberarVaga: () => void;
      try {
        liberarVaga = deps.teto.reservar(usuaria.openId);
      } catch (erro) {
        if (!(erro instanceof TRPCError) || erro.code !== "TOO_MANY_REQUESTS") throw erro;
        return res.status(429).json({ codigo: "MUITOS_PEDIDOS" });
      }
      // Antes de o corpo chegar ao último passo, a vaga volta com a conexão:
      // o corpo que passa do teto no meio da leitura (o tratador de erro
      // responde) e a conexão que cai durante o envio. Daí em diante, só o
      // desfecho do recebimento a devolve (ver o último passo).
      res.on("close", () => { if (!res.locals.corpoNoRecebimento) liberarVaga(); });
      res.locals.liberarVaga = liberarVaga;
      res.locals.usuaria = usuaria;
      next();
    },
    express.raw({ type: () => true, limit: DOCUMENTO_BYTES_MAX }),
    async (req: Request, res: Response) => {
      const usuaria = res.locals.usuaria as Usuaria;
      const liberarVaga = res.locals.liberarVaga as () => void;
      const meetingId = String(req.params.meetingId);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      // O corpo chegou: a conexão que cair agora já não decide a vaga. O
      // recebimento segue mesmo sem ninguém esperando a resposta (o PDF sobe, a
      // reunião é tomada e a IA lê), e a vaga só volta nos desfechos sem aceite
      // abaixo. `liberarVaga` tira a marca uma vez só.
      res.locals.corpoNoRecebimento = true;
      try {
        const resultado = await deps.receber({ ownerId: usuaria.openId, meetingId, bytes });
        if (resultado.repetido) {
          liberarVaga();
          return res.status(200).json({ codigo: "RECEBIDO", repetido: true });
        }
        // `trabalho` nunca rejeita: receberDocumento termina todo erro em log.
        void resultado.trabalho;
        return res.status(202).json({ codigo: "RECEBIDO", repetido: false });
      } catch (erro) {
        liberarVaga();
        if (erro instanceof RecusaDoDocumento) return res.status(STATUS_DA_RECUSA[erro.codigo]).json({ codigo: erro.codigo });
        if (erro instanceof FalhaPassageiraDoDocumento) return res.status(503).json({ codigo: "TENTE_DE_NOVO" });
        if (ehErroDeBancoIndisponivel(erro)) return res.status(503).json({ codigo: "BANCO_INDISPONIVEL" });
        console.error("[Documento] o documento não foi recebido:", descreverErroDeBanco(erro));
        return res.status(500).json({ codigo: "ERRO" });
      }
    },
  );
}
