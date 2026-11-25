import { beforeEach, describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Duas tarefas do quadro (achados da revisão de 01/09 sobre a PR #34):
 *
 * 1. "Apagar contato deixa para trás os dados extraídos pela IA" — a exclusão
 *    limpava possui/procura/sugestões mas deixava o vínculo com contextos e o
 *    enriquecimento inteiro (telefone, instagram, empresa extraídos pela IA e
 *    a conversa). Dado apagado não deixa fantasma — LGPD included.
 *
 * 2. "Match dá 100% para contatos que só têm o país em comum" — o núcleo
 *    reduzia "Fornecedor da China" a "china", e geografia virava mercadoria.
 */

import { apagarRastroDoContato } from "./db";
import { nucleoDoTermo } from "../shared/direcao-do-termo";
import {
  contactAssets, contactNeeds, aiMatchSuggestions, contactContexts,
  enrichmentSessions, enrichmentMessages, enrichmentSuggestions,
  meetings, meetingContactSuggestions, contextParticipants, proximasAcoes, entidadeMembros,
} from "../drizzle/schema";

/**
 * Banco falso por identidade de tabela — e que NÃO engole o WHERE: guarda as
 * colunas citadas em cada predicado. Sem isso, uma regressão que apagasse o
 * `eq(ownerId, ...)` (vazamento entre donas: apagaria o rastro de TODAS)
 * passaria verde, e a rede de proteção seria decorativa.
 */
type Operacao = { tabela: unknown; colunas: string[] };
let delecoes: Operacao[] = [];
let atualizacoes: Array<Operacao & { valores: Record<string, unknown> }> = [];
let sessoesNoBanco: Array<{ id: string }> = [];

/** Nomes das colunas dentro de uma condição do drizzle (varre os chunks). */
function colunasDe(condicao: unknown): string[] {
  const achadas: string[] = [];
  // O objeto do drizzle tem ciclos (coluna → tabela → colunas): sem o
  // conjunto de visitados, a varredura não termina.
  const visitados = new Set<unknown>();
  const visitar = (no: unknown) => {
    if (!no || typeof no !== "object" || visitados.has(no)) return;
    visitados.add(no);
    const alvo = no as Record<string, unknown>;
    // Coluna: registra e PARA. Descer nela levaria à tabela, e a tabela traz
    // todas as outras colunas — o que faria qualquer predicado "conter"
    // owner_id e deixaria o mutante da regressão passar (aconteceu).
    if (typeof alvo.name === "string" && alvo.table) { achadas.push(alvo.name); return; }
    for (const valor of Object.values(alvo)) {
      if (Array.isArray(valor)) valor.forEach(visitar);
      else if (valor && typeof valor === "object") visitar(valor);
    }
  };
  visitar(condicao);
  return achadas;
}

const fakeDb = {
  delete: (tabela: unknown) => ({
    where: async (condicao: unknown) => { delecoes.push({ tabela, colunas: colunasDe(condicao) }); },
  }),
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: async (condicao: unknown) => { atualizacoes.push({ tabela, colunas: colunasDe(condicao), valores }); },
    }),
  }),
  select: () => ({
    from: (tabela: unknown) => ({
      where: async () => (tabela === enrichmentSessions ? sessoesNoBanco : []),
    }),
  }),
} as never;

const tabelasApagadas = () => delecoes.map(operacao => operacao.tabela);

beforeEach(() => {
  delecoes = [];
  atualizacoes = [];
  sessoesNoBanco = [{ id: "sessao-1" }, { id: "sessao-2" }];
});

describe("Exclusão — o contato leva TODO o rastro junto (executado)", () => {
  it("apaga possui, procura, sugestões de match, vínculos de contexto e o enriquecimento inteiro", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    for (const tabela of [contactAssets, contactNeeds, aiMatchSuggestions, contactContexts, enrichmentSuggestions, enrichmentMessages, enrichmentSessions]) {
      expect(tabelasApagadas()).toContain(tabela);
    }
  });

  it("a sugestão de contato da REUNIÃO também sai — é dado pessoal extraído pela IA", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    expect(tabelasApagadas()).toContain(meetingContactSuggestions);
  });

  it("TODO delete do rastro filtra por dona: sem isso, apagaria o rastro do ecossistema inteiro", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    expect(delecoes.length).toBeGreaterThan(0);
    for (const operacao of delecoes) {
      expect(operacao.colunas).toContain("owner_id");
    }
  });

  it("cada delete mira o contato certo (contact_id ou o par de sugestões)", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    for (const operacao of delecoes) {
      const miraOContato = operacao.colunas.some(coluna =>
        ["contact_id", "existing_contact_id", "pair_low_contact_id", "session_id"].includes(coluna));
      expect(miraOContato).toBe(true);
    }
  });

  it("os ponteiros da reunião e do participante são ANULADOS, não apagados: o registro da dona sobrevive", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    const reuniao = atualizacoes.find(operacao => operacao.tabela === meetings);
    const participante = atualizacoes.find(operacao => operacao.tabela === contextParticipants);
    expect(reuniao?.valores).toEqual({ contactId: null });
    expect(participante?.valores).toEqual({ convertedContactId: null });
    expect(reuniao?.colunas).toContain("owner_id");
    // e a reunião em si nunca é apagada
    expect(tabelasApagadas()).not.toContain(meetings);
  });

  it("as próximas ações (H5a) ficam com a dona, sem o contato: o ponteiro é anulado, só nas ações dela", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    const acoes = atualizacoes.find(operacao => operacao.tabela === proximasAcoes);
    expect(acoes?.valores).toEqual({ contactId: null, updatedAt: expect.any(Number) });
    expect(acoes?.colunas).toEqual(["owner_id", "contact_id"]);
    expect(tabelasApagadas()).not.toContain(proximasAcoes);
  });

  it("o associado de uma entidade vira removido: some o documento, o contato e a CNAE cifrados, fica só o HMAC (lista de bloqueio)", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    const membro = atualizacoes.find(operacao => operacao.tabela === entidadeMembros);
    expect(membro?.valores).toMatchObject({
      estado: "removido", contactId: null, documentoCifrado: null, contatoCifrado: null,
      cnaePrincipal: null, cnaesSecundarios: null, referenciaDaEntidade: null, ativacaoHash: null,
    });
    expect(Object.keys(membro?.valores ?? {})).not.toContain("documentoHmac");
    expect(membro?.colunas).toEqual(["owner_id", "contact_id"]);
    expect(tabelasApagadas()).not.toContain(entidadeMembros);
  });

  it("as mensagens do enriquecimento caem ANTES das sessões — queda no meio não deixa órfão inalcançável", async () => {
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    expect(tabelasApagadas().indexOf(enrichmentMessages)).toBeLessThan(tabelasApagadas().indexOf(enrichmentSessions));
  });

  it("contato sem sessões de enriquecimento não dispara DELETE de mensagens", async () => {
    sessoesNoBanco = [];
    await apagarRastroDoContato(fakeDb, "dona-1", 42);
    expect(tabelasApagadas()).not.toContain(enrichmentMessages);
    expect(tabelasApagadas()).not.toContain(enrichmentSessions);
    // mas o resto do rastro cai do mesmo jeito
    expect(tabelasApagadas()).toContain(contactContexts);
    expect(tabelasApagadas()).toContain(enrichmentSuggestions);
  });

  it("o rastro sai ANTES do contato: falha no meio deixa a exclusão retentável", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const fonte = readFileSync(join(__dirname, "db.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("export async function deletePrivateContact"));
    const posicaoRastro = corpo.indexOf("await apagarRastroDoContato");
    const posicaoDelete = corpo.indexOf("delete(privateContacts)");
    expect(posicaoRastro).toBeGreaterThan(-1);
    expect(posicaoRastro).toBeLessThan(posicaoDelete);
  });
});

describe("Núcleo — lugar não é mercadoria", () => {
  it("'Fornecedor da China' NÃO vira 'china': o termo vale por inteiro", () => {
    expect(nucleoDoTermo("Fornecedor da China")).toBe("fornecedor-da-china");
  });

  it("dois termos que só compartilham o país não ganham o mesmo núcleo", () => {
    expect(nucleoDoTermo("Fornecedor da China")).not.toBe(nucleoDoTermo("Eletrônicos da China"));
  });

  // Igualdade EXATA: "maior que 1 pedaço" deixaria passar uma redução indevida
  // a "africa-do-sul" (3 pedaços) ou "sao-paulo" (2), que é justamente o bug.
  const lugares: Array<[string, string, string]> = [
    ["país em inglês", "Distribuidor de Brazil", "distribuidor-de-brazil"],
    ["gentílico", "Fabricante de chinesas", "fabricante-de-chinesas"],
    ["continente", "Exportadora da Europa", "exportadora-da-europa"],
    ["composto — África do Sul", "Produtora da África do Sul", "produtora-da-africa-do-sul"],
    ["estado brasileiro composto", "Fábrica de São Paulo", "fabrica-de-sao-paulo"],
    ["composto em inglês", "Supplier of South Africa", "supplier-of-south-africa"],
    ["país só em inglês", "Supplier of Netherlands", "supplier-of-netherlands"],
    ["circuito de eletrônicos", "Fornecedor de Taiwan", "fornecedor-de-taiwan"],
    ["ponto cardeal", "Fornecedor do Sul", "fornecedor-do-sul"],
    ["país fora do eixo comum", "Fornecedor de Uganda", "fornecedor-de-uganda"],
  ];
  for (const [nome, termo, esperado] of lugares) {
    it(`${nome}: "${termo}" fica inteiro`, () => {
      expect(nucleoDoTermo(termo)).toBe(esperado);
    });
  }

  it("singular e plural do lugar se comportam igual (assimetria do 'peru' fechada)", () => {
    expect(nucleoDoTermo("Fornecedor de peru")).toBe("fornecedor-de-peru");
    expect(nucleoDoTermo("Fazenda de perus")).toBe("fazenda-de-perus");
  });

  it("a redução legítima continua: papel e estrutura atravessam para a mercadoria", () => {
    expect(nucleoDoTermo("Fornecedor de terras raras")).toBe("terras-raras");
    expect(nucleoDoTermo("Mina de terras raras")).toBe("terras-raras");
    expect(nucleoDoTermo("Fazenda de café")).toBe("cafe");
  });

  it("mercadoria COM complemento de lugar segue reduzindo à mercadoria", () => {
    // a substância começa em "vinhos"; a Europa é complemento dela, não o núcleo
    expect(nucleoDoTermo("Fornecedor de vinhos da Europa")).toBe("vinhos-da-europa");
  });
});
