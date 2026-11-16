/**
 * A cópia das partes da gravação NO APARELHO (G9 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): cada parte fica no IndexedDB do
 * navegador até o servidor confirmar que a recebeu. Queda de rede, recarregar
 * a página ou um novo login não perdem a gravação: o envio retoma do que ficou.
 *
 * O IndexedDB pode faltar (aba privada de alguns navegadores, cota cheia):
 * aí as funções falham e quem chama segue enviando da memória, sem a cópia.
 * Sair da conta ou excluí-la apaga tudo (apagarTodasAsPartes).
 */

export type ParteNoAparelho = {
  meetingId: string;
  seq: number;
  blob: Blob;
  mimeType: string;
  duracaoMs: number;
  /** De quem é a gravação: a retomada só envia as da conta que está logada. */
  dona: string;
  guardadaEm: number;
};

const BANCO = "wrw-gravacoes";
const TABELA = "partes";
const VERSAO = 1;

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("Sem IndexedDB neste navegador."));
    const pedido = indexedDB.open(BANCO, VERSAO);
    pedido.onupgradeneeded = () => {
      const banco = pedido.result;
      if (!banco.objectStoreNames.contains(TABELA)) banco.createObjectStore(TABELA, { keyPath: ["meetingId", "seq"] });
    };
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(pedido.error ?? new Error("O IndexedDB não abriu."));
    pedido.onblocked = () => reject(new Error("O IndexedDB está bloqueado por outra aba."));
  });
}

async function comTabela<T>(modo: IDBTransactionMode, acao: (tabela: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const banco = await abrir();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transacao = banco.transaction(TABELA, modo);
      const pedido = acao(transacao.objectStore(TABELA));
      transacao.oncomplete = () => resolve(pedido.result);
      transacao.onerror = () => reject(transacao.error ?? pedido.error ?? new Error("A operação no IndexedDB falhou."));
      transacao.onabort = () => reject(transacao.error ?? new Error("A operação no IndexedDB foi abortada."));
    });
  } finally {
    banco.close();
  }
}

export function guardarParte(parte: ParteNoAparelho): Promise<unknown> {
  return comTabela("readwrite", tabela => tabela.put(parte));
}

export function apagarParte(meetingId: string, seq: number): Promise<unknown> {
  return comTabela("readwrite", tabela => tabela.delete([meetingId, seq]));
}

export async function partesGuardadas(dona: string): Promise<ParteNoAparelho[]> {
  const todas = await comTabela<ParteNoAparelho[]>("readonly", tabela => tabela.getAll() as IDBRequest<ParteNoAparelho[]>);
  return todas.filter(p => p.dona === dona).sort((a, b) => a.meetingId.localeCompare(b.meetingId) || a.seq - b.seq);
}

/**
 * A gravação descartada (G13b): as cópias dela saem do aparelho, para a
 * retomada não reenviá-las nem contá-las como áudio por enviar. Sem IndexedDB
 * neste navegador nada foi guardado, e não há o que apagar; as outras falhas
 * (outra aba bloqueando, por exemplo) chegam a quem chama, que tenta de novo.
 *
 * Só as CHAVES ([meetingId, seq]) são lidas: o getAll() trazia para a memória o
 * áudio de todas as partes guardadas, de todas as reuniões, para apagar as de
 * uma só (cada parte tem até ~5 MB).
 */
export async function apagarPartesDaReuniao(meetingId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const chaves = await comTabela<IDBValidKey[]>("readonly", tabela => tabela.getAllKeys());
  for (const chave of chaves) {
    if (Array.isArray(chave) && chave[0] === meetingId && typeof chave[1] === "number") await apagarParte(meetingId, chave[1]);
  }
}

/** Sair da conta ou excluí-la: nenhuma voz fica no aparelho. */
export async function apagarTodasAsPartes(): Promise<void> {
  await comTabela("readwrite", tabela => tabela.clear());
}
