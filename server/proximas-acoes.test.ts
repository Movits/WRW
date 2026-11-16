import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, mapUpdateSet, type SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As próximas ações (H5a) com o banco dublado: o que cada função lê e escreve,
 * com a dona no WHERE. O dublê guarda cada operação com o WHERE renderizado
 * pelo dialeto do MySQL, a lista de colunas lidas, se a leitura travou a linha
 * (FOR UPDATE) e o LIMIT, que ele aplica às linhas que devolve. O que só o banco
 * prova (o índice único, a transação, a espera nas travas) está em
 * proximas-acoes.integracao.test.ts; a ordem das travas da decisão no resumo,
 * em resumo-guardado.test.ts.
 */

const dialeto = new MySqlDialect();
type Predicado = { sql: string; params: unknown[] };
const renderizar = (condicao?: SQL): Predicado => (condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] });

type Operacao = Predicado & {
  tipo: "select" | "update" | "insert" | "delete";
  tabela: unknown;
  campos?: string[];
  travada?: boolean;
  limite?: number;
  valores?: Record<string, unknown>;
  linhas?: Record<string, unknown>[];
  noDuplicado?: Predicado;
};

const estado = {
  operacoes: [] as Operacao[],
  /** As linhas de cada leitura; o padrão é pela tabela, com as colunas projetadas. */
  ler: null as ((operacao: Operacao) => Record<string, unknown>[] | undefined) | null,
  tabelas: new Map<unknown, Record<string, unknown>[]>(),
  afetadas: 1,
  transacoes: 0,
};

const schema = await import("../drizzle/schema");

const projetar = (tabela: unknown, projecao: Record<string, unknown> | undefined, linhas: Record<string, unknown>[]) => {
  if (!projecao) return linhas;
  const chavePorColuna = new Map<unknown, string>(
    Object.entries(getTableColumns(tabela as MySqlTable)).map(([chave, coluna]) => [coluna, chave]),
  );
  return linhas.map(linha => Object.fromEntries(
    Object.entries(projecao).map(([nome, coluna]) => [nome, linha[chavePorColuna.get(coluna) ?? nome]]),
  ));
};

function selecionar(projecao?: Record<string, unknown>) {
  return {
    from: (tabela: unknown) => {
      const operacao: Operacao = { tipo: "select", tabela, sql: "", params: [], campos: projecao ? Object.keys(projecao) : undefined };
      estado.operacoes.push(operacao);
      const linhas = () => {
        const todas = estado.ler?.(operacao) ?? projetar(tabela, projecao, estado.tabelas.get(tabela) ?? []);
        return operacao.limite === undefined ? todas : todas.slice(0, operacao.limite);
      };
      const cadeia: Record<string, unknown> = {};
      Object.assign(cadeia, {
        innerJoin: () => cadeia,
        leftJoin: () => cadeia,
        where: (condicao?: SQL) => { Object.assign(operacao, renderizar(condicao)); return cadeia; },
        orderBy: () => cadeia,
        limit: (limite: number) => { operacao.limite = limite; return cadeia; },
        for: (modo: string) => { operacao.travada = modo === "update"; return cadeia; },
        then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) => Promise.resolve(linhas()).then(ok, falha),
      });
      return cadeia;
    },
  };
}

const fakeDb = {
  select: selecionar,
  selectDistinct: selecionar,
  insert: (tabela: unknown) => ({
    values: (valores: Record<string, unknown> | Record<string, unknown>[]) => {
      const operacao: Operacao = { tipo: "insert", tabela, sql: "", params: [], linhas: Array.isArray(valores) ? valores : [valores] };
      const gravar = async () => { estado.operacoes.push(operacao); };
      return {
        then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) => gravar().then(ok, falha),
        onDuplicateKeyUpdate: ({ set }: { set: Record<string, unknown> }) => {
          operacao.noDuplicado = renderizar(dialeto.buildUpdateSet(tabela as MySqlTable, mapUpdateSet(tabela as MySqlTable, set)));
          return gravar();
        },
      };
    },
  }),
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: async (condicao?: SQL) => {
        estado.operacoes.push({ tipo: "update", tabela, valores, ...renderizar(condicao) });
        return [{ affectedRows: estado.afetadas }];
      },
    }),
  }),
  delete: (tabela: unknown) => ({
    where: async (condicao?: SQL) => {
      estado.operacoes.push({ tipo: "delete", tabela, ...renderizar(condicao) });
      return [{ affectedRows: 1 }];
    },
  }),
  transaction: async <T>(trabalho: (tx: typeof fakeDb) => Promise<T>) => { estado.transacoes += 1; return trabalho(fakeDb); },
};
vi.mock("./db", () => ({ getDb: async () => fakeDb, exigirDb: async () => fakeDb }));
// O lembrete no sino (H15) é dublê: aqui se prova que as escritas da ação o
// chamam, na transação delas. A regra das horas está em server/lembretes.test.ts.
const lembretes = vi.hoisted(() => ({
  agendarLembreteDaAcao: vi.fn(async (..._args: unknown[]) => {}),
  esquecerLembrete: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("./lembretes", () => lembretes);

const servico = await import("./proximas-acoes");
const { MENSAGEM_ACAO_NAO_ENCONTRADA, MENSAGEM_CONTATO_FORA_DA_REDE } = await import("@shared/proximas-acoes");

const DONA = "dona-1";
const de = (tipo: Operacao["tipo"], tabela?: unknown) => estado.operacoes.filter(o => o.tipo === tipo && (tabela === undefined || o.tabela === tabela));
const db = fakeDb as unknown as Parameters<typeof servico.soltarAcoesDaReuniao>[0];

beforeEach(() => {
  estado.operacoes = [];
  estado.ler = null;
  estado.tabelas = new Map();
  estado.afetadas = 1;
  estado.transacoes = 0;
  lembretes.agendarLembreteDaAcao.mockClear();
  lembretes.esquecerLembrete.mockClear();
});

describe("do item do resumo à ação", () => {
  const ITEM = {
    id: "item-1", meetingId: "reuniao-1", section: "action", subject: null, text: "{F2} envia a proposta revisada",
    assignee: "{F2}", due: "até sexta-feira", excerpt: "eu mando a proposta até sexta", status: "confirmed", done: false, doneAt: null,
  };

  it("a ação confirmada vira próxima ação, com o texto, o responsável, o prazo dito e o trecho; os rótulos de voz ficam", async () => {
    estado.tabelas.set(schema.meetingSummaryItems, [ITEM]);
    expect(await servico.criarDoItem(db, DONA, "item-1", 1_000)).toBe(true);
    const [insercao] = de("insert", schema.proximasAcoes);
    expect(insercao.linhas).toEqual([expect.objectContaining({
      ownerId: DONA, origem: "reuniao", meetingId: "reuniao-1", itemId: "item-1",
      texto: "{F2} envia a proposta revisada", detalhe: null, responsavel: "{F2}", prazoDito: "até sexta-feira",
      trecho: "eu mando a proposta até sexta", feita: false, feitaEm: null, createdAt: 1_000, updatedAt: 1_000,
    })]);
    // Idempotente pelo índice único: o conflito não muda nada na ação que já existe.
    expect(insercao.noDuplicado?.sql).toBe("`item_id` = `proximas_acoes`.`item_id`");
    // A leitura do item é da dona.
    expect(de("select", schema.meetingSummaryItems)[0]).toMatchObject({
      sql: "(`meeting_summary_items`.`id` = ? and `meeting_summary_items`.`owner_id` = ?)", params: ["item-1", DONA],
    });
  });

  it("a tarefa tem assunto: ele vira o texto, e o parágrafo, o detalhe; feita no resumo nasce feita", async () => {
    estado.tabelas.set(schema.meetingSummaryItems, [{ ...ITEM, section: "task", subject: "Contrato com o importador", text: "{F1} fecha o contrato.", done: true, doneAt: 500 }]);
    await servico.criarDoItem(db, DONA, "item-1", 1_000);
    expect(de("insert", schema.proximasAcoes)[0].linhas?.[0]).toMatchObject({
      texto: "Contrato com o importador", detalhe: "{F1} fecha o contrato.", feita: true, feitaEm: 500,
    });
  });

  it.each([
    ["pendente", { status: "pending" }],
    ["ignorado", { status: "ignored" }],
    ["decisão", { section: "decision" }],
    ["foco", { section: "focus" }],
  ])("item %s não vira ação", async (_nome, diferenca) => {
    estado.tabelas.set(schema.meetingSummaryItems, [{ ...ITEM, ...diferenca }]);
    expect(await servico.criarDoItem(db, DONA, "item-1")).toBe(false);
    expect(de("insert")).toEqual([]);
  });

  it("item de outra dona (ou que não existe): nada", async () => {
    expect(await servico.criarDoItem(db, DONA, "item-1")).toBe(false);
    expect(de("insert")).toEqual([]);
  });

  it("garantirAcoesDosItensConfirmados cria as que faltam, de uma vez, e só lê confirmadas sem ação da reunião da dona", async () => {
    estado.tabelas.set(schema.meetingSummaryItems, [ITEM, { ...ITEM, id: "item-2", section: "task", subject: "Logística" }]);
    expect(await servico.garantirAcoesDosItensConfirmados(db, DONA, "reuniao-1", 2_000)).toBe(2);
    expect(de("insert", schema.proximasAcoes)[0].linhas?.map(l => l.itemId)).toEqual(["item-1", "item-2"]);
    const leitura = de("select", schema.meetingSummaryItems)[0];
    expect(leitura.sql).toBe(
      "(`meeting_summary_items`.`owner_id` = ? and `meeting_summary_items`.`meeting_id` = ? and `meeting_summary_items`.`section` in (?, ?)"
      + " and `meeting_summary_items`.`status` = ? and `proximas_acoes`.`id` is null)",
    );
    expect(leitura.params).toEqual([DONA, "reuniao-1", "action", "task", "confirmed"]);
  });

  it("garantirAcoesDosItensConfirmados sem nada faltando não escreve", async () => {
    expect(await servico.garantirAcoesDosItensConfirmados(db, DONA, "reuniao-1")).toBe(0);
    expect(de("insert")).toEqual([]);
  });

  it("garantirAcoesDaDona visita cada reunião numa transação própria, com a reunião travada, e pula a que não está pronta", async () => {
    estado.ler = operacao => {
      if (operacao.tabela === schema.meetingSummaryItems && operacao.campos?.length === 1) return [{ meetingId: "reuniao-1" }, { meetingId: "reuniao-2" }];
      if (operacao.tabela === schema.meetings) return [{ status: operacao.params[0] === "reuniao-1" ? "ready" : "deleted" }];
      if (operacao.tabela === schema.meetingSummaryItems) return [ITEM];
      return [];
    };
    expect(await servico.garantirAcoesDaDona(DONA)).toBe(1);
    expect(estado.transacoes).toBe(2);
    const travas = de("select", schema.meetings);
    expect(travas.map(o => [o.travada, o.params])).toEqual([[true, ["reuniao-1", DONA]], [true, ["reuniao-2", DONA]]]);
    expect(de("insert", schema.proximasAcoes)).toHaveLength(1);
  });

  it("garantirAcoesDaDona sem reunião a completar não abre transação", async () => {
    expect(await servico.garantirAcoesDaDona(DONA)).toBe(0);
    expect(estado.transacoes).toBe(0);
  });
});

describe("feita: uma escrita só, para a ação e o item", () => {
  it("pelo item (a caixa do resumo): o item e a ação dele", async () => {
    await servico.escreverFeita(db, DONA, { itemId: "item-1" }, true, 3_000);
    const [item, acao] = de("update");
    expect(item).toMatchObject({ tabela: schema.meetingSummaryItems, valores: { done: true, doneAt: 3_000, updatedAt: 3_000 } });
    expect(item.params).toEqual(["item-1", DONA]);
    expect(acao).toMatchObject({ tabela: schema.proximasAcoes, valores: { feita: true, feitaEm: 3_000, updatedAt: 3_000 } });
    expect(acao.sql).toBe("(`proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`item_id` = ?)");
    expect(acao.params).toEqual([DONA, "item-1"]);
  });

  it("pela ação (a lista): a ação e o item dela; desmarcar zera as datas", async () => {
    await servico.escreverFeita(db, DONA, { acaoId: "acao-1", itemId: "item-1" }, false, 3_000);
    const [item, acao] = de("update");
    expect(item).toMatchObject({ tabela: schema.meetingSummaryItems, valores: { done: false, doneAt: null } });
    expect(acao).toMatchObject({ tabela: schema.proximasAcoes, valores: { feita: false, feitaEm: null } });
    expect(acao.params).toEqual([DONA, "acao-1"]);
  });

  it("a manual (ou solta) não tem item: só a ação", async () => {
    await servico.escreverFeita(db, DONA, { acaoId: "acao-1", itemId: null }, true, 3_000);
    expect(de("update").map(o => o.tabela)).toEqual([schema.proximasAcoes]);
  });
});

describe("a reunião que sai: as ações se soltam", () => {
  const ACOES = [
    { id: "acao-1", texto: "{F2} envia a proposta", detalhe: null, responsavel: "{F2}", itemId: "item-1" },
    { id: "acao-2", texto: "Ligar para {F3}", detalhe: "Com {F1}, nome com $& e $1", responsavel: null, itemId: "item-2" },
    { id: "acao-3", texto: "Solta antes, no reprocesso", detalhe: null, responsavel: "Carla", itemId: null },
  ];
  beforeEach(() => {
    estado.tabelas.set(schema.proximasAcoes, ACOES);
    estado.tabelas.set(schema.meetings, [{ speakerNames: { F1: "Ana $&", F2: "Carla", F9: "" } }]);
  });

  it("exclusão: os nomes das vozes viram texto (a voz sem nome fica rótulo), e item, reunião e trecho saem", async () => {
    expect(await servico.soltarAcoesDaReuniao(db, DONA, "reuniao-1", true, 4_000)).toBe(3);
    const atualizacoes = de("update", schema.proximasAcoes);
    expect(atualizacoes.map(o => o.valores)).toEqual([
      { texto: "Carla envia a proposta", detalhe: null, responsavel: "Carla", itemId: null, meetingId: null, trecho: null, updatedAt: 4_000 },
      { texto: "Ligar para {F3}", detalhe: "Com Ana $&, nome com $& e $1", responsavel: null, itemId: null, meetingId: null, trecho: null, updatedAt: 4_000 },
      // Já tinha os nomes no texto: só perde a reunião e o trecho.
      { itemId: null, meetingId: null, trecho: null, updatedAt: 4_000 },
    ]);
    for (const [i, operacao] of atualizacoes.entries()) {
      expect(operacao.sql).toBe("(`proximas_acoes`.`id` = ? and `proximas_acoes`.`owner_id` = ?)");
      expect(operacao.params).toEqual([ACOES[i].id, DONA]);
    }
    expect(de("select", schema.proximasAcoes)[0]).toMatchObject({
      sql: "(`proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`meeting_id` = ?)", params: [DONA, "reuniao-1"],
    });
    expect(de("select", schema.meetings)[0].params).toEqual(["reuniao-1", DONA]);
    expect(de("delete")).toEqual([]);
  });

  it("reprocesso: as presas ao item se soltam com os nomes, e a reunião e o trecho ficam; a já solta não é tocada", async () => {
    expect(await servico.soltarAcoesDaReuniao(db, DONA, "reuniao-1", false, 4_000)).toBe(2);
    const valores = de("update", schema.proximasAcoes).map(o => o.valores);
    expect(valores).toEqual([
      { texto: "Carla envia a proposta", detalhe: null, responsavel: "Carla", itemId: null, updatedAt: 4_000 },
      { texto: "Ligar para {F3}", detalhe: "Com Ana $&, nome com $& e $1", responsavel: null, itemId: null, updatedAt: 4_000 },
    ]);
  });

  it("o responsável com o nome longo cabe na coluna", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ ...ACOES[0], responsavel: "{F2} e {F1}" }]);
    estado.tabelas.set(schema.meetings, [{ speakerNames: { F1: "A".repeat(60), F2: "B".repeat(60) } }]);
    await servico.soltarAcoesDaReuniao(db, DONA, "reuniao-1", true);
    expect(String(de("update", schema.proximasAcoes)[0].valores?.responsavel)).toHaveLength(120);
  });

  it("sem ação presa ao item, nem lê a reunião; sem ação nenhuma, só a leitura das ações", async () => {
    estado.tabelas.set(schema.proximasAcoes, [ACOES[2]]);
    expect(await servico.soltarAcoesDaReuniao(db, DONA, "reuniao-1", false)).toBe(0);
    expect(de("select", schema.meetings)).toEqual([]);
    expect(de("update")).toEqual([]);
    estado.tabelas.set(schema.proximasAcoes, []);
    estado.operacoes = [];
    expect(await servico.soltarAcoesDaReuniao(db, DONA, "reuniao-1", true)).toBe(0);
    expect(estado.operacoes.map(o => [o.tipo, o.tabela])).toEqual([["select", schema.proximasAcoes]]);
  });

  it("meeting-service solta as ações ANTES de apagar os itens: true na exclusão, false no reprocesso", () => {
    const fonte = readFileSync(join(__dirname, "meeting-service.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("async function apagarDerivadosSemGravacao"));
    expect(corpo.indexOf("await soltarAcoesDaReuniao(db, ownerId, meetingId, reuniaoSai);")).toBeGreaterThan(-1);
    expect(corpo.indexOf("soltarAcoesDaReuniao")).toBeLessThan(corpo.indexOf("delete(meetingSummaryItems)"));
    expect(corpo.indexOf("soltarAcoesDaReuniao")).toBeLessThan(corpo.indexOf("delete(meetingContactSuggestions)"));
    const exclusao = fonte.slice(fonte.indexOf("async function apagarDerivadosDaReuniao"), fonte.indexOf("async function apagarDerivadosSemGravacao"));
    expect(exclusao).toContain("apagarDerivadosSemGravacao(db, ownerId, meetingId, true)");
    expect(fonte).toContain("if (execucao.limparAntes) await apagarDerivadosSemGravacao(db, ownerId, meetingId, false);");
  });

  it("a fila do resumo, ao trocar os itens, solta antes as ações presas a eles, na transação dela, com a reunião já travada", () => {
    const fonte = readFileSync(join(__dirname, "fila-do-resumo.ts"), "utf8");
    const corpo = fonte.slice(fonte.indexOf("async function gravarResumo"), fonte.indexOf("export async function rodarUmaVez"));
    const soltar = corpo.indexOf("await soltarAcoesDaReuniao(tx, alvo.ownerId, alvo.meetingId, false, agora);");
    expect(soltar).toBeGreaterThan(corpo.indexOf(".from(meetings)"));
    expect(soltar).toBeLessThan(corpo.indexOf("tx.delete(meetingSummaryItems)"));
  });
});

describe("a lista: o que vai à tela", () => {
  const LINHA = {
    id: "acao-1", texto: "{F2} envia a proposta", detalhe: null, responsavel: "{F2}", prazo: "2026-11-20", prazoDito: "até sexta",
    origem: "reuniao", feita: false, feitaEm: null, trecho: "eu mando a proposta", google: "ok", createdAt: 1, updatedAt: 2, meetingId: "reuniao-1", contactId: null,
    tituloDaReuniao: "Reunião com a Carla", vozesDaReuniao: { F2: "Carla", bad: "x" }, itemVivo: "item-1", nomeDoContato: null,
  };
  const lerLista = (linhas: Record<string, unknown>[], contatos: Record<string, unknown>[] = [], abertas = 4) => {
    estado.ler = operacao => {
      if (operacao.tabela === schema.meetingSummaryItems) return [];
      if (operacao.tabela === schema.privateContacts) return contatos;
      if (operacao.tabela === schema.proximasAcoes) return operacao.campos?.includes("abertas") ? [{ abertas }] : linhas;
      return [];
    };
  };

  it("presa ao item: a reunião com o link do item e os nomes das vozes; o responsável sugere o contato da rede", async () => {
    lerLista([LINHA], [{ id: 7, fullName: "Carla Souza" }, { id: 8, fullName: "Bia Lima" }]);
    const { acoes, abertas, limite } = await servico.listarProximasAcoes(DONA, "abertas");
    expect(abertas).toBe(4);
    expect(limite).toBe(servico.LIMITE_DA_LISTA);
    expect(acoes).toEqual([{
      id: "acao-1", texto: "{F2} envia a proposta", detalhe: null, responsavel: "{F2}", prazo: "2026-11-20", prazoDito: "até sexta",
      origem: "reuniao", feita: false, feitaEm: null, trecho: "eu mando a proposta", google: "ok", createdAt: 1, updatedAt: 2,
      reuniao: { id: "reuniao-1", titulo: "Reunião com a Carla", itemId: "item-1" },
      vozes: { F2: "Carla" }, contato: null, contatoSugerido: { id: 7, nome: "Carla Souza" },
    }]);
    // As abertas, da dona.
    const leitura = de("select", schema.proximasAcoes)[0];
    expect(leitura.sql).toBe("(`proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`feita` = ?)");
    expect(leitura.params).toEqual([DONA, false]);
    expect(de("select", schema.privateContacts)[0].params).toEqual([DONA]);
  });

  it("todas: sem o filtro de feita; solta ou de reunião excluída, sem nomes nem link do item; o contato só se é da dona", async () => {
    lerLista([
      { ...LINHA, id: "excluida", meetingId: "reuniao-2", tituloDaReuniao: null, vozesDaReuniao: null, itemVivo: null, trecho: null },
      { ...LINHA, id: "reprocessada", itemVivo: null },
      { ...LINHA, id: "com-contato", contactId: 5, nomeDoContato: "Bia Lima", feita: true },
      { ...LINHA, id: "contato-sumiu", contactId: 6, nomeDoContato: null, responsavel: null },
    ]);
    const { acoes } = await servico.listarProximasAcoes(DONA, "todas");
    expect(de("select", schema.proximasAcoes)[0]).toMatchObject({ sql: "`proximas_acoes`.`owner_id` = ?", params: [DONA] });
    const porId = Object.fromEntries(acoes.map(acao => [acao.id, acao]));
    expect(porId.excluida).toMatchObject({ reuniao: null, vozes: {} });
    expect(porId.reprocessada).toMatchObject({ reuniao: { id: "reuniao-1", titulo: "Reunião com a Carla", itemId: null }, vozes: {} });
    expect(porId["com-contato"].contato).toEqual({ id: 5, nome: "Bia Lima" });
    expect(porId["contato-sumiu"].contato).toBeNull();
  });

  it("sem candidata a sugestão (voz sem nome, feita, já com contato), nem lê a rede", async () => {
    lerLista([
      { ...LINHA, vozesDaReuniao: {} },
      { ...LINHA, id: "feita", feita: true },
      { ...LINHA, id: "com-contato", contactId: 5, nomeDoContato: "Bia Lima" },
    ]);
    const { acoes } = await servico.listarProximasAcoes(DONA, "todas");
    expect(acoes.every(acao => acao.contatoSugerido === null)).toBe(true);
    expect(de("select", schema.privateContacts)).toEqual([]);
  });

  it("a rede é indexada uma vez por leitura: cada nome dela é lido uma vez, por mais ações que perguntem", async () => {
    let leiturasDoNome = 0;
    const contato = (id: number, nome: string) => ({ id, get fullName() { leiturasDoNome += 1; return nome; } });
    const rede = [contato(7, "Carla Souza"), contato(8, "Bia Lima"), ...Array.from({ length: 48 }, (_, i) => contato(100 + i, `Pessoa ${i}`))];
    lerLista([
      { ...LINHA, id: "a-1", responsavel: "Carla" },
      { ...LINHA, id: "a-2", responsavel: "Bia" },
      { ...LINHA, id: "a-3", responsavel: "Mariana" },
    ], rede);
    const { acoes } = await servico.listarProximasAcoes(DONA, "abertas");
    expect(acoes.map(acao => acao.contatoSugerido?.id ?? null)).toEqual([7, 8, null]);
    // Uma leitura por contato no índice, e mais uma por sugestão (o nome que vai à tela).
    expect(leiturasDoNome).toBe(rede.length + 2);
  });

  it("rede maior que o teto: nenhuma sugestão, porque a homônima de fora da leitura faria apontar a pessoa errada", async () => {
    const enchimento = Array.from({ length: servico.CONTATOS_PARA_SUGERIR }, (_, i) => ({ id: 1_000 + i, fullName: `Pessoa ${i}` }));
    const carla = { id: 7, fullName: "Carla Souza" };
    const sugestaoDaCarla = async () => (await servico.listarProximasAcoes(DONA, "abertas")).acoes[0].contatoSugerido;
    // A Carla Lima, outra Carla, fica depois do teto da leitura.
    lerLista([{ ...LINHA, responsavel: "Carla" }], [carla, ...enchimento, { id: 8, fullName: "Carla Lima" }]);
    expect(await sugestaoDaCarla()).toBeNull();
    // Uma Carla só no que se leu não basta: a rede passou do teto, e outra pode vir depois.
    lerLista([{ ...LINHA, responsavel: "Carla" }], [carla, ...enchimento]);
    expect(await sugestaoDaCarla()).toBeNull();
    // No teto, a rede foi lida inteira: a sugestão vale.
    lerLista([{ ...LINHA, responsavel: "Carla" }], [carla, ...enchimento.slice(1)]);
    expect(await sugestaoDaCarla()).toEqual({ id: 7, nome: "Carla Souza" });
  });

  it("o cartão do Dashboard: as abertas, sem a sugestão de contato", async () => {
    lerLista([LINHA], [{ id: 7, fullName: "Carla Souza" }], 9);
    const painel = await servico.proximasAcoesDoPainel(DONA);
    expect(painel.abertas).toBe(9);
    expect(painel.acoes).toHaveLength(1);
    expect(painel.acoes[0]).not.toHaveProperty("contatoSugerido");
    expect(de("select", schema.privateContacts)).toEqual([]);
  });

  it("o perfil do contato (H5b): as ações da dona ligadas a ele, abertas e feitas, só lendo", async () => {
    lerLista([
      { ...LINHA, contactId: 5, nomeDoContato: "Carla Souza" },
      { ...LINHA, id: "feita", contactId: 5, nomeDoContato: "Carla Souza", feita: true, feitaEm: 9 },
    ]);
    const acoes = await servico.proximasAcoesDoContato(DONA, 5);
    // A dona e o contato no WHERE, sem o filtro de feita; o teto do perfil.
    const leitura = de("select", schema.proximasAcoes)[0];
    expect(leitura.sql).toBe("(`proximas_acoes`.`owner_id` = ? and `proximas_acoes`.`contact_id` = ?)");
    expect(leitura.params).toEqual([DONA, 5]);
    expect(leitura.limite).toBe(servico.ACOES_NO_PERFIL_DO_CONTATO);
    // O que a tela recebe é o mesmo da lista: o link do item, os nomes das vozes e o contato.
    expect(acoes.map(acao => [acao.id, acao.feita])).toEqual([["acao-1", false], ["feita", true]]);
    expect(acoes[0]).toMatchObject({
      reuniao: { id: "reuniao-1", titulo: "Reunião com a Carla", itemId: "item-1" }, vozes: { F2: "Carla" }, contato: { id: 5, nome: "Carla Souza" },
    });
    expect(acoes[0]).not.toHaveProperty("contatoSugerido");
    // Só lê: nem o backfill dos itens confirmados (a ação do item nasce sem
    // contato), nem a rede para sugerir, nem escrita ou transação.
    expect(estado.operacoes.map(o => [o.tipo, o.tabela])).toEqual([["select", schema.proximasAcoes]]);
    expect(estado.transacoes).toBe(0);
  });
});

describe("o que a dona faz na lista", () => {
  const erro = (mensagem: string) => expect.objectContaining({ code: "NOT_FOUND", message: mensagem });

  it("ligar contato confere a posse: contato de outra rede não liga nada", async () => {
    await expect(servico.ligarContato(DONA, "acao-1", 42)).rejects.toEqual(erro(MENSAGEM_CONTATO_FORA_DA_REDE));
    expect(de("select", schema.privateContacts)[0]).toMatchObject({
      sql: "(`private_contacts`.`id` = ? and `private_contacts`.`ownerId` = ?)", params: [42, DONA],
    });
    expect(de("update")).toEqual([]);
  });

  it("ligar contato da dona grava o ponteiro na ação da dona; tirar (null) nem lê a rede", async () => {
    estado.tabelas.set(schema.privateContacts, [{ id: 42 }]);
    await servico.ligarContato(DONA, "acao-1", 42);
    const [ligou] = de("update", schema.proximasAcoes);
    expect(ligou.valores).toMatchObject({ contactId: 42 });
    expect(ligou.params).toEqual(["acao-1", DONA]);
    estado.operacoes = [];
    await servico.ligarContato(DONA, "acao-1", null);
    expect(de("select")).toEqual([]);
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ contactId: null });
  });

  it("ação que não é da dona: NOT_FOUND com a frase que a tela traduz", async () => {
    estado.afetadas = 0;
    await expect(servico.ligarContato(DONA, "acao-1", null)).rejects.toEqual(erro(MENSAGEM_ACAO_NAO_ENCONTRADA));
    await expect(servico.editarProximaAcao(DONA, "acao-1", { texto: "x" })).rejects.toEqual(erro(MENSAGEM_ACAO_NAO_ENCONTRADA));
    await expect(servico.apagarProximaAcao(DONA, "acao-1")).rejects.toEqual(erro(MENSAGEM_ACAO_NAO_ENCONTRADA));
    await expect(servico.marcarProximaAcaoFeita(DONA, "acao-1", true)).rejects.toEqual(erro(MENSAGEM_ACAO_NAO_ENCONTRADA));
  });

  it("apagar a ação presa ao item trava a reunião, devolve o item a 'para conferir' e apaga a ação, numa transação", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ id: "acao-1", itemId: "item-1", meetingId: "reuniao-1" }]);
    await servico.apagarProximaAcao(DONA, "acao-1");
    expect(estado.transacoes).toBe(1);
    expect(de("select", schema.meetings)[0]).toMatchObject({ travada: true, params: ["reuniao-1", DONA] });
    const [item] = de("update", schema.meetingSummaryItems);
    expect(item.valores).toMatchObject({ status: "pending", decidedAt: null, done: false, doneAt: null });
    // Só o item ainda confirmado, da dona.
    expect(item.sql).toBe("(`meeting_summary_items`.`id` = ? and `meeting_summary_items`.`owner_id` = ? and `meeting_summary_items`.`status` = ?)");
    expect(item.params).toEqual(["item-1", DONA, "confirmed"]);
    expect(de("delete", schema.proximasAcoes)[0].params).toEqual(["acao-1", DONA]);
  });

  it("apagar a manual: só a ação, sem trava nem item", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ id: "acao-1", itemId: null, meetingId: null }]);
    await servico.apagarProximaAcao(DONA, "acao-1");
    expect(de("select", schema.meetings)).toEqual([]);
    expect(de("update")).toEqual([]);
    expect(de("delete", schema.proximasAcoes)).toHaveLength(1);
  });

  it("marcar feita na lista marca o item junto (escreverFeita)", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ id: "acao-1", itemId: "item-1", meetingId: "reuniao-1" }]);
    await servico.marcarProximaAcaoFeita(DONA, "acao-1", true);
    expect(de("update").map(o => o.tabela)).toEqual([schema.meetingSummaryItems, schema.proximasAcoes]);
    expect(de("select", schema.meetings)[0].travada).toBe(true);
  });

  it("anotar à mão: origem manual, sem item nem reunião; contato de outra rede é recusado antes de gravar", async () => {
    const { id } = await servico.criarProximaAcao(DONA, { texto: "Mandar o contrato", prazo: "2026-12-01", detalhe: null, responsavel: "Bia" });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(de("insert", schema.proximasAcoes)[0].linhas?.[0]).toMatchObject({
      id, ownerId: DONA, origem: "manual", texto: "Mandar o contrato", detalhe: null, responsavel: "Bia",
      prazo: "2026-12-01", contactId: null, feita: false,
    });
    expect(de("insert", schema.proximasAcoes)[0].linhas?.[0]).not.toHaveProperty("itemId");
    estado.operacoes = [];
    await expect(servico.criarProximaAcao(DONA, { texto: "x", contactId: 99 })).rejects.toEqual(erro(MENSAGEM_CONTATO_FORA_DA_REDE));
    expect(de("insert")).toEqual([]);
  });

  it("editar muda só os campos que vieram; vazio apaga", async () => {
    await servico.editarProximaAcao(DONA, "acao-1", { texto: "Novo texto", prazo: null });
    const [editou] = de("update", schema.proximasAcoes);
    expect(Object.keys(editou.valores ?? {}).sort()).toEqual(["prazo", "texto", "updatedAt"]);
    expect(editou.valores).toMatchObject({ texto: "Novo texto", prazo: null });
    expect(editou.params).toEqual(["acao-1", DONA]);
  });
});

describe("o lembrete no sino (H15) anda com a ação", () => {
  it("anotar com prazo agenda o lembrete na mesma transação, depois da ação, com o fuso do aparelho", async () => {
    lembretes.agendarLembreteDaAcao.mockImplementationOnce(async () => { estado.operacoes.push({ tipo: "select", tabela: "lembrete", sql: "", params: [] }); });
    const { id } = await servico.criarProximaAcao(DONA, { texto: "Mandar o contrato", prazo: "2026-12-01", fuso: "Europe/Lisbon" });
    expect(estado.transacoes).toBe(1);
    expect(lembretes.agendarLembreteDaAcao).toHaveBeenCalledWith(fakeDb, DONA, id, "2026-12-01", "Europe/Lisbon", expect.any(Number));
    expect(estado.operacoes.map(o => o.tabela)).toEqual([schema.proximasAcoes, "lembrete"]);
  });

  it("anotar sem prazo também passa por ele (sem prazo, nenhum lembrete); o contato de outra rede não chega lá", async () => {
    await servico.criarProximaAcao(DONA, { texto: "Ligar para a Bia" });
    expect(lembretes.agendarLembreteDaAcao).toHaveBeenCalledWith(fakeDb, DONA, expect.any(String), null, undefined, expect.any(Number));
    lembretes.agendarLembreteDaAcao.mockClear();
    await expect(servico.criarProximaAcao(DONA, { texto: "x", prazo: "2026-12-01", contactId: 99 })).rejects.toBeDefined();
    expect(lembretes.agendarLembreteDaAcao).not.toHaveBeenCalled();
  });

  it("mudar o prazo reagenda (e tirar o prazo tira o lembrete); mudar só o texto não toca no lembrete", async () => {
    await servico.editarProximaAcao(DONA, "acao-1", { prazo: "2026-12-05", fuso: "America/Manaus" });
    expect(lembretes.agendarLembreteDaAcao).toHaveBeenLastCalledWith(fakeDb, DONA, "acao-1", "2026-12-05", "America/Manaus", expect.any(Number));
    await servico.editarProximaAcao(DONA, "acao-1", { prazo: null });
    expect(lembretes.agendarLembreteDaAcao).toHaveBeenLastCalledWith(fakeDb, DONA, "acao-1", null, undefined, expect.any(Number));
    lembretes.agendarLembreteDaAcao.mockClear();
    await servico.editarProximaAcao(DONA, "acao-1", { texto: "Outro texto" });
    expect(lembretes.agendarLembreteDaAcao).not.toHaveBeenCalled();
  });

  it("a ação que não é da dona: nem o lembrete muda", async () => {
    estado.afetadas = 0;
    await expect(servico.editarProximaAcao(DONA, "acao-1", { prazo: "2026-12-05" })).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_ACAO_NAO_ENCONTRADA });
    expect(lembretes.agendarLembreteDaAcao).not.toHaveBeenCalled();
  });

  it("apagar a ação esquece o lembrete e os avisos dela, na transação da exclusão", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ id: "acao-1", itemId: null, meetingId: null }]);
    await servico.apagarProximaAcao(DONA, "acao-1");
    expect(estado.transacoes).toBe(1);
    expect(lembretes.esquecerLembrete).toHaveBeenCalledWith(fakeDb, DONA, "acao", "acao-1");
  });

  it("desconfirmar o item esquece o lembrete de cada ação que sai; sem ação, nada a esquecer", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ id: "acao-7" }]);
    await servico.apagarAcaoDoItem(db, DONA, "item-1");
    const [leitura] = de("select", schema.proximasAcoes);
    expect(leitura.params).toEqual([DONA, "item-1"]);
    expect(de("delete", schema.proximasAcoes)[0].params).toEqual([DONA, "item-1"]);
    expect(lembretes.esquecerLembrete).toHaveBeenCalledWith(db, DONA, "acao", "acao-7");
    lembretes.esquecerLembrete.mockClear();
    estado.tabelas.set(schema.proximasAcoes, []);
    await servico.apagarAcaoDoItem(db, DONA, "item-1");
    expect(lembretes.esquecerLembrete).not.toHaveBeenCalled();
  });

  it("marcar feita não mexe no lembrete: o laço confere a ação no disparo", async () => {
    estado.tabelas.set(schema.proximasAcoes, [{ id: "acao-1", itemId: null, meetingId: null }]);
    await servico.marcarProximaAcaoFeita(DONA, "acao-1", true);
    expect(lembretes.agendarLembreteDaAcao).not.toHaveBeenCalled();
    expect(lembretes.esquecerLembrete).not.toHaveBeenCalled();
  });
});

describe("o estado na Google Agenda anda com as escritas (H5c)", () => {
  // Um dia que ainda vem e um que já passou, para qualquer relógio de quem roda o teste.
  const FUTURO = "2099-12-31";
  const PASSADO = "2001-01-01";
  const google = (naGoogle: boolean) => ({ naGoogle, fuso: "America/Sao_Paulo", agora: Date.now() });
  const comAcao = (linha: Record<string, unknown>) => estado.tabelas.set(schema.proximasAcoes, [linha]);

  it("anotar com a Google Agenda conectada nasce 'pendente'; sem ela, nulo", async () => {
    await servico.criarProximaAcao(DONA, { texto: "Mandar o contrato", prazo: FUTURO }, { naGoogle: true });
    expect(de("insert", schema.proximasAcoes)[0].linhas?.[0]).toMatchObject({ google: "pendente" });
    estado.operacoes = [];
    await servico.criarProximaAcao(DONA, { texto: "Mandar o contrato", prazo: FUTURO });
    expect(de("insert", schema.proximasAcoes)[0].linhas?.[0]).toMatchObject({ google: null });
  });

  it("editar com a Google lê a ação travada, com a dona, antes de gravar o estado na mesma escrita", async () => {
    comAcao({ prazo: FUTURO, feita: false, google: "ok" });
    const passo = await servico.editarProximaAcao(DONA, "acao-1", { texto: "Outro texto" }, google(true));
    expect(passo).toEqual({ destino: "gravar", googleAntes: "ok" });
    const [leitura] = de("select", schema.proximasAcoes);
    expect(leitura).toMatchObject({ travada: true, params: ["acao-1", DONA] });
    const [editou] = de("update", schema.proximasAcoes);
    expect(editou.valores).toMatchObject({ texto: "Outro texto", google: "pendente" });
    expect(editou.params).toEqual(["acao-1", DONA]);
    expect(estado.transacoes).toBe(1);
  });

  it("tirar o prazo tira a ação da agenda: o estado zera, e o destino diz a quem chama que o evento sai", async () => {
    comAcao({ prazo: FUTURO, feita: false, google: "ok" });
    expect(await servico.editarProximaAcao(DONA, "acao-1", { prazo: null }, google(true))).toEqual({ destino: "tirar", googleAntes: "ok" });
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ prazo: null, google: null });
  });

  it("sem a Google Agenda agora, a que estava lá fica 'falhou' (a Google ficou com a versão antiga); a que nunca foi continua nula", async () => {
    comAcao({ prazo: FUTURO, feita: false, google: "ok" });
    await servico.editarProximaAcao(DONA, "acao-1", { texto: "x" }, google(false));
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ google: "falhou" });
    estado.operacoes = [];
    comAcao({ prazo: FUTURO, feita: false, google: null });
    await servico.editarProximaAcao(DONA, "acao-1", { texto: "x" }, google(false));
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ google: null });
  });

  it("o dia do prazo já passou: a que nunca foi não vai (nulo), e a que está lá só muda ('pendente')", async () => {
    comAcao({ prazo: PASSADO, feita: false, google: null });
    expect(await servico.editarProximaAcao(DONA, "acao-1", { texto: "x" }, google(true))).toEqual({ destino: "atualizar", googleAntes: null });
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ google: null });
    estado.operacoes = [];
    comAcao({ prazo: PASSADO, feita: false, google: "ok" });
    expect(await servico.editarProximaAcao(DONA, "acao-1", { texto: "x" }, google(true))).toEqual({ destino: "atualizar", googleAntes: "ok" });
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ google: "pendente" });
  });

  it("o prazo novo que chega na edição decide o destino, não o de antes", async () => {
    comAcao({ prazo: null, feita: false, google: null });
    expect(await servico.editarProximaAcao(DONA, "acao-1", { prazo: FUTURO, fuso: "America/Sao_Paulo" }, google(true))).toEqual({ destino: "gravar", googleAntes: null });
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ prazo: FUTURO, google: "pendente" });
  });

  it("a ação que não é da dona, com a Google: NOT_FOUND na leitura travada, e nada se grava", async () => {
    estado.tabelas.set(schema.proximasAcoes, []);
    await expect(servico.editarProximaAcao(DONA, "acao-1", { texto: "x" }, google(true))).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_ACAO_NAO_ENCONTRADA });
    expect(de("update")).toEqual([]);
    expect(lembretes.agendarLembreteDaAcao).not.toHaveBeenCalled();
  });

  it("marcar feita zera o estado na mesma escrita da feita (a feita sai da agenda); desmarcar não mexe nele", async () => {
    await servico.escreverFeita(db, DONA, { itemId: "item-1" }, true, 3_000);
    expect(de("update", schema.proximasAcoes)[0].valores).toMatchObject({ feita: true, google: null });
    estado.operacoes = [];
    await servico.escreverFeita(db, DONA, { acaoId: "acao-1", itemId: null }, false, 3_000);
    expect(de("update", schema.proximasAcoes)[0].valores).not.toHaveProperty("google");
  });

  it("marcar e apagar devolvem o prazo e o estado de antes, para quem chama tirar o evento", async () => {
    comAcao({ id: "acao-1", itemId: null, meetingId: null, prazo: FUTURO, google: "ok" });
    expect(await servico.marcarProximaAcaoFeita(DONA, "acao-1", true)).toEqual({ prazo: FUTURO, googleAntes: "ok" });
    comAcao({ id: "acao-1", itemId: null, meetingId: null, prazo: null, google: null });
    expect(await servico.apagarProximaAcao(DONA, "acao-1")).toEqual({ prazo: null, googleAntes: null });
  });
});
