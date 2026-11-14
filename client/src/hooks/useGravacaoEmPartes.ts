import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { enviarParte, enviarPendentes, travaDoNavegador } from "@/lib/envio-das-partes";
import { apagarParte, guardarParte } from "@/lib/partes-no-aparelho";
import { ocupar, useOcupacao } from "@/lib/sessao-ocupada";
import type { AudioGravado } from "./useGravadorDeAudio";
import type { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

/** De quanto em quanto tempo o gravador fecha uma parte (o desenho: ~10 min). */
export const PARTE_SEGUNDOS = 600;
/** De quanto em quanto tempo a tela tenta de novo o que ficou no aparelho. */
const NOVA_TENTATIVA_MS = 30_000;
/** Os fins de gravação que o servidor ainda não confirmou: { meetingId: partes }. */
const CHAVE_DOS_FINS = "wrw:fins-de-gravacao-pendentes";

type Inicio = { title: string; language: string; consentNoticeVersion: typeof VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO; contactId?: number | null; contextId?: string | null };

function lerFins(): Record<string, number> {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE_DOS_FINS) ?? "{}");
    return bruto && typeof bruto === "object" ? bruto as Record<string, number> : {};
  } catch {
    return {};
  }
}
function gravarFins(fins: Record<string, number>) {
  try {
    if (Object.keys(fins).length) localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify(fins));
    else localStorage.removeItem(CHAVE_DOS_FINS);
  } catch {
    // Sem localStorage: o fim é tentado só nesta tela.
  }
}

/**
 * A gravação em partes do lado da tela (G9 do desenho do gravador): a reunião
 * nasce no começo (meetings.iniciarGravacao), cada parte que o gravador fecha
 * vai primeiro para o aparelho (IndexedDB) e depois ao servidor, em ordem, e
 * só sai do aparelho quando ele a confirma. No fim, encerrarGravacao diz
 * quantas partes houve, e a fila do servidor transcreve.
 *
 * Queda de rede ou deploy no meio não perdem nada: a cada 30 s, com a tela de
 * reuniões aberta, o que ficou no aparelho vai de novo, e o fim da gravação
 * que o servidor não confirmou é declarado de novo (guardado no localStorage).
 * Uma trava entre abas (Web Locks) impede duas abas de enviarem a mesma
 * gravação. Enquanto há envio, ou parte esperando no aparelho, a sessão fica
 * ocupada: o Sair e o fechar da aba pedem confirmação.
 *
 * Com `ativo` falso (o modo de hoje, sem partes), nada aqui toca o servidor.
 */
export function useGravacaoEmPartes(opcoes: { ativo: boolean; aoEncerrar: (meetingId: string) => void; aoFalhar: (erro: unknown) => void }) {
  const utils = trpc.useUtils();
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  const meetingId = useRef<string | null>(null);
  // As partes desta gravação vão ao servidor em ORDEM: cada envio espera o anterior.
  const fila = useRef<Promise<void>>(Promise.resolve());
  const [pendentes, setPendentes] = useState(0);
  const [noAparelho, setNoAparelho] = useState(0);
  useOcupacao("audio-nao-enviado", opcoes.ativo && noAparelho > 0);

  // A conta: do cache do React Query ou, se ele ainda não a tem, do servidor.
  const dona = useCallback(async () => utils.auth.me.getData()?.openId ?? (await utils.auth.me.fetch().catch(() => null))?.openId ?? null, [utils]);

  const encerrar = useCallback(async (id: string, partes: number) => {
    if (partes <= 0) {
      // Nada gravou: a reunião sem áudio sai, em vez de ficar "gravando".
      await utils.client.meetings.delete.mutate({ meetingId: id });
      return;
    }
    await utils.client.meetings.encerrarGravacao.mutate({ meetingId: id, partes });
  }, [utils]);

  const iniciar = useCallback(async (inicio: Inicio) => {
    const { id } = await utils.client.meetings.iniciarGravacao.mutate({ ...inicio, consentGranted: true, origem: "gravacao" });
    meetingId.current = id;
    return id;
  }, [utils]);

  /** O microfone não abriu depois de a reunião nascer: a reunião vazia sai. */
  const cancelar = useCallback(async () => {
    const id = meetingId.current;
    meetingId.current = null;
    if (id) await utils.client.meetings.delete.mutate({ meetingId: id }).catch(() => {});
  }, [utils]);

  /** Uma parte que o gravador fechou: aparelho, depois servidor. Na última, encerra. */
  const receberParte = useCallback((parte: AudioGravado & { seq: number; ultima: boolean }) => {
    const id = meetingId.current;
    if (!id) return atuais.current.aoFalhar(new Error("Gravação em partes sem reunião."));
    setPendentes(n => n + 1);
    const liberar = ocupar("enviando");
    fila.current = fila.current.then(async () => {
      const quem = await dona();
      // A parte vazia (Parar logo depois de uma troca) não vai: não é áudio.
      if (parte.blob.size > 0) {
        // A cópia no aparelho: se o IndexedDB faltar, segue da memória.
        if (quem) await guardarParte({ meetingId: id, seq: parte.seq, blob: parte.blob, mimeType: parte.mimeType, duracaoMs: parte.duracaoMs, dona: quem, guardadaEm: Date.now() }).catch(() => {});
        const resultado = await travaDoNavegador(`wrw-envio-${id}`, () => enviarParte(id, parte.seq, parte.blob, parte.mimeType));
        if (resultado?.tipo === "recebida" || resultado?.tipo === "recusada") await apagarParte(id, parte.seq).catch(() => {});
        else setNoAparelho(n => n + 1);
      }
      if (parte.ultima) {
        const total = parte.blob.size > 0 ? parte.seq + 1 : parte.seq;
        meetingId.current = null;
        try {
          await encerrar(id, total);
          atuais.current.aoEncerrar(id);
        } catch (erro) {
          // O fim fica guardado e é declarado de novo pela retomada.
          gravarFins({ ...lerFins(), [id]: total });
          throw erro;
        }
      }
    }).catch(erro => atuais.current.aoFalhar(erro)).finally(() => {
      setPendentes(n => n - 1);
      liberar();
    });
  }, [dona, encerrar]);

  // A retomada, a cada 30 s com a tela aberta: as partes que ficaram no
  // aparelho e os fins que o servidor não confirmou.
  useEffect(() => {
    if (!opcoes.ativo) return;
    let ativo = true;
    let relogio = 0;
    const tentar = async () => {
      const quem = await dona();
      if (quem) {
        const r = await enviarPendentes(quem).catch(() => null);
        if (ativo && r) setNoAparelho(r.restantes);
        for (const [id, partes] of Object.entries(lerFins())) {
          try {
            await encerrar(id, partes);
            // Relê antes de gravar: outro fim pode ter entrado durante o await.
            const { [id]: _declarado, ...resto } = lerFins();
            gravarFins(resto);
          } catch {
            // Segue guardado para a próxima tentativa.
          }
        }
      }
      if (ativo) relogio = window.setTimeout(() => void tentar(), NOVA_TENTATIVA_MS);
    };
    relogio = window.setTimeout(() => void tentar(), 0);
    return () => {
      ativo = false;
      window.clearTimeout(relogio);
    };
  }, [opcoes.ativo, dona, encerrar]);

  return { iniciar, cancelar, receberParte, enviando: pendentes > 0 };
}
