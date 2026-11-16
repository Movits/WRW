import { apagarPartesDaReuniao } from "./partes-no-aparelho";

/**
 * Os descartes de gravação que ainda não terminaram (G13b). O Descartar da
 * gravação em partes apaga a reunião no servidor (meetings.delete, que leva as
 * partes que subiram e os objetos delas no bucket) e as cópias das partes no
 * aparelho; o microfone que não abre depois de a reunião nascer apaga a reunião
 * vazia pelo mesmo caminho. A exclusão que falha (rede, deploy) fica guardada
 * aqui, no localStorage, e a retomada a repete: sem ela, a varredura de
 * abandono do servidor (server/fila-de-transcricao.ts, encerrarAbandonadas,
 * 6 h) fecharia a reunião e transcreveria o que a dona descartou.
 *
 * Cada descarte guarda a DONA (o openId da conta, o mesmo que marca as cópias
 * das partes no aparelho), e só a conta que descartou o retoma. Outra conta no
 * mesmo navegador recebe NOT_FOUND para a reunião que não é dela, e esse
 * NOT_FOUND apagava da lista o descarte da outra. Para a própria dona, NOT_FOUND
 * quer dizer que a reunião já saiu (outra aba a excluiu, ou a exclusão anterior
 * chegou e só a resposta se perdeu): está feito.
 *
 * Quem retoma: a tela de Reuniões (hooks/useGravacaoEmPartes.ts), antes de
 * reenviar as partes que ficaram no aparelho, e toda tela logada
 * (components/RetomadaDosDescartes.tsx), que também ocupa a sessão enquanto o
 * servidor não excluiu. As duas podem rodar juntas: excluir de novo dá
 * NOT_FOUND, que é feito.
 *
 * O Sair da conta (lib/sessao-ocupada.ts, liberarTodas) não apaga esta lista:
 * são só ids, por dona, e a confirmação do Sair já avisa que o descarte não
 * terminou. Ela volta a valer no próximo login da mesma conta neste navegador.
 */

/** A chave no localStorage. Exportada para quem ouve a mudança feita em outra aba (o evento storage). */
export const CHAVE_DOS_DESCARTES = "wrw:descartes-de-gravacao-pendentes";

export type DescartePendente = {
  /** A reunião da gravação descartada. */
  id: string;
  /** A conta que descartou (o openId): só ela retoma este descarte. */
  dona: string;
  /**
   * O servidor já excluiu a reunião e falta só a cópia no aparelho (outra aba
   * bloqueando o IndexedDB, por exemplo). Para a dona o descarte já valeu: nada
   * vai para a transcrição, e a sessão não fica ocupada por ele.
   */
  soFaltaACopia?: true;
};

/** Exclui a reunião no servidor, pelo caminho de exclusão de sempre (meetings.delete). */
export type ExcluirNoServidor = (meetingId: string) => Promise<unknown>;

/** O que saiu numa tentativa: a reunião no servidor e as cópias no aparelho. */
export type ApagadoNoDescarte = { servidor: boolean; copia: boolean };

const ouvintesDaLista = new Set<() => void>();
const ouvintesDoFim = new Set<(meetingId: string) => void>();

function ehDescarte(valor: unknown): valor is DescartePendente {
  const descarte = valor as Partial<DescartePendente> | null;
  return typeof descarte === "object" && descarte !== null && typeof descarte.id === "string" && typeof descarte.dona === "string";
}

const mesmo = (descarte: DescartePendente, id: string, dona: string) => descarte.id === id && descarte.dona === dona;

/** Todos os descartes guardados neste navegador, de qualquer conta. */
export function lerDescartes(): DescartePendente[] {
  try {
    const bruto: unknown = JSON.parse(localStorage.getItem(CHAVE_DOS_DESCARTES) ?? "[]");
    return Array.isArray(bruto) ? bruto.filter(ehDescarte) : [];
  } catch {
    return [];
  }
}

function gravarDescartes(descartes: DescartePendente[]) {
  try {
    if (descartes.length) localStorage.setItem(CHAVE_DOS_DESCARTES, JSON.stringify(descartes));
    else localStorage.removeItem(CHAVE_DOS_DESCARTES);
  } catch {
    // Sem localStorage: o descarte é tentado só agora, nesta aba.
  }
  for (const ouvinte of Array.from(ouvintesDaLista)) ouvinte();
}

/** Os descartes guardados da conta `dona`: os únicos que ela retoma. */
export function descartesDa(dona: string): DescartePendente[] {
  return lerDescartes().filter(descarte => descarte.dona === dona);
}

/** Algum descarte da conta ainda espera a exclusão no servidor? É o que ocupa a sessão. */
export function esperaOServidor(dona: string): boolean {
  return descartesDa(dona).some(descarte => !descarte.soFaltaACopia);
}

/** Guarda o descarte antes de tentar a exclusão: se ela falhar, ou a aba fechar no meio, a retomada a repete. */
export function guardarDescarte(id: string, dona: string) {
  gravarDescartes([...lerDescartes().filter(descarte => !mesmo(descarte, id, dona)), { id, dona }]);
}

// O código tRPC do erro (data.code). Só o erro que o servidor devolveu tem um;
// o da rede, por exemplo, não.
function codigoDoErro(erro: unknown) {
  return (erro as { data?: { code?: string } } | null)?.data?.code;
}

/**
 * Uma tentativa de apagar a gravação descartada `id`: as cópias no aparelho e,
 * no servidor, a reunião. O descarte sai da lista quando as duas saíram; com só
 * o servidor feito, fica marcado `soFaltaACopia`, e a retomada tenta a cópia.
 * Nunca lança: responde o que saiu.
 *
 * Sem `dona` (a sessão acabou no meio, e não há a quem atribuir o descarte),
 * a exclusão é tentada só agora, sem mexer na lista.
 */
export async function apagarGravacaoDescartada(id: string, dona: string | null, excluirNoServidor: ExcluirNoServidor): Promise<ApagadoNoDescarte> {
  // A cópia sai primeiro porque não depende da rede: sem ela, a retomada não
  // reenvia esta gravação nem a conta como áudio por enviar. Dentro do then,
  // para a falha síncrona também virar "não saiu", e não uma exceção.
  const copia = await Promise.resolve().then(() => apagarPartesDaReuniao(id)).then(() => true, () => false);
  // Excluída no servidor numa tentativa anterior: falta só a cópia.
  let servidor = dona !== null && lerDescartes().some(descarte => mesmo(descarte, id, dona) && descarte.soFaltaACopia);
  if (!servidor) {
    try {
      await excluirNoServidor(id);
      servidor = true;
    } catch (erro) {
      // NOT_FOUND para a própria dona: a reunião já saiu. Banco fora do ar,
      // rede ou deploy: não saiu, e o descarte segue guardado.
      servidor = codigoDoErro(erro) === "NOT_FOUND";
    }
  }
  if (dona !== null && servidor) {
    // Relê antes de gravar: outra retomada pode ter mexido na lista durante os awaits.
    gravarDescartes(copia
      ? lerDescartes().filter(descarte => !mesmo(descarte, id, dona))
      : lerDescartes().map(descarte => (mesmo(descarte, id, dona) ? { ...descarte, soFaltaACopia: true as const } : descarte)));
  }
  return { servidor, copia };
}

/**
 * Repete os descartes guardados da conta `dona`, um por vez. Quando a exclusão
 * no servidor de um deles termina aqui, avisa quem ouve (aoTerminarUmDescarte):
 * a tela fecha o aviso de que o descarte não tinha terminado.
 */
export async function retomarDescartes(dona: string, excluirNoServidor: ExcluirNoServidor): Promise<void> {
  for (const descarte of descartesDa(dona)) {
    const { servidor } = await apagarGravacaoDescartada(descarte.id, dona, excluirNoServidor);
    if (servidor && !descarte.soFaltaACopia) for (const ouvinte of Array.from(ouvintesDoFim)) ouvinte(descarte.id);
  }
}

/** Chama `ouvinte` a cada mudança na lista feita nesta aba. Devolve a função que para de ouvir. */
export function aoMudarOsDescartes(ouvinte: () => void): () => void {
  ouvintesDaLista.add(ouvinte);
  return () => {
    ouvintesDaLista.delete(ouvinte);
  };
}

/** Chama `ouvinte` com a reunião cuja exclusão no servidor uma retomada concluiu. Devolve a função que para de ouvir. */
export function aoTerminarUmDescarte(ouvinte: (meetingId: string) => void): () => void {
  ouvintesDoFim.add(ouvinte);
  return () => {
    ouvintesDoFim.delete(ouvinte);
  };
}
