import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, gte, isNotNull, ne, notInArray, type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Memória Inteligente (etapa 6) — três contratos que a versão anterior não tinha:
 *
 * 1. Fonte apagada leva o documento da memória junto. Antes, notas de um
 *    contato excluído continuavam pesquisáveis (e citáveis pela resposta da IA)
 *    para sempre.
 * 2. Ritmo: embeddings saem em LOTES (uma requisição por lote, que é o que o
 *    plano do Gemini conta), com teto de tempo por rodada; cota ou pico no meio
 *    não derruba nada — o que faltou fica pendente para a próxima rodada.
 * 3. Resiliência: a busca não morre quando a reindexação falha, e a resposta da
 *    IA fora do ar vira um aviso honesto — nunca o JSON cru do provedor no
 *    toast da usuária.
 *
 * O banco é simulado por identidade das tabelas do schema; as escritas ficam
 * capturadas para as asserções. O WHERE de cada consulta é renderizado pelo
 * dialeto do MySQL e APLICADO às linhas semeadas (`col` = ?, `col` is null /
 * is not null, `col` in (...) / not in (...), and/or, parênteses; qualquer
 * outro operador ou pedaço desconhecido LANÇA, para o dublê nunca ler um
 * predicado como algo parecido): sem isso, o filtro `owner_id = ? and
 * visibility = ?` dos contextos seria ignorado, um contexto do catálogo
 * viraria documento no teste sem virar no banco real, e os testes da
 * reverificação de 04/09 (participante em contexto do catálogo) não
 * distinguiriam o conserto do defeito. Os agregados da assinatura ({n, m})
 * são calculados sobre as linhas filtradas, e o DELETE também é aplicado.
 */

const embedWithGemini = vi.fn();
const embedManyWithGemini = vi.fn();
vi.mock("./gemini", () => ({
  embedWithGemini: (...args: unknown[]) => embedWithGemini(...args),
  embedManyWithGemini: (...args: unknown[]) => embedManyWithGemini(...args),
}));

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({
  invokeLLM: (...args: unknown[]) => invokeLLM(...args),
}));

// Marcador: uma tabela "fora do ar" faz o SELECT dela estourar.
const TABELA_FORA_DO_AR = Symbol("tabela fora do ar");
const tabelas = new Map<unknown, unknown>();
type Escrita = { sql: string; params: unknown[] };
const escritas = {
  inseridos: [] as Record<string, unknown>[],
  atualizados: [] as Record<string, unknown>[],
  // O WHERE de cada UPDATE e DELETE: qual documento foi atualizado e quais
  // foram apagados — o duplicado só se prova pelo id que saiu.
  alvosAtualizados: [] as Escrita[],
  apagados: [] as Escrita[],
  delecoes: 0,
};
// O WHERE de cada SELECT, renderizado pelo dialeto do MySQL (sem banco), fica
// guardado: o escopo por dona — a consulta dos vínculos e a dos contextos
// visíveis (dela OU catálogo) — também se prova olhando para ele.
const dialeto = new MySqlDialect();
const leituras: Array<{ tabela: unknown; sql: string; params: unknown[] }> = [];

// Avalia o WHERE renderizado contra uma linha semeada. Cobre o que o
// memory-service usa — `col` = ?, `col` is null / is not null, `col` in (?, ?)
// / not in (?, ?), and/or e parênteses — e é ESTRITO no resto: operador que o
// dublê não implementa (>=, <=, <>, <, >, !=) e qualquer pedaço que o
// tokenizador não reconhece LANÇAM, em vez de serem lidos como algo parecido.
// Antes, `not in (...)` era lido como `in` e `>= ?` como `= ?`, em silêncio:
// um teste com o predicado errado passaria (revisão da PR-D). Semântica do
// SQL: NULL = ? é falso, e NULL not in (...) também.
const TOKEN = /\s*(\(|\)|,|\?|\band\b|\bor\b|is not null|is null|not in|\bin\b|<>|>=|<=|!=|=|<|>|`[^`]+`\.`[^`]+`)/y;
function tokenizar(sql: string): string[] {
  const tokens: string[] = [];
  let posicao = 0;
  while (posicao < sql.length) {
    TOKEN.lastIndex = posicao;
    const encontrado = TOKEN.exec(sql);
    if (!encontrado) {
      const resto = sql.slice(posicao).trim();
      if (!resto) break;
      throw new Error(`o dublê de banco não reconhece "${resto.slice(0, 24)}" em: ${sql}`);
    }
    tokens.push(encontrado[1]);
    posicao = TOKEN.lastIndex;
  }
  return tokens;
}
function avaliarWhere(tabela: unknown, sql: string, params: unknown[], linha: Record<string, unknown>): boolean {
  const colunas = getTableColumns(tabela as never) as Record<string, { name: string }>;
  const chavePorNomeSql = new Map(Object.entries(colunas).map(([chave, coluna]) => [coluna.name, chave]));
  const tokens = tokenizar(sql);
  let posicao = 0;
  let parametro = 0;
  const valorDaColuna = (token: string | undefined) => {
    const nomeSql = token?.match(/`([^`]+)`$/)?.[1];
    if (!nomeSql) throw new Error(`o dublê de banco esperava uma coluna e achou "${token}" em: ${sql}`);
    return linha[chavePorNomeSql.get(nomeSql) ?? nomeSql];
  };
  const igual = (valor: unknown, esperado: unknown) => valor != null && String(valor) === String(esperado);
  const primario = (): boolean => {
    const token = tokens[posicao++];
    if (token === "(") {
      const resultado = ou();
      posicao += 1; // )
      return resultado;
    }
    const valor = valorDaColuna(token);
    const operador = tokens[posicao++];
    if (operador === "is null") return valor == null;
    if (operador === "is not null") return valor != null;
    if (operador === "=") {
      posicao += 1; // ?
      return igual(valor, params[parametro++]);
    }
    if (operador === "in" || operador === "not in") {
      posicao += 1; // (
      const esperados: unknown[] = [];
      while (tokens[posicao] !== ")") {
        if (tokens[posicao] === "?") esperados.push(params[parametro++]);
        posicao += 1;
      }
      posicao += 1; // )
      const contido = esperados.some(esperado => igual(valor, esperado));
      return operador === "in" ? contido : valor != null && !contido;
    }
    throw new Error(`o dublê de banco não implementa o operador "${operador}" (em "${token} ${operador}") em: ${sql}`);
  };
  const e = (): boolean => {
    let resultado = primario();
    while (tokens[posicao] === "and") { posicao += 1; resultado = primario() && resultado; }
    return resultado;
  };
  const ou = (): boolean => {
    let resultado = e();
    while (tokens[posicao] === "or") { posicao += 1; resultado = e() || resultado; }
    return resultado;
  };
  return ou();
}

const fakeDb = {
  // A assinatura de mudança pede agregados {n, m} que o fake precisa CALCULAR:
  // devolver linhas cruas faria cada tabela virar "undefined:undefined" e o
  // teste da assinatura passaria com qualquer implementação.
  select: (projecao?: Record<string, unknown>) => ({
    from: (tabela: unknown) => ({
      where: async (condicao?: SQL) => {
        const { sql, params } = condicao ? dialeto.sqlToQuery(condicao) : { sql: "", params: [] };
        leituras.push({ tabela, sql, params });
        const linhas = tabelas.get(tabela) ?? [];
        if (linhas === TABELA_FORA_DO_AR) throw new Error("tabela fora do ar");
        const cru = (linhas as Record<string, unknown>[]).filter(linha => !condicao || avaliarWhere(tabela, sql, params, linha));
        if (projecao && "n" in projecao && "m" in projecao) {
          return [{ n: cru.length, m: cru.reduce((maior, linha) => Math.max(maior, Number(linha.updatedAt ?? 0)), 0) }];
        }
        return cru;
      },
    }),
  }),
  insert: () => ({ values: async (valores: Record<string, unknown>) => { escritas.inseridos.push(valores); } }),
  update: () => ({ set: (valores: Record<string, unknown>) => ({ where: async (condicao: SQL) => {
    escritas.atualizados.push(valores);
    escritas.alvosAtualizados.push(dialeto.sqlToQuery(condicao));
  } }) }),
  // O DELETE também é aplicado às linhas semeadas: a busca que vem depois da
  // indexação precisa enxergar o índice já limpo, como no banco real.
  delete: (tabela: unknown) => ({ where: async (condicao: SQL) => {
    const { sql, params } = dialeto.sqlToQuery(condicao);
    escritas.delecoes += 1;
    escritas.apagados.push({ sql, params });
    const linhas = tabelas.get(tabela);
    if (Array.isArray(linhas)) tabelas.set(tabela, linhas.filter(linha => !avaliarWhere(tabela, sql, params, linha)));
  } }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb as never, exigirDb: async () => fakeDb as never }));

// Toda linha semeada é da dona por padrão: como o dublê aplica o WHERE, uma
// linha sem `ownerId` não passaria em `owner_id = ?` e sumiria do teste.
// `ownerId: null` explícito (contexto do catálogo) e `ownerId: "outra"` valem.
const semear = (tabela: unknown, linhas: Record<string, unknown>[]) =>
  tabelas.set(tabela, linhas.map(linha => ({ ownerId: "dona", ...linha })));

const schema = await import("../drizzle/schema");
const servico = await import("./memory-service");

const vetor768 = () => new Array(768).fill(0.1);

const docDeContato = (id: number, nome: string, extra: Record<string, unknown> = {}) => ({
  id: `doc-${id}`, ownerId: "dona", sourceType: "contact", sourceId: String(id),
  title: nome, content: `Contato: ${nome}`, metadata: {},
  embedding: vetor768(), contentHash: servico.buildMemoryHash(`Contato: ${nome}`),
  indexedAt: 1, createdAt: 1, updatedAt: 1, ...extra,
});

beforeEach(() => {
  tabelas.clear();
  tabelas.set(schema.privateContacts, []);
  tabelas.set(schema.contexts, []);
  tabelas.set(schema.meetingTranscripts, []);
  tabelas.set(schema.memoryDocuments, []);
  tabelas.set(schema.contactAssets, []);
  tabelas.set(schema.contactNeeds, []);
  tabelas.set(schema.contextParticipants, []);
  tabelas.set(schema.meetings, []);
  tabelas.set(schema.contactContexts, []);
  escritas.inseridos = []; escritas.atualizados = []; escritas.delecoes = 0;
  escritas.alvosAtualizados = []; escritas.apagados = [];
  leituras.length = 0;
  embedWithGemini.mockReset(); embedManyWithGemini.mockReset(); invokeLLM.mockReset();
  embedManyWithGemini.mockImplementation(async (textos: string[]) => textos.map(() => vetor768()));
  // A assinatura de mudança é estado de módulo; sem limpar, um teste herdaria
  // o "nada mudou" do anterior e a indexação nem rodaria.
  servico.esquecerAssinaturasDeIndexacao();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Memória — órfão não sobrevive à fonte", () => {
  it("apagar o contato remove o documento correspondente do índice", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana"), docDeContato(99, "Excluída")]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.removed).toBe(1);
    expect(escritas.delecoes).toBe(1);
    // a Ana não mudou: reaproveita o vetor, sem gastar embedding
    expect(resultado.skipped).toBe(1);
    expect(embedManyWithGemini).not.toHaveBeenCalled();
  });

  it("sem órfão, nenhum DELETE é disparado", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana")]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.removed).toBe(0);
    expect(escritas.delecoes).toBe(0);
  });

  it("órfão de reunião também sai: a chave usa meetingId, não o id da linha", async () => {
    // A reunião precisa existir (viva): transcrição sem reunião não vira
    // documento — e o conteúdo indexado leva o título dela.
    semear(schema.meetings, [{ id: "reuniao-1", title: "Com a vinícola", status: "ready" }]);
    semear(schema.meetingTranscripts, [{ id: "linha-1", meetingId: "reuniao-1", ownerId: "dona", transcript: "Reunião sobre vinho", language: "pt" }]);
    const conteudo = "Reunião: Com a vinícola\nReunião sobre vinho";
    const docReuniao = {
      id: "doc-r1", ownerId: "dona", sourceType: "meeting", sourceId: "reuniao-1",
      title: "Com a vinícola", content: conteudo, metadata: {},
      embedding: vetor768(), contentHash: servico.buildMemoryHash(conteudo),
      indexedAt: 1, createdAt: 1, updatedAt: 1,
    };
    const docOrfao = { ...docReuniao, id: "doc-r99", sourceId: "reuniao-apagada" };
    semear(schema.memoryDocuments, [docReuniao, docOrfao]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.removed).toBe(1);
    expect(resultado.skipped).toBe(1);
    expect(embedManyWithGemini).not.toHaveBeenCalled();
  });

  it("o que o contato possui/procura entra no documento da memória (etapa 9)", async () => {
    // "Quem exporta medicamentos?" mora no possui/procura, não no cargo — sem
    // estas linhas no documento, a pesquisa do requisito não tinha resposta.
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.contactAssets, [{ contactId: 1, tagLabel: "Exportar medicamentos" }]);
    semear(schema.contactNeeds, [{ contactId: 1, tagLabel: "Distribuidores na Europa" }]);

    await servico.indexOwnerMemory("dona");

    expect(escritas.inseridos).toHaveLength(1);
    const conteudo = escritas.inseridos[0].content as string;
    expect(conteudo).toContain("Possui / oferece: Exportar medicamentos");
    expect(conteudo).toContain("Procura: Distribuidores na Europa");
  });

  it("participantes do contexto entram no documento — 'quem conhece ministros' tem onde morar", async () => {
    semear(schema.contexts, [{ id: "ctx-1", name: "Fórum de Investimentos", visibility: "private" }]);
    semear(schema.contextParticipants, [{ contextId: "ctx-1", name: "Carlos Andrade", role: "Ministro da Saúde", company: null, notes: null }]);

    await servico.indexOwnerMemory("dona");

    const doc = escritas.inseridos.find(item => item.sourceType === "context");
    expect(String(doc?.content)).toContain("Participantes: Carlos Andrade, Ministro da Saúde");
  });

  it("o vínculo contato↔contexto entra nos DOIS documentos — 'quem conheço na Nigéria' acha a Ana", async () => {
    // Auditoria de 04/09 (etapa 9): a Ana tinha país vazio, o contexto ficava
    // na Nigéria e o vínculo dizia onde foi o encontro — nada disso chegava ao
    // documento da Ana, e o documento do contexto não a nomeava.
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Souza" }]);
    semear(schema.contexts, [{ id: "ctx-1", name: "Missão Comercial Lagos", visibility: "private", city: "Lagos", country: "Nigéria" }]);
    semear(schema.contactContexts, [{ contactId: 1, contextId: "ctx-1", city: "Lagos", country: "Nigéria", eventDate: "2026-08-20", notes: "conheci no jantar da embaixada", relationshipType: "profissional" }]);

    await servico.indexOwnerMemory("dona");

    const contato = escritas.inseridos.find(item => item.sourceType === "contact");
    expect(String(contato?.content)).toContain("Onde conheci: Missão Comercial Lagos (Lagos · Nigéria) 2026-08-20 conheci no jantar da embaixada");
    const contexto = escritas.inseridos.find(item => item.sourceType === "context");
    expect(String(contexto?.content)).toContain("Contatos vinculados: Ana Souza, conheci no jantar da embaixada");
  });

  it("vínculo a contexto do CATÁLOGO (sem dona) também nomeia o contexto no documento do contato", async () => {
    // Revisão da PR: privateContexts só tem os contextos da dona; o nome de um
    // contexto de catálogo vinculado ficava de fora — "quem conheci na Web
    // Summit?" não achava ninguém.
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Souza" }]);
    semear(schema.contexts, [{ id: "cat-1", ownerId: null, name: "Web Summit Lisboa", visibility: "public" }]);
    semear(schema.contactContexts, [{ contactId: 1, contextId: "cat-1", city: "Lisboa", country: "Portugal" }]);

    await servico.indexOwnerMemory("dona");

    const contato = escritas.inseridos.find(item => item.sourceType === "contact");
    expect(String(contato?.content)).toContain("Onde conheci: Web Summit Lisboa (Lisboa · Portugal)");
  });

  it("a consulta dos vínculos é DA DONA — WHERE owner_id = ? com a dona, na assinatura e na coleta", async () => {
    // O dublê aplica o WHERE às linhas semeadas, mas a asserção sobre o SQL
    // renderizado continua: é ela que prova que o escopo está NA CONSULTA — nos
    // agregados da assinatura e na coleta — e não num filtro em memória depois.
    // Sem a dona no WHERE, os vínculos (e as notas do encontro) de OUTRA dona
    // entrariam nos documentos desta. Mutante provado na revisão da PR.
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Souza" }]);
    semear(schema.contactContexts, [{ contactId: 1, contextId: "ctx-1", country: "Nigéria" }]);

    await servico.indexOwnerMemory("dona");

    const consultas = leituras.filter(leitura => leitura.tabela === schema.contactContexts);
    // duas leituras: o count/max da assinatura e a coleta das fontes
    expect(consultas).toHaveLength(2);
    for (const consulta of consultas) {
      expect(consulta.sql).toBe("`contact_contexts`.`owner_id` = ?");
      expect(consulta.params).toEqual(["dona"]);
    }
  });

  it("o nome do contexto vinculado vem só do que a dona pode ver: dela OU do catálogo (owner_id IS NULL)", async () => {
    // Sem o `or(..., isNull)`, o contexto de catálogo some do documento ("Onde
    // conheci: (Lisboa · Portugal)" sem nome); com um `in` sem a dona, o nome de
    // um contexto privado de OUTRA dona (vínculo legado) vazaria para cá.
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Souza" }]);
    semear(schema.contexts, [{ id: "cat-1", ownerId: null, name: "Web Summit Lisboa", visibility: "public" }]);
    semear(schema.contactContexts, [{ contactId: 1, contextId: "cat-1", city: "Lisboa", country: "Portugal" }]);

    await servico.indexOwnerMemory("dona");

    const porIds = leituras.find(leitura => leitura.tabela === schema.contexts && leitura.sql.includes(" in ("));
    expect(porIds?.sql).toBe("(`contexts`.`id` in (?) and (`contexts`.`owner_id` = ? or `contexts`.`owner_id` is null))");
    expect(porIds?.params).toEqual(["cat-1", "dona"]);
  });

  it("vínculo novo muda a assinatura: o contato é reindexado sem outra edição", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Souza", updatedAt: 10 }]);
    semear(schema.contexts, [{ id: "ctx-1", name: "Missão Comercial Lagos", visibility: "private", updatedAt: 5 }]);
    await servico.indexOwnerMemory("dona");
    embedManyWithGemini.mockClear();
    semear(schema.contactContexts, [{ contactId: 1, contextId: "ctx-1", country: "Nigéria", updatedAt: 20 }]);

    const segunda = await servico.indexOwnerMemory("dona");

    expect(segunda.indexed).toBeGreaterThanOrEqual(1);
    expect(embedManyWithGemini).toHaveBeenCalled();
    const contato = escritas.atualizados.concat(escritas.inseridos).find(item => String(item.content ?? "").includes("Onde conheci: Missão Comercial Lagos (Nigéria)"));
    expect(contato).toBeDefined();
  });

  it("a transcrição ganha o título da reunião — deixa de ser um texto anônimo", async () => {
    semear(schema.meetingTranscripts, [{ meetingId: "m-1", transcript: "Falamos de vinho e logística", language: "pt" }]);
    semear(schema.meetings, [{ id: "m-1", title: "Reunião com a vinícola" }]);

    await servico.indexOwnerMemory("dona");

    const doc = escritas.inseridos.find(item => item.sourceType === "meeting");
    expect(doc?.title).toBe("Reunião com a vinícola");
    expect(String(doc?.content)).toContain("Reunião: Reunião com a vinícola");
    // O "Abrir fonte" leva ao detalhe da reunião, não à lista (30/10/2026).
    expect(doc?.metadata).toMatchObject({ href: "/meetings/m-1", meetingId: "m-1" });
  });

  it("transcrição sem reunião VIVA não vira documento: nem a de reunião sumida, nem a de reunião 'deleted'", async () => {
    // Reverificação de 04/09 (etapa 3): a exclusão durante o processamento
    // deixava a transcrição órfã, e a memória a indexava com o título de
    // reserva — a fala de uma reunião que a dona mandou apagar respondia a
    // buscas. O documento antigo da reunião excluída vira órfão e sai.
    semear(schema.meetingTranscripts, [
      { meetingId: "sumida", transcript: "Falamos de vinho com a Ana", language: "pt" },
      { meetingId: "marcada", transcript: "Falamos de logística com o Carlos", language: "pt" },
      { meetingId: "viva", transcript: "Falamos de exportação", language: "pt" },
    ]);
    semear(schema.meetings, [
      { id: "marcada", title: "Excluída no meio", status: "deleted" },
      { id: "viva", title: "Reunião viva", status: "ready" },
    ]);
    const docDaMarcada = {
      id: "doc-marcada", ownerId: "dona", sourceType: "meeting", sourceId: "marcada",
      title: "Excluída no meio", content: "Reunião: Excluída no meio\nFalamos de logística com o Carlos", metadata: {},
      embedding: vetor768(), contentHash: servico.buildMemoryHash("Reunião: Excluída no meio\nFalamos de logística com o Carlos"),
      indexedAt: 1, createdAt: 1, updatedAt: 1,
    };
    semear(schema.memoryDocuments, [docDaMarcada]);

    const resultado = await servico.indexOwnerMemory("dona");

    const documentos = escritas.inseridos.filter(item => item.sourceType === "meeting");
    expect(documentos.map(item => item.sourceId)).toEqual(["viva"]);
    expect(JSON.stringify(escritas.inseridos)).not.toContain("Ana");
    expect(JSON.stringify(escritas.inseridos)).not.toContain("Carlos");
    expect(resultado.removed).toBe(1);
  });

  it("nada mudou desde a última rodada: a seguinte nem carrega as fontes (assinatura)", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    await servico.indexOwnerMemory("dona");
    embedManyWithGemini.mockClear();

    const segunda = await servico.indexOwnerMemory("dona");

    expect(segunda.indexed).toBe(0);
    expect(embedManyWithGemini).not.toHaveBeenCalled();
  });

  it("edição sem linha nova também muda a assinatura: updatedAt maior reindexa", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", updatedAt: 10 }]);
    await servico.indexOwnerMemory("dona");
    embedManyWithGemini.mockClear();
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Paula", updatedAt: 20 }]);

    const segunda = await servico.indexOwnerMemory("dona");

    expect(segunda.indexed).toBe(1);
    expect(embedManyWithGemini).toHaveBeenCalled();
  });

  it("rodada interrompida NÃO congela o índice: a assinatura só é lembrada completa", async () => {
    // Sem o guarda de pendência, a primeira rodada (cota estourada) carimbaria
    // a assinatura e toda busca seguinte pularia a retomada prometida.
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }, { id: 2, fullName: "Bia" }]);
    embedManyWithGemini.mockRejectedValueOnce(new Error("cota esgotada"));

    const primeira = await servico.indexOwnerMemory("dona");
    expect(primeira.pending).toBe(2);

    const segunda = await servico.indexOwnerMemory("dona");

    expect(segunda.indexed).toBe(2);
    expect(segunda.pending).toBe(0);
  });

  it("cada documento recebe o vetor do seu próprio texto (ordem do lote)", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }, { id: 2, fullName: "Bia" }]);
    embedManyWithGemini.mockImplementation(async (textos: string[]) => textos.map((_, posicao) => {
      const marcado = new Array(768).fill(0);
      marcado[posicao] = 1;
      return marcado;
    }));

    await servico.indexOwnerMemory("dona");

    const porConteudo = new Map(escritas.inseridos.map(linha => [linha.content as string, linha.embedding as number[]]));
    expect(porConteudo.get("Contato: Ana")?.[0]).toBe(1);
    expect(porConteudo.get("Contato: Bia")?.[1]).toBe(1);
  });

  it("vetor da era OpenAI (1536) é reindexado sem apagar o documento", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana", { embedding: new Array(1536).fill(0.1) })]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.indexed).toBe(1);
    expect(escritas.atualizados).toHaveLength(1);
    expect((escritas.atualizados[0] as { embedding: number[] }).embedding).toHaveLength(768);
    expect(escritas.delecoes).toBe(0);
  });
});

describe("Memória — ritmo dos embeddings", () => {
  it("cota no meio da indexação não derruba: o resto fica pendente", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }, { id: 2, fullName: "Bia" }]);
    embedManyWithGemini.mockRejectedValue(new Error("cota esgotada"));

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.indexed).toBe(0);
    expect(resultado.pending).toBe(2);
    expect(escritas.inseridos).toHaveLength(0);
  });

  it("acima do teto: lotes de até 16 com pausa, excedente avisado, e o documento além do teto NÃO vira órfão", async () => {
    vi.useFakeTimers();
    const muitos = Array.from({ length: 801 }, (_, indice) => ({ id: indice + 1, fullName: `Contato ${indice + 1}` }));
    semear(schema.privateContacts, muitos);
    // O contato 801 fica fora do índice pelo teto — mas a fonte EXISTE, então o
    // documento antigo dele não pode ser apagado como órfão.
    semear(schema.memoryDocuments, [docDeContato(801, "Contato 801")]);

    const promessa = servico.indexOwnerMemory("dona");
    // a pausa entre lotes é real: sem avançar o relógio, só o primeiro lote sai
    await vi.advanceTimersByTimeAsync(0);
    expect(embedManyWithGemini).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    const resultado = await promessa;

    expect(resultado.total).toBe(800);
    expect(resultado.truncated).toBe(1);
    expect(resultado.indexed).toBe(800);
    expect(resultado.removed).toBe(0);
    expect(escritas.delecoes).toBe(0);
    // 800 documentos em lotes de 16 = 50 requisições — nunca uma por documento
    expect(embedManyWithGemini).toHaveBeenCalledTimes(50);
    const maiorLote = Math.max(...embedManyWithGemini.mock.calls.map(chamada => (chamada[0] as string[]).length));
    expect(maiorLote).toBeLessThanOrEqual(16);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("acima do teto"));

    // A rodada seguinte cai no atalho da assinatura — e o truncamento continua
    // visível, em vez do zero fixo que o atalho devolveria sem memória dele.
    const seguinte = await servico.indexOwnerMemory("dona");
    expect(seguinte.indexed).toBe(0);
    expect(seguinte.truncated).toBe(1);
  });

  it("orçamento de tempo estourado: para com pendência em vez de segurar a requisição", async () => {
    vi.useFakeTimers();
    const contatos = Array.from({ length: 32 }, (_, indice) => ({ id: indice + 1, fullName: `C${indice + 1}` }));
    semear(schema.privateContacts, contatos);
    embedManyWithGemini.mockImplementation(async (textos: string[]) => {
      await new Promise(resolve => setTimeout(resolve, 31_000));
      return textos.map(() => vetor768());
    });

    const promessa = servico.indexOwnerMemory("dona");
    await vi.advanceTimersByTimeAsync(31_000);
    const resultado = await promessa;

    expect(resultado.indexed).toBe(16);
    expect(resultado.pending).toBe(16);
  });
});

describe("Memória — busca e resposta resilientes", () => {
  it("busca segue funcionando quando os embeddings de indexação falham", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana", { contentHash: "hash-desatualizado" })]);
    embedManyWithGemini.mockRejectedValue(new Error("IA fora do ar"));
    embedWithGemini.mockResolvedValue(vetor768());

    const { hits, pending } = await servico.semanticSearch("dona", "quem é a Ana?");

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Ana");
    expect(hits[0].score).toBeCloseTo(1);
    // e a pendência não é segredo: a busca conta o que ficou por indexar
    expect(pending).toBe(1);
  });

  it("até um erro inesperado na reindexação não mata a busca", async () => {
    tabelas.set(schema.privateContacts, TABELA_FORA_DO_AR as never);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana")]);
    embedWithGemini.mockResolvedValue(vetor768());

    const { hits } = await servico.semanticSearch("dona", "quem é a Ana?");

    expect(hits).toHaveLength(1);
  });

  it("LLM fora do ar vira aviso honesto: hits continuam e nada de JSON cru", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana")]);
    embedWithGemini.mockResolvedValue(vetor768());
    invokeLLM.mockRejectedValue(new Error('LLM invoke failed: 429 Too Many Requests – {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'));

    const resultado = await servico.searchAndAnswer("dona", "quem é a Ana?");

    expect(resultado.hits).toHaveLength(1);
    expect(resultado.answer).toBe(servico.AI_UNAVAILABLE_ANSWER);
    expect(resultado.answer).not.toMatch(/429|RESOURCE_EXHAUSTED/);
  });

  it("LLM saudável continua respondendo normalmente", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana" }]);
    semear(schema.memoryDocuments, [docDeContato(1, "Ana")]);
    embedWithGemini.mockResolvedValue(vetor768());
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "A Ana é sua conexão. [1]" } }] });

    const resultado = await servico.searchAndAnswer("dona", "quem é a Ana?");

    expect(resultado.answer).toBe("A Ana é sua conexão. [1]");
  });
});

describe("Memória — documento duplicado da mesma fonte (reverificação de 04/09, etapa 6)", () => {
  // A chave (owner, sourceType, sourceId) não tem índice único e rodadas
  // concorrentes já duplicaram documentos. O Map ficava com o último da lista
  // e o outro nunca mais era tocado: o duplicado com as notas que a dona já
  // apagou seguia pesquisável e citável pela resposta da IA.
  const conteudoAtual = "Contato: Ana\nNotas: prefere reuniões pela manhã";
  const conteudoAntigo = "Contato: Ana\nNotas: CPF 123.456.789-00, dívida com o banco";
  const docDaAna = (id: string, content: string, indexedAt: number) => ({
    id, ownerId: "dona", sourceType: "contact", sourceId: "1", title: "Ana", content, metadata: {},
    embedding: vetor768(), contentHash: servico.buildMemoryHash(content), indexedAt, createdAt: 1, updatedAt: 1,
  });

  it("o duplicado obsoleto sai do índice; sobrevive o de indexedAt maior — e a busca não devolve mais a nota apagada", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", notes: "prefere reuniões pela manhã" }]);
    // o obsoleto vem POR ÚLTIMO na lista: quem escolhesse "o último lido" (o
    // Map antigo) ficaria com ele, não com o mais recente
    semear(schema.memoryDocuments, [docDaAna("doc-novo", conteudoAtual, 2), docDaAna("doc-antigo", conteudoAntigo, 1)]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.removed).toBe(1);
    expect(resultado.skipped).toBe(1);
    expect(embedManyWithGemini).not.toHaveBeenCalled();
    // um único DELETE, da dona, só com o obsoleto
    expect(escritas.apagados).toHaveLength(1);
    expect(escritas.apagados[0].sql).toBe("(`memory_documents`.`owner_id` = ? and `memory_documents`.`id` in (?))");
    expect(escritas.apagados[0].params).toEqual(["dona", "doc-antigo"]);

    embedWithGemini.mockResolvedValue(vetor768());
    const { hits } = await servico.semanticSearch("dona", "quem é a Ana?");
    expect(hits.map(hit => hit.id)).toEqual(["doc-novo"]);
    expect(JSON.stringify(hits)).not.toContain("CPF 123.456.789-00");
  });

  it("os dois com hash velho e a fonte mudou: um único UPDATE, no sobrevivente, e o outro é apagado", async () => {
    const velho = "Contato: Ana\nNotas: segredo antigo";
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", notes: "nota nova" }]);
    // doc-a é o mais recente e vem PRIMEIRO: o Map antigo atualizaria doc-b
    semear(schema.memoryDocuments, [docDaAna("doc-a", velho, 5), docDaAna("doc-b", velho, 3)]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado).toMatchObject({ indexed: 1, removed: 1, skipped: 0 });
    expect(escritas.atualizados).toHaveLength(1);
    expect(escritas.atualizados[0].content).toBe("Contato: Ana\nNotas: nota nova");
    expect(escritas.alvosAtualizados[0].params).toEqual(["doc-a", "dona"]);
    expect(escritas.apagados).toHaveLength(1);
    expect(escritas.apagados[0].params).toEqual(["dona", "doc-b"]);
  });

  it("órfão e duplicado saem no MESMO DELETE, e `removed` conta os dois", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", notes: "prefere reuniões pela manhã" }]);
    semear(schema.memoryDocuments, [
      docDaAna("doc-antigo", conteudoAntigo, 1), docDaAna("doc-novo", conteudoAtual, 2), docDeContato(99, "Excluída"),
    ]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.removed).toBe(2);
    expect(escritas.apagados).toHaveLength(1);
    expect(escritas.apagados[0].params).toEqual(["dona", "doc-99", "doc-antigo"]);
  });

  it("duplicado criado por outra rodada DEPOIS do retrato não é apagado por esta", async () => {
    // A guarda `createdAt < snapshotAt` dos órfãos vale para o duplicado: uma
    // rodada concorrente que acabou de inserir não pode ter o documento
    // apagado pela rodada mais antiga.
    vi.useFakeTimers({ now: 1_000 });
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", notes: "prefere reuniões pela manhã" }]);
    semear(schema.memoryDocuments, [
      docDaAna("doc-velho", conteudoAtual, 2),
      { ...docDaAna("doc-da-outra-rodada", conteudoAtual, 1), createdAt: 5_000 },
    ]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.removed).toBe(0);
    expect(escritas.delecoes).toBe(0);
  });

  // Revisão adversarial da PR-D: empate em indexedAt deixava o sobrevivente ao
  // sabor da ordem do SELECT (sem ORDER BY, o MySQL não a garante): com `>`
  // sobrevivia o primeiro lido, com `>=` o último — duas rodadas podiam
  // escolher sobreviventes diferentes para a mesma dupla. Cada cenário roda
  // com as duas ordens de leitura e exige o MESMO sobrevivente.
  const sobreviventeComOrdem = async (docs: Record<string, unknown>[]) => {
    servico.esquecerAssinaturasDeIndexacao();
    escritas.apagados = []; escritas.delecoes = 0;
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", notes: "prefere reuniões pela manhã" }]);
    semear(schema.memoryDocuments, docs);
    const resultado = await servico.indexOwnerMemory("dona");
    expect(resultado.removed).toBe(1);
    expect(escritas.apagados).toHaveLength(1);
    const [, apagado] = escritas.apagados[0].params;
    return docs.map(doc => doc.id).find(id => id !== apagado);
  };

  it("empate em indexedAt e createdAt: sobrevive o id maior, lido em [A,B] ou em [B,A]", async () => {
    const a = docDaAna("doc-a", conteudoAtual, 2);
    const b = docDaAna("doc-b", conteudoAtual, 2);
    expect(await sobreviventeComOrdem([a, b])).toBe("doc-b");
    expect(await sobreviventeComOrdem([b, a])).toBe("doc-b");
  });

  it("empate só em indexedAt: createdAt maior decide antes do id, em qualquer ordem", async () => {
    // "doc-z" tem o id maior, mas "doc-a" foi criado depois: createdAt vence
    const z = { ...docDaAna("doc-z", conteudoAtual, 2), createdAt: 1 };
    const a = { ...docDaAna("doc-a", conteudoAtual, 2), createdAt: 3 };
    expect(await sobreviventeComOrdem([z, a])).toBe("doc-a");
    expect(await sobreviventeComOrdem([a, z])).toBe("doc-a");
  });

  it("'Atualizar memória' ignora a assinatura lembrada: apaga o duplicado nascido depois dela — e a busca segue usando o cache", async () => {
    // A assinatura só enxerga as tabelas-fonte; um duplicado inserido em
    // memory_documents por outra rodada (outro processo) não a muda. A busca
    // pode viver com isso até a próxima edição; o clique explícito, não
    // (revisão da PR-D).
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana", notes: "prefere reuniões pela manhã" }]);
    semear(schema.memoryDocuments, [docDaAna("doc-novo", conteudoAtual, 2)]);
    await servico.indexOwnerMemory("dona"); // lembra a assinatura
    semear(schema.memoryDocuments, [docDaAna("doc-novo", conteudoAtual, 2), docDaAna("doc-duplicado", conteudoAntigo, 1)]);
    leituras.length = 0;
    embedWithGemini.mockResolvedValue(vetor768());

    const busca = await servico.semanticSearch("dona", "quem é a Ana?");

    // a busca caiu no atalho: leu só o agregado da assinatura (1 leitura de
    // private_contacts, não 2) e não apagou nada — o duplicado ainda aparece
    expect(leituras.filter(leitura => leitura.tabela === schema.privateContacts)).toHaveLength(1);
    expect(escritas.delecoes).toBe(0);
    expect(busca.hits.map(hit => hit.id).sort()).toEqual(["doc-duplicado", "doc-novo"]);

    const reindex = await servico.indexOwnerMemory("dona", { forcar: true });

    expect(reindex.removed).toBe(1);
    expect(escritas.apagados).toHaveLength(1);
    expect(escritas.apagados[0].params).toEqual(["dona", "doc-duplicado"]);
    const depois = await servico.semanticSearch("dona", "quem é a Ana?");
    expect(depois.hits.map(hit => hit.id)).toEqual(["doc-novo"]);
  });

  it("'Atualizar memória' no meio de uma rodada em voo não se contenta com ela: espera-a e abre a própria rodada", async () => {
    // A rodada em voo (de uma busca) fotografou a base ANTES do clique.
    // Devolver o resultado dela era o comportamento anterior: o duplicado que
    // nasceu durante a rodada ficava para a próxima edição.
    semear(schema.privateContacts, [
      { id: 1, fullName: "Ana", notes: "prefere reuniões pela manhã" },
      { id: 2, fullName: "Bia" }, // sem documento: obriga a rodada a esperar o embedding
    ]);
    semear(schema.memoryDocuments, [docDaAna("doc-novo", conteudoAtual, 2)]);
    let liberar!: () => void;
    embedManyWithGemini.mockImplementationOnce(async (textos: string[]) => {
      await new Promise<void>(resolve => { liberar = resolve; });
      return textos.map(() => vetor768());
    });

    const emVoo = servico.indexOwnerMemory("dona");
    await new Promise(resolve => setImmediate(resolve)); // até a rodada parar no embedding
    expect(embedManyWithGemini).toHaveBeenCalledTimes(1);
    // outra rodada (outro processo) inseriu um duplicado da Ana enquanto isso
    (tabelas.get(schema.memoryDocuments) as Record<string, unknown>[]).push(docDaAna("doc-duplicado", conteudoAntigo, 1));
    const forcada = servico.indexOwnerMemory("dona", { forcar: true });
    liberar();
    const [primeira, segunda] = await Promise.all([emVoo, forcada]);

    expect(primeira).toMatchObject({ indexed: 1, removed: 0 });
    expect(segunda.removed).toBe(1);
    expect(escritas.apagados.map(escrita => escrita.params)).toEqual([["dona", "doc-duplicado"]]);
  });
});

describe("Memória — participante em contexto do CATÁLOGO (reverificação de 04/09, etapa 9)", () => {
  // A tela oferece "Adicionar participante" em contexto do catálogo e o router
  // aceita (contextIsVisible admite owner_id NULL), mas o documento de contexto
  // só existia para contexto privado da dona: o participante — dado dela —
  // não caía em documento nenhum e "quem conhece ministros?" não o achava.
  const webSummit = {
    id: "cat-1", ownerId: null, name: "Web Summit Lisboa", visibility: "public",
    eventDate: "2026-11-03", city: "Lisboa", country: "Portugal",
    description: "Maior evento de tecnologia da Europa", notes: "nota global do catálogo",
  };

  it("vira documento DA DONA, com o que é dela e sem description/notes do catálogo — e o WHERE aceita owner_id is null", async () => {
    semear(schema.contexts, [webSummit]);
    semear(schema.contextParticipants, [{ contextId: "cat-1", name: "Carlos Andrade", role: "Ministro da Saúde", company: null, notes: null }]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.total).toBe(1);
    const doc = escritas.inseridos.find(item => item.sourceType === "context");
    expect(doc).toMatchObject({ ownerId: "dona", sourceType: "context", sourceId: "cat-1", title: "Web Summit Lisboa" });
    const conteudo = String(doc?.content);
    expect(conteudo).toContain("Contexto: Web Summit Lisboa");
    expect(conteudo).toContain("Data: 2026-11-03");
    expect(conteudo).toContain("Lisboa · Portugal");
    expect(conteudo).toContain("Participantes: Carlos Andrade, Ministro da Saúde");
    expect(conteudo).not.toContain("Maior evento de tecnologia");
    expect(conteudo).not.toContain("nota global do catálogo");
    // a consulta que traz o contexto é a dos ids referenciados, dela OU catálogo
    const porIds = leituras.find(leitura => leitura.tabela === schema.contexts && leitura.sql.includes(" in ("));
    expect(porIds?.sql).toBe("(`contexts`.`id` in (?) and (`contexts`.`owner_id` = ? or `contexts`.`owner_id` is null))");
    expect(porIds?.params).toEqual(["cat-1", "dona"]);
  });

  it("vínculo dela a contexto do catálogo também gera o documento do contexto, nomeando o contato", async () => {
    semear(schema.privateContacts, [{ id: 1, fullName: "Ana Souza" }]);
    semear(schema.contexts, [webSummit]);
    semear(schema.contactContexts, [{ contactId: 1, contextId: "cat-1", notes: "painel de saúde digital" }]);

    await servico.indexOwnerMemory("dona");

    const contexto = escritas.inseridos.find(item => item.sourceType === "context");
    expect(String(contexto?.content)).toContain("Contatos vinculados: Ana Souza, painel de saúde digital");
  });

  it("catálogo sem nada dela (participante de OUTRA dona) não vira documento", async () => {
    semear(schema.contexts, [webSummit]);
    semear(schema.contextParticipants, [{ ownerId: "outra", contextId: "cat-1", name: "Carlos Andrade", role: "Ministro" }]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.total).toBe(0);
    expect(escritas.inseridos).toHaveLength(0);
  });

  it("contexto PRIVADO de outra dona com participante dela (vínculo legado) continua fora", async () => {
    semear(schema.contexts, [{ id: "ctx-alheio", ownerId: "outra", name: "Jantar da Beatriz", visibility: "private" }]);
    semear(schema.contextParticipants, [{ contextId: "ctx-alheio", name: "Fulana" }]);

    const resultado = await servico.indexOwnerMemory("dona");

    expect(resultado.total).toBe(0);
    expect(escritas.inseridos).toHaveLength(0);
    expect(JSON.stringify(escritas.inseridos)).not.toContain("Jantar da Beatriz");
  });

  it("renomear/editar o contexto do CATÁLOGO muda a assinatura: o documento da dona é reindexado sem outra edição dela", async () => {
    // O documento da dona carrega nome/data/cidade/país do catálogo, mas a
    // assinatura só via as tabelas filtradas pela dona (owner_id = ?): o
    // catálogo (owner_id NULL) ficava fora, e a "Web Summit Lisboa" renomeada
    // continuava com o nome velho no índice até a dona editar outra coisa
    // (revisão da PR-D).
    semear(schema.contexts, [{ ...webSummit, updatedAt: 5 }]);
    semear(schema.contextParticipants, [{ contextId: "cat-1", name: "Carlos Andrade", role: "Ministro da Saúde", updatedAt: 3 }]);
    await servico.indexOwnerMemory("dona");
    embedManyWithGemini.mockClear();
    semear(schema.contexts, [{ ...webSummit, name: "Web Summit Lisboa 2026", updatedAt: 20 }]);

    const segunda = await servico.indexOwnerMemory("dona");

    expect(segunda.indexed).toBe(1);
    expect(embedManyWithGemini).toHaveBeenCalledTimes(1);
    // o dublê não grava o INSERT da primeira rodada em memory_documents, então
    // a segunda insere de novo em vez de atualizar: o que importa é o conteúdo
    const reindexado = escritas.atualizados.concat(escritas.inseridos)
      .find(item => String(item.content ?? "").includes("Contexto: Web Summit Lisboa 2026"));
    expect(reindexado).toBeDefined();
    // o agregado do catálogo é uma leitura própria de contexts, com owner_id IS NULL, em cada rodada
    const doCatalogo = leituras.filter(leitura => leitura.tabela === schema.contexts && leitura.sql === "`contexts`.`owner_id` is null");
    expect(doCatalogo).toHaveLength(2);
  });
});

describe("Memória — quanto de cada fonte chega ao LLM (reverificação de 04/09, etapa 9)", () => {
  const hitDeReuniao = (numero: number, content: string) => ({
    id: `doc-r${numero}`, sourceType: "meeting" as const, sourceId: `m-${numero}`,
    title: `Reunião ${numero}`, content, metadata: {}, score: 1 - numero / 100,
  });

  it("o fato dito no FIM de uma transcrição de 3.000+ caracteres chega ao prompt", async () => {
    // O corte único de 2.500 deixava o LLM com os ~3 primeiros minutos: a
    // reunião aparecia como fonte e a resposta dizia que a informação não
    // existia.
    const enchimento = "Conversa introdutória sobre a agenda. ".repeat(80); // ~3.000 chars
    const fato = "o preço acordado foi 42 euros por caixa";
    const transcricao = `${enchimento}${fato}`;
    const conteudo = `Reunião: Vinícola\n${transcricao}`;
    semear(schema.meetingTranscripts, [{ meetingId: "m-1", transcript: transcricao, language: "pt" }]);
    semear(schema.meetings, [{ id: "m-1", title: "Vinícola" }]);
    semear(schema.memoryDocuments, [{
      id: "doc-r1", ownerId: "dona", sourceType: "meeting", sourceId: "m-1", title: "Vinícola",
      content: conteudo, metadata: {}, embedding: vetor768(), contentHash: servico.buildMemoryHash(conteudo),
      indexedAt: 1, createdAt: 1, updatedAt: 1,
    }]);
    embedWithGemini.mockResolvedValue(vetor768());
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "42 euros por caixa. [1]" } }] });

    const resultado = await servico.searchAndAnswer("dona", "qual foi o preço por caixa combinado com a vinícola?");

    expect(resultado.hits).toHaveLength(1);
    const prompt = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const contextoEnviado = prompt.messages.find(mensagem => mensagem.role === "user")!.content;
    expect(contextoEnviado).toContain(fato);
  });

  it("janela por fonte: reunião até 12.000, contato e contexto até 2.500", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const hits = [
      hitDeReuniao(1, `${"r".repeat(12_000)}FIM-DA-REUNIAO`),
      { id: "doc-c", sourceType: "contact" as const, sourceId: "1", title: "Ana", content: `${"c".repeat(2_500)}FIM-DO-CONTATO`, metadata: {}, score: 0.9 },
      { id: "doc-x", sourceType: "context" as const, sourceId: "ctx", title: "Feira", content: `${"x".repeat(2_500)}FIM-DO-CONTEXTO`, metadata: {}, score: 0.8 },
    ];

    await servico.answerFromMemory("pergunta", hits);

    const prompt = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const contextoEnviado = prompt.messages.find(mensagem => mensagem.role === "user")!.content;
    expect(contextoEnviado).toContain("r".repeat(12_000));
    expect(contextoEnviado).toContain("c".repeat(2_500));
    expect(contextoEnviado).toContain("x".repeat(2_500));
    expect(contextoEnviado).not.toContain("FIM-DA-REUNIAO");
    expect(contextoEnviado).not.toContain("FIM-DO-CONTATO");
    expect(contextoEnviado).not.toContain("FIM-DO-CONTEXTO");
  });

  it("teto total de 40.000: os últimos hits ficam fora, avisados no log, e a numeração das fontes não muda", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    // 6 reuniões de 12.000 = 72.000: só três cabem no teto
    const hits = Array.from({ length: 6 }, (_, indice) => hitDeReuniao(indice + 1, `MARCA-${indice + 1} ${"t".repeat(12_000)}`));

    await servico.answerFromMemory("pergunta", hits);

    const prompt = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const contextoEnviado = prompt.messages.find(mensagem => mensagem.role === "user")!.content;
    expect(contextoEnviado.length).toBeLessThanOrEqual(servico.TETO_DO_CONTEXTO + 200);
    for (const numero of [1, 2, 3]) expect(contextoEnviado).toContain(`[${numero}] Reunião ${numero}\nMARCA-${numero}`);
    for (const numero of [4, 5, 6]) expect(contextoEnviado).not.toContain(`MARCA-${numero}`);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("fonte [4] (meeting) ficou fora do prompt"));
  });

  it("um hit que não cabe não bloqueia um menor que vem depois", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const hits = [
      ...Array.from({ length: 4 }, (_, indice) => hitDeReuniao(indice + 1, `MARCA-${indice + 1} ${"t".repeat(12_000)}`)),
      { id: "doc-c", sourceType: "contact" as const, sourceId: "1", title: "Ana", content: "Contato: Ana", metadata: {}, score: 0.5 },
    ];

    await servico.answerFromMemory("pergunta", hits);

    const prompt = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const contextoEnviado = prompt.messages.find(mensagem => mensagem.role === "user")!.content;
    expect(contextoEnviado).not.toContain("MARCA-4");
    expect(contextoEnviado).toContain("[5] Ana\nContato: Ana");
  });
});

describe("Dublê de banco — o avaliador de WHERE é estrito (revisão da PR-D)", () => {
  // Antes, o tokenizador descartava o que não reconhecia: `not in (...)` era
  // lido como `in` e `>= ?` como `= ?`, em silêncio — um teste com o predicado
  // errado passaria. Casos de sanidade do próprio dublê, com o SQL vindo do
  // dialeto real.
  it("`not in` com o item presente é falso; ausente é verdadeiro; NULL not in (...) é falso, como no SQL", () => {
    const { sql, params } = dialeto.sqlToQuery(notInArray(schema.memoryDocuments.id, ["doc-a", "doc-b"]));
    expect(sql).toBe("`memory_documents`.`id` not in (?, ?)");
    expect(avaliarWhere(schema.memoryDocuments, sql, params, { id: "doc-a" })).toBe(false);
    expect(avaliarWhere(schema.memoryDocuments, sql, params, { id: "doc-c" })).toBe(true);
    expect(avaliarWhere(schema.memoryDocuments, sql, params, { id: null })).toBe(false);
  });

  it("operador não implementado (>=, <>) LANÇA um erro claro em vez de ser lido como =", () => {
    const maiorOuIgual = dialeto.sqlToQuery(gte(schema.memoryDocuments.indexedAt, 5));
    expect(maiorOuIgual.sql).toBe("`memory_documents`.`indexed_at` >= ?");
    expect(() => avaliarWhere(schema.memoryDocuments, maiorOuIgual.sql, maiorOuIgual.params, { indexedAt: 5 }))
      .toThrow('não implementa o operador ">="');
    const diferente = dialeto.sqlToQuery(ne(schema.memoryDocuments.id, "doc-a"));
    expect(diferente.sql).toBe("`memory_documents`.`id` <> ?");
    expect(() => avaliarWhere(schema.memoryDocuments, diferente.sql, diferente.params, { id: "doc-b" }))
      .toThrow('não implementa o operador "<>"');
  });

  it("`is not null` distingue o catálogo (NULL) do contexto com dona", () => {
    const { sql, params } = dialeto.sqlToQuery(isNotNull(schema.contexts.ownerId));
    expect(sql).toBe("`contexts`.`owner_id` is not null");
    expect(avaliarWhere(schema.contexts, sql, params, { ownerId: null })).toBe(false);
    expect(avaliarWhere(schema.contexts, sql, params, { ownerId: "dona" })).toBe(true);
  });
});
