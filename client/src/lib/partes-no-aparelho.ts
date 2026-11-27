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

// Quem ouve as mudanças feitas nesta aba (G13c): a retomada de toda tela logada
// (components/RetomadaDasPartes.tsx) reconta o áudio por enviar e ocupa a sessão
// quando a tela que grava deixa uma parte aqui. O IndexedDB não avisa sozinho.
const ouvintes = new Set<() => void>();

function avisarQueMudou() {
  for (const ouvinte of Array.from(ouvintes)) ouvinte();
}

/** Chama `ouvinte` a cada parte guardada ou apagada nesta aba. Devolve a função que para de ouvir. */
export function aoMudarAsPartes(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}

export async function guardarParte(parte: ParteNoAparelho): Promise<unknown> {
  const resultado = await comTabela("readwrite", tabela => tabela.put(parte));
  avisarQueMudou();
  return resultado;
}

export async function apagarParte(meetingId: string, seq: number): Promise<unknown> {
  const resultado = await comTabela("readwrite", tabela => tabela.delete([meetingId, seq]));
  avisarQueMudou();
  return resultado;
}

export async function partesGuardadas(dona: string): Promise<ParteNoAparelho[]> {
  const todas = await comTabela<ParteNoAparelho[]>("readonly", tabela => tabela.getAll() as IDBRequest<ParteNoAparelho[]>);
  return todas.filter(p => p.dona === dona).sort((a, b) => a.meetingId.localeCompare(b.meetingId) || a.seq - b.seq);
}

/**
 * A parte ainda está no aparelho? Conta só a chave, sem trazer o áudio para a
 * memória. É a conferência de quem envia (lib/envio-das-partes.ts), já com a
 * trava da reunião: a parte que outra aba, ou outra retomada, enviou e apagou
 * depois da leitura da lista não sobe de novo (G13c).
 */
export async function parteNoAparelho(meetingId: string, seq: number): Promise<boolean> {
  return (await comTabela<number>("readonly", tabela => tabela.count([meetingId, seq]))) > 0;
}

/**
 * Quantas partes da conta `dona` estão no aparelho, sem trazer o áudio de todas
 * para a memória (revisão da G13c). É a conta do áudio por enviar, que a
 * retomada de toda tela logada (components/RetomadaDasPartes.tsx) refaz a cada
 * parte guardada ou apagada: com o getAll, cada conta lia todas as partes, e uma
 * retomada de N partes fazia N leituras de tudo.
 *
 * Aqui vão só as chaves ([meetingId, seq]) e UMA parte por reunião, porque a
 * dona mora no valor, e não na chave: as partes de uma gravação são todas da
 * conta que a gravou. `pular` tira as reuniões que não contam (a gravação
 * descartada) sem ler nenhuma parte delas.
 */
export async function contarPartesDa(dona: string, pular: (meetingId: string) => boolean = () => false): Promise<number> {
  const chaves = await comTabela<IDBValidKey[]>("readonly", tabela => tabela.getAllKeys());
  const porReuniao = new Map<string, number[]>();
  for (const chave of chaves) {
    if (!Array.isArray(chave) || typeof chave[0] !== "string" || typeof chave[1] !== "number" || pular(chave[0])) continue;
    const seqs = porReuniao.get(chave[0]);
    if (seqs) seqs.push(chave[1]);
    else porReuniao.set(chave[0], [chave[1]]);
  }
  let total = 0;
  for (const [meetingId, seqs] of Array.from(porReuniao.entries())) {
    const primeira = await comTabela<ParteNoAparelho | undefined>("readonly", tabela => tabela.get([meetingId, seqs[0]]) as IDBRequest<ParteNoAparelho | undefined>);
    if (primeira?.dona === dona) total += seqs.length;
  }
  return total;
}

/**
 * Quantas partes de QUALQUER conta estão no aparelho, pelas chaves, sem trazer
 * o áudio. É a pergunta do Sair da conta (components/SairDaConta.tsx): ele
 * apaga todas (apagarTodasAsPartes), de toda conta, então conta todas.
 * `pular` tira as reuniões que não contam (a gravação descartada).
 */
export async function contarTodasAsPartes(pular: (meetingId: string) => boolean = () => false): Promise<number> {
  const chaves = await comTabela<IDBValidKey[]>("readonly", tabela => tabela.getAllKeys());
  return chaves.filter(chave => Array.isArray(chave) && typeof chave[0] === "string" && !pular(chave[0])).length;
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
  avisarQueMudou();
}
