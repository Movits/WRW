import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { enviarParte, enviarPendentes, travaDoNavegador } from "@/lib/envio-das-partes";
import { apagarParte, guardarParte } from "@/lib/partes-no-aparelho";
import { ocupar } from "@/lib/sessao-ocupada";
import type { AudioGravado } from "./useGravadorDeAudio";
import type { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

/** De quanto em quanto tempo o gravador fecha uma parte (o desenho: ~10 min). */
export const PARTE_SEGUNDOS = 600;
/** De quanto em quanto tempo a tela tenta de novo o que ficou no aparelho. */
const NOVA_TENTATIVA_MS = 30_000;

type Inicio = { title: string; language: string; consentNoticeVersion: typeof VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO; contactId?: number | null; contextId?: string | null };

/**
 * A gravação em partes do lado da tela (G9 do desenho do gravador): a reunião
 * nasce no começo (meetings.iniciarGravacao), cada parte que o gravador fecha
 * vai primeiro para o aparelho (IndexedDB) e depois ao servidor, em ordem, e
 * só sai do aparelho quando ele a confirma. No fim, encerrarGravacao diz
 * quantas partes houve, e a fila do servidor transcreve.
 *
 * Queda de rede ou deploy no meio não perdem nada: o que ficou no aparelho é
 * reenviado a cada 30 s com a tela aberta, e ao abrir a tela de novo (mesmo
 * depois de um novo login). Uma trava entre abas (Web Locks) impede duas abas
 * de enviarem a mesma gravação. Enquanto há envio, a sessão fica ocupada.
 *
 * Com `ativo` falso (o modo de hoje, sem partes), nada aqui toca o servidor:
 * os procedimentos e a conta são lidos só quando a gravação em partes começa.
 */
export function useGravacaoEmPartes(opcoes: { ativo: boolean; aoEncerrar: (meetingId: string) => void; aoFalhar: (erro: unknown) => void }) {
  const utils = trpc.useUtils();
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  const meetingId = useRef<string | null>(null);
  // As partes desta gravação vão ao servidor em ORDEM: cada envio espera o anterior.
  const fila = useRef<Promise<void>>(Promise.resolve());
  const [pendentes, setPendentes] = useState(0);
  const dona = () => utils.auth.me.getData()?.openId ?? null;

  const iniciar = useCallback(async (inicio: Inicio) => {
    const { id } = await utils.client.meetings.iniciarGravacao.mutate({ ...inicio, consentGranted: true, origem: "gravacao" });
    meetingId.current = id;
    return id;
  }, [utils]);

  /** Uma parte que o gravador fechou: aparelho, depois servidor. Na última, encerra. */
  const receberParte = useCallback((parte: AudioGravado & { seq: number; ultima: boolean }) => {
    const id = meetingId.current;
    const quem = dona();
    if (!id || !quem) return;
    setPendentes(n => n + 1);
    const liberar = ocupar("enviando");
    fila.current = fila.current.then(async () => {
      // A cópia no aparelho: se o IndexedDB faltar, segue da memória.
      await guardarParte({ meetingId: id, seq: parte.seq, blob: parte.blob, mimeType: parte.mimeType, duracaoMs: parte.duracaoMs, dona: quem, guardadaEm: Date.now() }).catch(() => {});
      const resultado = await travaDoNavegador(`wrw-envio-${id}`, () => enviarParte(id, parte.seq, parte.blob, parte.mimeType));
      if (resultado?.tipo === "recebida" || resultado?.tipo === "recusada") await apagarParte(id, parte.seq).catch(() => {});
      if (parte.ultima) {
        await utils.client.meetings.encerrarGravacao.mutate({ meetingId: id, partes: parte.seq + 1 });
        meetingId.current = null;
        atuais.current.aoEncerrar(id);
      }
    }).catch(erro => atuais.current.aoFalhar(erro)).finally(() => {
      setPendentes(n => n - 1);
      liberar();
    });
  }, [utils]);

  // A retomada: o que ficou no aparelho (de antes de um recarregar, de uma
  // queda de rede, de outra sessão da mesma conta) vai de novo.
  useEffect(() => {
    if (!opcoes.ativo) return;
    let ativo = true;
    let relogio = 0;
    const tentar = () => {
      const quem = dona();
      if (!quem) return;
      void enviarPendentes(quem).catch(() => ({ restantes: 0, semSessao: false })).then(r => {
        if (ativo && r.restantes > 0) relogio = window.setTimeout(tentar, NOVA_TENTATIVA_MS);
      });
    };
    relogio = window.setTimeout(tentar, 0);
    return () => {
      ativo = false;
      window.clearTimeout(relogio);
    };
  }, [opcoes.ativo]);

  return { iniciar, receberParte, enviando: pendentes > 0 };
}
