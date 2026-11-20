import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { auditLogs, meetingAudioSlices, meetingRecordings, meetings } from "../drizzle/schema";
import {
  ACAO_AUDIO_BAIXADO, CONVERSOES_DE_AUDIO_SIMULTANEAS, RECUSAS_DO_AUDIO, VALIDADE_DO_ENDERECO_DO_AUDIO_MS, type FormatoDoAudio,
} from "@shared/baixar-audio";
import { ambienteDoFfmpeg, type ParteDoAudio } from "./conversao-do-audio";
import { exigirDb } from "./db";
import { MEETING_AUDIO_TTL_MS, MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { storageGetBytes } from "./storage";

/**
 * Baixar o áudio da reunião (H8c; shared/baixar-audio.ts): a preparação, que
 * confere e audita, e o balcão dos endereços de uso único. A conversão em si
 * está em server/conversao-do-audio.ts, e a rota que transmite, em
 * server/_core/rota-do-audio-baixado.ts.
 *
 * Uma transação só lê a reunião e as partes (ou a gravação do envio único) e
 * grava a auditoria MEETING_AUDIO_DOWNLOADED por insert direto que lança (o
 * createAuditLog engole o erro): se a linha não entra, a transação volta atrás
 * e nenhum endereço é emitido, porque o arquivo sai da WRW com a voz de todas
 * as pessoas da reunião e não volta. É o padrão do MEETING_EXPORTED da H8
 * (server/exportar-reuniao.ts). Os bytes saem do bucket depois, pelo servidor,
 * só com o endereço que esta transação liberou.
 *
 * - Toda consulta leva a dona no WHERE: reunião de outra conta, excluída ou que
 *   não existe é "não encontrada".
 * - Gravando ou recebendo partes, ainda não: o arquivo sairia pela metade.
 *   Processando, pronta ou com falha, sim: o áudio já está inteiro no bucket (e
 *   é justamente na falha que a dona pode querer o áudio).
 * - Saem as partes que o player toca (recebidas ou transcritas, no prazo), no
 *   tempo do player; sem nenhuma, a recusa diz se o áudio passou dos 30 dias
 *   (a mesma conta de gravacaoParaOuvir, em meeting-service.ts) ou se não há
 *   áudio guardado.
 * - A auditoria guarda o formato, as contagens, a duração e os formatos de
 *   origem; nunca a chave do bucket, o título ou o conteúdo.
 */

export type PedidoDoAudio = {
  formato: FormatoDoAudio;
  userId: number;
  ipAddress: string;
  userAgent: string | undefined;
};

export type AudioPreparado = {
  /** As partes, na ordem da reunião; as chaves ficam no servidor (no balcão), nunca na resposta. */
  partes: ParteDoAudio[];
  /** Do começo ao fim da última parte, no tempo do player. */
  duracaoSegundos: number;
};

/** O que a preparação lê de cada parte. */
type LinhaDaParte = {
  seq: number; status: string; storageKey: string; mimeType: string;
  durationMs: number; offsetMs: number | null; expiresAt: number;
};

/**
 * As partes que saem no arquivo, no tempo do player (gravacaoParaOuvir, em
 * meeting-service.ts): o início é o gravado pela fila (offset) ou, antes de ela
 * transcrever, a soma das anteriores, contada sobre TODAS as linhas; saem só as
 * recebidas ou transcritas, no prazo.
 */
export function partesParaBaixar(linhas: LinhaDaParte[], agora: number): ParteDoAudio[] {
  const partes: ParteDoAudio[] = [];
  let acumulado = 0;
  for (const linha of [...linhas].sort((a, b) => a.seq - b.seq)) {
    const inicio = linha.offsetMs !== null && linha.offsetMs !== undefined ? Number(linha.offsetMs) : acumulado;
    acumulado = inicio + Number(linha.durationMs);
    if ((linha.status !== "received" && linha.status !== "transcribed") || Number(linha.expiresAt) <= agora) continue;
    partes.push({ seq: linha.seq, storageKey: linha.storageKey, mimeType: linha.mimeType, inicioMs: inicio, duracaoMs: Number(linha.durationMs) });
  }
  return partes;
}

const recusa = (code: "PRECONDITION_FAILED", codigo: string) => new TRPCError({ code, message: codigo });
const semAudio = (vencido: boolean) => recusa("PRECONDITION_FAILED", vencido ? RECUSAS_DO_AUDIO.vencido : RECUSAS_DO_AUDIO.ausente);

export async function prepararAudioDaReuniao(ownerId: string, meetingId: string, pedido: PedidoDoAudio, agora: number = Date.now()): Promise<AudioPreparado> {
  const db = await exigirDb();
  return db.transaction(async tx => {
    const [reuniao] = await tx.select({
      status: meetings.status,
      audioPipeline: meetings.audioPipeline,
      createdAt: meetings.createdAt,
    }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), ne(meetings.status, "deleted")))
      .limit(1);
    // Lançar aqui desfaz a transação: nada foi gravado ainda.
    if (!reuniao) throw new TRPCError({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
    if (reuniao.status === "recording" || reuniao.status === "uploading") throw recusa("PRECONDITION_FAILED", RECUSAS_DO_AUDIO.aindaGravando);
    // Sem linha de áudio, a data da reunião distingue "já venceu e saiu" de "nunca houve".
    const vencidaPelaData = Number(reuniao.createdAt) + MEETING_AUDIO_TTL_MS <= agora;

    const emPartes = reuniao.audioPipeline === "slices";
    let partes: ParteDoAudio[];
    if (emPartes) {
      const linhas = await tx.select({
        seq: meetingAudioSlices.seq,
        status: meetingAudioSlices.status,
        storageKey: meetingAudioSlices.storageKey,
        mimeType: meetingAudioSlices.mimeType,
        durationMs: meetingAudioSlices.durationMs,
        offsetMs: meetingAudioSlices.offsetMs,
        expiresAt: meetingAudioSlices.expiresAt,
      }).from(meetingAudioSlices)
        .where(and(eq(meetingAudioSlices.meetingId, meetingId), eq(meetingAudioSlices.ownerId, ownerId)))
        .orderBy(asc(meetingAudioSlices.seq));
      partes = partesParaBaixar(linhas, agora);
      if (!partes.length) throw semAudio(linhas.length ? linhas.every(linha => Number(linha.expiresAt) <= agora) : vencidaPelaData);
    } else {
      // A mais recente, como em gravacaoParaOuvir: é a que a tela toca.
      const [gravacao] = await tx.select({
        storageKey: meetingRecordings.storageKey,
        mimeType: meetingRecordings.mimeType,
        durationSeconds: meetingRecordings.durationSeconds,
        expiresAt: meetingRecordings.expiresAt,
      }).from(meetingRecordings)
        .where(and(eq(meetingRecordings.meetingId, meetingId), eq(meetingRecordings.ownerId, ownerId)))
        .orderBy(desc(meetingRecordings.createdAt))
        .limit(1);
      if (!gravacao) throw semAudio(vencidaPelaData);
      if (Number(gravacao.expiresAt) <= agora) throw semAudio(true);
      partes = [{ seq: 0, storageKey: gravacao.storageKey, mimeType: gravacao.mimeType, inicioMs: 0, duracaoMs: Number(gravacao.durationSeconds) * 1000 }];
    }

    const ultima = partes[partes.length - 1];
    const duracaoSegundos = Math.round((ultima.inicioMs + ultima.duracaoMs) / 1000);
    await tx.insert(auditLogs).values({
      userId: pedido.userId,
      action: ACAO_AUDIO_BAIXADO,
      resource: "meetings",
      resourceId: meetingId,
      details: {
        formato: pedido.formato,
        partes: partes.length,
        duracaoSegundos,
        emPartes,
        formatosDeOrigem: Array.from(new Set(partes.map(parte => parte.mimeType))).sort(),
      },
      // Os mesmos cortes do createAuditLog (server/security.ts).
      ipAddress: pedido.ipAddress.split(",")[0].trim().substring(0, 45),
      userAgent: pedido.userAgent ? pedido.userAgent.substring(0, 500) : null,
      status: "success",
      // A voz de todas as pessoas da reunião sai da WRW: médio, como o PDF (H8) e o link aberto.
      riskLevel: "medium",
    });
    return { partes, duracaoSegundos };
  });
}

/** O que o endereço de uso único guarda, no servidor. */
export type FichaDoAudio = {
  ownerId: string;
  meetingId: string;
  formato: FormatoDoAudio;
  nomeDoArquivo: string;
  partes: ParteDoAudio[];
};

/** A ficha é 24 bytes aleatórios em base64url (192 bits). */
export const FORMATO_DA_FICHA = /^[A-Za-z0-9_-]{32}$/;

/**
 * O balcão dos endereços do download: cada preparação aceita vira uma ficha de
 * uso único, que vale VALIDADE_DO_ENDERECO_DO_AUDIO_MS e só para a dona que a
 * pediu. A ficha guarda as chaves das partes no servidor; o navegador só vê o
 * número dela.
 *
 * O balcão também é o teto da instância: a vaga é reservada ANTES da transação
 * (para a recusa por ocupação não gravar auditoria), vira ficha quando a
 * preparação dá certo e só volta quando a ficha vence sem uso ou quando o
 * download termina, de qualquer jeito. Em memória, como os tetos dos outros
 * procedimentos: o Render roda uma instância.
 */
export function criarBalcaoDoAudio(opcoes: { limite?: number; validadeMs?: number; relogio?: () => number } = {}) {
  const limite = opcoes.limite ?? CONVERSOES_DE_AUDIO_SIMULTANEAS;
  const validadeMs = opcoes.validadeMs ?? VALIDADE_DO_ENDERECO_DO_AUDIO_MS;
  const relogio = opcoes.relogio ?? Date.now;
  const fichas = new Map<string, { ficha: FichaDoAudio; venceEm: number }>();
  let reservas = 0;
  let emCurso = 0;
  const varrer = () => {
    const agora = relogio();
    fichas.forEach((guardada, numero) => { if (guardada.venceEm <= agora) fichas.delete(numero); });
  };
  return {
    /** Reserva uma vaga, ou recusa com AUDIO_OCUPADO. A vaga vira ficha (emitir) ou volta (soltar). */
    reservar() {
      varrer();
      if (reservas + fichas.size + emCurso >= limite) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_AUDIO.ocupado });
      }
      reservas++;
      let decidida = false;
      return {
        emitir(ficha: FichaDoAudio): string {
          if (decidida) throw new Error("Esta vaga do balcão do áudio já foi usada.");
          decidida = true;
          reservas--;
          const numero = crypto.randomBytes(24).toString("base64url");
          fichas.set(numero, { ficha, venceEm: relogio() + validadeMs });
          return numero;
        },
        soltar() {
          if (decidida) return;
          decidida = true;
          reservas--;
        },
      };
    },
    /**
     * A rota toma a ficha: uma vez só, dentro da validade e só pela dona dela.
     * Ficha de outra conta não é consumida (quem achou o endereço não estraga o
     * download da dona). `terminar` devolve a vaga quando o download acaba.
     */
    tomar(numero: string, ownerId: string): { ficha: FichaDoAudio; terminar: () => void } | null {
      varrer();
      if (!FORMATO_DA_FICHA.test(numero)) return null;
      const guardada = fichas.get(numero);
      if (!guardada || guardada.ficha.ownerId !== ownerId) return null;
      fichas.delete(numero);
      emCurso++;
      let terminou = false;
      return {
        ficha: guardada.ficha,
        terminar: () => {
          if (terminou) return;
          terminou = true;
          emCurso--;
        },
      };
    },
    /** Quantas vagas estão tomadas agora (reservas, fichas no prazo e downloads em curso). */
    ocupadas() {
      varrer();
      return reservas + fichas.size + emCurso;
    },
    /** Só os testes: zera o balcão. */
    esquecer() {
      fichas.clear();
      reservas = 0;
      emCurso = 0;
    },
  };
}

export type BalcaoDoAudio = ReturnType<typeof criarBalcaoDoAudio>;

/** O balcão da instância. */
export const balcaoDoAudio = criarBalcaoDoAudio();

/** Até 32 MB por parte lida: a parte tem até 16 MB (TAMANHO_MAXIMO_DA_PARTE), e o envio único, até 10 MB. */
export const LIMITE_DA_PARTE_LIDA = 32 * 1024 * 1024;

/** Os bytes de uma parte, do bucket para o servidor, com prazo e teto (storageGetBytes). */
export function lerParteDoBucket(storageKey: string): Promise<Buffer> {
  return storageGetBytes(storageKey, LIMITE_DA_PARTE_LIDA);
}

/** Depois de um ffmpeg ausente, quanto tempo até conferir de novo. */
const ESPERA_DEPOIS_DA_FALTA_MS = 60_000;

/**
 * O ffmpeg sobe e tem os dois codificadores (libmp3lame e aac)? A preparação
 * confere antes de auditar, para a dona receber um código traduzido em vez de
 * um download que falha. O sim fica guardado; o não, só por um minuto: uma
 * conferência que falhou por um instante (a instância sem memória para subir
 * mais um processo, por exemplo) não vale até o próximo deploy.
 */
export function criarConferenciaDoFfmpeg(executavel = "ffmpeg", relogio: () => number = Date.now) {
  let resposta: { ok: boolean; em: number } | null = null;
  let emCurso: Promise<boolean> | null = null;
  return function ffmpegDisponivel(): Promise<boolean> {
    if (resposta?.ok) return Promise.resolve(true);
    if (resposta && relogio() - resposta.em < ESPERA_DEPOIS_DA_FALTA_MS) return Promise.resolve(false);
    emCurso ??= conferirFfmpeg(executavel).then(ok => {
      resposta = { ok, em: relogio() };
      emCurso = null;
      if (!ok) console.error(`[Áudio] o ffmpeg (${executavel}) não subiu ou não tem libmp3lame e aac: baixar o áudio fica indisponível. Confira o Dockerfile.`);
      return ok;
    });
    return emCurso;
  };
}

function conferirFfmpeg(executavel: string): Promise<boolean> {
  return new Promise(resolver => {
    let saida = "";
    let filho: ReturnType<typeof spawn>;
    try {
      filho = spawn(executavel, ["-hide_banner", "-encoders"], { env: ambienteDoFfmpeg(), windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolver(false);
      return;
    }
    const prazo = setTimeout(() => filho.kill("SIGKILL"), 15_000);
    filho.stdout?.setEncoding("utf8");
    filho.stdout?.on("data", (pedaco: string) => { saida = (saida + pedaco).slice(-200_000); });
    filho.stdout?.on("error", () => undefined);
    filho.once("error", () => { clearTimeout(prazo); resolver(false); });
    filho.once("close", codigo => {
      clearTimeout(prazo);
      resolver(codigo === 0 && /\slibmp3lame\s/.test(saida) && /^\s*A\S*\s+aac\s/m.test(saida));
    });
  });
}

/** A conferência da instância. */
export const ffmpegDisponivel = criarConferenciaDoFfmpeg();
