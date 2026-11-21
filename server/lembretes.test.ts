import { getTableColumns, mapUpdateSet, type SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Os lembretes no sino (H15, server/lembretes.ts) com o banco dublado: o que
 * cada função lê e escreve, com a dona no WHERE, renderizado pelo dialeto do
 * MySQL. Agendar (a hora certa, a mesma hora que não repete, a que passou),
 * esquecer, os avisos da reunião e o laço (a reserva por token, a marca e o
 * aviso na mesma transação, o que sai sem aviso). O que só o banco prova (a
 * reserva atômica entre duas rodadas, o índice único) está em
 * lembretes.integracao.test.ts.
 */

const dialeto = new MySqlDialect();
type Predicado = { sql: string; params: unknown[] };
const renderizar = (condicao?: SQL): Predicado => (condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] });

type Operacao = Predicado & {
  tipo: "select" | "update" | "insert" | "delete";
  tabela: unknown;
  campos?: string[];
  limite?: number;
  ordem?: string;
  valores?: Record<string, unknown>;
  linhas?: Record<string, unknown>[];
  noDuplicado?: Predicado;
  naTransacao: boolean;
};

const estado = {
  operacoes: [] as Operacao[],
  /** As linhas de cada leitura; o padrão é pela tabela, com as colunas projetadas. */
  ler: null as ((operacao: Operacao) => Record<string, unknown>[] | undefined) | null,
  tabelas: new Map<unknown, Record<string, unknown>[]>(),
  /** As linhas que cada UPDATE diz ter mudado; o padrão é 1. */
  afetadas: null as ((operacao: Operacao) => number) | null,
  /** Uma leitura que lança, para provar que a falha de um lembrete não segura os outros. */
  falharLeitura: null as ((operacao: Operacao) => boolean) | null,
  transacoes: 0,
  aberta: false,
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

const anotar = (operacao: Omit<Operacao, "naTransacao" | "sql" | "params"> & Partial<Predicado>): Operacao => {
  const completa = { sql: "", params: [], ...operacao, naTransacao: estado.aberta } as Operacao;
  estado.operacoes.push(completa);
  return completa;
};

function selecionar(projecao?: Record<string, unknown>) {
  return {
    from: (tabela: unknown) => {
      const operacao = anotar({ tipo: "select", tabela, campos: projecao ? Object.keys(projecao) : undefined });
      const linhas = () => {
        if (estado.falharLeitura?.(operacao)) throw new Error("leitura falhou");
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
        then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) => Promise.resolve().then(linhas).then(ok, falha),
      });
      return cadeia;
    },
  };
}

const fakeDb = {
  select: selecionar,
  insert: (tabela: unknown) => ({
    values: (valores: Record<string, unknown> | Record<string, unknown>[]) => {
      const operacao = { tipo: "insert" as const, tabela, linhas: Array.isArray(valores) ? valores : [valores] };
      const gravar = async () => { anotar(operacao); };
      return {
        then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) => gravar().then(ok, falha),
        onDuplicateKeyUpdate: ({ set }: { set: Record<string, unknown> }) => {
          Object.assign(operacao, { noDuplicado: renderizar(dialeto.buildUpdateSet(tabela as MySqlTable, mapUpdateSet(tabela as MySqlTable, set))) });
          return gravar();
        },
      };
    },
  }),
  update: (tabela: unknown) => ({
    set: (valores: Record<string, unknown>) => ({
      where: (condicao?: SQL) => {
        const operacao = anotar({ tipo: "update", tabela, valores, ...renderizar(condicao) });
        const cadeia: Record<string, unknown> = {};
        Object.assign(cadeia, {
          orderBy: (ordem: unknown) => { operacao.ordem = renderizar(ordem as SQL).sql; return cadeia; },
          limit: (limite: number) => { operacao.limite = limite; return cadeia; },
          then: (ok: (valor: unknown) => unknown, falha?: (erro: unknown) => unknown) =>
            Promise.resolve([{ affectedRows: estado.afetadas?.(operacao) ?? 1 }]).then(ok, falha),
        });
        return cadeia;
      },
    }),
  }),
  delete: (tabela: unknown) => ({
    where: async (condicao?: SQL) => { anotar({ tipo: "delete", tabela, ...renderizar(condicao) }); return [{ affectedRows: 1 }]; },
  }),
  transaction: async <T>(trabalho: (tx: typeof fakeDb) => Promise<T>) => {
    estado.transacoes += 1;
    estado.aberta = true;
    try {
      return await trabalho(fakeDb);
    } finally {
      estado.aberta = false;
    }
  },
};
vi.mock("./db", () => ({ getDb: async () => fakeDb, exigirDb: async () => fakeDb }));

const lembretes = await import("./lembretes");

const DONA = "dona-1";
const ACAO = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const AGENDA = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const REUNIAO = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const utc = (ano: number, mes: number, dia: number, hora = 0, minuto = 0) => Date.UTC(ano, mes - 1, dia, hora, minuto);
// "Agora" fixo: 16/11/2026, 10h em Brasília.
const AGORA = utc(2026, 11, 16, 13);
const db = fakeDb as unknown as Parameters<typeof lembretes.agendarLembreteDaAcao>[0];
const de = (tipo: Operacao["tipo"], tabela?: unknown) => estado.operacoes.filter(o => o.tipo === tipo && (tabela === undefined || o.tabela === tabela));
const escritas = () => estado.operacoes.filter(o => o.tipo !== "select");

beforeEach(() => {
  estado.operacoes = [];
  estado.ler = null;
  estado.tabelas = new Map();
  estado.afetadas = null;
  estado.falharLeitura = null;
  estado.transacoes = 0;
  estado.aberta = false;
  lembretes.religarLembretesParaTestes();
  lembretes._paraTestes.tokensVivos.clear();
});

describe("agendar: a hora do lembrete anda com a origem", () => {
  const PRAZO = "2026-11-20";
  const AS_9H_DO_PRAZO = utc(2026, 11, 20, 12);
  const FIM_DO_PRAZO = utc(2026, 11, 21, 3);

  it("a ação com prazo, sem lembrete ainda: grava às 9h do prazo no fuso do aparelho, até o fim do dia, com a dona", async () => {
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, PRAZO, "America/Sao_Paulo", AGORA);
    const [leitura] = de("select", schema.lembretes);
    expect(leitura.sql).toBe("(`lembretes`.`owner_id` = ? and `lembretes`.`origem` = ? and `lembretes`.`origem_id` = ?)");
    expect(leitura.params).toEqual([DONA, "acao", ACAO]);
    const [insercao] = de("insert", schema.lembretes);
    expect(insercao.linhas?.[0]).toMatchObject({
      ownerId: DONA, origem: "acao", origemId: ACAO, dispararEm: AS_9H_DO_PRAZO, expiraEm: FIM_DO_PRAZO,
      disparadoEm: null, lockToken: null, lockedUntil: null, createdAt: AGORA, updatedAt: AGORA,
    });
    // Duas escritas da mesma origem ao mesmo tempo: o índice único fica com uma, já pendente.
    expect(insercao.noDuplicado).toMatchObject({
      sql: "`disparar_em` = ?, `expira_em` = ?, `disparado_em` = ?, `lock_token` = ?, `locked_until` = ?, `updated_at` = ?",
      params: [AS_9H_DO_PRAZO, FIM_DO_PRAZO, null, null, null, AGORA],
    });
  });

  it("o fuso de outro lugar muda a hora; o que o Intl não conhece, ou nenhum, cai em Brasília", async () => {
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, PRAZO, "Asia/Tokyo", AGORA);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, PRAZO, "Marte/Olympus", AGORA);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, PRAZO, null, AGORA);
    expect(de("insert", schema.lembretes).map(o => o.linhas?.[0].dispararEm)).toEqual([utc(2026, 11, 20, 0), AS_9H_DO_PRAZO, AS_9H_DO_PRAZO]);
  });

  it("a mesma hora de antes, pendente ou já disparada: nada muda (editar o texto não repete o aviso)", async () => {
    estado.tabelas.set(schema.lembretes, [{ id: "l-1", dispararEm: AS_9H_DO_PRAZO, expiraEm: FIM_DO_PRAZO }]);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, PRAZO, "America/Sao_Paulo", AGORA);
    expect(escritas()).toEqual([]);
  });

  it("outra hora ainda por vir: volta a pendente, sem a marca nem a reserva, só na linha da dona", async () => {
    estado.tabelas.set(schema.lembretes, [{ id: "l-1", dispararEm: utc(2026, 11, 18, 12), expiraEm: utc(2026, 11, 19, 3) }]);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, PRAZO, "America/Sao_Paulo", AGORA);
    const [mudanca] = de("update", schema.lembretes);
    expect(mudanca.valores).toEqual({
      dispararEm: AS_9H_DO_PRAZO, expiraEm: FIM_DO_PRAZO, disparadoEm: null, lockToken: null, lockedUntil: null, updatedAt: AGORA,
    });
    expect(mudanca.sql).toBe("(`lembretes`.`id` = ? and `lembretes`.`owner_id` = ?)");
    expect(mudanca.params).toEqual(["l-1", DONA]);
    expect(de("insert")).toEqual([]);
  });

  it("sem prazo (tirado na edição): o lembrete sai; sem lembrete, nada a fazer", async () => {
    estado.tabelas.set(schema.lembretes, [{ id: "l-1", dispararEm: AS_9H_DO_PRAZO, expiraEm: FIM_DO_PRAZO }]);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, null, "America/Sao_Paulo", AGORA);
    expect(de("delete", schema.lembretes).map(o => o.params)).toEqual([["l-1", DONA]]);
    estado.operacoes = [];
    estado.tabelas.set(schema.lembretes, []);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, null, "America/Sao_Paulo", AGORA);
    expect(escritas()).toEqual([]);
  });

  it("a hora nova já passou (prazo hoje, marcado às 10h): nada a avisar, e o lembrete de outra hora sai", async () => {
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, "2026-11-16", "America/Sao_Paulo", AGORA);
    expect(escritas()).toEqual([]);
    estado.tabelas.set(schema.lembretes, [{ id: "l-1", dispararEm: AS_9H_DO_PRAZO, expiraEm: FIM_DO_PRAZO }]);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, "2026-11-16", "America/Sao_Paulo", AGORA);
    expect(de("delete", schema.lembretes)).toHaveLength(1);
  });

  it("a mesma hora, que acabou de chegar (o laço pode estar avisando agora): o lembrete fica", async () => {
    const as9h = utc(2026, 11, 16, 12);
    estado.tabelas.set(schema.lembretes, [{ id: "l-1", dispararEm: as9h, expiraEm: utc(2026, 11, 17, 3) }]);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, "2026-11-16", "America/Sao_Paulo", AGORA);
    expect(escritas()).toEqual([]);
  });

  it("o aviso que já venceu (o dia do prazo acabou) sai, mesmo na mesma hora", async () => {
    estado.tabelas.set(schema.lembretes, [{ id: "l-1", dispararEm: utc(2026, 11, 10, 12), expiraEm: utc(2026, 11, 11, 3) }]);
    await lembretes.agendarLembreteDaAcao(db, DONA, ACAO, "2026-11-10", "America/Sao_Paulo", AGORA);
    expect(de("delete", schema.lembretes)).toHaveLength(1);
  });

  it("a reunião da agenda: os minutos antes do início, até o fim; sem lembrete, sai", async () => {
    const inicioEm = utc(2026, 11, 20, 17);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, { inicioEm, duracaoMinutos: 90, lembreteMinutos: 15 }, AGORA);
    expect(de("insert", schema.lembretes)[0].linhas?.[0]).toMatchObject({
      origem: "agenda", origemId: AGENDA, dispararEm: inicioEm - 15 * 60_000, expiraEm: inicioEm + 90 * 60_000,
    });
    estado.tabelas.set(schema.lembretes, [{ id: "l-2", dispararEm: inicioEm - 15 * 60_000, expiraEm: inicioEm + 90 * 60_000 }]);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, { inicioEm, duracaoMinutos: 90, lembreteMinutos: null }, AGORA);
    expect(de("delete", schema.lembretes).map(o => o.params)).toEqual([["l-2", DONA]]);
  });

  // A dona marca às 10h (AGORA) uma reunião para amanhã às 9h, com "1 dia
  // antes": a hora do lembrete já passou, mas a reunião ainda não começou. O
  // lembrete fica pendente nessa hora, e a próxima rodada do laço avisa.
  it("a reunião da agenda com a hora do lembrete já passada, antes do início: fica pendente nessa hora (marcar, e adiantar na edição)", async () => {
    const amanhaAs9h = utc(2026, 11, 17, 12);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, { inicioEm: amanhaAs9h, duracaoMinutos: 60, lembreteMinutos: 1440 }, AGORA);
    expect(de("insert", schema.lembretes)[0].linhas?.[0]).toMatchObject({
      origem: "agenda", origemId: AGENDA, dispararEm: amanhaAs9h - 1440 * 60_000, expiraEm: amanhaAs9h + 60 * 60_000, disparadoEm: null,
    });
    // "2 horas antes" de uma reunião adiantada para daqui a 1 h: a linha de outra hora volta a pendente, na hora que passou.
    estado.operacoes = [];
    const daquiAUmaHora = AGORA + 60 * 60_000;
    estado.tabelas.set(schema.lembretes, [{ id: "l-2", dispararEm: utc(2026, 11, 20, 15), expiraEm: utc(2026, 11, 20, 18) }]);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, { inicioEm: daquiAUmaHora, duracaoMinutos: 30, lembreteMinutos: 120 }, AGORA);
    expect(de("update", schema.lembretes).map(o => o.valores)).toEqual([{
      dispararEm: daquiAUmaHora - 120 * 60_000, expiraEm: daquiAUmaHora + 30 * 60_000, disparadoEm: null, lockToken: null, lockedUntil: null, updatedAt: AGORA,
    }]);
    expect(de("delete")).toEqual([]);
  });

  it("o lembrete atrasado da agenda, já com a linha nessa hora: editar só o título não repete o aviso", async () => {
    const amanhaAs9h = utc(2026, 11, 17, 12);
    estado.tabelas.set(schema.lembretes, [{ id: "l-2", dispararEm: amanhaAs9h - 1440 * 60_000, expiraEm: amanhaAs9h + 60 * 60_000 }]);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, { inicioEm: amanhaAs9h, duracaoMinutos: 60, lembreteMinutos: 1440 }, AGORA);
    expect(escritas()).toEqual([]);
  });

  it("a reunião da agenda que já começou, com a hora do lembrete passada: nada a avisar, e o lembrete de outra hora sai", async () => {
    const comecouHaDezMinutos = AGORA - 10 * 60_000;
    const reuniao = { inicioEm: comecouHaDezMinutos, duracaoMinutos: 60, lembreteMinutos: 15 };
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, reuniao, AGORA);
    expect(escritas()).toEqual([]);
    estado.tabelas.set(schema.lembretes, [{ id: "l-2", dispararEm: utc(2026, 11, 20, 15), expiraEm: utc(2026, 11, 20, 18) }]);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, reuniao, AGORA);
    expect(de("delete", schema.lembretes).map(o => o.params)).toEqual([["l-2", DONA]]);
  });

  it("a mesma hora com outra duração: só a validade acompanha, e a marca fica", async () => {
    const inicioEm = utc(2026, 11, 20, 17);
    estado.tabelas.set(schema.lembretes, [{ id: "l-2", dispararEm: inicioEm - 15 * 60_000, expiraEm: inicioEm + 90 * 60_000 }]);
    await lembretes.agendarLembreteDaAgenda(db, DONA, AGENDA, { inicioEm, duracaoMinutos: 120, lembreteMinutos: 15 }, AGORA);
    expect(de("update", schema.lembretes).map(o => o.valores)).toEqual([{ expiraEm: inicioEm + 120 * 60_000, updatedAt: AGORA }]);
  });
});

describe("esquecer e apagar os avisos", () => {
  it("a ação apagada: o lembrete sai pela dona e pela origem, e os avisos do gravador com o link dela saem da conta dela, pela chave", async () => {
    estado.tabelas.set(schema.users, [{ id: 7, openId: DONA }]);
    estado.tabelas.set(schema.platformNotifications, [{ id: 41 }, { id: 42 }]);
    await lembretes.esquecerLembrete(db, DONA, "acao", ACAO);
    const [lembrete] = de("delete", schema.lembretes);
    expect(lembrete.sql).toBe("(`lembretes`.`owner_id` = ? and `lembretes`.`origem` = ? and `lembretes`.`origem_id` = ?)");
    expect(lembrete.params).toEqual([DONA, "acao", ACAO]);
    expect(de("select", schema.users)[0].params).toEqual([DONA]);
    // Os avisos são achados numa leitura sem trava e saem pela chave: o DELETE
    // pela conta travava o intervalo dela no índice e o vão até a vizinha
    // (revisão do pacote do match, 20/11), como no aviso de pronta.
    const [achados] = de("select", schema.platformNotifications);
    expect(achados.sql).toBe("(`platform_notifications`.`userId` = ? and `platform_notifications`.`type` in (?, ?) and `platform_notifications`.`actionUrl` = ?)");
    expect(achados.params).toEqual([7, "lembrete", "reuniao_pronta", `/proximas-acoes?acao=${ACAO}`]);
    expect(de("delete", schema.platformNotifications).map(apagado => [apagado.sql, apagado.params])).toEqual([
      ["`platform_notifications`.`id` = ?", [41]],
      ["`platform_notifications`.`id` = ?", [42]],
    ]);
  });

  it("a reunião tirada da agenda: o link dos avisos é o do gravador com ela", async () => {
    estado.tabelas.set(schema.users, [{ id: 7, openId: DONA }]);
    await lembretes.esquecerLembrete(db, DONA, "agenda", AGENDA);
    expect(de("select", schema.platformNotifications)[0].params.at(-1)).toBe(`/gravar?agendada=${AGENDA}`);
  });

  it("a reunião gravada excluída: os avisos dela saem, pelo link da reunião", async () => {
    estado.tabelas.set(schema.users, [{ id: 7, openId: DONA }]);
    estado.tabelas.set(schema.platformNotifications, [{ id: 41 }]);
    await lembretes.apagarAvisosDaReuniao(db, DONA, REUNIAO);
    expect(de("select", schema.platformNotifications)[0].params).toEqual([7, "lembrete", "reuniao_pronta", `/meetings/${REUNIAO}`]);
    expect(de("delete", schema.platformNotifications).map(apagado => apagado.params)).toEqual([[41]]);
  });

  it("sem a conta (já excluída), só o lembrete sai", async () => {
    await lembretes.esquecerLembrete(db, DONA, "acao", ACAO);
    expect(escritas().map(o => o.tabela)).toEqual([schema.lembretes]);
  });
});

describe("o aviso de reunião pronta", () => {
  it("da reunião pronta da dona: tira o aviso anterior dela e grava o novo, com o título e como o resumo terminou", async () => {
    estado.ler = operacao => operacao.tabela === schema.meetings ? [{ titulo: "Comitê de exportação ☕", contaId: 7 }]
      : operacao.tabela === schema.platformNotifications ? [{ id: 41 }] : undefined;
    expect(await lembretes.avisarReuniaoPronta(db, DONA, REUNIAO, "pronto")).toBe(true);
    const [leitura] = de("select", schema.meetings);
    expect(leitura.sql).toBe("(`meetings`.`id` = ? and `meetings`.`owner_id` = ? and `meetings`.`status` = ?)");
    expect(leitura.params).toEqual([REUNIAO, DONA, "ready"]);
    // O anterior é achado numa leitura sem trava e sai pela chave: o DELETE
    // pela conta travava o intervalo dela no índice e o vão até a vizinha.
    const [achado] = de("select", schema.platformNotifications);
    expect(achado.params).toEqual([7, "reuniao_pronta", `/meetings/${REUNIAO}`]);
    const [anterior] = de("delete", schema.platformNotifications);
    expect(anterior.sql).toBe("`platform_notifications`.`id` = ?");
    expect(anterior.params).toEqual([41]);
    const [aviso] = de("insert", schema.platformNotifications);
    expect(aviso.linhas?.[0]).toEqual({
      userId: 7, type: "reuniao_pronta", title: "Comitê de exportação ☕", body: null,
      actionUrl: `/meetings/${REUNIAO}`, parametros: { titulo: "Comitê de exportação ☕", resumo: "pronto" }, isRead: false,
    });
    expect(estado.operacoes.map(o => o.tipo)).toEqual(["select", "select", "delete", "insert"]);
  });

  it("sem aviso anterior da reunião, só grava o novo: nenhum DELETE", async () => {
    estado.ler = operacao => operacao.tabela === schema.meetings ? [{ titulo: "Comitê", contaId: 7 }] : undefined;
    expect(await lembretes.avisarReuniaoPronta(db, DONA, REUNIAO, "pronto")).toBe(true);
    expect(estado.operacoes.map(o => o.tipo)).toEqual(["select", "select", "insert"]);
  });

  it("o resumo que falhou de vez também avisa: a transcrição está lá", async () => {
    estado.ler = operacao => operacao.tabela === schema.meetings ? [{ titulo: "Comitê", contaId: 7 }] : undefined;
    await lembretes.avisarReuniaoPronta(db, DONA, REUNIAO, "falhou");
    expect(de("insert", schema.platformNotifications)[0].linhas?.[0].parametros).toEqual({ titulo: "Comitê", resumo: "falhou" });
  });

  it("reunião que não está pronta, de outra dona ou de conta desativada (a leitura não acha): nada", async () => {
    estado.ler = () => [];
    expect(await lembretes.avisarReuniaoPronta(db, DONA, REUNIAO, "pronto")).toBe(false);
    expect(escritas()).toEqual([]);
  });

  it("o título longo é cortado no tamanho da coluna sem partir um emoji; os parâmetros guardam o título inteiro", async () => {
    const titulo = `${"a".repeat(198)}☕☕☕`;
    estado.ler = operacao => operacao.tabela === schema.meetings ? [{ titulo, contaId: 7 }] : undefined;
    await lembretes.avisarReuniaoPronta(db, DONA, REUNIAO, "pronto");
    const linha = de("insert", schema.platformNotifications)[0].linhas?.[0];
    expect(Array.from(linha?.title as string)).toHaveLength(200);
    expect(linha?.title).toBe(`${"a".repeat(198)}☕…`);
    expect((linha?.parametros as { titulo: string }).titulo).toBe(titulo);
  });
});

describe("o laço: reserva, marca e aviso", () => {
  const AS_9H = utc(2026, 11, 16, 12);
  const reservado = (extra: Record<string, unknown> = {}) => ({
    id: "l-1", ownerId: DONA, origem: "acao", origemId: ACAO, dispararEm: AS_9H, expiraEm: utc(2026, 11, 17, 3),
    contaId: 7, contaAtiva: true, ...extra,
  });
  /** As leituras do laço: os reservados (lembretes com a conta) e a origem de cada um. */
  function lendo(reservados: Record<string, unknown>[], origens: { acao?: Record<string, unknown>[]; agenda?: Record<string, unknown>[] } = {}) {
    estado.ler = operacao => {
      if (operacao.tabela === schema.lembretes && operacao.campos?.includes("contaId")) return reservados;
      if (operacao.tabela === schema.proximasAcoes) return origens.acao ?? [];
      if (operacao.tabela === schema.agendaReunioes) return origens.agenda ?? [];
      return undefined;
    };
  }
  const ACAO_ABERTA = { texto: "{F2} manda a proposta a {F3}", prazo: "2026-11-16", feita: false, reuniaoViva: REUNIAO, vozes: { F2: "Carla" }, itemVivo: "item-1" };

  it("reserva por token os vencidos, sem marca e sem reserva viva, os mais antigos primeiro, até o lote", async () => {
    lendo([]);
    estado.afetadas = () => 0;
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 0 });
    const [reserva] = de("update", schema.lembretes);
    expect(reserva.valores).toEqual({ lockToken: expect.stringMatching(/^[0-9a-f-]{36}$/), lockedUntil: AGORA + 2 * 60_000 });
    expect(reserva.sql).toBe("(`lembretes`.`disparado_em` is null and `lembretes`.`disparar_em` <= ? and (`lembretes`.`locked_until` is null or `lembretes`.`locked_until` < ?))");
    expect(reserva.params).toEqual([AGORA, AGORA]);
    expect(reserva.ordem).toBe("`lembretes`.`disparar_em` asc");
    expect(reserva.limite).toBe(lembretes.LEMBRETES_POR_RODADA);
    // Nada reservado: nem lê.
    expect(de("select")).toEqual([]);
    expect(lembretes._paraTestes.tokensVivos.size).toBe(0);
  });

  it("a ação aberta: os rótulos viram os nomes da reunião (a voz sem nome fica rótulo), e a marca e o aviso vão juntos", async () => {
    lendo([reservado()], { acao: [ACAO_ABERTA] });
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 1 });
    const token = de("update", schema.lembretes)[0].valores?.lockToken;
    const [lidos] = de("select", schema.lembretes);
    expect(lidos.params).toEqual([token]);
    const [origem] = de("select", schema.proximasAcoes);
    expect(origem.sql).toBe("(`proximas_acoes`.`id` = ? and `proximas_acoes`.`owner_id` = ?)");
    expect(origem.params).toEqual([ACAO, DONA]);
    expect(estado.transacoes).toBe(1);
    const [, marca] = de("update", schema.lembretes);
    expect(marca.naTransacao).toBe(true);
    expect(marca.valores).toEqual({ disparadoEm: AGORA, lockToken: null, lockedUntil: null, updatedAt: AGORA });
    expect(marca.sql).toBe("((`lembretes`.`id` = ? and `lembretes`.`lock_token` = ?) and `lembretes`.`disparado_em` is null)");
    expect(marca.params).toEqual(["l-1", token]);
    const [aviso] = de("insert", schema.platformNotifications);
    expect(aviso.naTransacao).toBe(true);
    expect(aviso.linhas?.[0]).toEqual({
      userId: 7, type: "lembrete", title: "Carla manda a proposta a {F3}", body: null, actionUrl: `/proximas-acoes?acao=${ACAO}`,
      parametros: { origem: "acao", texto: "Carla manda a proposta a {F3}", prazo: "2026-11-16" }, isRead: false,
    });
  });

  it("a ação solta (sem item, ou da reunião excluída): o texto vai como está, sem trocar rótulo", async () => {
    lendo([reservado()], { acao: [{ ...ACAO_ABERTA, texto: "Carla manda a proposta", itemVivo: null }] });
    await lembretes.rodarLembretesUmaVez({}, AGORA);
    expect((de("insert", schema.platformNotifications)[0].linhas?.[0].parametros as { texto: string }).texto).toBe("Carla manda a proposta");
  });

  it("a ação feita (ou sem prazo): marca sem avisar", async () => {
    lendo([reservado()], { acao: [{ ...ACAO_ABERTA, feita: true }] });
    await lembretes.rodarLembretesUmaVez({}, AGORA);
    expect(de("insert")).toEqual([]);
    expect(de("update", schema.lembretes)[1].valores).toEqual({ disparadoEm: AGORA, lockToken: null, lockedUntil: null, updatedAt: AGORA });
    expect(estado.transacoes).toBe(0);
  });

  it("a ação que não existe mais: o lembrete sai, pela reserva", async () => {
    lendo([reservado()], { acao: [] });
    await lembretes.rodarLembretesUmaVez({}, AGORA);
    const [saida] = de("delete", schema.lembretes);
    expect(saida.sql).toBe("(`lembretes`.`id` = ? and `lembretes`.`lock_token` = ?)");
    expect(de("insert")).toEqual([]);
  });

  it("a conta desativada, a que saiu e o aviso vencido: marca sem avisar e nem lê a origem", async () => {
    lendo([
      reservado({ id: "l-1", contaAtiva: false }),
      reservado({ id: "l-2", contaId: null, contaAtiva: null }),
      reservado({ id: "l-3", expiraEm: AGORA }),
    ], { acao: [ACAO_ABERTA] });
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 0 });
    expect(de("select", schema.proximasAcoes)).toEqual([]);
    expect(de("update", schema.lembretes).slice(1).map(o => o.params[0])).toEqual(["l-1", "l-2", "l-3"]);
    expect(de("insert")).toEqual([]);
  });

  it("reagendado ou apagado no meio (a marca não acha a reserva): nenhum aviso", async () => {
    lendo([reservado()], { acao: [ACAO_ABERTA] });
    estado.afetadas = operacao => (operacao.valores && "disparadoEm" in operacao.valores ? 0 : 1);
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 0 });
    expect(de("insert")).toEqual([]);
  });

  it("a reunião da agenda: o título, o início e o fuso de agora, e o link do gravador com ela", async () => {
    const inicioEm = utc(2026, 11, 16, 13, 15);
    lendo([reservado({ origem: "agenda", origemId: AGENDA, dispararEm: inicioEm - 15 * 60_000, expiraEm: inicioEm + 60 * 60_000 })], {
      agenda: [{ titulo: "Com a Bia", inicioEm, duracaoMinutos: 60, fuso: "America/Sao_Paulo", lembreteMinutos: 15 }],
    });
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 1 });
    const [origem] = de("select", schema.agendaReunioes);
    expect(origem.params).toEqual([AGENDA, DONA]);
    expect(de("insert", schema.platformNotifications)[0].linhas?.[0]).toMatchObject({
      type: "lembrete", title: "Com a Bia", actionUrl: `/gravar?agendada=${AGENDA}`,
      parametros: { origem: "agenda", titulo: "Com a Bia", inicioEm, fuso: "America/Sao_Paulo" },
    });
  });

  it("o lembrete da agenda marcado depois da hora dele, com a reunião por vir: avisa na rodada", async () => {
    const amanhaAs9h = utc(2026, 11, 17, 12);
    lendo([reservado({ origem: "agenda", origemId: AGENDA, dispararEm: amanhaAs9h - 1440 * 60_000, expiraEm: amanhaAs9h + 60 * 60_000 })], {
      agenda: [{ titulo: "Com a Bia", inicioEm: amanhaAs9h, duracaoMinutos: 60, fuso: "America/Sao_Paulo", lembreteMinutos: 1440 }],
    });
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 1 });
    expect(de("insert", schema.platformNotifications)[0].linhas?.[0]).toMatchObject({ type: "lembrete", actionUrl: `/gravar?agendada=${AGENDA}` });
  });

  it("a reunião da agenda sem lembrete agora: sai; com outra hora: volta a esperar, sem aviso", async () => {
    const inicioEm = utc(2026, 11, 16, 14);
    const daAgenda = reservado({ origem: "agenda", origemId: AGENDA, dispararEm: inicioEm - 60 * 60_000, expiraEm: inicioEm + 30 * 60_000 });
    lendo([daAgenda], { agenda: [{ titulo: "x", inicioEm, duracaoMinutos: 30, fuso: "UTC", lembreteMinutos: null }] });
    await lembretes.rodarLembretesUmaVez({}, AGORA);
    expect(de("delete", schema.lembretes)).toHaveLength(1);
    estado.operacoes = [];
    lendo([daAgenda], { agenda: [{ titulo: "x", inicioEm, duracaoMinutos: 30, fuso: "UTC", lembreteMinutos: 15 }] });
    await lembretes.rodarLembretesUmaVez({}, AGORA);
    expect(de("update", schema.lembretes)[1].valores).toEqual({
      dispararEm: inicioEm - 15 * 60_000, expiraEm: inicioEm + 30 * 60_000, lockToken: null, lockedUntil: null, updatedAt: AGORA,
    });
    expect(de("insert")).toEqual([]);
  });

  it("a falha de um lembrete vai ao log e não segura os outros", async () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    lendo([reservado({ id: "l-1", origemId: "quebra" }), reservado({ id: "l-2" })], { acao: [ACAO_ABERTA] });
    estado.falharLeitura = operacao => operacao.tabela === schema.proximasAcoes && operacao.params[0] === "quebra";
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 1 });
    expect(erro).toHaveBeenCalledTimes(1);
    expect(de("insert", schema.platformNotifications)).toHaveLength(1);
  });

  it("com a dona (os testes de integração): a reserva leva a dona no WHERE", async () => {
    lendo([]);
    estado.afetadas = () => 0;
    await lembretes.rodarLembretesUmaVez({ ownerId: DONA }, AGORA);
    expect(de("update", schema.lembretes)[0].sql).toContain("and `lembretes`.`owner_id` = ?");
  });
});

describe("o desligamento", () => {
  afterEach(() => lembretes.religarLembretesParaTestes());

  it("devolve as reservas desta instância, só as que não saíram, e o laço para de reservar", async () => {
    lembretes._paraTestes.tokensVivos.add("token-a");
    lembretes._paraTestes.tokensVivos.add("token-b");
    estado.afetadas = () => 2;
    expect(await lembretes.pararLembretes()).toEqual({ lembretes: 2 });
    const [devolucao] = de("update", schema.lembretes);
    expect(devolucao.valores).toEqual({ lockToken: null, lockedUntil: null });
    expect(devolucao.sql).toBe("(`lembretes`.`lock_token` in (?, ?) and `lembretes`.`disparado_em` is null)");
    expect(devolucao.params).toEqual(["token-a", "token-b"]);
    estado.operacoes = [];
    expect(await lembretes.rodarLembretesUmaVez({}, AGORA)).toEqual({ avisos: 0 });
    expect(estado.operacoes).toEqual([]);
  });

  it("sem reserva viva, nem toca no banco", async () => {
    expect(await lembretes.pararLembretes()).toEqual({ lembretes: 0 });
    expect(estado.operacoes).toEqual([]);
  });

  it("o laço roda uma rodada por intervalo e para de vez no desligamento", async () => {
    vi.useFakeTimers();
    try {
      lendo0();
      lembretes.iniciarLembretes(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(de("update", schema.lembretes)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(de("update", schema.lembretes)).toHaveLength(2);
      await lembretes.pararLembretes();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(de("update", schema.lembretes)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Nada vencido: a reserva não muda linha nenhuma. */
function lendo0() {
  estado.ler = () => [];
  estado.afetadas = () => 0;
}
