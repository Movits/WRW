import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { enviarParte, enviarPendentes, travaDoNavegador } from "@/lib/envio-das-partes";
import { apagarParte, guardarParte } from "@/lib/partes-no-aparelho";
import { aoTerminarUmDescarte, apagarGravacaoDescartada, descartesDa, guardarDescarte, retomarDescartes } from "@/lib/descartes-pendentes";
import { ocupar, useOcupacao } from "@/lib/sessao-ocupada";
import type { AudioGravado } from "./useGravadorDeAudio";
import type { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

/** De quanto em quanto tempo o gravador fecha uma parte (o desenho: ~10 min). */
export const PARTE_SEGUNDOS = 600;
/** De quanto em quanto tempo a tela tenta de novo o que ficou no aparelho. */
const NOVA_TENTATIVA_MS = 30_000;
/** Os fins de gravação que o servidor ainda não confirmou: { meetingId: partes }. */
const CHAVE_DOS_FINS = "wrw:fins-de-gravacao-pendentes";

/**
 * O que o Descartar fez (G13b). "descartada": o servidor excluiu a reunião (a
 * cópia no aparelho que não saiu fica para a retomada, sem aviso). "pendente": a
 * exclusão no servidor falhou e ficou guardada para a retomada
 * (lib/descartes-pendentes.ts). "nada": não havia gravação a descartar — a
 * última parte já tinha entrado na fila (o Encerrar no mesmo instante venceu, e
 * ela segue para a transcrição).
 */
export type ResultadoDoDescarte = "descartada" | "pendente" | "nada";

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
 * Descartar (G13b): a gravação começada por engano sai inteira — a reunião e
 * as partes que subiram, pelo caminho de exclusão de sempre (meetings.delete),
 * e as cópias no aparelho —, e nada dela vai para a transcrição. A exclusão
 * que falha (rede, deploy) fica guardada no localStorage, com a conta que
 * descartou (lib/descartes-pendentes.ts), e a retomada a repete: a desta tela,
 * antes de reenviar as partes, e a de toda tela logada
 * (components/RetomadaDosDescartes.tsx).
 *
 * Os avisos que a tela mostra saem por aqui (G13b): a parte que o servidor
 * recusou de vez (`aoRecusarParte`, com o código, que a tela traduz), a cópia
 * no aparelho que não pôde ser guardada (`aoFicarSemCopia`, uma vez por
 * gravação: sem a cópia, uma queda de rede perde o trecho que estava subindo)
 * e o descarte guardado cuja exclusão uma retomada concluiu
 * (`aoConcluirDescarte`, para a tela fechar o aviso de que ele não terminou).
 *
 * As closures sobrevivem ao desmonte: a parte que o gravador entrega depois de
 * a tela sair (o desmonte gravando para e entrega, G13b) sobe e encerra a
 * gravação do mesmo jeito.
 *
 * Com `ativo` falso (o envio único, ?envioUnico=1), nada aqui toca o servidor.
 */
export function useGravacaoEmPartes(opcoes: {
  ativo: boolean;
  aoEncerrar: (meetingId: string) => void;
  aoFalhar: (erro: unknown) => void;
  /** O servidor recusou uma parte de vez: o código da recusa, que a tela traduz. */
  aoRecusarParte?: (codigo: string | undefined) => void;
  /** A cópia de uma parte no aparelho falhou: uma vez por gravação. */
  aoFicarSemCopia?: () => void;
  /** A exclusão no servidor de um descarte guardado terminou numa retomada (desta tela ou de toda a sessão). */
  aoConcluirDescarte?: (meetingId: string) => void;
}) {
  const utils = trpc.useUtils();
  const atuais = useRef(opcoes);
  atuais.current = opcoes;
  const meetingId = useRef<string | null>(null);
  // As partes desta gravação vão ao servidor em ORDEM: cada envio espera o anterior.
  const fila = useRef<Promise<void>>(Promise.resolve());
  // As gravações descartadas nesta tela: a parte delas que ainda espera a vez
  // na fila sai sem subir, e a recusa de uma parte delas não vira aviso (a
  // reunião sumiu porque a dona mandou).
  const descartadas = useRef(new Set<string>());
  // A gravação que já levou o aviso da cópia que faltou: um aviso por gravação.
  const semCopiaAvisada = useRef<string | null>(null);
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

  /** A exclusão no servidor, pelo caminho de sempre (meetings.delete, que leva as partes que subiram e os objetos delas no bucket). */
  const excluirNoServidor = useCallback((id: string) => utils.client.meetings.delete.mutate({ meetingId: id }), [utils]);

  /**
   * Cancela a gravação `id`, e só ela: o microfone que não abriu depois de a
   * reunião nascer, ou o Descartar da dona (G13b). Antes o cancelar apagava a
   * reunião para a qual a tela apontava naquela hora: no duplo clique do
   * Iniciar, a da gravação em curso, que perdia as partes.
   *
   * A exclusão é guardada antes de tudo, com a dona, e corre na fila, depois da
   * parte que já estiver subindo; as que ainda esperam a vez saem sem subir.
   * Responde "descartada" quando o servidor excluiu (a cópia no aparelho que
   * não saiu fica para a retomada) e "pendente" quando a exclusão no servidor
   * falhou e segue guardada para a retomada.
   */
  const cancelar = useCallback(async (id: string): Promise<Exclude<ResultadoDoDescarte, "nada">> => {
    if (meetingId.current === id) meetingId.current = null;
    descartadas.current.add(id);
    // A conta vem do cache da sessão, sem esperar a rede, para o descarte ficar
    // guardado já no clique (a aba pode fechar logo depois). Sem ela no cache,
    // do servidor; sem conta nenhuma (a sessão acabou no meio), não há a quem
    // atribuir o descarte, e a exclusão é tentada só agora.
    const quem = utils.auth.me.getData()?.openId ?? (await dona());
    if (quem) guardarDescarte(id, quem);
    const exclusao = fila.current.then(() => apagarGravacaoDescartada(id, quem, excluirNoServidor));
    fila.current = exclusao.then(() => undefined, () => undefined);
    const { servidor } = await exclusao;
    return servidor ? "descartada" : "pendente";
  }, [utils, dona, excluirNoServidor]);

  /**
   * Descarta a gravação em curso (quem chama já parou o gravador sem entregar).
   * Sem gravação em curso — a última parte já entrou na fila, porque o Encerrar
   * chegou no mesmo instante —, não descarta nada: responde "nada".
   */
  const descartar = useCallback(async (): Promise<ResultadoDoDescarte> => {
    const id = meetingId.current;
    return id ? cancelar(id) : "nada";
  }, [cancelar]);

  /** Uma parte que o gravador fechou: aparelho, depois servidor. Na última, encerra. */
  const receberParte = useCallback((parte: AudioGravado & { seq: number; ultima: boolean }) => {
    const id = meetingId.current;
    if (!id) return atuais.current.aoFalhar(new Error("Gravação em partes sem reunião."));
    // A última parte encerra a gravação já ao entrar na fila, e não quando sobe:
    // o Descartar do mesmo instante não tem mais gravação a descartar ("nada"), e
    // o Encerrar vence. A gravação seguinte pode começar enquanto esta última
    // parte ainda espera a vez, com a reunião dela.
    if (parte.ultima) meetingId.current = null;
    setPendentes(n => n + 1);
    const liberar = ocupar("enviando");
    fila.current = fila.current.then(async () => {
      // Descartada enquanto esta parte esperava a vez: não sobe nem fica no aparelho.
      if (descartadas.current.has(id)) return;
      const quem = await dona();
      // A parte vazia (Parar logo depois de uma troca) não vai: não é áudio.
      if (parte.blob.size > 0) {
        // A cópia no aparelho: se o IndexedDB faltar (ou a conta não vier), segue
        // da memória, e a dona fica sabendo, uma vez por gravação, que uma queda
        // de rede agora perde o trecho que estava subindo.
        const copiada = quem !== null && await guardarParte({ meetingId: id, seq: parte.seq, blob: parte.blob, mimeType: parte.mimeType, duracaoMs: parte.duracaoMs, dona: quem, guardadaEm: Date.now() }).then(() => true, () => false);
        if (!copiada && semCopiaAvisada.current !== id) {
          semCopiaAvisada.current = id;
          atuais.current.aoFicarSemCopia?.();
        }
        const resultado = await travaDoNavegador(`wrw-envio-${id}`, () => enviarParte(id, parte.seq, parte.blob, parte.mimeType));
        if (resultado?.tipo === "recebida" || resultado?.tipo === "recusada") await apagarParte(id, parte.seq).catch(() => {});
        else setNoAparelho(n => n + 1);
        // A recusa é definitiva: o trecho fica de fora da transcrição, e a dona
        // precisa saber. Não na gravação que ela mesma descartou.
        if (resultado?.tipo === "recusada" && !descartadas.current.has(id)) atuais.current.aoRecusarParte?.(resultado.codigo);
      }
      if (parte.ultima) {
        const total = parte.blob.size > 0 ? parte.seq + 1 : parte.seq;
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

  // A retomada, a cada 30 s com a tela aberta: as gravações descartadas desta
  // conta cuja exclusão falhou, as partes que ficaram no aparelho e os fins que
  // o servidor não confirmou.
  useEffect(() => {
    if (!opcoes.ativo) return;
    let ativo = true;
    let relogio = 0;
    const tentar = async () => {
      const quem = await dona();
      if (quem) {
        // Os descartes antes do envio: a cópia de uma gravação descartada sai do
        // aparelho antes de a retomada reenviá-la. Só os desta conta; a retomada
        // de toda a sessão (components/RetomadaDosDescartes.tsx) pode estar
        // repetindo os mesmos, e a exclusão repetida dá NOT_FOUND, que é feito.
        await retomarDescartes(quem, excluirNoServidor);
        // A cópia de uma gravação descartada que ainda não saiu do aparelho (o
        // IndexedDB bloqueado por outra aba, por exemplo) volta recusada: não é
        // aviso para a dona, que a descartou.
        const descartada = (id: string) => descartadas.current.has(id) || descartesDa(quem).some(descarte => descarte.id === id);
        const r = await enviarPendentes(quem, {
          aoRecusar: (parte, codigo) => { if (!descartada(parte.meetingId)) atuais.current.aoRecusarParte?.(codigo); },
        }).catch(() => null);
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
  }, [opcoes.ativo, dona, encerrar, excluirNoServidor]);

  // O descarte guardado que uma retomada terminou de excluir no servidor (a
  // desta tela ou a de toda a sessão): a tela fecha o aviso de que ele não
  // tinha terminado.
  useEffect(() => {
    if (!opcoes.ativo) return;
    return aoTerminarUmDescarte(id => atuais.current.aoConcluirDescarte?.(id));
  }, [opcoes.ativo]);

  return { iniciar, cancelar, descartar, receberParte, enviando: pendentes > 0 };
}
