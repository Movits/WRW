import { useCallback, useRef, useState } from "react";
import type { CodigoDaRecusaDoMp3, CorteDoMp3 } from "@/lib/corte-do-mp3";
import { cortarMp3NoWorker, type OpcoesDoCorteNoWorker } from "@/lib/corte-do-mp3-no-worker";
import type { ResultadoDoDescarte, useGravacaoEmPartes } from "./useGravacaoEmPartes";

/** O que a importação usa da gravação em partes: o mesmo caminho até o servidor. */
type GravacaoEmPartes = Pick<ReturnType<typeof useGravacaoEmPartes>, "iniciar" | "cancelar" | "receberParte" | "esperarFila">;
type Inicio = Omit<Parameters<GravacaoEmPartes["iniciar"]>[0], "origem">;

/** Quem corta o MP3: o Worker na tela; nos testes, um dublê. */
export type Cortador = (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => Promise<CorteDoMp3>;

/** Onde a importação está, para a tela: lendo o arquivo, enviando as partes, cancelando. */
export type AndamentoDaImportacao =
  | { fase: "parada" }
  | { fase: "lendo"; lidos: number; total: number }
  | { fase: "enviando"; enviadas: number; total: number }
  | { fase: "cancelando" };

export type ResultadoDaImportacao =
  /** Todas as partes entraram na fila e a fila esvaziou: o fim foi declarado (ou guardado para a retomada). */
  | { tipo: "enviada"; meetingId: string }
  /** O arquivo não serve, e nenhuma reunião nasceu: não é MP3, passa de 12 h, ou não pôde ser lido. */
  | { tipo: "recusada"; motivo: CodigoDaRecusaDoMp3 | "ILEGIVEL" }
  /** A dona cancelou. `exclusao`: o que houve com a reunião que já tinha nascido (null se nenhuma nasceu). */
  | { tipo: "cancelada"; exclusao: Exclude<ResultadoDoDescarte, "nada"> | null }
  /** A sessão acabou no meio (o Sair): o envio para, e a reunião fica com o que subiu. */
  | { tipo: "sem-sessao"; meetingId: string };

type EmCurso = { controle: AbortController; meetingId: string | null; exclusao: Promise<Exclude<ResultadoDoDescarte, "nada">> | null };

/**
 * A importação de um MP3 em partes (H9a do plano do gravador; o caso da Dra.
 * Glenda, um MP3 de 38 min, que o envio único recusava por passar de 10 min e
 * 10 MB). O arquivo é cortado nos quadros, num Worker (lib/corte-do-mp3.ts), e
 * as partes seguem pelo caminho da gravação em partes (useGravacaoEmPartes): a
 * reunião nasce com a origem "arquivo", cada parte vai ao aparelho e depois ao
 * servidor, e a última declara o fim. A tela vai ao detalhe pelo aoEncerrar da
 * gravação em partes, como no Encerrar.
 *
 * - O corte vem antes de tudo: o arquivo que não é MP3, ou que passa de 12 h,
 *   é recusado sem a reunião nascer.
 * - Uma parte por vez: a seguinte só entra na fila quando a anterior saiu dela
 *   (esperarFila). O arquivo de horas nunca fica inteiro na memória nem na
 *   cópia do aparelho; cada parte é um File.slice das faixas dela.
 * - Cancelar, lendo, só para o corte. Enviando, exclui a reunião pelo caminho
 *   do Descartar da gravação (cancelar da gravação em partes): a parte que já
 *   sobe termina, as que esperam a vez saem sem subir, e a exclusão que falha
 *   fica guardada para a retomada.
 * - O envio segue se a tela sair (as closures sobrevivem ao desmonte, como as
 *   da gravação); o fim da sessão o para.
 */
export function useImportacaoEmPartes(opcoes: { partes: GravacaoEmPartes; temSessao: () => boolean; cortar?: Cortador }) {
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  const [andamento, setAndamento] = useState<AndamentoDaImportacao>({ fase: "parada" });
  const emCurso = useRef<EmCurso | null>(null);

  const importar = useCallback(async (arquivo: File, inicio: Inicio, aoCriarReuniao?: (meetingId: string) => void): Promise<ResultadoDaImportacao> => {
    if (emCurso.current) throw new Error("Já há um arquivo sendo enviado.");
    const { partes, temSessao, cortar = cortarMp3NoWorker } = atuais.current;
    const corrente: EmCurso = { controle: new AbortController(), meetingId: null, exclusao: null };
    emCurso.current = corrente;
    const cancelado = () => corrente.controle.signal.aborted;
    // A reunião que nasceu sai pelo cancelar da gravação em partes; o Cancelar
    // da tela já o chamou, salvo no clique durante a criação dela.
    const cancelada = async (): Promise<ResultadoDaImportacao> => ({
      tipo: "cancelada",
      exclusao: corrente.meetingId ? await (corrente.exclusao ??= partes.cancelar(corrente.meetingId)) : null,
    });
    try {
      setAndamento({ fase: "lendo", lidos: 0, total: arquivo.size });
      let corte: CorteDoMp3;
      try {
        corte = await cortar(arquivo, {
          sinal: corrente.controle.signal,
          aoLer: (lidos, total) => { if (!cancelado()) setAndamento({ fase: "lendo", lidos, total }); },
        });
      } catch {
        return cancelado() ? await cancelada() : { tipo: "recusada", motivo: "ILEGIVEL" };
      }
      if (cancelado()) return await cancelada();
      if (!corte.ok) return { tipo: "recusada", motivo: corte.codigo };

      const meetingId = await partes.iniciar({ ...inicio, origem: "arquivo" });
      corrente.meetingId = meetingId;
      if (cancelado()) return await cancelada();
      aoCriarReuniao?.(meetingId);
      const total = corte.partes.length;
      setAndamento({ fase: "enviando", enviadas: 0, total });
      for (let seq = 0; seq < total; seq++) {
        // O Sair no meio apagou as cópias do aparelho e a sessão: nada mais sobe.
        if (!temSessao()) return { tipo: "sem-sessao", meetingId };
        const { faixas, duracaoMs } = corte.partes[seq];
        partes.receberParte({
          blob: new Blob(faixas.map(faixa => arquivo.slice(faixa.inicio, faixa.fim)), { type: "audio/mpeg" }),
          mimeType: "audio/mpeg",
          duracaoMs,
          seq,
          ultima: seq === total - 1,
        });
        await partes.esperarFila();
        if (cancelado()) return await cancelada();
        setAndamento({ fase: "enviando", enviadas: seq + 1, total });
      }
      return { tipo: "enviada", meetingId };
    } finally {
      emCurso.current = null;
      setAndamento({ fase: "parada" });
    }
  }, []);

  /**
   * O Cancelar da tela. Com a reunião já criada, a exclusão entra na fila agora,
   * atrás da parte que já sobe; o resultado chega pelo `importar`.
   */
  const cancelar = useCallback(() => {
    const corrente = emCurso.current;
    if (!corrente || corrente.controle.signal.aborted) return;
    corrente.controle.abort();
    setAndamento({ fase: "cancelando" });
    if (corrente.meetingId) corrente.exclusao = atuais.current.partes.cancelar(corrente.meetingId);
  }, []);

  return { andamento, importar, cancelar };
}
