import { describe, expect, it, beforeEach, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Contextos (etapa 5) — o que as listagens devolvem e o que o vínculo garante.
 *
 * O defeito que motivou estes testes passou despercebido por não ter teste
 * nenhum no módulo: listContexts buscava o slug do tipo no JOIN e o descartava
 * no retorno. A tela ficava sem os ícones e — pior — o formulário de edição
 * abria com o tipo vazio, então salvar qualquer edição apagava o tipo do
 * contexto em silêncio.
 *
 * Mesmo padrão dos testes do enriquecimento: drizzle de verdade sobre um
 * cliente mysql2 falso que captura o SQL. Como estas funções obtêm a conexão
 * por getDb(), o falso entra pelo mock de drizzle-orm/mysql2: a URL de banco
 * vira o cliente falso, e quem já passa um cliente segue intocado.
 */

const estado = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  respostas: [] as unknown[][],
}));

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      estado.consultas.push({ sql: config.sql, params });
      return [estado.respostas.shift() ?? [], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const { listContexts, listContextsByContact, linkContactToContext, getContextById, deleteContext } = await import("./db");

const sqlDe = (trecho: string) => estado.consultas.find(c => c.sql.includes(trecho));

// Linha de `contexts` na ordem das colunas do schema (13 colunas).
const linhaContexto = (id: string, nome: string, dono: string | null = "dona-1", tipoId: string | null = "tipo-1") =>
  [id, dono, tipoId, nome, null, "2024-10-01", "Milão", "Itália", null, 1, "private", 1000, 1000];

// Linha de `contact_contexts` na ordem das colunas do schema (12 colunas).
const linhaVinculo = (id: string, contatoId: number, contextoId: string) =>
  [id, "dona-1", contatoId, contextoId, null, "Milão", null, null, "profissional", "private", 1000, 1000];

describe("Contextos — listagens dizem tudo o que a tela precisa", () => {
  beforeEach(() => { estado.consultas = []; estado.respostas = []; });

  it("listContexts devolve o slug do tipo — é ele que dá o ícone e preenche a edição", async () => {
    estado.respostas = [
      [[...linhaContexto("ctx-1", "CPHI 2024"), "CPHI", "#6366F1", "cphi"]], // contextos + tipo
      [[3]], // contagem de contatos do ctx-1
      [[1]], // total
    ];
    const r = await listContexts("dona-1", {});

    expect(r.total).toBe(1);
    expect(r.data[0].name).toBe("CPHI 2024");
    expect(r.data[0].typeName).toBe("CPHI");
    expect(r.data[0].typeSlug).toBe("cphi"); // o campo que era descartado
    expect(r.data[0].contactCount).toBe(3);
  });

  it("listContextsByContact devolve os contextos de um contato, com nome e tipo", async () => {
    estado.respostas = [
      [[...linhaVinculo("vinc-1", 42, "ctx-1"), "CPHI 2024", "CPHI", "#6366F1", "cphi"]],
    ];
    const r = await listContextsByContact("dona-1", 42);

    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      linkId: "vinc-1", contextId: "ctx-1", name: "CPHI 2024",
      city: "Milão", relationshipType: "profissional", typeSlug: "cphi",
    });
    const busca = sqlDe("from `contact_contexts`");
    expect(busca).toBeDefined();
    // A cadeia inteira do WHERE, com `and` entre cada condição e a regra de
    // dona também no CONTEXTO (dela, ou do catálogo): um `or` no lugar de
    // qualquer `and` devolveria vínculos de outras donas, e `arrayContaining`
    // nos params passava com a regra, sem ela e com o `and` trocado —
    // mesmo padrão de smart-match-consent.test.ts.
    expect(busca!.sql).toContain(
      "`contact_contexts`.`owner_id` = ? and `contact_contexts`.`contact_id` = ? and (`contexts`.`owner_id` = ? or `contexts`.`owner_id` is null)",
    );
    expect(busca!.params).toEqual(["dona-1", 42, "dona-1"]);
  });

  it("getContextById traz o NOME de cada contato vinculado, não só o número", async () => {
    estado.respostas = [
      [[...linhaContexto("ctx-1", "CPHI 2024"), "CPHI", "#6366F1", "cphi", "flask-conical"]], // contexto + tipo
      [linhaVinculo("vinc-1", 42, "ctx-1")], // vínculos
      [[42, "Ana Souza"]],                   // nomes dos vinculados
      [],                                    // participantes
      [],                                    // mídia
    ];
    const r = await getContextById("dona-1", "ctx-1");

    expect(r).not.toBeNull();
    expect(r!.links[0].contactName).toBe("Ana Souza");
    expect(r!.links[0].contactId).toBe(42);
  });

  it("vincular o mesmo contato duas vezes devolve o vínculo existente, sem duplicar", async () => {
    estado.respostas = [[["vinc-1"]]]; // já existe
    const r = await linkContactToContext("dona-1", { contactId: 42, contextId: "ctx-1" });

    expect(r).toEqual({ id: "vinc-1", created: false });
    expect(estado.consultas.some(c => c.sql.startsWith("insert"))).toBe(false);
  });

  it("re-vincular com dados novos atualiza o encontro existente em vez de descartá-los", async () => {
    estado.respostas = [[["vinc-1"]], []]; // já existe; update
    const r = await linkContactToContext("dona-1", {
      contactId: 42, contextId: "ctx-1", notes: "sentamos na mesma mesa", city: "Lisboa",
    });

    expect(r).toEqual({ id: "vinc-1", created: false });
    const update = sqlDe("update `contact_contexts`");
    expect(update).toBeDefined();
    expect(update!.params).toEqual(expect.arrayContaining(["sentamos na mesma mesa", "Lisboa"]));
    expect(estado.consultas.some(c => c.sql.startsWith("insert"))).toBe(false);
  });

  it("vínculo novo é criado com dono, contato e contexto certos", async () => {
    estado.respostas = [[], []]; // não existe; insert
    const r = await linkContactToContext("dona-1", { contactId: 42, contextId: "ctx-1" });

    expect(r.id).not.toBe("vinc-1");
    expect(r.created).toBe(true);
    const insert = sqlDe("insert into `contact_contexts`");
    expect(insert).toBeDefined();
    expect(insert!.params).toEqual(expect.arrayContaining(["dona-1", 42, "ctx-1"]));
  });

  // ── Revisão da PR #29: o tipo do vínculo ────────────────────────────────
  // O db.ts só grava por cima o que veio PREENCHIDO. Com o
  // `.default("profissional")` que existia na entrada do router, "preenchido"
  // era sempre — e a escolha antiga da dona morria a cada re-vinculação.

  it("re-vincular SEM tipo preserva o tipo já gravado: relationship_type não entra no update", async () => {
    estado.respostas = [[["vinc-1"]], []]; // já existe; update
    const r = await linkContactToContext("dona-1", {
      contactId: 42, contextId: "ctx-1", notes: "reencontro",
    });

    expect(r).toEqual({ id: "vinc-1", created: false });
    const update = sqlDe("update `contact_contexts`");
    expect(update).toBeDefined();
    expect(update!.sql).not.toContain("relationship_type");
    expect(update!.params).not.toContain("profissional");
  });

  it("re-vincular COM tipo novo troca o tipo — a escolha explícita da dona vale", async () => {
    estado.respostas = [[["vinc-1"]], []]; // já existe; update
    const r = await linkContactToContext("dona-1", {
      contactId: 42, contextId: "ctx-1", relationshipType: "ambos",
    });

    expect(r).toEqual({ id: "vinc-1", created: false });
    const update = sqlDe("update `contact_contexts`");
    expect(update!.sql).toContain("relationship_type");
    expect(update!.params).toEqual(expect.arrayContaining(["ambos"]));
  });

  // ── Revisão da PR #122: apagar um campo ao editar o vínculo ──────────────
  // null (ou vazio) apaga; undefined mantém. Antes, `if (data.city)` pulava o
  // null e, sem nenhum outro campo, nenhum UPDATE rodava — e a tela dizia
  // "atualizado".

  it("re-vincular com cidade e notas em null gera UPDATE que as apaga, sem tocar em data e país", async () => {
    estado.respostas = [[["vinc-1"]], []]; // já existe; update
    const r = await linkContactToContext("dona-1", {
      contactId: 42, contextId: "ctx-1", city: null, notes: "",
    });

    expect(r).toEqual({ id: "vinc-1", created: false });
    const update = sqlDe("update `contact_contexts`");
    expect(update).toBeDefined();
    expect(update!.sql).toContain("`city` = ?");
    expect(update!.sql).toContain("`notes` = ?");
    expect(update!.sql).not.toContain("`event_date`");
    expect(update!.sql).not.toContain("`country`");
    expect(update!.sql).not.toContain("relationship_type");
    // cidade e notas vão como null (o vazio também vira null), antes do updated_at
    expect(update!.params.slice(0, 2)).toEqual([null, null]);
  });

  it("re-vincular sem NENHUM dado novo não dispara update algum", async () => {
    estado.respostas = [[["vinc-1"]]]; // já existe, e nada a atualizar
    const r = await linkContactToContext("dona-1", { contactId: 42, contextId: "ctx-1" });

    expect(r).toEqual({ id: "vinc-1", created: false });
    expect(sqlDe("update `contact_contexts`")).toBeUndefined();
  });

  it("vínculo NOVO sem tipo nasce 'profissional' — o default vive só na criação", async () => {
    estado.respostas = [[], []]; // não existe; insert
    const r = await linkContactToContext("dona-1", { contactId: 42, contextId: "ctx-1" });

    expect(r.created).toBe(true);
    const insert = sqlDe("insert into `contact_contexts`");
    expect(insert!.params).toEqual(expect.arrayContaining(["profissional"]));
  });

  it("vínculo NOVO com tipo informado nasce com o tipo da dona, não com o default", async () => {
    estado.respostas = [[], []]; // não existe; insert
    await linkContactToContext("dona-1", {
      contactId: 42, contextId: "ctx-1", relationshipType: "pessoal",
    });

    const insert = sqlDe("insert into `contact_contexts`");
    expect(insert!.params).toEqual(expect.arrayContaining(["pessoal"]));
    expect(insert!.params).not.toContain("profissional");
  });
});

describe("deleteContext — a posse decide antes de qualquer outra escrita (reverificação de 04/09, etapa 5)", () => {
  // Antes, o DELETE em context_media vinha primeiro: num contexto do catálogo
  // (owner_id NULL, que contextIsVisible e uploadMedia aceitam) as linhas de
  // anexo da dona sumiam e só depois o DELETE em contexts afetava 0 linhas —
  // NOT_FOUND com os anexos já perdidos.
  beforeEach(() => { estado.consultas = []; estado.respostas = []; });

  // Desde a H7c tudo vai numa transação: o cliente falso vê o begin e o commit
  // (cada um consome uma resposta da fila), e o que fica entre os dois.
  const semTransacao = () => estado.consultas.filter(c => c.sql !== "begin" && c.sql !== "commit" && c.sql !== "rollback");

  it("contexto que não é dela (catálogo): o PRIMEIRO SQL é o delete em contexts com id, dona e is_custom; 0 linhas → false e context_media intocada", async () => {
    estado.respostas = [[], { affectedRows: 0 }, []];
    const ok = await deleteContext("dona-1", "ctx-catalogo");

    expect(ok).toBe(false);
    expect(estado.consultas.map(c => c.sql)[0]).toBe("begin");
    expect(semTransacao()).toHaveLength(1);
    expect(semTransacao()[0].sql).toBe(
      "delete from `contexts` where (`contexts`.`id` = ? and `contexts`.`owner_id` = ? and `contexts`.`is_custom` = ?)",
    );
    expect(semTransacao()[0].params).toEqual(["ctx-catalogo", "dona-1", true]);
    expect(estado.consultas.some(c => c.sql.startsWith("delete from `context_media`"))).toBe(false);
    expect(estado.consultas.some(c => c.sql.startsWith("update `meetings`"))).toBe(false);
  });

  it("contexto dela: apaga o contexto e SÓ ENTÃO os registros de anexo e o ponteiro das reuniões dela, tudo com a dona no WHERE e numa transação", async () => {
    estado.respostas = [[], { affectedRows: 1 }, { affectedRows: 2 }, { affectedRows: 3 }, []];
    const ok = await deleteContext("dona-1", "ctx-1");

    expect(ok).toBe(true);
    expect(estado.consultas.map(c => c.sql)[0]).toBe("begin");
    expect(estado.consultas.map(c => c.sql).at(-1)).toBe("commit");
    const escritas = semTransacao();
    expect(escritas).toHaveLength(3);
    expect(escritas[0].sql).toMatch(/^delete from `contexts` /);
    expect(escritas[1].sql).toBe(
      "delete from `context_media` where (`context_media`.`context_id` = ? and `context_media`.`owner_id` = ?)",
    );
    expect(escritas[1].params).toEqual(["ctx-1", "dona-1"]);
    // H7c: a reunião da dona fica, sem o contexto excluído (e o updated_at,
    // que é a ficha de quem a processa, não muda).
    expect(escritas[2].sql).toBe(
      "update `meetings` set `context_id` = ? where (`meetings`.`owner_id` = ? and `meetings`.`context_id` = ?)",
    );
    expect(escritas[2].params).toEqual([null, "dona-1", "ctx-1"]);
  });
});
