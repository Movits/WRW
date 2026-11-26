import { useCallback, useRef, useSyncExternalStore } from "react";
import { ehCorteCancelado, montarParte, type CodigoDaRecusaDoCorte, type CorteDoArquivo, type ParteCortada, type RecusaDoCorte, type TipoDaParte } from "@/lib/corte-comum";
import { cortarArquivoNoWorker, type OpcoesDoCorteNoWorker } from "@/lib/corte-do-arquivo-no-worker";
import type { FimDoArquivo, ResultadoDoDescarte, useGravacaoEmPartes } from "./useGravacaoEmPartes";

/** O que a importação usa da gravação em partes: o mesmo caminho até o servidor. */
type GravacaoEmPartes = Pick<ReturnType<typeof useGravacaoEmPartes>, "iniciar" | "cancelar" | "subirParteDoArquivo" | "encerrarArquivo">;
type Inicio = Omit<Parameters<GravacaoEmPartes["iniciar"]>[0], "origem">;

/** Quem corta o arquivo: o Worker na tela; nos testes, um dublê. */
export type Cortador = (arquivo: Blob, opcoes: OpcoesDoCorteNoWorker) => Promise<CorteDoArquivo>;

/**
 * O recuo do corte (G14, parte 2): diz se o arquivo que o corte recusou vai
 * inteiro, como uma parte só, e em que tipo (null: não vai, e vale a recusa).
 * É o arquivo curto de um formato que o corte reconhece mas não lê (o ALAC do
 * Gravador do iPhone, o AC-3, o Vorbis no WebM); o servidor o converte em MP3
 * quando o Gemini não lista o codec (server/fatias-de-reuniao.ts).
 */
export type RecuoDoCorte = (recusa: RecusaDoCorte) => Promise<{ mimeType: TipoDaParte; duracaoMs: number } | null>;

/** O arquivo inteiro como a única parte: os bytes do arquivo, de 0 ao fim, sem nada novo. */
export function parteComOArquivoInteiro(arquivo: Blob, duracaoMs: number): ParteCortada {
  return { novos: new Uint8Array(0), ordem: Float64Array.of(1, 0, arquivo.size), bytes: arquivo.size, duracaoMs };
}

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
  /**
   * O arquivo não serve, e nenhuma reunião nasceu: o formato não é conhecido
   * ou não tem suporte (`detalhe`: qual), o vídeo não tem áudio, o arquivo está
   * danificado, passa de 12 h ou de 200 partes, ou não pôde ser lido.
   */
  | { tipo: "recusada"; motivo: CodigoDaRecusaDoCorte | "ILEGIVEL"; detalhe?: string }
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
 * A importação de um arquivo em partes (H9a, H9b e H9c do plano do gravador;
 * o caso da Dra. Glenda, um MP3 de 38 min, que o envio único recusava por
 * passar de 10 min e 10 MB, e depois tudo o que o HiNoter importa: M4A, MP4 e
 * MOV, WAV, OGG do WhatsApp, WebM, FLAC e AAC). O arquivo é cortado sem
 * recodificar, num Worker (lib/corte-do-arquivo.ts, que reconhece o formato
 * pelos bytes), e as partes seguem pelo caminho da gravação em partes
 * (useGravacaoEmPartes): a reunião nasce com a origem "arquivo", cada parte
 * vai ao aparelho e depois ao servidor, no tipo que o corte diz (audio/mpeg,
 * audio/mp4, audio/ogg...), e o fim vem depois da última. A tela vai ao
 * detalhe pelo aoEncerrar da gravação em partes, como no Encerrar.
 *
 * - O corte vem antes de tudo: o arquivo que não se lê, sem suporte, sem áudio
 *   ou que passa de 12 h é recusado sem a reunião nascer.
 * - Uma parte por vez, e só depois de a anterior chegar: a seguinte é montada
 *   quando o servidor confirmou esta (ou a recusou de vez). A que não subiu
 *   (rede, 429, 5xx, a trava com outra aba) vai de novo, lida outra vez do
 *   arquivo, depois de uma espera que dobra a cada falha (até 1 min), ou assim
 *   que a conexão volta. O arquivo de horas nunca fica inteiro na memória nem
 *   na cópia do aparelho, que guarda só a parte em curso: cada parte é montada
 *   com os bytes novos do formato (cabeçalhos, páginas) e File.slice dos
 *   trechos do arquivo (lib/corte-comum.ts, montarParte).
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

  const importar = useCallback(async (arquivo: File, inicio: Inicio, aoCriarReuniao?: (meetingId: string) => void, recuo?: RecuoDoCorte): Promise<ResultadoDaImportacao> => {
    if (emCurso) throw new Error("Já há um arquivo sendo enviado.");
    const { partes, temSessao, cortar = cortarArquivoNoWorker } = atuais.current;
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
      let corte: CorteDoArquivo;
      try {
        corte = await cortar(arquivo, {
          sinal,
          aoLer: (lidos, total) => { if (!cancelado()) mostrar(corrente, { fase: "lendo", lidos, total }); },
        });
      } catch (erro) {
        if (cancelado()) return await cancelada();
        // Para a dona, o arquivo estragado e o defeito do corte dão o mesmo
        // aviso; o console guarda a diferença para quem a atende.
        if (!ehCorteCancelado(erro)) console.error("[Importação] o arquivo não pôde ser cortado:", erro);
        return { tipo: "recusada", motivo: "ILEGIVEL" };
      }
      if (cancelado()) return await cancelada();
      let mimeType: TipoDaParte;
      let partesDoArquivo: ParteCortada[];
      if (corte.ok) {
        mimeType = corte.mimeType;
        partesDoArquivo = corte.partes;
      } else {
        // O recuo do corte: o arquivo inteiro vai como uma parte só, pela
        // mesma rota, quando quem chamou diz que ele cabe numa.
        const inteiro = recuo ? await recuo(corte).catch(() => null) : null;
        if (cancelado()) return await cancelada();
        if (!inteiro) return { tipo: "recusada", motivo: corte.codigo, ...(corte.detalhe ? { detalhe: corte.detalhe } : {}) };
        mimeType = inteiro.mimeType;
        partesDoArquivo = [parteComOArquivoInteiro(arquivo, inteiro.duracaoMs)];
      }

      const meetingId = await partes.iniciar({ ...inicio, origem: "arquivo" });
      corrente.meetingId = meetingId;
      if (cancelado()) return await cancelada();
      aoCriarReuniao?.(meetingId);
      const total = partesDoArquivo.length;
      mostrar(corrente, { fase: "enviando", enviadas: 0, total });
      for (let seq = 0; seq < total; seq++) {
        const parte = partesDoArquivo[seq];
        for (let espera = PRIMEIRA_ESPERA_MS; ; espera = Math.min(espera * 2, ESPERA_MAXIMA_MS)) {
          // O Sair no meio apagou as cópias do aparelho e a sessão: nada mais sobe.
          if (!temSessao()) return { tipo: "sem-sessao", meetingId };
          const desfecho = await partes.subirParteDoArquivo(meetingId, {
            blob: montarParte(arquivo, parte, mimeType),
            mimeType,
            duracaoMs: parte.duracaoMs,
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
