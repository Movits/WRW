import { beforeEach, describe, expect, it, vi } from "vitest";

// server/matching.ts resolve VAULT_ENCRYPTION_KEY no import (senão lança).
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";
process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * Motor de perfis — a rodada compara a usuária com TODOS os perfis que podem
 * casar (desenho DOC-4 de 16/11, seção 7).
 *
 * Antes, a leitura tinha `.limit(50)` sem ordem: cada usuária era comparada
 * com os 50 primeiros perfis que o banco devolvesse, e quem casava depois do
 * 50º nunca aparecia, embora o comentário dissesse "todas as outras". Agora:
 *
 * 1. A leitura vai página a página (PERFIS_POR_PAGINA), na ordem do id, cada
 *    página depois do último id lido — o índice único de user_profiles.userId
 *    serve a consulta, e a memória não guarda os perfis de todo mundo.
 * 2. Ficam as MATCHES_GUARDADOS_POR_RODADA de nota mais alta (na mesma nota,
 *    o id menor): rodar de novo guarda as mesmas, na mesma ordem.
 * 3. A dispensada não ocupa vaga, e a linha que a dona já tem é regravada
 *    com a nota nova, mesmo fora das melhores.
 *
 * O banco é o drizzle de verdade sobre um cliente falso: o SQL conferido é o
 * que vai ao MySQL, e o cliente responde como o MySQL responderia a ele
 * (filtra, ordena e corta pela página pedida).
 */

type Perfil = Record<string, unknown> & { userId: number };
const banco = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  dona: null as (Record<string, unknown> & { userId: number }) | null,
  perfis: [] as Array<Record<string, unknown> & { userId: number }>,
  existentes: [] as Array<{ matchedUserId: number; aiInsight: string | null; userDismissed: boolean }>,
}));

/** As colunas de um SELECT, na ordem do SQL: o mysql2 do drizzle devolve as linhas como listas nessa ordem. */
function colunasDoSelect(sql: string): string[] {
  const lista = /^select (.*?) from /.exec(sql)?.[1] ?? "";
  return lista.split(", ").map(coluna => /`([^`]+)`$/.exec(coluna)?.[1] ?? coluna);
}
const naOrdem = (sql: string, linha: Record<string, unknown>) => colunasDoSelect(sql).map(coluna => linha[coluna] ?? null);

/** A página que o MySQL devolveria à consulta das candidatas: filtro, ordem e corte lidos do próprio SQL. */
function paginaDoBanco(sql: string, params: unknown[]): Perfil[] {
  const comCursor = sql.includes("`user_profiles`.`userId` > ?");
  const [quem] = params as [number];
  const depoisDe = comCursor ? (params[2] as number) : -Infinity;
  const limite = params[params.length - 1] as number;
  const filtradas = banco.perfis.filter(perfil => perfil.userId !== quem && perfil.userId > depoisDe);
  const ordenadas = sql.includes("order by `user_profiles`.`userId` asc") ? [...filtradas].sort((a, b) => a.userId - b.userId) : filtradas;
  return ordenadas.slice(0, limite);
}

vi.mock("drizzle-orm/mysql2", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  const clienteFalso = {
    query: async (config: { sql: string }, params: unknown[] = []) => {
      const sql = config.sql;
      banco.consultas.push({ sql, params });
      if (/^\s*(insert|update|delete)/i.test(sql)) return [{ affectedRows: 1 }, []];
      if (/ from `user_profiles` inner join `users`/.test(sql)) return [paginaDoBanco(sql, params).map(perfil => naOrdem(sql, perfil)), []];
      if (/ from `user_profiles` where/.test(sql)) return [banco.dona ? [naOrdem(sql, banco.dona)] : [], []];
      if (/ from `matches` where/.test(sql)) return [banco.existentes.map(linha => naOrdem(sql, linha)), []];
      return [[], []];
    },
  } as never;
  return {
    ...original,
    drizzle: ((entrada: unknown) =>
      typeof entrada === "string" ? original.drizzle(clienteFalso) : original.drizzle(entrada as never)) as typeof original.drizzle,
  };
});

const usersComConsentimento = vi.hoisted(() => vi.fn(async (ids: number[]) => new Set(ids)));
vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => true,
  usersComConsentimento: (ids: number[]) => usersComConsentimento(ids),
}));
const invokeLLM = vi.hoisted(() => vi.fn(async () => ({ choices: [{ message: { content: "insight de teste" } }] })));
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...(args as [])) }));
// O registro PLATFORM_MATCH tem teste próprio (registro-de-conexoes-nos-motores.test.ts).
vi.mock("./network-registro", () => ({ registrarConexoesEntreMembrasDepoisDoCalculo: async () => undefined }));

const { calculateCompatibilityScore, generateMatchesForUser, MATCHES_GUARDADOS_POR_RODADA, PERFIS_POR_PAGINA } = await import("./matching");

const dona: Perfil = {
  userId: 1, primarySpecialty: "marketing", secondarySpecialties: ["vendas"], sector: "Saúde", seekingTypes: [],
  values: ["innovation"], whatIHave: ["tecnologia"], whatINeed: ["investidores"], investmentCapacity: null,
  lookingForInvestment: false, investmentAmountSeeking: null, country: "Brasil", city: "Brasília", openToRemote: true,
};
/** Complementar à dona (cada uma tem o que a outra procura): passa do corte de 40 com folga. */
const complementar = (userId: number, extra: Record<string, unknown> = {}): Perfil => ({
  ...dona, userId, primarySpecialty: "vendas", secondarySpecialties: ["marketing"], whatIHave: ["investidores"], whatINeed: ["tecnologia"],
  city: "São Paulo", ...extra,
});
/** Só oferece serviço que a dona não declarou precisar: o portão da demanda expressa a bloqueia. */
const bloqueada = (userId: number): Perfil => ({
  userId, whatIHave: ["Advocacia tributária"], whatINeed: ["fornecedores"], sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"],
});

const nota = (perfil: Perfil) => calculateCompatibilityScore(dona as never, perfil as never);
/** O que a rodada deve guardar: as que passam do portão e do corte, nota mais alta primeiro, e na mesma nota o id menor. */
const melhoresEsperadas = (perfis: Perfil[], quantas = MATCHES_GUARDADOS_POR_RODADA) => perfis
  .map(perfil => ({ userId: perfil.userId, scores: nota(perfil) }))
  .filter(({ scores }) => !scores.bloqueio && scores.overall >= 40)
  .sort((a, b) => b.scores.overall - a.scores.overall || a.userId - b.userId)
  .slice(0, quantas)
  .map(({ userId }) => userId);

const paginasLidas = () => banco.consultas.filter(c => / from `user_profiles` inner join `users`/.test(c.sql));
/** O par gravado: o INSERT de `matches` leva userId, matchedUserId e overallScore nas três primeiras posições. */
const gravadas = () => banco.consultas
  .filter(c => /^insert into `matches`/.test(c.sql))
  .map(c => {
    expect(c.sql).toMatch(/^insert into `matches` \(`id`, `userId`, `matchedUserId`, `overallScore`,/);
    return { matchedUserId: c.params[1] as number, overallScore: c.params[2] as number, comInsight: c.params.includes("insight de teste") };
  });

beforeEach(() => {
  banco.consultas = [];
  banco.dona = dona;
  banco.perfis = [];
  banco.existentes = [];
  usersComConsentimento.mockClear();
  usersComConsentimento.mockImplementation(async (ids: number[]) => new Set(ids));
  invokeLLM.mockClear();
});

describe("motor de perfis — a rodada compara com todos os perfis que podem casar", () => {
  it("o que casa depois do 50º perfil aparece", async () => {
    // Pré-condições do cenário: as 55 primeiras não casam, as 5 últimas casam.
    expect(nota(bloqueada(2)).bloqueio).toBe("servico-sem-demanda-expressa");
    expect(nota(complementar(57)).overall).toBeGreaterThanOrEqual(40);
    banco.perfis = [
      ...Array.from({ length: 55 }, (_, i) => bloqueada(i + 2)),
      ...Array.from({ length: 5 }, (_, i) => complementar(i + 57)),
    ];

    expect(await generateMatchesForUser(1)).toBe(5);

    expect(gravadas().map(g => g.matchedUserId).sort((a, b) => a - b)).toEqual([57, 58, 59, 60, 61]);
  });

  it("lê todas as páginas, na ordem do id, cada uma depois do último id lido, só de contas ativas", async () => {
    const total = PERFIS_POR_PAGINA * 2 + 37;
    banco.perfis = Array.from({ length: total }, (_, i) => complementar(i + 2));

    await generateMatchesForUser(1);

    const paginas = paginasLidas();
    expect(paginas).toHaveLength(3);
    for (const pagina of paginas) {
      expect(pagina.sql).toContain("where (`user_profiles`.`userId` <> ? and `users`.`isActive` = ? and `user_profiles`.`userId` > ?)");
      expect(pagina.sql).toMatch(/order by `user_profiles`\.`userId` asc limit \?$/);
    }
    expect(paginas.map(p => p.params)).toEqual([
      [1, true, 0, PERFIS_POR_PAGINA],
      [1, true, PERFIS_POR_PAGINA + 1, PERFIS_POR_PAGINA],
      [1, true, PERFIS_POR_PAGINA * 2 + 1, PERFIS_POR_PAGINA],
    ]);
    // O termo do Smart Match é conferido página a página, com os ids daquela página.
    expect(usersComConsentimento.mock.calls.map(([ids]) => ids.length)).toEqual([PERFIS_POR_PAGINA, PERFIS_POR_PAGINA, 37]);
  });

  it("guarda as melhores de todas as páginas, e não as primeiras: a de nota mais alta no fim da última página entra", async () => {
    const total = PERFIS_POR_PAGINA * 2 + 37;
    // As 30 últimas moram na cidade da dona e tiram nota maior que as outras.
    banco.perfis = Array.from({ length: total }, (_, i) => complementar(i + 2, i >= total - 30 ? { city: "Brasília" } : {}));
    expect(nota(banco.perfis[total - 1]).overall).toBeGreaterThan(nota(banco.perfis[0]).overall);

    expect(await generateMatchesForUser(1)).toBe(MATCHES_GUARDADOS_POR_RODADA);

    const esperadas = melhoresEsperadas(banco.perfis);
    expect(esperadas.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => total - 30 + i + 2));
    expect(gravadas().map(g => g.matchedUserId)).toEqual(esperadas);
  });

  it("a ordem não muda entre rodadas: os mesmos perfis guardam as mesmas conexões, na mesma ordem e com a mesma nota", async () => {
    const cidades = ["Brasília", "São Paulo", "Lisboa"];
    banco.perfis = Array.from({ length: 640 }, (_, i) => complementar(i + 2, {
      city: cidades[i % 3], ...(i % 7 === 0 ? { country: "Portugal" } : {}), ...(i % 5 === 0 ? { values: [] } : {}),
    }));

    await generateMatchesForUser(1);
    const primeira = gravadas();
    banco.consultas = [];
    await generateMatchesForUser(1);
    const segunda = gravadas();

    expect(primeira).toHaveLength(MATCHES_GUARDADOS_POR_RODADA);
    expect(segunda).toEqual(primeira);
    expect(primeira.map(g => g.matchedUserId)).toEqual(melhoresEsperadas(banco.perfis));
  });

  it("a dispensada não ocupa vaga, e a linha que a dona já tem é regravada com a nota nova, mesmo fora das melhores", async () => {
    const total = 300;
    banco.perfis = Array.from({ length: total }, (_, i) => complementar(i + 2, i >= total - 10 ? { city: "Brasília" } : {}));
    const [primeiraDasMelhores] = melhoresEsperadas(banco.perfis, 1);
    const foraDasMelhores = 280; // nota comum e id alto: fica fora das 100
    expect(melhoresEsperadas(banco.perfis)).not.toContain(foraDasMelhores);
    banco.existentes = [
      { matchedUserId: primeiraDasMelhores, aiInsight: "texto que custou cota", userDismissed: true },
      { matchedUserId: foraDasMelhores, aiInsight: null, userDismissed: false },
    ];

    await generateMatchesForUser(1);

    const ids = gravadas().map(g => g.matchedUserId);
    // As 100 melhores entre as não dispensadas...
    const semADispensada = melhoresEsperadas(banco.perfis.filter(perfil => perfil.userId !== primeiraDasMelhores));
    expect(ids.filter(id => semADispensada.includes(id))).toHaveLength(MATCHES_GUARDADOS_POR_RODADA);
    // ... mais as duas linhas que a dona já tem, regravadas (o upsert não toca userDismissed).
    expect(new Set(ids)).toEqual(new Set([...semADispensada, primeiraDasMelhores, foraDasMelhores]));
    expect(gravadas().find(g => g.matchedUserId === foraDasMelhores)?.overallScore).toBe(nota(banco.perfis[foraDasMelhores - 2]).overall);
    // As linhas existentes são lidas antes da comparação, para a dispensa ser conhecida.
    const ordem = banco.consultas.map(c => (/ from `matches` where/.test(c.sql) ? "existentes" : / inner join `users`/.test(c.sql) ? "pagina" : null)).filter(Boolean);
    expect(ordem.slice(0, 2)).toEqual(["existentes", "pagina"]);
  });

  it("sem o termo do outro lado, a candidata de qualquer página fica fora", async () => {
    const total = PERFIS_POR_PAGINA + 20;
    banco.perfis = Array.from({ length: total }, (_, i) => complementar(i + 2));
    const semTermo = new Set([3, PERFIS_POR_PAGINA + 10]);
    usersComConsentimento.mockImplementation(async (ids: number[]) => new Set(ids.filter(id => !semTermo.has(id))));

    await generateMatchesForUser(1);

    const ids = gravadas().map(g => g.matchedUserId);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(PERFIS_POR_PAGINA + 10);
    expect(ids).toEqual(melhoresEsperadas(banco.perfis.filter(perfil => !semTermo.has(perfil.userId))));
  });

  it("o insight de IA (no máximo 3) vai às conexões de nota mais alta, onde quer que estejam", async () => {
    // Na cidade da dona e com os valores dela, a nota passa de 70; as três de nota mais alta estão no fim.
    banco.perfis = [
      ...Array.from({ length: 40 }, (_, i) => complementar(i + 2, { values: [] })),
      ...Array.from({ length: 3 }, (_, i) => complementar(i + 42, { city: "Brasília" })),
    ];
    const altas = melhoresEsperadas(banco.perfis, 3);
    expect(altas).toEqual([42, 43, 44]);
    expect(nota(banco.perfis[40]).overall).toBeGreaterThanOrEqual(70);

    await generateMatchesForUser(1);

    expect(invokeLLM).toHaveBeenCalledTimes(3);
    expect(gravadas().filter(g => g.comInsight).map(g => g.matchedUserId)).toEqual(altas);
  });
});
