import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A dona edita e acrescenta itens do resumo guardado (H4f), com o banco num
 * fake EM MEMÓRIA que avalia de verdade o WHERE renderizado pelo dialeto do
 * MySQL (igualdades e `<>` em AND): a dona no WHERE é provada pelo predicado,
 * não por um contador escolhido no teste. A transação do fake volta tudo ao
 * estado anterior quando lança, como a do banco, e registra a ordem das travas
 * (FOR UPDATE). O comportamento no MySQL de verdade está em
 * server/resumo-guardado-edicao.integracao.test.ts.
 */
type Linha = Record<string, unknown>;
const banco = vi.hoisted(() => ({
  tabelas: { meetings: [], meeting_summaries: [], meeting_summary_items: [] } as Record<string, Array<Record<string, unknown>>>,
  travas: [] as string[],
  escritas: [] as string[],
}));

vi.mock("./db", async () => {
  const schema = await import("../drizzle/schema");
  const { getTableColumns, getTableName, is, SQL } = await import("drizzle-orm");
  const { MySqlDialect } = await import("drizzle-orm/mysql-core");
  const dialeto = new MySqlDialect();
  const TABELAS = [schema.meetings, schema.meetingSummaries, schema.meetingSummaryItems];
  // O nome da coluna no banco → a chave no TypeScript, por tabela.
  const chaves = new Map(TABELAS.map(tabela => [getTableName(tabela), Object.fromEntries(
    Object.entries(getTableColumns(tabela)).map(([chave, coluna]) => [coluna.name, chave]))]));
  const chave = (tabela: string, coluna: string) => {
    const achada = chaves.get(tabela)?.[coluna];
    if (!achada) throw new Error(`o fake não conhece ${tabela}.${coluna}`);
    return achada;
  };

  function casa(tabela: string, condicao: unknown, linha: Linha): boolean {
    if (!condicao) return true;
    const { sql, params } = dialeto.sqlToQuery(condicao as InstanceType<typeof SQL>);
    const termos = Array.from(sql.matchAll(/`(\w+)`\.`(\w+)` (=|<>) \?/g));
    if (/\bor\b/i.test(sql) || termos.length !== params.length) throw new Error(`o fake não avalia: ${sql}`);
    return termos.every(([, deQual, coluna, operador], i) => {
      if (deQual !== tabela) throw new Error(`o fake só avalia o WHERE da tabela principal: ${sql}`);
      const igual = linha[chave(tabela, coluna)] === params[i];
      return operador === "=" ? igual : !igual;
    });
  }

  // O inner join do itemParaDecidir: o item com o resumo e a reunião dele, da mesma dona.
  function relacionada(tabela: string, item: Linha): Linha | undefined {
    const id = tabela === "meeting_summaries" ? item.summaryId : item.meetingId;
    return banco.tabelas[tabela].find(linha => linha.id === id && linha.ownerId === item.ownerId);
  }

  function consulta(selecao: Record<string, unknown> | undefined) {
    let tabela = "";
    let condicao: unknown;
    const juntas: string[] = [];
    const construtor = {
      from(t: never) { tabela = getTableName(t); return construtor; },
      innerJoin(t: never) { juntas.push(getTableName(t)); return construtor; },
      where(c: unknown) { condicao = c; return construtor; },
      limit() { return construtor; },
      orderBy() { return construtor; },
      for(modo: string) { if (modo === "update") banco.travas.push(tabela); return construtor; },
      then(resolver: (linhas: Linha[]) => unknown, rejeitar?: (erro: unknown) => unknown) {
        try {
          const linhas = banco.tabelas[tabela]
            .filter(linha => casa(tabela, condicao, linha) && juntas.every(t => relacionada(t, linha)));
          return Promise.resolve(resolver(projetar(selecao, tabela, linhas)));
        } catch (erro) {
          return rejeitar ? Promise.resolve(rejeitar(erro)) : Promise.reject(erro);
        }
      },
    };
    return construtor;
  }

  function projetar(selecao: Record<string, unknown> | undefined, tabela: string, linhas: Linha[]): Linha[] {
    if (!selecao) return linhas.map(linha => ({ ...linha }));
    const agregados = Object.entries(selecao).filter(([, campo]) => is(campo, SQL));
    if (agregados.length) {
      // count() e max(coluna), do acrescentar: uma linha só.
      return [Object.fromEntries(agregados.map(([nome, campo]) => {
        const texto = dialeto.sqlToQuery(campo as InstanceType<typeof SQL>).sql;
        if (/^count\(\*\)$/.test(texto)) return [nome, linhas.length];
        const maximo = /^max\(`(\w+)`\.`(\w+)`\)$/.exec(texto);
        if (!maximo) throw new Error(`o fake não agrega: ${texto}`);
        const valores = linhas.map(linha => linha[chave(maximo[1], maximo[2])] as number);
        return [nome, valores.length ? Math.max(...valores) : null];
      }))];
    }
    return linhas.map(linha => Object.fromEntries(Object.entries(selecao).map(([nome, campo]) => {
      const coluna = campo as { name: string; table: never };
      const deQual = getTableName(coluna.table);
      const origem = deQual === tabela ? linha : relacionada(deQual, linha);
      return [nome, origem?.[chave(deQual, coluna.name)]];
    })));
  }

  // O que o UPDATE escreve: valor puro, ou as duas expressões que o serviço usa.
  function valorDe(tabela: string, campo: string, valor: unknown, linha: Linha): unknown {
    if (!is(valor, SQL)) return valor;
    const { sql, params } = dialeto.sqlToQuery(valor as InstanceType<typeof SQL>);
    const soma = /^`(\w+)`\.`(\w+)` \+ 1$/.exec(sql);
    if (soma) return (linha[chave(tabela, soma[2])] as number) + 1;
    if (/^coalesce\(`\w+`\.`\w+`, \?\)$/.test(sql)) return linha[campo] ?? params[0];
    throw new Error(`o fake não escreve: ${sql}`);
  }

  const api = {
    select: (selecao?: Record<string, unknown>) => consulta(selecao),
    update: (t: never) => ({ set: (valores: Linha) => ({ where: async (condicao: unknown) => {
      const tabela = getTableName(t);
      banco.escritas.push(`update ${tabela}`);
      const alvo = banco.tabelas[tabela].filter(linha => casa(tabela, condicao, linha));
      for (const linha of alvo) {
        const novos = Object.fromEntries(Object.entries(valores).map(([campo, valor]) => [campo, valorDe(tabela, campo, valor, linha)]));
        Object.assign(linha, novos);
      }
      return [{ affectedRows: alvo.length }];
    } }) }),
    insert: (t: never) => ({ values: async (valores: Linha | Linha[]) => {
      const tabela = getTableName(t);
      banco.escritas.push(`insert ${tabela}`);
      for (const linha of Array.isArray(valores) ? valores : [valores]) banco.tabelas[tabela].push({ ...linha });
    } }),
  };
  return {
    getDb: async () => null,
    exigirDb: async () => ({
      ...api,
      // A transação do banco: o que ela escreveu volta atrás quando ela lança.
      transaction: async <T>(trabalho: (tx: typeof api) => Promise<T>) => {
        const antes = structuredClone(banco.tabelas);
        try {
          return await trabalho(api);
        } catch (erro) {
          banco.tabelas = antes;
          throw erro;
        }
      },
    }),
  };
});

const servico = await import("./resumo-guardado");
const schema = await import("../drizzle/schema");
const { MENSAGEM_ITEM_NAO_ENCONTRADO, MENSAGEM_RESUMO_CHEIO, MENSAGEM_RESUMO_SENDO_GERADO } = await import("@shared/const");
const { ITENS_DO_RESUMO_MAX, SECOES_DO_RESUMO, secaoTemAssunto, secaoTemResponsavel } = await import("@shared/item-do-resumo");
const { MENSAGEM_REUNIAO_NAO_ENCONTRADA } = await import("./meeting-service");

const DONA = "dona-1";
const OUTRA = "dona-2";
const REUNIAO = "reuniao-1";
const RESUMO = "resumo-1";
const AGORA = 1_800_000_000_000;
const ANTES = AGORA - 60_000;

function item(extra: Linha = {}): Linha {
  return {
    id: `item-${Math.random()}`, summaryId: RESUMO, meetingId: REUNIAO, ownerId: DONA, section: "action", position: 0,
    subject: null, text: "{F2} envia a proposta", assignee: "{F2}", due: "até sexta-feira",
    excerpt: "eu mando a proposta até sexta-feira", startSeconds: 75, confidence: "0.900",
    status: "pending", done: false, decidedAt: null, doneAt: null, origin: "ai", editedAt: null,
    createdAt: ANTES, updatedAt: ANTES, ...extra,
  };
}

function montar({ reuniao = "ready", resumo = "ready" as string | null, itens = [] as Linha[] } = {}) {
  banco.tabelas = {
    meetings: [{ id: REUNIAO, ownerId: DONA, status: reuniao }],
    meeting_summaries: resumo ? [{ id: RESUMO, meetingId: REUNIAO, ownerId: DONA, status: resumo, version: 1, updatedAt: ANTES }] : [],
    meeting_summary_items: itens,
  };
  banco.travas = [];
  banco.escritas = [];
}

const itens = () => banco.tabelas.meeting_summary_items;
const versao = () => banco.tabelas.meeting_summaries[0]?.version;
const CAMPOS = { texto: "{F2} envia a proposta revisada", assunto: null, responsavel: "{F2}", prazo: "até sexta-feira" };

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(AGORA);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("editarItemDoResumo (H4f)", () => {
  it("o item pendente editado fica confirmado, com edited_at, e a versão do resumo sobe", async () => {
    const acao = item();
    montar({ itens: [acao] });
    await servico.editarItemDoResumo(DONA, acao.id as string, { ...CAMPOS, prazo: "até segunda-feira" });
    expect(itens()[0]).toMatchObject({
      text: "{F2} envia a proposta revisada", assignee: "{F2}", due: "até segunda-feira",
      status: "confirmed", decidedAt: AGORA, editedAt: AGORA, updatedAt: AGORA,
      // O que não é da edição fica: a origem, o trecho, o tempo e a caixa.
      origin: "ai", excerpt: "eu mando a proposta até sexta-feira", startSeconds: 75, done: false,
    });
    expect(versao()).toBe(2);
  });

  it("salvar sem mudar nada é confirmar: sem edited_at e sem subir a versão", async () => {
    const acao = item({ text: CAMPOS.texto });
    montar({ itens: [acao] });
    await servico.editarItemDoResumo(DONA, acao.id as string, CAMPOS);
    expect(itens()[0]).toMatchObject({ status: "confirmed", decidedAt: AGORA, editedAt: null });
    expect(versao()).toBe(1);
  });

  it("o item já confirmado: a data da decisão e a marca de feito ficam como estavam", async () => {
    const feita = item({ status: "confirmed", decidedAt: ANTES, done: true, doneAt: ANTES });
    montar({ itens: [feita] });
    await servico.editarItemDoResumo(DONA, feita.id as string, CAMPOS);
    expect(itens()[0]).toMatchObject({ status: "confirmed", decidedAt: ANTES, done: true, doneAt: ANTES, editedAt: AGORA });
  });

  it("o item ignorado editado volta confirmado", async () => {
    const ignorado = item({ status: "ignored", decidedAt: ANTES });
    montar({ itens: [ignorado] });
    await servico.editarItemDoResumo(DONA, ignorado.id as string, CAMPOS);
    expect(itens()[0]).toMatchObject({ status: "confirmed", decidedAt: AGORA });
  });

  it("cada seção guarda só os campos dela: assunto só na tarefa; responsável e prazo só na ação e na tarefa", async () => {
    const decisao = item({ section: "decision", assignee: null, due: null });
    const tarefa = item({ section: "task", subject: "Contrato" });
    const acao = item();
    montar({ itens: [decisao, tarefa, acao] });
    const tudo = { texto: "Texto novo", assunto: "Assunto novo", responsavel: "Maria", prazo: "amanhã" };
    for (const linha of [decisao, tarefa, acao]) await servico.editarItemDoResumo(DONA, linha.id as string, tudo);
    expect(itens().map(l => [l.section, l.subject, l.assignee, l.due])).toEqual([
      ["decision", null, null, null],
      ["task", "Assunto novo", "Maria", "amanhã"],
      ["action", null, "Maria", "amanhã"],
    ]);
  });

  it("só a dona: o item de outra conta é 'não existe', e nada muda", async () => {
    const acao = item();
    montar({ itens: [acao] });
    await expect(servico.editarItemDoResumo(OUTRA, acao.id as string, CAMPOS)).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
    expect(itens()[0]).toMatchObject({ status: "pending", text: "{F2} envia a proposta", editedAt: null });
    expect(banco.escritas).toEqual([]);
  });

  it.each([
    ["o resumo sendo refeito", { resumo: "pending" }],
    ["o resumo que falhou", { resumo: "failed" }],
    ["a reunião fora de 'ready'", { reuniao: "processing" }],
  ])("%s: CONFLICT, com a frase traduzível, e nada muda", async (_caso, estado) => {
    const acao = item();
    montar({ ...estado, itens: [acao] });
    await expect(servico.editarItemDoResumo(DONA, acao.id as string, CAMPOS)).rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    expect(itens()[0].status).toBe("pending");
    expect(versao()).toBe(1);
  });

  it("a reunião apagada: o item 'não existe'", async () => {
    const acao = item();
    montar({ reuniao: "deleted", itens: [acao] });
    await expect(servico.editarItemDoResumo(DONA, acao.id as string, CAMPOS)).rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_ITEM_NAO_ENCONTRADO });
  });

  it("trava a reunião e depois o resumo, a ordem da fila do resumo, antes de escrever", async () => {
    const acao = item();
    montar({ itens: [acao] });
    await servico.editarItemDoResumo(DONA, acao.id as string, { ...CAMPOS, texto: "outro" });
    expect(banco.travas).toEqual(["meetings", "meeting_summaries"]);
    expect(banco.escritas).toEqual(["update meeting_summary_items", "update meeting_summaries"]);
  });
});

describe("acrescentarItemDoResumo (H4f)", () => {
  it("entra no fim do resumo, confirmado, com a origem da dona, sem trecho, sem tempo e sem confiança; a versão sobe", async () => {
    montar({ itens: [item({ position: 0 }), item({ position: 7, section: "question", status: "ignored" })] });
    const id = await servico.acrescentarItemDoResumo(DONA, REUNIAO, "task", { texto: "{F1} revisa o contrato", assunto: "Contrato", responsavel: "{F1}", prazo: "dia 20" });
    const novo = itens().find(linha => linha.id === id);
    expect(novo).toMatchObject({
      summaryId: RESUMO, meetingId: REUNIAO, ownerId: DONA, section: "task", position: 8,
      subject: "Contrato", text: "{F1} revisa o contrato", assignee: "{F1}", due: "dia 20",
      excerpt: "", startSeconds: null, origin: "owner", status: "confirmed", done: false, decidedAt: AGORA,
      createdAt: AGORA, updatedAt: AGORA,
    });
    // Sem confiança: fica o padrão da coluna (0), e não um número inventado.
    expect(novo).not.toHaveProperty("confidence");
    expect(typeof id).toBe("string");
    expect(versao()).toBe(2);
  });

  it("no resumo sem itens, o primeiro fica na posição 0", async () => {
    montar();
    await servico.acrescentarItemDoResumo(DONA, REUNIAO, "action", { texto: "Ligar para o importador", assunto: null, responsavel: null, prazo: null });
    expect(itens().map(l => l.position)).toEqual([0]);
  });

  it("a seção sem responsável e sem assunto guarda só o texto", async () => {
    montar();
    await servico.acrescentarItemDoResumo(DONA, REUNIAO, "decision", { texto: "Fechar com a Alemanha", assunto: "X", responsavel: "Maria", prazo: "amanhã" });
    expect(itens()[0]).toMatchObject({ section: "decision", subject: null, assignee: null, due: null });
  });

  it("o teto: com o resumo cheio (ignorados inclusive), recusa com a frase traduzível, e nada é gravado", async () => {
    const cheio = Array.from({ length: ITENS_DO_RESUMO_MAX }, (_, i) => item({ position: i, status: i % 2 ? "ignored" : "confirmed" }));
    montar({ itens: cheio });
    await expect(servico.acrescentarItemDoResumo(DONA, REUNIAO, "action", { texto: "Mais um", assunto: null, responsavel: null, prazo: null }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: MENSAGEM_RESUMO_CHEIO });
    expect(itens()).toHaveLength(ITENS_DO_RESUMO_MAX);
    expect(versao()).toBe(1);
    // Um a menos ainda cabe.
    montar({ itens: cheio.slice(1) });
    await servico.acrescentarItemDoResumo(DONA, REUNIAO, "action", { texto: "O último", assunto: null, responsavel: null, prazo: null });
    expect(itens()).toHaveLength(ITENS_DO_RESUMO_MAX);
  });

  it.each([
    ["sem resumo", { resumo: null }],
    ["o resumo na fila", { resumo: "pending" }],
    ["o resumo que falhou", { resumo: "failed" }],
    ["a reunião fora de 'ready'", { reuniao: "processing" }],
  ])("%s: CONFLICT, com a frase traduzível, e nada é gravado", async (_caso, estado) => {
    montar(estado as never);
    await expect(servico.acrescentarItemDoResumo(DONA, REUNIAO, "action", { texto: "Novo", assunto: null, responsavel: null, prazo: null }))
      .rejects.toMatchObject({ code: "CONFLICT", message: MENSAGEM_RESUMO_SENDO_GERADO });
    expect(itens()).toEqual([]);
  });

  it("a reunião de outra dona, ou apagada: 'reunião não encontrada', e nada é gravado", async () => {
    montar();
    await expect(servico.acrescentarItemDoResumo(OUTRA, REUNIAO, "action", { texto: "Novo", assunto: null, responsavel: null, prazo: null }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
    montar({ reuniao: "deleted" });
    await expect(servico.acrescentarItemDoResumo(DONA, REUNIAO, "action", { texto: "Novo", assunto: null, responsavel: null, prazo: null }))
      .rejects.toMatchObject({ code: "NOT_FOUND", message: MENSAGEM_REUNIAO_NAO_ENCONTRADA });
    expect(itens()).toEqual([]);
  });

  it("trava a reunião e depois o resumo antes de contar e gravar", async () => {
    montar();
    await servico.acrescentarItemDoResumo(DONA, REUNIAO, "action", { texto: "Novo", assunto: null, responsavel: null, prazo: null });
    expect(banco.travas).toEqual(["meetings", "meeting_summaries"]);
    expect(banco.escritas).toEqual(["insert meeting_summary_items", "update meeting_summaries"]);
  });
});

describe("decidirItemDoResumo: o item escrito pela dona não volta a 'para conferir'", () => {
  it("Desfazer o ignorar de um item que a dona acrescentou o devolve confirmado", async () => {
    const daDona = item({ origin: "owner", status: "ignored", excerpt: "", startSeconds: null });
    montar({ itens: [daDona] });
    await servico.decidirItemDoResumo(DONA, daDona.id as string, "pending");
    expect(itens()[0]).toMatchObject({ status: "confirmed", decidedAt: AGORA });
  });

  it("o item da IA que a dona editou também volta confirmado", async () => {
    const editado = item({ status: "ignored", editedAt: ANTES });
    montar({ itens: [editado] });
    await servico.decidirItemDoResumo(DONA, editado.id as string, "pending");
    expect(itens()[0].status).toBe("confirmed");
  });

  it("o item da IA sem edição volta a pendente, como antes; ignorar o item da dona continua valendo", async () => {
    const daIA = item({ status: "ignored", decidedAt: ANTES });
    const daDona = item({ origin: "owner", status: "confirmed" });
    montar({ itens: [daIA, daDona] });
    await servico.decidirItemDoResumo(DONA, daIA.id as string, "pending");
    await servico.decidirItemDoResumo(DONA, daDona.id as string, "ignored");
    expect(itens().map(l => [l.origin, l.status, l.decidedAt])).toEqual([["ai", "pending", null], ["owner", "ignored", AGORA]]);
  });
});

describe("as seções do item (shared/item-do-resumo.ts)", () => {
  it("a lista é a do schema, na ordem do formato da cliente", () => {
    expect([...SECOES_DO_RESUMO]).toEqual(schema.meetingSummaryItems.section.enumValues);
  });

  it("responsável e prazo só na ação e na tarefa; assunto só na tarefa", () => {
    expect(SECOES_DO_RESUMO.filter(secaoTemResponsavel)).toEqual(["action", "task"]);
    expect(SECOES_DO_RESUMO.filter(secaoTemAssunto)).toEqual(["task"]);
  });
});
