import type { Express, Request, Response } from "express";
import { ROTA_DO_AUDIO_BAIXADO, TIPO_DO_AUDIO, type FormatoDoAudio } from "@shared/baixar-audio";
import { ehErroDeBancoIndisponivel } from "../banco-indisponivel";
import { balcaoDoAudio, lerParteDoBucket, type BalcaoDoAudio } from "../baixar-audio-da-reuniao";
import { converterPartes, type ParteDoAudio } from "../conversao-do-audio";
import { sdk } from "./sdk";

/**
 * A rota do download do áudio da reunião (H8c): `GET
 * /api/reunioes/baixar-audio/{ficha}`. A ficha sai de `meetings.baixarAudio`
 * (routers/meetings.ts), que já conferiu a dona, o prazo dos 30 dias e o teto
 * e gravou a auditoria; aqui ela é tomada uma vez só, pela mesma dona (o
 * cookie da sessão), e o arquivo é transmitido enquanto o ffmpeg o converte
 * (server/conversao-do-audio.ts).
 *
 * - O navegador recebe só o arquivo: as partes vêm do bucket pelo servidor,
 *   com a chave guardada na ficha, e nenhum redirecionamento para URL
 *   assinada acontece (diferente do player, que toca pelo proxy).
 * - O tamanho não vai no cabeçalho: o arquivo é feito enquanto sai. Se a
 *   conversão falhar no meio, a conexão é cortada, e o navegador marca o
 *   download como falho (em vez de guardar um arquivo pela metade como se
 *   estivesse inteiro).
 * - A dona que fecha o download, ou cuja rede para por 5 min, encerra a
 *   conversão; a vaga do balcão volta em qualquer saída.
 * - As recusas são JSON `{ codigo }`, como na rota das partes: a tela não lê
 *   esta resposta (a navegação é do próprio navegador), e as recusas que a dona
 *   precisa ler, traduzidas, já saíram no passo do tRPC.
 * - Só GET toma a ficha. O Express responde HEAD pela rota GET, e um HEAD (de
 *   um gerenciador de downloads, por exemplo) gastaria a ficha de uso único e
 *   uma conversão inteira sem corpo: ele leva 405, e a ficha segue valendo.
 */

/** A conexão que fica este tempo sem andar (a rede da dona parou) perde o download, e a vaga volta. */
export const PRAZO_DA_CONEXAO_PARADA_MS = 5 * 60_000;

/**
 * O Content-Disposition do arquivo: o nome em UTF-8 no filename* (RFC 6266 e
 * 5987, que todo navegador atual lê) e uma versão só com ASCII no filename,
 * para o cliente antigo. O res.attachment do Express manda o "ã" de "Reunião"
 * cru no filename, sem o filename*, e cada navegador o lê de um jeito.
 */
export function cabecalhoDoAnexo(nome: string): string {
  const ascii = nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]|["\\]/g, "_");
  const codificado = encodeURIComponent(nome).replace(/['()*]/g, letra => `%${letra.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${codificado}`;
}

type Dependencias = {
  autenticar: (req: Request) => Promise<{ openId: string; isCron?: boolean }>;
  balcao: Pick<BalcaoDoAudio, "tomar">;
  converter: (partes: ParteDoAudio[], formato: FormatoDoAudio, saida: Response, sinal: AbortSignal) => Promise<void>;
};

const PADRAO: Dependencias = {
  autenticar: req => sdk.authenticateRequest(req),
  balcao: balcaoDoAudio,
  converter: (partes, formato, saida, sinal) => converterPartes(partes, formato, saida, { lerParte: lerParteDoBucket }, sinal),
};

export function registrarRotaDoAudioBaixado(app: Express, deps: Dependencias = PADRAO) {
  app.get(`${ROTA_DO_AUDIO_BAIXADO}/:ficha`, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).end();
    }
    let usuaria: Awaited<ReturnType<Dependencias["autenticar"]>>;
    try {
      usuaria = await deps.autenticar(req);
    } catch (erro) {
      if (ehErroDeBancoIndisponivel(erro)) return res.status(503).json({ codigo: "BANCO_INDISPONIVEL" });
      return res.status(401).json({ codigo: "SEM_SESSAO" });
    }
    if (usuaria.isCron) return res.status(403).json({ codigo: "SEM_SESSAO" });

    const tomada = deps.balcao.tomar(String(req.params.ficha ?? ""), usuaria.openId);
    // Vencida, já usada, de outra conta ou inventada: a mesma resposta, sem dizer qual.
    if (!tomada) return res.status(404).json({ codigo: "ENDERECO_VENCIDO" });
    const { ficha, terminar } = tomada;

    const controle = new AbortController();
    res.on("close", () => { if (!res.writableFinished) controle.abort(); });
    res.setTimeout(PRAZO_DA_CONEXAO_PARADA_MS, () => res.destroy());
    try {
      res.status(200);
      // O nome já veio limpo (nomeDoArquivoDoAudio), sem aspas nem quebra de linha.
      res.setHeader("Content-Disposition", cabecalhoDoAnexo(ficha.nomeDoArquivo));
      res.setHeader("Content-Type", TIPO_DO_AUDIO[ficha.formato]);
      res.setHeader("Accept-Ranges", "none");
      // O navegador mostra o download começando antes do primeiro pedaço convertido.
      res.flushHeaders();
      await deps.converter(ficha.partes, ficha.formato, res, controle.signal);
      res.end();
    } catch (erro) {
      if (!controle.signal.aborted) {
        console.error(`[Áudio] o download do áudio da reunião ${ficha.meetingId} parou no meio: ${erro instanceof Error ? erro.message : String(erro)}`);
      }
      res.destroy();
    } finally {
      terminar();
    }
  });
}
