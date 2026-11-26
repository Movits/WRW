import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Possui / procura é dado da AGENDA, e a dona vê e remove sem o termo do
 * Smart Match.
 *
 * O chat de enriquecimento grava contact_assets/contact_needs sem exigir o
 * termo (é dado do contato), e a vitrine e o acervo Ouro já expõem esses
 * itens. Mas o único lugar que os listava e removia era intelligentMatches,
 * inteiro atrás da trava do termo: quem nunca aceitou (ou revogou) via um
 * "Fábrica de armas" exposto na vitrine e não conseguia apagá-lo sem aceitar
 * um termo de cruzamento que não queria.
 *
 * Aqui: network.assetsNeeds / removeAsset / removeNeed, rota real via
 * createCaller, drizzle de verdade sobre um mysql2 falso que captura o SQL
 * (o owner_id precisa estar no WHERE, não na boa vontade da tela). O
 * cruzamento (matches.ts) fica como está, atrás da trava.
 */

const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  contatoEhDaDona: true,
  /** O item de possui/procura pedido existe e é da dona? (SELECT antes do DELETE) */
  itemEhDaDona: true,
  linhasApagadas: 1,
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      const sql = config.sql;
      // Um dublê que responde pelo CONTEÚDO da consulta, para o teste não
      // depender da ordem em que as consultas paralelas chegam.
      if (sql.startsWith("delete")) return [{ affectedRows: estado.linhasApagadas }, []];
      // A leitura do contato do item (só `contact_id`), antes do DELETE.
      if (/^select `contact_id` from `contact_(assets|needs)`/.test(sql)) return [estado.itemEhDaDona ? [[42]] : [], []];
      if (sql.includes("from `private_contacts`")) return [estado.contatoEhDaDona ? [[42, "dona-1"]] : [], []];
      if (sql.includes("from `contact_assets`")) return [[[1, "Vinho do Porto", "Bebidas"]], []];
      if (sql.includes("from `contact_needs`")) return [[[2, "Distribuidora na Ásia", null]], []];
      return [[], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const hasValidConsent = vi.fn(async () => false);
vi.mock("./routers/consent", () => ({
  hasValidConsent: (...args: unknown[]) => hasValidConsent(...(args as [])),
  usersComConsentimento: async (ids: number[]) => new Set(ids),
}));

const recalculatePrivateMatches = vi.fn(async () => ({ created: 0, updated: 0, removed: 0, total: 0 }));
vi.mock("./match-service", () => ({
  recalculatePrivateMatches: (...args: unknown[]) => recalculatePrivateMatches(...(args as [])),
  slugifyMatchTag: (v: string) => v.toLowerCase(),
}));

const { networkRouter } = await import("./routers/network");

const ctx = {
  user: { id: 1, openId: "dona-1", email: "t@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never;

const consultasEm = (tabela: string) => estado.consultas.filter(c => c.sql.includes(`\`${tabela}\``));

beforeEach(() => {
  estado.consultas = [];
  estado.contatoEhDaDona = true;
  estado.itemEhDaDona = true;
  estado.linhasApagadas = 1;
  hasValidConsent.mockReset(); hasValidConsent.mockResolvedValue(false);
  recalculatePrivateMatches.mockReset();
  recalculatePrivateMatches.mockResolvedValue({ created: 0, updated: 0, removed: 0, total: 0 });
});

describe("Rede — assetsNeeds: a dona vê o que o chat registrou, sem termo", () => {
  const rede = networkRouter.createCaller(ctx);

  it("contato de outra dona (ou inexistente) é NOT_FOUND, e as tabelas de possui/procura nem são lidas", async () => {
    estado.contatoEhDaDona = false;
    await expect(rede.assetsNeeds({ contactId: 42 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(consultasEm("contact_assets")).toHaveLength(0);
    expect(consultasEm("contact_needs")).toHaveLength(0);
    // a posse foi conferida no banco, com a dona no WHERE (em private_contacts
    // a coluna se chama ownerId; em contact_assets/needs, owner_id)
    const posse = consultasEm("private_contacts")[0];
    expect(posse.sql).toContain("`private_contacts`.`ownerId` = ?");
    expect(posse.params).toEqual(expect.arrayContaining([42, "dona-1"]));
  });

  it("contato dela: devolve possui e procura, filtrados por dona E contato no SQL", async () => {
    const r = await rede.assetsNeeds({ contactId: 42 });
    expect(r).toEqual({
      possui: [{ id: 1, label: "Vinho do Porto", category: "Bebidas" }],
      procura: [{ id: 2, label: "Distribuidora na Ásia", category: null }],
    });
    for (const tabela of ["contact_assets", "contact_needs"]) {
      const consulta = consultasEm(tabela)[0];
      expect(consulta.sql).toContain("`owner_id` = ?");
      expect(consulta.sql).toContain("`contact_id` = ?");
      expect(consulta.params).toEqual(expect.arrayContaining(["dona-1", 42]));
    }
    // e sem passar pela trava do cruzamento
    expect(hasValidConsent).not.toHaveBeenCalled();
  });
});

describe("Rede — removeAsset / removeNeed: apagar o próprio dado não exige termo", () => {
  const rede = networkRouter.createCaller(ctx);

  const apagarSugestoes = () => estado.consultas.filter(c => c.sql.startsWith("delete from `ai_match_suggestions`"));

  it("sem termo: o DELETE sai com owner_id no WHERE e o cruzamento NÃO é recalculado", async () => {
    await expect(rede.removeAsset({ id: 5 })).resolves.toEqual({ success: true });

    const apagar = consultasEm("contact_assets").find(c => c.sql.startsWith("delete"));
    expect(apagar).toBeDefined();
    expect(apagar!.sql).toContain("`id` = ?");
    expect(apagar!.sql).toContain("`owner_id` = ?");
    expect(apagar!.params).toEqual(expect.arrayContaining([5, "dona-1"]));
    expect(hasValidConsent).toHaveBeenCalledWith(1, "termo_smart_match");
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });

  it("o contato do item é lido ANTES do DELETE, com o owner_id no WHERE", async () => {
    await rede.removeNeed({ id: 9 });

    const leitura = estado.consultas.findIndex(c => c.sql.startsWith("select `contact_id` from `contact_needs`"));
    const remocao = estado.consultas.findIndex(c => c.sql.startsWith("delete from `contact_needs`"));
    expect(leitura).toBeGreaterThanOrEqual(0);
    expect(remocao).toBeGreaterThan(leitura);
    expect(estado.consultas[leitura].sql).toBe("select `contact_id` from `contact_needs` where (`contact_needs`.`id` = ? and `contact_needs`.`owner_id` = ?) limit ?");
    expect(estado.consultas[leitura].params).toEqual([9, "dona-1", 1]);
  });

  it("sem termo: a sugestão cuja razão saiu não fica fantasma — as sugestões da dona com esse contato no par são apagadas", async () => {
    await expect(rede.removeAsset({ id: 5 })).resolves.toEqual({ success: true });

    // Sem o termo o recálculo não roda; sem isto, ai_match_suggestions guardava
    // a razão apagada até o próximo recálculo. Molde de apagarRastroDoContato:
    // owner_id no WHERE e o contato (lido antes do DELETE) em qualquer lado do par.
    expect(apagarSugestoes()).toHaveLength(1);
    expect(apagarSugestoes()[0].sql).toBe("delete from `ai_match_suggestions` where (`ai_match_suggestions`.`owner_id` = ? and (`ai_match_suggestions`.`pair_low_contact_id` = ? or `ai_match_suggestions`.`pair_high_contact_id` = ?))");
    expect(apagarSugestoes()[0].params).toEqual(["dona-1", 42, 42]);
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });

  it("com o termo: recalcula, SEM e-mail (remoção não é notícia de oportunidade nova), e não apaga sugestões à mão", async () => {
    hasValidConsent.mockResolvedValue(true);
    await expect(rede.removeNeed({ id: 9 })).resolves.toEqual({ success: true });

    const apagar = consultasEm("contact_needs").find(c => c.sql.startsWith("delete"));
    expect(apagar).toBeDefined();
    expect(apagar!.sql).toContain("`owner_id` = ?");
    expect(apagar!.params).toEqual(expect.arrayContaining([9, "dona-1"]));
    expect(recalculatePrivateMatches).toHaveBeenCalledTimes(1);
    expect(recalculatePrivateMatches.mock.calls[0]).toEqual(["dona-1"]); // só a dona, nenhum e-mail
    // O recálculo refaz o mapa inteiro; apagar por cima seria trabalho dobrado.
    expect(apagarSugestoes()).toHaveLength(0);
  });

  it("id de outra dona (ou inexistente) → NOT_FOUND antes de qualquer DELETE, e nada é recalculado", async () => {
    hasValidConsent.mockResolvedValue(true);
    estado.itemEhDaDona = false;
    await expect(rede.removeAsset({ id: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(estado.consultas.some(c => c.sql.startsWith("delete"))).toBe(false);
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
  });

  it("corrida: o item sumiu entre o SELECT e o DELETE (zero linhas) → NOT_FOUND, e nada é recalculado", async () => {
    hasValidConsent.mockResolvedValue(true);
    estado.linhasApagadas = 0;
    await expect(rede.removeAsset({ id: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(recalculatePrivateMatches).not.toHaveBeenCalled();
    expect(apagarSugestoes()).toHaveLength(0);
  });

  it("recálculo que falha não desfaz a remoção: melhor esforço", async () => {
    hasValidConsent.mockResolvedValue(true);
    recalculatePrivateMatches.mockRejectedValue(new Error("motor fora do ar"));
    const silencio = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(rede.removeAsset({ id: 5 })).resolves.toEqual({ success: true });
    } finally {
      silencio.mockRestore();
    }
  });
});

describe("Rede — addItem / editItem: a dona acrescenta e corrige na ficha, sem termo (T45, 24/11)", () => {
  const rede = networkRouter.createCaller(ctx);
  const gravacoes = () => estado.consultas.filter(c => /^(insert|update)/.test(c.sql));

  it("contato de outra dona: NOT_FOUND, conferido com a dona no WHERE, e nada é gravado", async () => {
    estado.contatoEhDaDona = false;
    await expect(rede.addItem({ contactId: 42, tipo: "possui", rotulo: "Exportação de café" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(consultasEm("private_contacts")[0].params).toEqual(expect.arrayContaining([42, "dona-1"]));
    expect(gravacoes()).toEqual([]);
  });

  it("o contato já tem o item: CONFLICT com o código, e nada é gravado", async () => {
    await expect(rede.addItem({ contactId: 42, tipo: "possui", rotulo: "Vinho do Porto" })).rejects.toMatchObject({ code: "CONFLICT", message: "ITEM_DA_FICHA_REPETIDO" });
    expect(gravacoes()).toEqual([]);
  });

  it("corrigir o item de outra dona: NOT_FOUND, e nada é gravado", async () => {
    estado.itemEhDaDona = false;
    await expect(rede.editItem({ id: 9, tipo: "procura", rotulo: "Outra coisa" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const leitura = consultasEm("contact_needs")[0];
    expect(leitura.sql).toContain("`owner_id` = ?");
    expect(leitura.params).toEqual(expect.arrayContaining([9, "dona-1"]));
    expect(gravacoes()).toEqual([]);
  });

  it("o texto passa do teto da coluna: recusado na entrada", async () => {
    await expect(rede.addItem({ contactId: 42, tipo: "procura", rotulo: "x".repeat(201) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(estado.consultas).toEqual([]);
  });
});
