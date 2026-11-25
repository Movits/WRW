import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSCAS_RECENTES_MAX } from "@shared/busca-de-reunioes";
import { apagarBuscasRecentesDoAparelho, guardarBuscaRecente, lerBuscasRecentes, limparBuscasRecentes } from "./buscas-recentes";

/**
 * As buscas recentes entre as reuniões (H7b), no navegador: por conta, no
 * máximo BUSCAS_RECENTES_MAX, protegidas contra o armazenamento recusado, e
 * apagadas de todas as contas no Sair (useAuth).
 */
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("buscas recentes", () => {
  it("guarda por conta, com a mais nova na frente e sem repetida", () => {
    guardarBuscaRecente("dona-1", "proposta");
    guardarBuscaRecente("dona-1", "frete");
    expect(guardarBuscaRecente("dona-1", "Proposta")).toEqual(["Proposta", "frete"]);
    expect(lerBuscasRecentes("dona-2")).toEqual([]);
    expect(lerBuscasRecentes(null)).toEqual([]);
  });

  it("lê só textos e no máximo o teto, mesmo de um valor guardado estranho", () => {
    window.localStorage.setItem("mmm.buscasDeReunioes.dona-1", JSON.stringify(["a", 2, null, "", ...Array.from({ length: 20 }, (_, i) => `t${i}`)]));
    const lidas = lerBuscasRecentes("dona-1");
    expect(lidas[0]).toBe("a");
    expect(lidas).toHaveLength(BUSCAS_RECENTES_MAX);
    window.localStorage.setItem("mmm.buscasDeReunioes.dona-1", "{não é json");
    expect(lerBuscasRecentes("dona-1")).toEqual([]);
  });

  it("o armazenamento recusado não derruba a busca: a lista vale só na tela", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("bloqueado"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("bloqueado"); });
    expect(lerBuscasRecentes("dona-1")).toEqual([]);
    expect(guardarBuscaRecente("dona-1", "proposta")).toEqual(["proposta"]);
    expect(() => limparBuscasRecentes("dona-1")).not.toThrow();
  });

  it("o Sair apaga as recentes de todas as contas, e só elas", () => {
    guardarBuscaRecente("dona-1", "proposta");
    guardarBuscaRecente("dona-2", "frete");
    window.localStorage.setItem("wrw:fins-de-gravacao-pendentes", "[]");
    apagarBuscasRecentesDoAparelho();
    expect(lerBuscasRecentes("dona-1")).toEqual([]);
    expect(lerBuscasRecentes("dona-2")).toEqual([]);
    expect(window.localStorage.getItem("wrw:fins-de-gravacao-pendentes")).toBe("[]");
  });
});
