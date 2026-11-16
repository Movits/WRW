import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apagarParte, apagarPartesDaReuniao, apagarTodasAsPartes, guardarParte, partesGuardadas, type ParteNoAparelho } from "./partes-no-aparelho";

// Quantas vezes o getAll trouxe as partes inteiras (com o áudio) para a memória.
let leiturasComOAudio = 0;

/**
 * Um IndexedDB mínimo em memória (o jsdom não traz um): só o que o módulo usa
 * (open com upgrade, put, delete, getAll, getAllKeys, clear e o oncomplete da
 * transação, que chega depois, como no navegador).
 */
function indexedDBEmMemoria() {
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
          getAll: () => {
            leiturasComOAudio++;
            return fazer(() => Array.from(linhas.values()));
          },
          // Só as chaves ([meetingId, seq]), sem o áudio.
          getAllKeys: () => fazer(() => Array.from(linhas.keys()).map(k => JSON.parse(k) as unknown[])),
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

const parte = (meetingId: string, seq: number, dona = "dona-1"): ParteNoAparelho => ({
  meetingId, seq, dona, blob: new Blob(["som"]), mimeType: "audio/mp4", duracaoMs: 600_000, guardadaEm: 1,
});

beforeEach(() => {
  leiturasComOAudio = 0;
  vi.stubGlobal("indexedDB", indexedDBEmMemoria());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("partes-no-aparelho (G9)", () => {
  it("guarda, lista só as da conta em ordem de reunião e de parte, e apaga uma", async () => {
    await guardarParte(parte("r-2", 1));
    await guardarParte(parte("r-2", 0));
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-1#0", "r-2#0", "r-2#1"]);
    await apagarParte("r-2", 0);
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-1#0", "r-2#1"]);
  });

  it("a mesma parte guardada de novo substitui a anterior (chave reunião + parte)", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte({ ...parte("r-1", 0), duracaoMs: 5 });
    const partes = await partesGuardadas("dona-1");
    expect(partes).toHaveLength(1);
    expect(partes[0].duracaoMs).toBe(5);
  });

  it("apagarTodasAsPartes (Sair, excluir a conta) não deixa voz de ninguém no aparelho", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    await apagarTodasAsPartes();
    expect(await partesGuardadas("dona-1")).toEqual([]);
    expect(await partesGuardadas("outra-conta")).toEqual([]);
  });

  it("sem IndexedDB, falha (quem chama segue da memória)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(guardarParte(parte("r-1", 0))).rejects.toThrow("Sem IndexedDB");
  });

  it("a gravação descartada (G13b): saem do aparelho só as partes dela, de qualquer conta, e as outras ficam", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-1", 1));
    await guardarParte(parte("r-2", 0));
    await guardarParte(parte("r-9", 0, "outra-conta"));
    await apagarPartesDaReuniao("r-1");
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-2#0"]);
    expect(await partesGuardadas("outra-conta")).toHaveLength(1);
  });

  it("apagar a gravação descartada lê só as chaves: o áudio das partes guardadas não vem para a memória (revisão da G13b)", async () => {
    await guardarParte(parte("r-1", 0));
    await guardarParte(parte("r-1", 1));
    await guardarParte(parte("r-2", 0));
    await apagarPartesDaReuniao("r-1");
    expect(leiturasComOAudio).toBe(0);
    expect((await partesGuardadas("dona-1")).map(p => `${p.meetingId}#${p.seq}`)).toEqual(["r-2#0"]);
  });

  it("sem IndexedDB nada foi guardado: apagar a gravação descartada não tem o que apagar e não falha", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(apagarPartesDaReuniao("r-1")).resolves.toBeUndefined();
  });
});
