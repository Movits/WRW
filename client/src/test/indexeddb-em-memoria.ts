import { vi } from "vitest";

/**
 * Um IndexedDB mínimo em memória (o jsdom não traz um): só o que
 * lib/partes-no-aparelho.ts usa (open com upgrade, put, delete, get, getAll,
 * getAllKeys, count, clear e o oncomplete da transação, que chega depois, num
 * setTimeout, como no navegador). Quem usa troca o global num beforeEach:
 * vi.stubGlobal("indexedDB", indexedDBEmMemoria()).
 *
 * `aoLerComOAudio` ouve as leituras que trazem partes inteiras (com o áudio)
 * para a memória, com quantas partes cada uma trouxe: o getAll (todas) e o get
 * (uma). `aoLerAsChaves` ouve as leituras só das chaves (o getAllKeys).
 */
export function indexedDBEmMemoria(opcoes: { aoLerComOAudio?: (partes: number) => void; aoLerAsChaves?: () => void } = {}) {
  const tabelas = new Map<string, Map<string, unknown>>();
  const chave = (valor: Record<string, unknown>, caminho: string[]) => JSON.stringify(caminho.map(c => valor[c]));
  const caminhos = new Map<string, string[]>();
  const pedido = <T>(resultado: () => T) => {
    const r = { result: undefined as T | undefined, error: null };
    return { r, rodar: () => { r.result = resultado(); } };
  };
  const banco = {
    objectStoreNames: { contains: (nome: string) => tabelas.has(nome) },
    createObjectStore: (nome: string, { keyPath }: { keyPath: string[] }) => {
      tabelas.set(nome, new Map());
      caminhos.set(nome, keyPath);
    },
    close: vi.fn(),
    transaction: (nome: string) => {
      const linhas = tabelas.get(nome)!;
      const caminho = caminhos.get(nome)!;
      const transacao: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
        objectStore: () => ({
          put: (valor: Record<string, unknown>) => fazer(() => void linhas.set(chave(valor, caminho), valor)),
          delete: (k: unknown[]) => fazer(() => void linhas.delete(JSON.stringify(k))),
          get: (k: unknown[]) => {
            opcoes.aoLerComOAudio?.(1);
            return fazer(() => linhas.get(JSON.stringify(k)));
          },
          getAll: () => {
            opcoes.aoLerComOAudio?.(linhas.size);
            return fazer(() => Array.from(linhas.values()));
          },
          // Só as chaves ([meetingId, seq]), sem o áudio.
          getAllKeys: () => {
            opcoes.aoLerAsChaves?.();
            return fazer(() => Array.from(linhas.keys()).map(k => JSON.parse(k) as unknown[]));
          },
          // Quantas linhas têm esta chave: 0 ou 1.
          count: (k: unknown[]) => fazer(() => (linhas.has(JSON.stringify(k)) ? 1 : 0)),
          clear: () => fazer(() => void linhas.clear()),
        }),
      };
      const fazer = <T>(resultado: () => T) => {
        const { r, rodar } = pedido(resultado);
        setTimeout(() => { rodar(); transacao.oncomplete?.(); }, 0);
        return r;
      };
      return transacao;
    },
  };
  return {
    open: () => {
      const r: { result: typeof banco; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: banco };
      setTimeout(() => {
        if (!tabelas.size) r.onupgradeneeded?.();
        r.onsuccess?.();
      }, 0);
      return r;
    },
  };
}
