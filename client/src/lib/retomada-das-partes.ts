import { descartesDa } from "./descartes-pendentes";
import { enviarPendentes, travaDoNavegador, type Trava } from "./envio-das-partes";
import { contarPartesDa, type ParteNoAparelho } from "./partes-no-aparelho";

/**
 * A retomada da gravação em partes (G9, G13c): as partes que ficaram no
 * aparelho e os fins de gravação que o servidor não confirmou. Quem chama é a
 * tela de Reuniões (hooks/useGravacaoEmPartes.ts), depois de repetir os
 * descartes guardados, e toda tela logada (components/RetomadaDasPartes.tsx).
 * Antes da G13c só a tela de Reuniões retomava: a dona saía da tela gravando
 * (o que entrega a gravação, G13b), a última parte falhava por rede, e nada
 * tentava de novo até ela voltar a Reuniões. Nesse meio-tempo a varredura de
 * abandono do servidor (server/fila-de-transcricao.ts, encerrarAbandonadas,
 * 6 h) podia fechar a reunião sem essa parte, que depois era recusada.
 *
 * A ordem é a de sempre: primeiro as partes, reunião por reunião e na ordem
 * delas; depois os fins. Só as da conta logada: cada parte no aparelho e cada
 * fim guardado levam a dona. As da gravação descartada não sobem nem são
 * encerradas: quem termina o caso dela é a exclusão guardada
 * (lib/descartes-pendentes.ts).
 *
 * O fim é declarado mesmo quando uma parte da reunião ficou no aparelho nesta
 * volta (rede, 429, 5xx, a trava com outra aba), como na gravação: o servidor
 * aceita as partes que faltam depois do fim, até o total declarado
 * (server/fatias-de-reuniao.ts), e a fila espera a que falta por 24 h depois da
 * última que chegou (ESPERA_PELA_PARTE_QUE_FALTA_MS). Segurar o fim até a
 * última parte subir deixaria a reunião em 'recording', e em 6 h sem parte
 * nova a varredura de abandono a fecharia com o total que viu (a maior posição
 * que chegou + 1), recusando depois a última parte: o caso que a G13c fecha.
 *
 * As duas retomadas não fazem o mesmo trabalho duas vezes. Na mesma aba, a
 * chamada que chega com outra em curso, da mesma conta, pega carona nela, e as
 * gravações que ela não quer subir (`pular`) passam a ficar de fora da volta em
 * curso também. Entre abas, vale a trava do navegador (Web Locks) da reunião,
 * e quem pega a trava confere de novo, já com ela, o que ainda falta: a parte
 * ainda no aparelho (lib/envio-das-partes.ts) e o fim ainda guardado. Sem a
 * trava (navegador antigo), o servidor ainda aceita a mesma parte de novo sem
 * duplicar, e o mesmo fim enquanto a reunião espera as partes
 * (server/fatias-de-reuniao.ts). O fim que ele recusa de vez sai da lista, em
 * vez de voltar a cada 30 s.
 */

/** A chave no localStorage. Exportada para quem ouve a mudança feita em outra aba (o evento storage). */
export const CHAVE_DOS_FINS = "wrw:fins-de-gravacao-pendentes";

/**
 * Um fim guardado: o total de partes e a conta que gravou (o openId, o mesmo
 * das partes no aparelho). O fim guardado antes da G13c é só o número, sem a
 * conta; o mesmo vale para o fim de uma gravação que nunca soube a conta (nem
 * no início, nem no fim). Esse fim sem dona vale para a conta logada, como
 * valia, com uma ressalva: ver `naoSaoDaConta`.
 */
type FimGuardado = { partes: number; dona?: string };

/** Um fim que a conta declara: `semDona` é o fim sem conta guardada (ver FimGuardado). */
export type FimDaConta = { id: string; partes: number; semDona: boolean };

const ouvintesDosFins = new Set<() => void>();

/**
 * Os fins sem dona que voltaram NOT_FOUND para uma conta, nesta aba. Sem a
 * dona, o NOT_FOUND não diz se a reunião saiu ou se é de outra conta (o
 * servidor responde igual às duas). Por isso o fim fica guardado, para a dona
 * declará-lo quando entrar, e esta aba não o tenta de novo para a mesma conta,
 * em vez de mandar a cada 30 s o id de uma reunião alheia. Recarregar a página
 * tenta uma vez de novo.
 */
const naoSaoDaConta = new Set<string>();
const daConta = (dona: string, meetingId: string) => JSON.stringify([dona, meetingId]);

function lerFins(): Record<string, FimGuardado> {
  try {
    const bruto: unknown = JSON.parse(localStorage.getItem(CHAVE_DOS_FINS) ?? "{}");
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
    const fins: Record<string, FimGuardado> = {};
    for (const [id, valor] of Object.entries(bruto as Record<string, unknown>)) {
      if (typeof valor === "number" && Number.isInteger(valor)) {
        fins[id] = { partes: valor };
        continue;
      }
      const fim = valor as Partial<FimGuardado> | null;
      if (fim && typeof fim === "object" && typeof fim.partes === "number" && Number.isInteger(fim.partes)) {
        fins[id] = typeof fim.dona === "string" ? { partes: fim.partes, dona: fim.dona } : { partes: fim.partes };
      }
    }
    return fins;
  } catch {
    return {};
  }
}

function gravarFins(fins: Record<string, FimGuardado>) {
  try {
    if (Object.keys(fins).length) localStorage.setItem(CHAVE_DOS_FINS, JSON.stringify(fins));
    else localStorage.removeItem(CHAVE_DOS_FINS);
  } catch {
    // Sem localStorage: o fim é tentado só agora.
  }
  for (const ouvinte of Array.from(ouvintesDosFins)) ouvinte();
}

/** Guarda o fim que o servidor não confirmou, com a conta que gravou (null: a gravação nunca soube a conta). */
export function guardarFim(meetingId: string, partes: number, dona: string | null) {
  gravarFins({ ...lerFins(), [meetingId]: dona === null ? { partes } : { partes, dona } });
}

/** Os fins guardados que a conta `dona` declara: os dela e os sem dona que ainda não voltaram NOT_FOUND para ela nesta aba. */
export function finsDa(dona: string): FimDaConta[] {
  return Object.entries(lerFins())
    .filter(([id, fim]) => fim.dona === dona || (fim.dona === undefined && !naoSaoDaConta.has(daConta(dona, id))))
    .map(([id, fim]) => ({ id, partes: fim.partes, semDona: fim.dona === undefined }));
}

/** Tira o fim declarado (ou recusado de vez). Relê antes de gravar: outro fim pode ter entrado durante o await. */
function tirarFim(meetingId: string, partes: number) {
  const { [meetingId]: atual, ...resto } = lerFins();
  // Outro total guardado para a mesma reunião depois da leitura: fica.
  if (!atual || atual.partes !== partes) return;
  gravarFins(resto);
}

/** Chama `ouvinte` a cada mudança nos fins guardados feita nesta aba. Devolve a função que para de ouvir. */
export function aoMudarOsFins(ouvinte: () => void): () => void {
  ouvintesDosFins.add(ouvinte);
  return () => {
    ouvintesDosFins.delete(ouvinte);
  };
}

/** O código tRPC do erro (data.code). Só o erro que o servidor devolveu tem um; o da rede, por exemplo, não. */
function codigoDoErro(erro: unknown) {
  return (erro as { data?: { code?: string } } | null)?.data?.code;
}

/**
 * O servidor recusou o fim de vez (meetings.encerrarGravacao), e repetir não
 * muda a resposta: NOT_FOUND (a reunião foi excluída, ou é de outra conta),
 * CONFLICT (já encerrada, com outro total, ou já na fila: é o fim repetido
 * depois que a fila a pegou) ou BAD_REQUEST (o total não bate com as partes que
 * chegaram). Rede, deploy, banco fora do ar e sessão vencida não dão nenhum
 * desses códigos: o fim segue guardado.
 */
export function fimRecusadoDeVez(erro: unknown): boolean {
  const codigo = codigoDoErro(erro);
  return codigo === "NOT_FOUND" || codigo === "CONFLICT" || codigo === "BAD_REQUEST";
}

/** O que a retomada pede ao servidor: o fim (meetings.encerrarGravacao) e a exclusão de sempre (meetings.delete). */
export type ServidorDaGravacao = {
  encerrarGravacao: (meetingId: string, partes: number) => Promise<unknown>;
  excluir: (meetingId: string) => Promise<unknown>;
};

/** O fim da gravação: diz ao servidor quantas partes houve. Sem nenhuma com áudio, a reunião sai, em vez de ficar "gravando". */
export function declararFim(servidor: ServidorDaGravacao, meetingId: string, partes: number): Promise<unknown> {
  return partes <= 0 ? servidor.excluir(meetingId) : servidor.encerrarGravacao(meetingId, partes);
}

export type ResultadoDaRetomada = {
  /** As partes da conta que ficaram no aparelho; null quando ele não pôde ser lido. */
  restantes: number | null;
  /** Alguma parte voltou com a sessão vencida (401/403): ela vai depois do novo login. */
  semSessao: boolean;
};

export type OpcoesDaRetomada = {
  servidor: ServidorDaGravacao;
  /**
   * Uma parte que o servidor recusou de vez (e que saiu do aparelho), com o
   * código da recusa. Não é chamada para a gravação que não sobe mais (a
   * descartada no meio do envio, que o servidor recusa porque a reunião saiu).
   */
  aoRecusar?: (parte: ParteNoAparelho, codigo?: string) => void;
  /** Gravações que não sobem agora, além das descartadas guardadas: a tela de Reuniões passa as que descartou. */
  pular?: (meetingId: string) => boolean;
  trava?: Trava;
  buscar?: typeof fetch;
};

// A volta em curso nesta aba, por conta, com as gravações que quem pegou
// carona nela também não quer subir.
const emCurso = new Map<string, { volta: Promise<ResultadoDaRetomada>; pulos: Array<(meetingId: string) => boolean> }>();

/**
 * Uma volta da retomada da conta `dona`: as partes, depois os fins. Com outra
 * volta da mesma conta em curso nesta aba, devolve a dela, e o `pular` desta
 * chamada passa a valer nela também (o aoRecusar, o buscar e a trava ficam os
 * da volta em curso: o aviso da recusa é o mesmo nas duas retomadas). Nunca
 * lança.
 */
export function retomarPartesEFins(dona: string, opcoes: OpcoesDaRetomada): Promise<ResultadoDaRetomada> {
  const emAndamento = emCurso.get(dona);
  if (emAndamento) {
    if (opcoes.pular) emAndamento.pulos.push(opcoes.pular);
    return emAndamento.volta;
  }
  const pulos = opcoes.pular ? [opcoes.pular] : [];
  const volta = retomar(dona, opcoes, pulos).finally(() => {
    emCurso.delete(dona);
  });
  emCurso.set(dona, { volta, pulos });
  return volta;
}

/** A volta da conta `dona` em curso nesta aba, se houver: quem conta o aparelho espera por ela (components/RetomadaDasPartes.tsx). */
export function retomadaEmCurso(dona: string): Promise<ResultadoDaRetomada> | undefined {
  return emCurso.get(dona)?.volta;
}

async function retomar(dona: string, opcoes: OpcoesDaRetomada, pulos: Array<(meetingId: string) => boolean>): Promise<ResultadoDaRetomada> {
  const trava = opcoes.trava ?? travaDoNavegador;
  // Lida a cada pergunta: o Descartar pode chegar no meio da volta, e quem
  // pega carona acrescenta as dele.
  const pular = (meetingId: string) => pulos.some(pula => pula(meetingId)) || descartesDa(dona).some(descarte => descarte.id === meetingId);
  // A parte que subia quando a gravação foi descartada volta recusada (a
  // reunião saiu): não é aviso para a dona, que a descartou.
  const aoRecusar = (parte: ParteNoAparelho, codigo?: string) => {
    if (!pular(parte.meetingId)) opcoes.aoRecusar?.(parte, codigo);
  };
  const partes = await enviarPendentes(dona, { trava, buscar: opcoes.buscar, aoRecusar, pular }).catch((erro: unknown) => {
    // O aparelho ilegível (outra aba bloqueando o IndexedDB, cota) não impede
    // os fins, que moram no localStorage: o servidor aceita as partes depois
    // do fim. Fica registrado, porque nada mais diz que as partes não subiram.
    console.warn("[Gravação] as partes no aparelho não puderam ser lidas nesta volta da retomada:", erro instanceof Error ? erro.message : erro);
    return null;
  });
  for (const { id } of finsDa(dona)) {
    if (pular(id)) continue;
    await trava(`wrw-envio-${id}`, async () => {
      // Com a trava, relê: outra aba pode ter declarado este fim e o tirado da lista.
      const fim = finsDa(dona).find(guardado => guardado.id === id);
      if (!fim) return;
      try {
        await declararFim(opcoes.servidor, id, fim.partes);
        tirarFim(id, fim.partes);
      } catch (erro) {
        // O resto (rede, deploy, sessão vencida) segue guardado para a próxima volta.
        if (!fimRecusadoDeVez(erro)) return;
        // Sem a dona, o NOT_FOUND pode ser de outra conta: o fim fica para ela.
        // O CONFLICT e o BAD_REQUEST valem para qualquer conta: a de outra
        // dona para no NOT_FOUND antes deles, e a entrada mal formada (o
        // BAD_REQUEST da validação) a dona também receberia.
        if (fim.semDona && codigoDoErro(erro) === "NOT_FOUND") naoSaoDaConta.add(daConta(dona, id));
        else tirarFim(id, fim.partes);
      }
    }).catch(() => null);
  }
  return { restantes: partes?.restantes ?? null, semSessao: partes?.semSessao ?? false };
}

/**
 * Quantas partes da conta esperam no aparelho para subir: é o que ocupa a
 * sessão ("audio-nao-enviado"). As da gravação descartada não contam: para a
 * dona, o descarte já valeu. Conta pelas chaves, sem trazer o áudio
 * (contarPartesDa). Sem IndexedDB no navegador nada foi guardado; as outras
 * falhas (outra aba bloqueando) chegam a quem chama.
 */
export async function partesPorEnviar(dona: string): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const descartadas = new Set(descartesDa(dona).map(descarte => descarte.id));
  return contarPartesDa(dona, meetingId => descartadas.has(meetingId));
}
