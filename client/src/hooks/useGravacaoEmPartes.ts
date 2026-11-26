import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { enviarParte, travaDoNavegador, type ResultadoDoEnvio } from "@/lib/envio-das-partes";
import { apagarParte, guardarParte } from "@/lib/partes-no-aparelho";
import { aoTerminarUmDescarte, apagarGravacaoDescartada, guardarDescarte, retomarDescartes } from "@/lib/descartes-pendentes";
import { declararFim, fimRecusadoDeVez, guardarFim, retomarPartesEFins, type ServidorDaGravacao } from "@/lib/retomada-das-partes";
import { ocupar, useOcupacao } from "@/lib/sessao-ocupada";
import type { AudioGravado } from "./useGravadorDeAudio";
import type { TipoDaParte } from "@/lib/corte-comum";
import type { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";

/** De quanto em quanto tempo o gravador fecha uma parte (o desenho: ~10 min). */
export const PARTE_SEGUNDOS = 600;
/** De quanto em quanto tempo a tela tenta de novo o que ficou no aparelho. */
const NOVA_TENTATIVA_MS = 30_000;
/**
 * As esperas entre as tentativas de envio da parte que NÃO tem cópia no
 * aparelho (a última se repete): ela só existe na memória da aba, e a
 * retomada, que lê o aparelho, nunca a acharia. Ver `subir`.
 */
export const ESPERAS_DA_PARTE_SEM_COPIA_MS = [2_000, 5_000, 10_000, 30_000] as const;


/**
 * O que o Descartar fez (G13b). "descartada": o servidor excluiu a reunião (a
 * cópia no aparelho que não saiu fica para a retomada, sem aviso). "pendente": a
 * exclusão no servidor falhou e ficou guardada para a retomada
 * (lib/descartes-pendentes.ts). "nada": não havia gravação a descartar — a
 * última parte já tinha entrado na fila (o Encerrar no mesmo instante venceu, e
 * ela segue para a transcrição).
 */
export type ResultadoDoDescarte = "descartada" | "pendente" | "nada";

/**
 * O começo da reunião em partes. A `origem` diz de onde vem o áudio: o
 * microfone (o padrão) ou o arquivo importado em partes (H9a,
 * useImportacaoEmPartes).
 */
type Inicio = { title: string; language: string; consentNoticeVersion: typeof VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO; contactId?: number | null; contextId?: string | null; origem?: "gravacao" | "arquivo" };

/**
 * Uma parte a enviar: a que o gravador fecha (AudioGravado) ou a de um
 * arquivo importado em partes (H9a, H9b e H9c), que sobe no tipo que o corte
 * diz (audio/mpeg, audio/mp4, audio/ogg, audio/flac...: TipoDaParte).
 */
export type ParteParaEnviar = Omit<AudioGravado, "mimeType"> & { mimeType: AudioGravado["mimeType"] | TipoDaParte; seq: number; ultima: boolean };

/**
 * Uma parte do arquivo importado em partes (H9a): sem o `ultima`, porque o fim do
 * arquivo vem à parte (encerrarArquivo), depois de todas as partes recebidas.
 */
export type ParteDoArquivo = Omit<ParteParaEnviar, "ultima">;

/**
 * O que houve com uma parte do arquivo importado (H9a), para a importação
 * decidir se manda a seguinte: o resultado do envio (lib/envio-das-partes.ts);
 * "ocupada", quando outra aba enviava a mesma gravação naquela hora (a trava
 * entre abas); e "descartada", quando a importação foi cancelada antes de a
 * parte subir.
 */
export type DesfechoDaParte = ResultadoDoEnvio | { tipo: "ocupada" } | { tipo: "descartada" };

/**
 * O fim do arquivo importado (H9a). "declarado": o servidor o confirmou, e a
 * tela foi ao detalhe (aoEncerrar). "pendente": a confirmação falhou (rede,
 * deploy, sessão vencida), e o fim ficou guardado para a retomada declarar.
 * "recusado": o servidor o recusou de vez (a reunião excluída em outro
 * aparelho, por exemplo), e o aviso saiu pelo aoFalhar. "descartada": a
 * importação foi cancelada antes ou enquanto o fim estava no ar, e a exclusão
 * vem logo atrás, na fila.
 */
export type FimDoArquivo = "declarado" | "pendente" | "recusado" | "descartada";

/**
 * A gravação em partes do lado da tela (G9 do desenho do gravador): a reunião
 * nasce no começo (meetings.iniciarGravacao), cada parte que o gravador fecha
 * vai primeiro para o aparelho (IndexedDB) e depois ao servidor, em ordem, e
 * só sai do aparelho quando ele a confirma. No fim, encerrarGravacao diz
 * quantas partes houve, e a fila do servidor transcreve.
 *
 * Queda de rede ou deploy no meio não perdem nada: a cada 30 s, com a tela de
 * reuniões aberta, o que ficou no aparelho vai de novo, e o fim da gravação
 * que o servidor não confirmou é declarado de novo (guardado no localStorage,
 * com a conta). Desde a G13c a mesma retomada (lib/retomada-das-partes.ts)
 * roda também em toda tela logada (components/RetomadaDasPartes.tsx), para a
 * dona que saiu de Reuniões; as duas não enviam a mesma parte nem declaram o
 * mesmo fim duas vezes. Uma trava entre abas (Web Locks) impede duas abas de
 * enviarem a mesma gravação. Enquanto há envio, ou parte esperando no
 * aparelho, a sessão fica ocupada: o Sair e o fechar da aba pedem confirmação.
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
 * gravação: sem a cópia, o trecho que não subiu depende da aba aberta, que
 * insiste no envio até o servidor confirmar)
 * e o descarte guardado cuja exclusão uma retomada concluiu
 * (`aoConcluirDescarte`, para a tela fechar o aviso de que ele não terminou).
 *
 * As closures sobrevivem ao desmonte: a parte que o gravador entrega depois de
 * a tela sair (o desmonte gravando para e entrega, G13b) sobe e encerra a
 * gravação do mesmo jeito.
 *
 * O arquivo importado em partes (H9a, hooks/useImportacaoEmPartes.ts) passa por
 * aqui também: a reunião nasce com a origem "arquivo", cada parte cortada sobe
 * pela mesma fila, no tipo da parte (subirParteDoArquivo, que responde o que
 * houve com ela: a importação só manda a seguinte quando esta chegou), e o fim
 * vem depois de todas (encerrarArquivo).
 */
export function useGravacaoEmPartes(opcoes: {
  aoEncerrar: (meetingId: string) => void;
  /**
   * O fim sem nenhuma parte com áudio (G17: o microfone caiu antes de 1 s de
   * gravação, e a parte curta demais saiu): a reunião vazia foi excluída
   * (declararFim), e não há detalhe para abrir. Sem isto, a tela ia ao
   * detalhe de uma reunião que não existe mais.
   */
  aoEncerrarSemAudio?: (meetingId: string) => void;
  aoFalhar: (erro: unknown) => void;
  /** O servidor recusou uma parte de vez: o código da recusa, que a tela traduz. */
  aoRecusarParte?: (codigo: string | undefined) => void;
  /** A cópia de uma parte no aparelho falhou: uma vez por gravação. */
  aoFicarSemCopia?: () => void;
  /**
   * Uma parte sem cópia no aparelho que não subiu e não vai mais subir: a
   * sessão acabou (401/403, o Sair) ou a tela saiu sem conseguir guardar a
   * cópia. O trecho fica de fora da gravação, e a dona precisa saber.
   */
  aoPerderParte?: (meetingId: string, seq: number) => void;
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
  // A conta que começou cada gravação (do cache da sessão, no Iniciar): a dona
  // da reunião no servidor. O fim e o descarte guardados levam essa conta
  // quando a sessão some no meio (o Sair com a gravação no ar, o cache
  // limpo): sem ela, a primeira conta que entrasse neste aparelho tentaria o
  // fim de uma reunião alheia (revisão da G13c). A cópia das partes, não:
  // depois do Sair nenhuma voz fica no aparelho.
  const donas = useRef(new Map<string, string>());
  // As esperas das partes sem cópia que esta aba ainda insiste em enviar, por
  // gravação: o descarte as acorda, para a insistência parar já (e a sessão
  // desocupar) em vez de na próxima volta.
  const esperasSemCopia = useRef(new Map<string, Set<() => void>>());
  const montada = useRef(true);
  const [pendentes, setPendentes] = useState(0);
  const [noAparelho, setNoAparelho] = useState(0);
  useOcupacao("audio-nao-enviado", noAparelho > 0);

  // A conta: do cache do React Query ou, se ele ainda não a tem, do servidor.
  const dona = useCallback(async () => utils.auth.me.getData()?.openId ?? (await utils.auth.me.fetch().catch(() => null))?.openId ?? null, [utils]);

  // O fim (meetings.encerrarGravacao) e a exclusão no servidor, pelo caminho de
  // sempre (meetings.delete, que leva as partes que subiram e os objetos delas
  // no bucket): o mesmo par que a retomada de toda tela logada usa.
  const servidorDaGravacao = useMemo<ServidorDaGravacao>(() => ({
    encerrarGravacao: (id, partes) => utils.client.meetings.encerrarGravacao.mutate({ meetingId: id, partes }),
    excluir: id => utils.client.meetings.delete.mutate({ meetingId: id }),
  }), [utils]);
  const excluirNoServidor = servidorDaGravacao.excluir;

  // Sem nenhuma parte com áudio, a reunião sai, em vez de ficar "gravando".
  const encerrar = useCallback((id: string, partes: number) => declararFim(servidorDaGravacao, id, partes), [servidorDaGravacao]);

  const iniciar = useCallback(async ({ origem = "gravacao", ...inicio }: Inicio) => {
    const { id } = await utils.client.meetings.iniciarGravacao.mutate({ ...inicio, consentGranted: true, origem });
    meetingId.current = id;
    const quem = utils.auth.me.getData()?.openId;
    if (quem) donas.current.set(id, quem);
    return id;
  }, [utils]);

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
    esperasSemCopia.current.get(id)?.forEach(acordar => acordar());
    // A conta vem do cache da sessão, sem esperar a rede, para o descarte ficar
    // guardado já no clique (a aba pode fechar logo depois). Sem ela no cache,
    // a que começou a gravação, e só então do servidor; sem conta nenhuma, não
    // há a quem atribuir o descarte, e a exclusão é tentada só agora.
    const quem = utils.auth.me.getData()?.openId ?? donas.current.get(id) ?? (await dona());
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

  // A cópia da parte no aparelho (IndexedDB), com a conta. Sem a conta ou sem
  // o IndexedDB, não há cópia: responde false.
  const copiar = useCallback((id: string, parte: ParteDoArquivo, quem: string | null) =>
    quem === null
      ? Promise.resolve(false)
      : guardarParte({ meetingId: id, seq: parte.seq, blob: parte.blob, mimeType: parte.mimeType, duracaoMs: parte.duracaoMs, dona: quem, guardadaEm: Date.now() }).then(() => true, () => false),
  []);

  // Um envio da parte ao servidor, com a trava entre abas. A confirmada ou
  // recusada de vez sai do aparelho; a recusa avisa a dona, menos na gravação
  // que ela mesma descartou.
  const enviar = useCallback(async (id: string, parte: ParteDoArquivo): Promise<DesfechoDaParte> => {
    const resultado: DesfechoDaParte = (await travaDoNavegador(`wrw-envio-${id}`, () => enviarParte(id, parte.seq, parte.blob, parte.mimeType))) ?? { tipo: "ocupada" };
    if (resultado.tipo === "recebida" || resultado.tipo === "recusada") await apagarParte(id, parte.seq).catch(() => {});
    if (resultado.tipo === "recusada" && !descartadas.current.has(id)) atuais.current.aoRecusarParte?.(resultado.codigo);
    return resultado;
  }, []);

  // Uma parte vai primeiro ao aparelho (a cópia) e depois ao servidor, e só
  // sai do aparelho quando o servidor a confirma ou a recusa de vez. Roda
  // dentro da fila; a gravação e o arquivo importado passam por aqui.
  const subir = useCallback(async (id: string, parte: ParteDoArquivo, quem: string | null): Promise<{ desfecho: DesfechoDaParte; copiada: boolean }> => {
    // Se o IndexedDB faltar (ou a conta não vier), segue da memória, e a dona
    // fica sabendo, uma vez por gravação, que o trecho depende desta aba
    // aberta até subir.
    const copiada = await copiar(id, parte, quem);
    if (!copiada && semCopiaAvisada.current !== id) {
      semCopiaAvisada.current = id;
      atuais.current.aoFicarSemCopia?.();
    }
    // Uma falha inesperada (a trava do navegador, por exemplo) é passageira:
    // a parte não pode sumir por uma exceção.
    const desfecho = await enviar(id, parte).catch((): DesfechoDaParte => ({ tipo: "passageira" }));
    return { desfecho, copiada };
  }, [copiar, enviar]);

  /**
   * A parte da gravação que não tem cópia no aparelho e cujo envio falhou
   * (rede, deploy, outra aba com a trava). Ela só existe na memória desta aba:
   * a retomada, que lê o aparelho, nunca a acharia, e o trecho sumia da
   * gravação (o defeito achado na validação da #202). Aqui ela é tentada de
   * novo, com espera crescente, até o servidor a confirmar ou recusar de vez.
   * A cada volta a cópia é tentada de novo: a que der certo devolve a parte ao
   * caminho de sempre (a retomada da G13c a manda depois).
   *
   * Corre por fora da fila: as partes seguintes e o fim da gravação não
   * esperam por ela (o servidor aceita, depois do fim, as partes que faltavam
   * até o total). Enquanto ela não sobe, a sessão fica ocupada: fechar a aba
   * pergunta. A insistência para (revisão da #260):
   * - no descarte da gravação: a dona mandou, nada a avisar;
   * - no desmonte da tela: os relógios saem, e a parte tem uma última chance
   *   de ir ao aparelho, para a retomada de toda tela logada seguir por ela;
   * - na sessão encerrada (401/403, o Sair): nada mais sobe por esta aba, e a
   *   cópia não é tentada, porque depois do Sair nenhuma voz fica no aparelho.
   * Sem cópia no fim, a parte se perdeu, e a tela avisa (aoPerderParte). O
   * aviso da cópia indisponível já pede que a dona fique na tela até o envio
   * terminar.
   */
  const insistirSemCopia = useCallback((id: string, parte: ParteDoArquivo, quemNoInicio: string | null, desfechoDoEnvio: DesfechoDaParte) => {
    // Sem a cópia, a parte se perdeu: avisa, menos na gravação descartada.
    const perder = () => {
      if (!descartadas.current.has(id)) atuais.current.aoPerderParte?.(id, parte.seq);
    };
    if (desfechoDoEnvio.tipo === "sem-sessao") return perder();
    const liberar = ocupar("enviando");
    const esperar = (ms: number) => new Promise<void>(resolve => {
      const esperas = esperasSemCopia.current.get(id) ?? new Set<() => void>();
      esperasSemCopia.current.set(id, esperas);
      const acordar = () => {
        clearTimeout(relogio);
        esperas.delete(acordar);
        if (!esperas.size) esperasSemCopia.current.delete(id);
        resolve();
      };
      const relogio = setTimeout(acordar, ms);
      esperas.add(acordar);
    });
    void (async () => {
      let quem = quemNoInicio ?? donas.current.get(id) ?? null;
      for (let tentativa = 0; ; tentativa += 1) {
        // A tela já saiu (ou saiu durante a espera): uma última chance de cópia, sem relógio.
        if (montada.current) await esperar(ESPERAS_DA_PARTE_SEM_COPIA_MS[Math.min(tentativa, ESPERAS_DA_PARTE_SEM_COPIA_MS.length - 1)]);
        if (descartadas.current.has(id)) return;
        quem = quem ?? await dona();
        if (await copiar(id, parte, quem)) {
          // Agora no aparelho: a retomada a manda, e ela conta como áudio por enviar.
          if (montada.current) setNoAparelho(n => n + 1);
          return;
        }
        if (!montada.current) return perder();
        const resultado = await enviar(id, parte).catch((): DesfechoDaParte => ({ tipo: "passageira" }));
        if (resultado.tipo === "recebida" || resultado.tipo === "recusada") return;
        if (resultado.tipo === "sem-sessao") return perder();
      }
    })().finally(liberar);
  }, [dona, copiar, enviar]);

  // A tela montada: o desmonte acorda as esperas das partes sem cópia, para a
  // insistência parar já, sem relógio pendurado (revisão da #260).
  useEffect(() => {
    montada.current = true;
    return () => {
      montada.current = false;
      esperasSemCopia.current.forEach(esperas => esperas.forEach(acordar => acordar()));
    };
  }, []);

  // O fim de `id`, com `total` partes: o servidor o confirma, e a tela vai ao
  // detalhe (aoEncerrar). Cancelada antes, ou enquanto o fim estava no ar (o
  // Cancelar da importação, H9a), a reunião não é encerrada, ou a tela não vai
  // ao detalhe: a exclusão vem logo atrás, na fila, e o detalhe seria o de uma
  // reunião que está para sair. O fim que falha fica guardado, com a conta, e a
  // retomada o declara de novo: a desta tela e a de toda tela logada, para a
  // dona que já saiu de Reuniões (a última parte chega depois do desmonte,
  // G13b). O que o servidor recusou de vez (a reunião excluída ou já
  // encerrada) não volta. Sem a conta agora (a sessão acabou no meio), vai a
  // que começou a gravação. O erro sobe para quem chamou.
  const declararOFim = useCallback(async (id: string, total: number, quem: string | null): Promise<"declarado" | "descartada"> => {
    if (descartadas.current.has(id)) return "descartada";
    try {
      await encerrar(id, total);
    } catch (erro) {
      if (!fimRecusadoDeVez(erro)) guardarFim(id, total, quem ?? donas.current.get(id) ?? null);
      throw erro;
    }
    if (descartadas.current.has(id)) return "descartada";
    if (total <= 0) atuais.current.aoEncerrarSemAudio?.(id);
    else atuais.current.aoEncerrar(id);
    return "declarado";
  }, [encerrar]);

  /** Uma parte que o gravador fechou: aparelho, depois servidor. Na última, encerra. */
  const receberParte = useCallback((parte: ParteParaEnviar) => {
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
        const { desfecho, copiada } = await subir(id, parte, quem);
        if (desfecho.tipo !== "recebida" && desfecho.tipo !== "recusada") {
          // A que não chegou fica no aparelho, e a retomada a manda depois. Sem
          // a cópia, ela só existe na memória: esta aba insiste até subir.
          if (copiada) setNoAparelho(n => n + 1);
          else insistirSemCopia(id, parte, quem, desfecho);
        }
      }
      // A última declara o fim: sem áudio nela, o total conta só as partes que têm.
      if (parte.ultima) await declararOFim(id, parte.blob.size > 0 ? parte.seq + 1 : parte.seq, quem);
    }).catch(erro => atuais.current.aoFalhar(erro)).finally(() => {
      setPendentes(n => n - 1);
      liberar();
    });
  }, [dona, subir, declararOFim, insistirSemCopia]);

  /**
   * Uma parte do MP3 importado em partes (H9a): vai ao aparelho e ao servidor
   * pela mesma fila da gravação, e responde o que houve com ela. A importação
   * só manda a seguinte quando esta foi recebida (ou recusada de vez); na
   * passageira, manda a mesma de novo, lida outra vez do arquivo. Assim a cópia
   * no aparelho tem só a parte em curso, e serve para quando a página recarrega
   * no meio: a retomada a sobe. A parte que ficou no aparelho não conta no
   * áudio por enviar (`noAparelho`): a importação ainda a está mandando, e a
   * sessão segue ocupada pelo envio. Nunca rejeita: a falha inesperada (a trava
   * do navegador, por exemplo) volta como passageira, e a importação tenta de novo.
   */
  const subirParteDoArquivo = useCallback((id: string, parte: ParteDoArquivo): Promise<DesfechoDaParte> => {
    setPendentes(n => n + 1);
    const liberar = ocupar("enviando");
    const desfecho = fila.current.then(async (): Promise<DesfechoDaParte> => {
      if (descartadas.current.has(id)) return { tipo: "descartada" };
      return (await subir(id, parte, await dona())).desfecho;
    });
    fila.current = desfecho.then(() => undefined, () => undefined);
    return desfecho.catch((): DesfechoDaParte => ({ tipo: "passageira" })).finally(() => {
      setPendentes(n => n - 1);
      liberar();
    });
  }, [dona, subir]);

  /**
   * O fim do arquivo importado em partes (H9a), depois de todas as partes: pela
   * mesma fila, atrás da última (ver FimDoArquivo). A falha que não é recusa
   * (rede, deploy) não vira o aviso de envio que falhou: as partes já estão no
   * servidor, o fim fica guardado para a retomada, e a tela diz que o envio
   * termina sozinho, para a dona não mandar o arquivo de novo.
   */
  const encerrarArquivo = useCallback((id: string, total: number): Promise<FimDoArquivo> => {
    // Como a última parte da gravação: o fim pedido, a reunião deixa de ser a da tela.
    if (meetingId.current === id) meetingId.current = null;
    setPendentes(n => n + 1);
    const liberar = ocupar("enviando");
    const fim = fila.current.then(async (): Promise<FimDoArquivo> => {
      try {
        return await declararOFim(id, total, await dona());
      } catch (erro) {
        if (!fimRecusadoDeVez(erro)) return "pendente";
        atuais.current.aoFalhar(erro);
        return "recusado";
      }
    });
    fila.current = fim.then(() => undefined, () => undefined);
    return fim.finally(() => {
      setPendentes(n => n - 1);
      liberar();
    });
  }, [dona, declararOFim]);

  // A retomada, a cada 30 s com a tela aberta: as gravações descartadas desta
  // conta cuja exclusão falhou, as partes que ficaram no aparelho e os fins que
  // o servidor não confirmou.
  useEffect(() => {
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
        // As partes e os fins, pelo mesmo caminho da retomada de toda tela
        // logada (G13c): se ela já corre nesta aba, esta volta pega carona, e
        // nada sobe nem é encerrado duas vezes. As gravações descartadas nesta
        // tela não sobem, nem na volta de toda tela logada em que esta pegar
        // carona. A cópia de uma gravação descartada que ainda não saiu do
        // aparelho (o IndexedDB bloqueado por outra aba, por exemplo) e volta
        // recusada não é aviso para a dona, que a descartou: a retomada não
        // chama o aoRecusar das gravações que ela pula.
        const r = await retomarPartesEFins(quem, {
          servidor: servidorDaGravacao,
          pular: id => descartadas.current.has(id),
          aoRecusar: (_parte, codigo) => atuais.current.aoRecusarParte?.(codigo),
        });
        if (ativo && r.restantes !== null) setNoAparelho(r.restantes);
      }
      if (ativo) relogio = window.setTimeout(() => void tentar(), NOVA_TENTATIVA_MS);
    };
    relogio = window.setTimeout(() => void tentar(), 0);
    return () => {
      ativo = false;
      window.clearTimeout(relogio);
    };
  }, [dona, servidorDaGravacao, excluirNoServidor]);

  // O descarte guardado que uma retomada terminou de excluir no servidor (a
  // desta tela ou a de toda a sessão): a tela fecha o aviso de que ele não
  // tinha terminado.
  useEffect(() => aoTerminarUmDescarte(id => atuais.current.aoConcluirDescarte?.(id)), []);

  return { iniciar, cancelar, descartar, receberParte, subirParteDoArquivo, encerrarArquivo, enviando: pendentes > 0 };
}
