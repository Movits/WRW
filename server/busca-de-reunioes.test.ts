import { describe, expect, it } from "vitest";
import {
  BUSCAS_RECENTES_MAX, comBuscaRecente, filtrarReunioesNaTela, grupoDaOrigem, inicioDoPeriodo, padraoDoLike, passaNosFiltros,
  semAcento, temFiltro, termoProntoParaOServidor, type ReuniaoParaFiltrar,
} from "@shared/busca-de-reunioes";

/**
 * A busca entre as reuniões (H7b): a parte pura, de shared/busca-de-reunioes.ts
 * (o padrão do LIKE do servidor, a busca na tela, os filtros e as buscas
 * recentes). O SQL de verdade está em busca-de-reunioes.integracao.test.ts.
 */
const DIA = 24 * 60 * 60_000;
const AGORA = Date.UTC(2026, 10, 21, 12);

const reuniao = (extra: Partial<ReuniaoParaFiltrar> & { id: string }): ReuniaoParaFiltrar & { id: string } => ({
  title: "Reunião", createdAt: AGORA - DIA, origem: "gravacao", etiquetas: null, ondeFoi: null,
  contactId: null, contextId: null, contatoNome: null, contextoNome: null, ...extra,
});

describe("padraoDoLike", () => {
  it("o % e o _ digitados valem como letra (escapados com !), e o próprio ! também", () => {
    expect(padraoDoLike("50%")).toBe("%50!%%");
    expect(padraoDoLike("a_b")).toBe("%a!_b%");
    expect(padraoDoLike("oi!")).toBe("%oi!!%");
    expect(padraoDoLike("café")).toBe("%café%");
  });
});

describe("termoProntoParaOServidor", () => {
  it("a partir de 3 letras; 2 só nas escritas sem espaço", () => {
    expect(termoProntoParaOServidor("ab")).toBe(false);
    expect(termoProntoParaOServidor("  abc ")).toBe(true);
    expect(termoProntoParaOServidor("会议")).toBe(true);
    expect(termoProntoParaOServidor("契")).toBe(false);
    expect(termoProntoParaOServidor("🚀🚀")).toBe(false);
  });
});

describe("filtrarReunioesNaTela", () => {
  const lista = [
    reuniao({ id: "a", title: "Reunião com a Ana", etiquetas: ["Clientes"], createdAt: AGORA - 2 * DIA }),
    reuniao({ id: "b", title: "Mentoria", ondeFoi: "Café da Paulista", contatoNome: "Bia Souza", createdAt: AGORA - 40 * DIA, contactId: 7 }),
    reuniao({ id: "c", title: "Contrato", origem: "pdf", contextoNome: "Feira de Milão", contextId: "ctx-1" }),
    reuniao({ id: "d", title: "Vídeo do evento", origem: "youtube", etiquetas: ["clientes", "Evento"] }),
  ];

  it("acha o termo sem acento e sem caixa no título, nas etiquetas, no 'Onde foi', no contato e no contexto", () => {
    expect(filtrarReunioesNaTela(lista, "reuniao", {}, AGORA).map(r => r.id)).toEqual(["a"]);
    expect(filtrarReunioesNaTela(lista, "CLIENTES", {}, AGORA).map(r => r.id)).toEqual(["a", "d"]);
    expect(filtrarReunioesNaTela(lista, "paulista", {}, AGORA).map(r => r.id)).toEqual(["b"]);
    expect(filtrarReunioesNaTela(lista, "souza", {}, AGORA).map(r => r.id)).toEqual(["b"]);
    expect(filtrarReunioesNaTela(lista, "milao", {}, AGORA).map(r => r.id)).toEqual(["c"]);
    expect(filtrarReunioesNaTela(lista, "  ", {}, AGORA).map(r => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("os filtros: etiqueta (sem caixa), origem, período, contato e contexto", () => {
    expect(filtrarReunioesNaTela(lista, "", { etiqueta: "CLIENTES" }, AGORA).map(r => r.id)).toEqual(["a", "d"]);
    expect(filtrarReunioesNaTela(lista, "", { origem: "documento" }, AGORA).map(r => r.id)).toEqual(["c"]);
    expect(filtrarReunioesNaTela(lista, "", { origem: "youtube" }, AGORA).map(r => r.id)).toEqual(["d"]);
    expect(filtrarReunioesNaTela(lista, "", { origem: "audio" }, AGORA).map(r => r.id)).toEqual(["a", "b"]);
    expect(filtrarReunioesNaTela(lista, "", { periodo: "30d" }, AGORA).map(r => r.id)).toEqual(["a", "c", "d"]);
    expect(filtrarReunioesNaTela(lista, "", { contactId: 7 }, AGORA).map(r => r.id)).toEqual(["b"]);
    expect(filtrarReunioesNaTela(lista, "", { contextId: "ctx-1" }, AGORA).map(r => r.id)).toEqual(["c"]);
    expect(filtrarReunioesNaTela(lista, "evento", { etiqueta: "clientes" }, AGORA).map(r => r.id)).toEqual(["d"]);
  });

  it("passaNosFiltros sem filtro deixa passar tudo; temFiltro diz se há algum", () => {
    expect(passaNosFiltros(lista[2], {}, AGORA)).toBe(true);
    expect(temFiltro({})).toBe(false);
    expect(temFiltro({ periodo: "7d" })).toBe(true);
  });
});

describe("grupoDaOrigem e inicioDoPeriodo", () => {
  it("o envio único (origem nula) e o arquivo e a aba são áudio; PDF e foto, documento", () => {
    expect([null, "gravacao", "arquivo", "aba"].map(grupoDaOrigem)).toEqual(["audio", "audio", "audio", "audio"]);
    expect(["pdf", "foto"].map(grupoDaOrigem)).toEqual(["documento", "documento"]);
    expect(grupoDaOrigem("youtube")).toBe("youtube");
  });

  it("o período conta de agora para trás; sem período, null", () => {
    expect(inicioDoPeriodo("7d", AGORA)).toBe(AGORA - 7 * DIA);
    expect(inicioDoPeriodo(null, AGORA)).toBeNull();
  });
});

describe("comBuscaRecente", () => {
  it("põe o termo na frente, sem repetida (sem caixa e sem acento) e no máximo BUSCAS_RECENTES_MAX", () => {
    expect(comBuscaRecente(["proposta", "Reunião"], "reuniao")).toEqual(["reuniao", "proposta"]);
    expect(comBuscaRecente(["a1"], "   ")).toEqual(["a1"]);
    const cheia = Array.from({ length: BUSCAS_RECENTES_MAX }, (_, i) => `termo ${i}`);
    const nova = comBuscaRecente(cheia, "novo");
    expect(nova).toHaveLength(BUSCAS_RECENTES_MAX);
    expect(nova[0]).toBe("novo");
    expect(nova).not.toContain(`termo ${BUSCAS_RECENTES_MAX - 1}`);
  });

  it("semAcento é a régua da comparação", () => {
    expect(semAcento("AÇÃO Ñandú")).toBe("acao nandu");
  });
});
