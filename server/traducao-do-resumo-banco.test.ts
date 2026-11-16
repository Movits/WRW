import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * O banco da tradução do resumo (H11) com o drizzle de verdade sobre um
 * cliente mysql2 falso (molde de meeting-service.test.ts): o SQL que sai é o
 * que iria ao MySQL, e o teste lê as consultas e os valores. Prova a dona no
 * WHERE de toda leitura, a tradução de outra versão que não vale, e a gravação
 * numa transação que trava a reunião e confere o resumo antes de escrever. O
 * banco de verdade está em traducao-do-resumo.integracao.test.ts.
 */
const banco = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  // status, resumoId, statusDoResumo, versao, idiomaDoResumo (e, se vierem, statusDoMapa e mapa)
  reuniao: ["ready", "resumo-1", "ready", 3, "pt-BR"] as unknown[] | null,
  // id, section, subject, text, assignee, due, excerpt, startSeconds, status, origin, editedAt
  itens: [] as unknown[][],
  // summaryId, sourceVersion, content
  traducao: null as unknown[] | null,
  // Na transação: a reunião [status], o resumo [id, status, versao] e a tradução [summaryId, sourceVersion, content].
  reuniaoTravada: ["ready"] as unknown[] | null,
  resumoTravado: ["resumo-1", "ready", 3] as unknown[] | null,
  traducaoTravada: null as unknown[] | null,
}));
vi.mock("drizzle-orm/mysql2", async importOriginal => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const linhas = (linha: unknown[] | null) => [linha ? [linha] : [], []];
  const clienteFalso = {
    query: async (config: { sql: string } | string, params: unknown[] = []) => {
      const sql = typeof config === "string" ? config : config.sql;
      banco.consultas.push({ sql, params });
      if (/^(begin|commit|rollback)/.test(sql)) return [[], []];
      if (sql.startsWith("insert") || sql.startsWith("update")) return [{ affectedRows: 1 }, []];
      const travada = sql.endsWith("for update");
      if (sql.includes("from `meetings` left join")) return linhas(banco.reuniao);
      if (sql.includes("from `meeting_summary_items`")) return [banco.itens, []];
      if (sql.includes("from `meeting_summary_translations`")) return linhas(travada ? banco.traducaoTravada : banco.traducao);
      if (sql.includes("from `meetings`") && travada) return linhas(banco.reuniaoTravada);
      if (sql.includes("from `meeting_summaries`") && travada) return linhas(banco.resumoTravado);
      return [[], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const { gravarTraducaoDoResumo, lerResumoParaTraduzir } = await import("./traducao-do-resumo-banco");

const ITEM = ["item-1", "action", null, "{F2} envia a proposta", "{F2}", "até sexta", "vou mandar a proposta até sexta", 30, "pending", "ai", null];
const ALVO = { ownerId: "dona-1", meetingId: "reuniao-1", idioma: "en" as const, resumoId: "resumo-1", versao: 3 };
const consultasCom = (trecho: string) => banco.consultas.filter(c => c.sql.includes(trecho));

beforeEach(() => {
  Object.assign(banco, {
    consultas: [], reuniao: ["ready", "resumo-1", "ready", 3, "pt-BR"], itens: [ITEM], traducao: null,
    reuniaoTravada: ["ready"], resumoTravado: ["resumo-1", "ready", 3], traducaoTravada: null,
  });
});

describe("ler o resumo para traduzir", () => {
  it("toda leitura leva a dona no WHERE, e os itens saem na ordem do resumo", async () => {
    banco.traducao = ["resumo-1", 3, JSON.stringify({ itens: {}, mapa: {} })];
    const leitura = await lerResumoParaTraduzir("dona-1", "reuniao-1", "en");

    expect(leitura).toEqual({
      estado: "pronto", resumoId: "resumo-1", versao: 3, idiomaOriginal: "pt-BR", rotulosDoMapa: [], guardado: { itens: {}, mapa: {} }, soGuardada: false,
      itens: [{ id: "item-1", section: "action", subject: null, text: "{F2} envia a proposta", assignee: "{F2}", due: "até sexta", excerpt: "vou mandar a proposta até sexta", startSeconds: 30, status: "pending", origin: "ai", editedAt: null }],
    });
    const [reuniao] = consultasCom("from `meetings` left join");
    expect(reuniao.sql).toContain("`meeting_summaries`.`owner_id` = `meetings`.`owner_id`");
    expect(reuniao.sql).toContain("`meetings`.`owner_id` = ?");
    expect(reuniao.sql).toContain("`meetings`.`status` <> ?");
    expect(reuniao.params).toEqual(expect.arrayContaining(["reuniao-1", "dona-1", "deleted"]));
    const [itens] = consultasCom("from `meeting_summary_items`");
    expect(itens.sql).toContain("`meeting_summary_items`.`owner_id` = ?");
    expect(itens.sql).toContain("order by `meeting_summary_items`.`position`");
    expect(itens.params).toEqual(["resumo-1", "dona-1"]);
    const [traducao] = consultasCom("from `meeting_summary_translations`");
    expect(traducao.params).toEqual(["dona-1", "reuniao-1", "en", 1]);
  });

  it("a tradução de outro resumo ou de outra versão não vale", async () => {
    banco.traducao = ["resumo-1", 2, JSON.stringify({ itens: { x: {} }, mapa: {} })];
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en")).toMatchObject({ estado: "pronto", guardado: null });
    banco.traducao = ["resumo-antigo", 3, JSON.stringify({ itens: { x: {} }, mapa: {} })];
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en")).toMatchObject({ estado: "pronto", guardado: null });
  });

  it("os rótulos do mapa mental (H10) vão junto, só do mapa pronto que ainda passa na conferência", async () => {
    const MAPA = { ramos: [{ rotulo: "Exportação", folhas: [{ rotulo: "Contêiner", filhos: ["12 de março", "Contêiner"] }] }, { rotulo: "Feiras", folhas: [] }] };
    banco.reuniao = ["ready", "resumo-1", "ready", 3, "pt-BR", "ready", JSON.stringify(MAPA)];
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en")).toMatchObject({ estado: "pronto", rotulosDoMapa: ["Exportação", "Contêiner", "12 de março", "Feiras"] });
    const [reuniao] = consultasCom("from `meetings` left join");
    expect(reuniao.sql).toContain("`meeting_summaries`.`mind_map_status`");
    // O mapa na fila, o que falhou e o que a conferência não aceita mais: nada a traduzir.
    for (const [status, mapa] of [["pending", MAPA], ["failed", MAPA], [null, null], ["ready", { ramos: [{ rotulo: "Só um", folhas: [] }] }]]) {
      banco.reuniao = ["ready", "resumo-1", "ready", 3, "pt-BR", status, mapa === null ? null : JSON.stringify(mapa)];
      expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en")).toMatchObject({ estado: "pronto", rotulosDoMapa: [] });
    }
  });

  it("o resumo já no idioma pedido: 'original', sem ler itens nem tradução", async () => {
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "pt-BR")).toEqual({ estado: "original" });
    // Reunião antiga guarda 'pt': é o mesmo pt-BR.
    banco.reuniao = ["ready", "resumo-1", "ready", 3, "pt"];
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "pt-BR")).toEqual({ estado: "original" });
    expect(consultasCom("from `meeting_summary_items`")).toEqual([]);
  });

  it("sem resumo pronto, ou com a reunião fora de 'ready': 'sem_resumo'", async () => {
    for (const linha of [
      ["ready", null, null, null, null], ["ready", "resumo-1", "pending", 0, null], ["ready", "resumo-1", "failed", 0, null],
      ["processing", "resumo-1", "ready", 3, "pt-BR"], ["processing", "resumo-1", "failed", 3, "pt-BR"],
    ]) {
      banco.reuniao = linha;
      expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en"), JSON.stringify(linha)).toEqual({ estado: "sem_resumo" });
    }
  });

  it("no refazer (H4d), a versão anterior que fica na tela: a do refazer que falhou se traduz como a pronta; a do refazer em curso, só com a tradução guardada", async () => {
    const guardado = { itens: { "item-1": { h: "x", subject: null, text: "EN", due: null } }, mapa: {} };
    banco.traducao = ["resumo-1", 3, JSON.stringify(guardado)];
    banco.reuniao = ["ready", "resumo-1", "failed", 3, "pt-BR"];
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en")).toMatchObject({ estado: "pronto", versao: 3, guardado, soGuardada: false });
    banco.reuniao = ["ready", "resumo-1", "pending", 3, "pt-BR"];
    expect(await lerResumoParaTraduzir("dona-1", "reuniao-1", "en")).toMatchObject({ estado: "pronto", versao: 3, guardado, soGuardada: true });
  });

  it("reunião que não existe, de outra dona ou apagada: NOT_FOUND", async () => {
    banco.reuniao = null;
    await expect(lerResumoParaTraduzir("dona-2", "reuniao-1", "en")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("gravar a tradução", () => {
  it("na transação: trava a reunião, confere o resumo e insere a linha da dona, com a versão e o conteúdo", async () => {
    const montar = vi.fn(() => ({ itens: { "item-1": { h: "abc", subject: null, text: "EN", due: null } }, mapa: {} }));
    await expect(gravarTraducaoDoResumo(ALVO, montar, "gemini-teste-1")).resolves.toBe(true);

    expect(montar).toHaveBeenCalledWith(null);
    const passos = banco.consultas.map(c => c.sql.split(" ")[0]);
    expect(passos[0]).toBe("begin");
    expect(passos.at(-1)).toBe("commit");
    const [reuniao] = consultasCom("from `meetings` where");
    expect(reuniao.sql).toMatch(/`meetings`\.`owner_id` = \?.* for update$/);
    const [resumo] = consultasCom("from `meeting_summaries` where");
    expect(resumo.sql).toMatch(/`meeting_summaries`\.`owner_id` = \?.* for update$/);
    const [insert] = consultasCom("insert into `meeting_summary_translations`");
    expect(insert.params).toEqual(expect.arrayContaining(["resumo-1", "reuniao-1", "dona-1", "en", 3, "gemini-teste-1"]));
    expect(insert.params).toContain(JSON.stringify(montar.mock.results[0].value));
  });

  it("com a linha da mesma versão: atualiza só a da dona, reunião e idioma, e montar recebe o guardado", async () => {
    const guardado = { itens: { "item-1": { h: "abc", subject: null, text: "EN", due: null } }, mapa: {} };
    banco.traducaoTravada = ["resumo-1", 3, JSON.stringify(guardado)];
    const montar = vi.fn(() => guardado);
    await gravarTraducaoDoResumo(ALVO, montar, null);

    expect(montar).toHaveBeenCalledWith(guardado);
    const [update] = consultasCom("update `meeting_summary_translations`");
    expect(update.sql).toContain("where (`meeting_summary_translations`.`owner_id` = ? and `meeting_summary_translations`.`meeting_id` = ? and `meeting_summary_translations`.`language` = ?)");
    expect(update.params.slice(-3)).toEqual(["dona-1", "reuniao-1", "en"]);
    // Sem o modelo, o da tradução anterior fica.
    expect(update.sql).not.toContain("`model`");
    expect(consultasCom("insert into")).toEqual([]);
  });

  it("a linha de outra versão é trocada inteira: montar recebe null", async () => {
    banco.traducaoTravada = ["resumo-1", 2, JSON.stringify({ itens: { velho: {} }, mapa: {} })];
    const montar = vi.fn(() => ({ itens: {}, mapa: {} }));
    await gravarTraducaoDoResumo(ALVO, montar, null);
    expect(montar).toHaveBeenCalledWith(null);
  });

  it("o refazer que falhou (H4d) aceita a gravação, como o pronto: é a versão que vale na tela", async () => {
    banco.resumoTravado = ["resumo-1", "failed", 3];
    const montar = vi.fn(() => ({ itens: {}, mapa: {} }));
    await expect(gravarTraducaoDoResumo(ALVO, montar, null)).resolves.toBe(true);
    expect(consultasCom("insert into `meeting_summary_translations`")).toHaveLength(1);
  });

  it("resumo refeito, reprocessado ou apagado no meio, ou reunião fora de 'ready': nada é escrito", async () => {
    const casos: Array<Partial<typeof banco>> = [
      { resumoTravado: ["resumo-1", "ready", 4] },
      { resumoTravado: ["resumo-2", "ready", 3] },
      { resumoTravado: ["resumo-1", "pending", 3] },
      { resumoTravado: null },
      { reuniaoTravada: ["processing"] },
      { reuniaoTravada: ["deleted"] },
      { reuniaoTravada: null },
    ];
    for (const caso of casos) {
      Object.assign(banco, { consultas: [], reuniaoTravada: ["ready"], resumoTravado: ["resumo-1", "ready", 3] }, caso);
      const montar = vi.fn();
      await expect(gravarTraducaoDoResumo(ALVO, montar, null), JSON.stringify(caso)).resolves.toBe(false);
      expect(montar).not.toHaveBeenCalled();
      expect(consultasCom("insert into").concat(consultasCom("update `"))).toEqual([]);
    }
  });
});
