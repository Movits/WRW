import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Etapa 2 — auditoria de 04/09 (MAJOR): tag ou categoria escrita em chinês,
 * japonês, árabe, russo ou hindi virava slug vazio, e o cruzamento nunca
 * casava — nem tag idêntica, nem categoria idêntica — nos cinco idiomas que a
 * PR #55 abriu (o placeholder zh convida a digitar "冷藏仓储").
 *
 * Proposto para o repo como server/match-escritas-nao-latinas.test.ts, com os
 * imports voltando a "./match-service" e "@shared/direcao-do-termo".
 */

// Fake de banco por identidade de tabela, no padrão de
// exclusao-e-nucleo-sem-fantasma.test.ts: devolve as linhas da tabela pedida
// e captura o que foi inserido.
const estado = vi.hoisted(() => ({
  linhas: new Map<unknown, unknown[]>(),
  inseridos: [] as Array<Record<string, unknown>>,
}));
vi.mock("./db", () => ({
  exigirDb: async () => ({
    // A leitura dos itens leva ORDER BY id: o dublê aceita.
    select: () => ({ from: (tabela: unknown) => ({ where: () => { const p = Promise.resolve(estado.linhas.get(tabela) ?? []); return Object.assign(p, { orderBy: () => p }); } }) }),
    insert: (_t: unknown) => ({ values: async (v: Record<string, unknown>) => { estado.inseridos.push(v); } }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  }),
}));
vi.mock("./_core/email", () => ({ sendEmail: vi.fn(async () => false) }));
// O registro das conexões internas no fim do recálculo tem teste próprio (registro-de-conexoes-nos-motores.test.ts).
vi.mock("./network-registro", () => ({ registrarConexoesInternasDepoisDoRecalculo: async () => undefined }));

const { scoreMatch, slugifyMatchTag, recalculatePrivateMatches } = await import("./match-service");
const { analisarTermo, nucleoDoTermo, saoConcorrentes } = await import("@shared/direcao-do-termo");
const { aiMatchSuggestions, contactAssets, contactNeeds, privateContacts } = await import("../drizzle/schema");

const item = (label: string, category: string | null = null) => ({ slug: slugifyMatchTag(label), label, category });

const idiomas: Array<[string, string, string]> = [
  ["zh", "冷藏仓储", "饮料"],
  ["ja", "冷蔵倉庫", "飲料"],
  ["ar", "نبيذ", "مشروبات"],
  ["ru", "вино", "напитки"],
  ["hi", "शराब", "पेय"],
];

describe("Slug — letra de qualquer escrita sobrevive", () => {
  it.each(idiomas)("%s: a tag \"%s\" vira ela mesma, não vazio", (_, tag) => {
    expect(slugifyMatchTag(tag)).toBe(tag);
    expect(analisarTermo(tag).objeto).toBe(tag);
    expect(nucleoDoTermo(tag)).toBe(tag);
  });

  it("minúsculas valem para o cirílico também (mata o mutante sem toLowerCase)", () => {
    expect(slugifyMatchTag("Вино")).toBe("вино");
    expect(slugifyMatchTag("Холодильные склады")).toBe("холодильные-склады");
  });

  it("cirílico: й e ё são letras, não acentos — o strip de diacrítico só age após letra latina", () => {
    // Na NFD, й = и + U+0306 e ё = е + U+0308: um strip cego juntava "войны"
    // (guerras) com "воины" (guerreiros) e gravava grafias inexistentes.
    expect(slugifyMatchTag("Йогурт")).toBe("йогурт");
    expect(slugifyMatchTag("Ёлка")).toBe("ёлка");
    expect(slugifyMatchTag("чай")).not.toBe(slugifyMatchTag("чаи"));
    expect(scoreMatch(item("войны"), item("воины")).score).toBe(0);
    // e o latim continua perdendo o acento como sempre
    expect(slugifyMatchTag("Exportação de açaí")).toBe("exportacao-de-acai");
  });

  it("a matra do devanágari NÃO é acento: शराब fica inteira (mata o mutante que tira \\p{M})", () => {
    expect(slugifyMatchTag("शराब")).toBe("शराब");
    expect(slugifyMatchTag("शराब")).not.toBe("शरब");
    expect(slugifyMatchTag("शराब")).not.toContain("-");
  });

  it("compatibilidade NFKD: largura inteira e ordinais viram ASCII (mata o mutante NFD)", () => {
    expect(slugifyMatchTag("ＡＢＣ１２３")).toBe("abc123");
    expect(slugifyMatchTag("Galpão de 500 m²")).toBe("galpao-de-500-m2");
  });

  it("o corte de 160 é por caractere e nunca parte uma surrogate pair", () => {
    const slug = slugifyMatchTag("𠀀".repeat(200));
    expect(Array.from(slug).length).toBe(160);
    expect(slug.isWellFormed()).toBe(true);
  });
});

describe("Regressão latina — o que já era [a-z0-9] após tirar o acento dá o MESMO slug", () => {
  const casos: Array<[string, string]> = [
    ["Mineração de Terras Raras", "mineracao-de-terras-raras"],
    // Exceção deliberada: "ª" é compatibilidade NFKD (→ "a"); o slug antigo
    // descartava o caractere ("2-unidade"). Linha antiga mantém o slug velho no
    // banco, e o dedupe do enriquecimento compara também pelo rótulo.
    ["Café & Cia. (Ltda) — 2ª unidade!", "cafe-cia-ltda-2a-unidade"],
    ["  Exportação para a China  ", "exportacao-para-a-china"],
    ["Armazenagem refrigerada", "armazenagem-refrigerada"],
    ["Terrenos com outorga", "terrenos-com-outorga"],
    ["Ñandú / açaí_orgânico", "nandu-acai-organico"],
  ];
  it.each(casos)("\"%s\" → %s", (rotulo, esperado) => {
    expect(slugifyMatchTag(rotulo)).toBe(esperado);
  });

  it("o analisador segue latino onde era latino", () => {
    expect(analisarTermo("Exportar vinho")).toEqual({ direcao: "oferta", objeto: "vinho", verbo: "exportar" });
    expect(nucleoDoTermo("Fornecedor de terras raras")).toBe("terras-raras");
    expect(nucleoDoTermo("Fazenda de perus")).toBe("fazenda-de-perus");
    expect(nucleoDoTermo("Fornecedor da China")).toBe("fornecedor-da-china");
    expect(scoreMatch(item("Terras raras"), item("Fornecedor de terras raras")).score).toBe(100);
    expect(scoreMatch(item("Exportar vinho"), item("Exportar vinho"))).toHaveProperty("bloqueio", "concorrentes");
  });
});

describe("scoreMatch — tag e categoria idênticas casam nos cinco idiomas", () => {
  it.each(idiomas)("%s: tag idêntica = 100 exact; mesma categoria = 60", (_, tag, categoria) => {
    expect(scoreMatch(item(tag, categoria), item(tag, categoria))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item(tag), item(tag))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("x", categoria), item("y", categoria))).toEqual({ score: 60, type: "category" });
    expect(saoConcorrentes(tag, tag)).toBe(false);
  });

  it("linha antiga com tag_slug \"\" ainda casa: o objeto vem do rótulo (mata o mutante que só conserta o slug)", () => {
    const antigo = { slug: "", label: "冷藏仓储", category: null };
    expect(scoreMatch(antigo, { ...antigo })).toEqual({ score: 100, type: "exact" });
  });

  it("marcador fraco latino na frente de escrita não latina é descascado", () => {
    expect(analisarTermo("procura 冷藏仓储").objeto).toBe("冷藏仓储");
    expect(scoreMatch(item("冷藏仓储"), item("procura 冷藏仓储")).score).toBe(100);
  });

  it("não casa por pedaço: tag diferente na mesma escrita continua 0", () => {
    expect(scoreMatch(item("冷藏仓储"), item("冷藏")).score).toBe(0);
    expect(scoreMatch(item("冷藏仓储"), item("仓储")).score).toBe(0);
    expect(scoreMatch(item("вино"), item("виноград")).score).toBe(0);
    expect(scoreMatch(item("x", "饮料"), item("y", "食品")).score).toBe(0);
  });
});

describe("recalculatePrivateMatches — linhas gravadas com slug vazio antes do conserto", () => {
  beforeEach(() => { estado.linhas.clear(); estado.inseridos = []; });

  it("recalcula o slug a partir do rótulo: as duas razões aparecem, não uma só", async () => {
    const t = 1;
    const linha = (id: number, contactId: number, tagLabel: string) =>
      ({ id, ownerId: "dona", contactId, tagSlug: "", tagLabel, category: null, description: null, createdAt: t, updatedAt: t });
    estado.linhas.set(privateContacts, [{ id: 1, fullName: "Ana" }, { id: 2, fullName: "Bo" }]);
    estado.linhas.set(contactAssets, [linha(1, 1, "冷藏仓储"), linha(2, 1, "饮料批发")]);
    estado.linhas.set(contactNeeds, [linha(3, 2, "冷藏仓储"), linha(4, 2, "饮料批发")]);
    estado.linhas.set(aiMatchSuggestions, []);

    const r = await recalculatePrivateMatches("dona");
    expect(r).toEqual({ created: 1, updated: 0, removed: 0, total: 1 });
    const [sugestao] = estado.inseridos;
    expect(sugestao.matchScore).toBe(100);
    expect(sugestao.matchType).toBe("exact");
    expect((sugestao.matchedAssets as Array<{ slug: string }>).map(a => a.slug)).toEqual(["冷藏仓储", "饮料批发"]);
    expect(sugestao.reasonText).toBe("Ana possui 冷藏仓储 e 饮料批发, que Bo procura.");
  });
});
