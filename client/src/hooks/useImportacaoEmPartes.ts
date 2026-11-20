import { useCallback, useRef, useSyncExternalStore } from "react";
import { ehCorteCancelado, type CodigoDaRecusaDoMp3, type CorteDoMp3 } from "@/lib/corte-do-mp3";
import { cortarMp3NoWorker, type OpcoesDoCorteNoWorker } from "@/lib/corte-do-mp3-no-worker";
import type { FimDoArquivo, ResultadoDoDescarte, useGravacaoEmPartes } from "./useGravacaoEmPartes";

/** O que a importação usa da gravação em partes: o mesmo caminho até o servidor. */
type GravacaoEmPartes = Pick<ReturnType<typeof useGravacaoEmPartes>, "iniciar" | "cancelar" | "subirParteDoArquivo" | "encerrarArquivo">;
type Inicio = Omit<Parameters<GravacaoEmPartes["iniciar"]>[0], "origem">;

/** Quem corta o MP3: o Worker na tela; nos testes, um dublê. */
export type Cortador = (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => Promise<CorteDoMp3>;

/** Onde a importação está, para a tela: lendo o arquivo, enviando as partes, cancelando. */
export type AndamentoDaImportacao =
  | { fase: "parada" }
  | { fase: "lendo"; lidos: number; total: number }
  /** `tentandoDeNovo`: a parte da vez não subiu (rede, servidor ocupado), e a importação espera para mandá-la de novo. */
  | { fase: "enviando"; enviadas: number; total: number; tentandoDeNovo?: boolean }
  | { fase: "cancelando" };

export type ResultadoDaImportacao =
  /**
   * Todas as partes chegaram (ou foram recusadas de vez, cada uma com o aviso
   * dela) e o fim foi pedido: `fim` diz como ele ficou (FimDoArquivo; o
   * "descartada" de lá é a "cancelada" daqui).
   */
  | { tipo: "enviada"; meetingId: string; fim: Exclude<FimDoArquivo, "descartada"> }
  /** O arquivo não serve, e nenhuma reunião nasceu: não é MP3, passa de 12 h, ou não pôde ser lido. */
  | { tipo: "recusada"; motivo: CodigoDaRecusaDoMp3 | "ILEGIVEL" }
  /** A dona cancelou. `exclusao`: o que houve com a reunião que já tinha nascido (null se nenhuma nasceu). */
  | { tipo: "cancelada"; exclusao: Exclude<ResultadoDoDescarte, "nada"> | null }
  /** A sessão acabou no meio (o Sair, ou o servidor respondeu que ela venceu): o envio para, e a reunião fica com o que subiu. */
  | { tipo: "sem-sessao"; meetingId: string }
  /** A reunião deixou de receber áudio no meio (excluída em outro aparelho, ou já fechada): o envio para; o aviso da recusa já saiu. */
  | { tipo: "sem-reuniao"; meetingId: string };

/** A primeira espera antes de mandar de novo a parte que não subiu: dobra a cada falha, até o teto. */
export const PRIMEIRA_ESPERA_MS = 2_000;
export const ESPERA_MAXIMA_MS = 60_000;

/**
 * As recusas que dizem que a reunião não recebe mais áudio: ela foi excluída
 * (em outro aparelho, por exemplo) ou já foi fechada (pela varredura de
 * abandono, depois de 6 h sem parte nova). As outras partes teriam a mesma
 * resposta, e subir 14 MB cada só para ouvi-la não serve a ninguém. As demais
 * recusas são da parte (o servidor mediu um tamanho ou um tempo que não
 * aceita): o trecho fica de fora, com o aviso, e o envio segue, como na gravação.
 */
const REUNIAO_FECHADA: ReadonlySet<string> = new Set(["SEM_REUNIAO", "FORA_DO_ESTADO"]);

type EmCurso = {
  controle: AbortController;
  /** A gravação em partes da tela que começou a importação: o Cancelar de outra tela põe a exclusão na mesma fila. */
  partes: GravacaoEmPartes;
  meetingId: string | null;
  exclusao: Promise<Exclude<ResultadoDoDescarte, "nada">> | null;
};

// A importação em curso nesta aba mora fora da tela (decisão 5 da H9a): sair
// de Reuniões no meio não para o envio, e a tela que volta mostra o andamento
// e o Cancelar da mesma importação, em vez de um formulário livre que deixaria
// mandar o arquivo de novo.
const PARADA: AndamentoDaImportacao = { fase: "parada" };
let emCurso: EmCurso | null = null;
let andamentoAtual: AndamentoDaImportacao = PARADA;
const ouvintes = new Set<() => void>();

function avisarOuvintes() {
  for (const ouvinte of Array.from(ouvintes)) ouvinte();
}

/** Mostra o andamento da `importacao`, se ela ainda é a em curso: a de um teste anterior, esquecida, não escreve mais. */
function mostrar(importacao: EmCurso, andamento: AndamentoDaImportacao) {
  if (emCurso !== importacao) return;
  andamentoAtual = andamento;
  avisarOuvintes();
}

function terminar(importacao: EmCurso) {
  if (emCurso !== importacao) return;
  emCurso = null;
  andamentoAtual = PARADA;
  avisarOuvintes();
}

function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

const lerAndamento = () => andamentoAtual;

/** Só para os testes: esquece a importação que um teste anterior deixou no ar. */
export function _reiniciarParaTestes() {
  emCurso = null;
  andamentoAtual = PARADA;
  avisarOuvintes();
}

/** Espera `ms`, ou até a conexão voltar (o evento online do navegador), ou até o Cancelar. */
function esperarParaTentarDeNovo(ms: number, sinal: AbortSignal): Promise<void> {
  if (sinal.aborted) return Promise.resolve();
  return new Promise(pronto => {
    let relogio = 0;
    const acabar = () => {
      window.clearTimeout(relogio);
      window.removeEventListener("online", acabar);
      sinal.removeEventListener("abort", acabar);
      pronto();
    };
    relogio = window.setTimeout(acabar, ms);
    window.addEventListener("online", acabar);
    sinal.addEventListener("abort", acabar);
  });
}

/**
 * A importação de um MP3 em partes (H9a do plano do gravador; o caso da Dra.
 * Glenda, um MP3 de 38 min, que o envio único recusava por passar de 10 min e
 * 10 MB). O arquivo é cortado nos quadros, num Worker (lib/corte-do-mp3.ts), e
 * as partes seguem pelo caminho da gravação em partes (useGravacaoEmPartes): a
 * reunião nasce com a origem "arquivo", cada parte vai ao aparelho e depois ao
 * servidor, e o fim vem depois da última. A tela vai ao detalhe pelo
 * aoEncerrar da gravação em partes, como no Encerrar.
 *
 * - O corte vem antes de tudo: o arquivo que não é MP3, ou que passa de 12 h,
 *   é recusado sem a reunião nascer.
 * - Uma parte por vez, e só depois de a anterior chegar: a seguinte é cortada
 *   quando o servidor confirmou esta (ou a recusou de vez). A que não subiu
 *   (rede, 429, 5xx, a trava com outra aba) vai de novo, lida outra vez do
 *   arquivo, depois de uma espera que dobra a cada falha (até 1 min), ou assim
 *   que a conexão volta. O arquivo de horas nunca fica inteiro na memória nem
 *   na cópia do aparelho, que guarda só a parte em curso: cada parte é um
 *   File.slice das faixas dela.
 * - Cancelar, lendo, só para o corte. Enviando, exclui a reunião pelo caminho
 *   do Descartar da gravação (cancelar da gravação em partes): a parte que já
 *   sobe termina, as que esperam a vez saem sem subir, e a exclusão que falha
 *   fica guardada para a retomada.
 * - O envio segue se a tela sair (as closures sobrevivem ao desmonte, como as
 *   da gravação, e a importação em curso mora fora da tela); o fim da sessão o
 *   para, e a reunião excluída em outro aparelho também.
 */
export function useImportacaoEmPartes(opcoes: { partes: GravacaoEmPartes; temSessao: () => boolean; cortar?: Cortador }) {
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  const andamento = useSyncExternalStore(assinar, lerAndamento, lerAndamento);

  const importar = useCallback(async (arquivo: File, inicio: Inicio, aoCriarReuniao?: (meetingId: string) => void): Promise<ResultadoDaImportacao> => {
    if (emCurso) throw new Error("Já há um arquivo sendo enviado.");
    const { partes, temSessao, cortar = cortarMp3NoWorker } = atuais.current;
    const corrente: EmCurso = { controle: new AbortController(), partes, meetingId: null, exclusao: null };
    emCurso = corrente;
    const sinal = corrente.controle.signal;
    const cancelado = () => sinal.aborted;
    // A reunião que nasceu sai pelo cancelar da gravação em partes; o Cancelar
    // da tela já o chamou, salvo no clique durante a criação dela.
    const cancelada = async (): Promise<ResultadoDaImportacao> => ({
      tipo: "cancelada",
      exclusao: corrente.meetingId ? await (corrente.exclusao ??= partes.cancelar(corrente.meetingId)) : null,
    });
    try {
      mostrar(corrente, { fase: "lendo", lidos: 0, total: arquivo.size });
      let corte: CorteDoMp3;
      try {
        corte = await cortar(arquivo, {
          sinal,
          aoLer: (lidos, total) => { if (!cancelado()) mostrar(corrente, { fase: "lendo", lidos, total }); },
        });
      } catch (erro) {
        if (cancelado()) return await cancelada();
        // Para a dona, o arquivo estragado e o defeito do corte dão o mesmo
        // aviso; o console guarda a diferença para quem a atende.
        if (!ehCorteCancelado(erro)) console.error("[Importação] o MP3 não pôde ser cortado:", erro);
        return { tipo: "recusada", motivo: "ILEGIVEL" };
      }
      if (cancelado()) return await cancelada();
      if (!corte.ok) return { tipo: "recusada", motivo: corte.codigo };

      const meetingId = await partes.iniciar({ ...inicio, origem: "arquivo" });
      corrente.meetingId = meetingId;
      if (cancelado()) return await cancelada();
      aoCriarReuniao?.(meetingId);
      const total = corte.partes.length;
      mostrar(corrente, { fase: "enviando", enviadas: 0, total });
      for (let seq = 0; seq < total; seq++) {
        const { faixas, duracaoMs } = corte.partes[seq];
        for (let espera = PRIMEIRA_ESPERA_MS; ; espera = Math.min(espera * 2, ESPERA_MAXIMA_MS)) {
          // O Sair no meio apagou as cópias do aparelho e a sessão: nada mais sobe.
          if (!temSessao()) return { tipo: "sem-sessao", meetingId };
          const desfecho = await partes.subirParteDoArquivo(meetingId, {
            blob: new Blob(faixas.map(faixa => arquivo.slice(faixa.inicio, faixa.fim)), { type: "audio/mpeg" }),
            mimeType: "audio/mpeg",
            duracaoMs,
            seq,
          });
          if (cancelado() || desfecho.tipo === "descartada") return await cancelada();
          if (desfecho.tipo === "recebida") break;
          if (desfecho.tipo === "recusada") {
            if (REUNIAO_FECHADA.has(desfecho.codigo ?? "")) return { tipo: "sem-reuniao", meetingId };
            break;
          }
          if (desfecho.tipo === "sem-sessao") return { tipo: "sem-sessao", meetingId };
          // Passageira, ou outra aba enviando a mesma parte: ela vai de novo depois da espera.
          mostrar(corrente, { fase: "enviando", enviadas: seq, total, tentandoDeNovo: true });
          await esperarParaTentarDeNovo(espera, sinal);
          if (cancelado()) return await cancelada();
          mostrar(corrente, { fase: "enviando", enviadas: seq, total });
        }
        mostrar(corrente, { fase: "enviando", enviadas: seq + 1, total });
      }
      const fim = await partes.encerrarArquivo(meetingId, total);
      if (cancelado() || fim === "descartada") return await cancelada();
      return { tipo: "enviada", meetingId, fim };
    } finally {
      terminar(corrente);
    }
  }, []);

  /**
   * O Cancelar da tela, que vale para a importação em curso nesta aba, mesmo a
   * começada por outra tela. Com a reunião já criada, a exclusão entra na fila
   * agora, atrás da parte que já sobe; o resultado chega pelo `importar`.
   */
  const cancelar = useCallback(() => {
    const corrente = emCurso;
    if (!corrente || corrente.controle.signal.aborted) return;
    corrente.controle.abort();
    mostrar(corrente, { fase: "cancelando" });
    if (corrente.meetingId) corrente.exclusao = corrente.partes.cancelar(corrente.meetingId);
  }, []);

  return { andamento, importar, cancelar };
}
