import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * U3, "matches possíveis" (promessa à Dra. Glenda na reunião de 11/11/2026):
 * a Bronze vê QUANTAS conexões são possíveis para ela, e a lista se libera com
 * o cadastro completo (o nível Prata).
 *
 *  1. A Bronze recebe o número e não recebe a lista (matches.list vazio, sem
 *     nem ler o banco); a Prata, a Ouro, a presidente e a admin, a lista.
 *  2. O número é o tamanho da lista que ela veria como Prata: as mesmas linhas,
 *     o termo dos dois lados, o portão da demanda expressa e a janela de 50.
 *  3. A resposta do número não traz coluna pessoal, id nem nome: só o total e
 *     se a lista está liberada.
 *  4. O poder de distribuidora não é nível; sem o termo dela, zero (etapa 11).
 *
 * A prova contra o banco real está em conexoes-possiveis.integracao.test.ts.
 */

const estado = vi.hoisted(() => ({
  termoDela: true,
  /** Quem do outro lado tem o termo; null = todas. */
  comTermo: null as number[] | null,
  bloqueados: [3] as number[],
  linhas: [] as Array<Record<string, unknown>>,
}));

const usersComConsentimento = vi.fn(async (ids: number[]) =>
  new Set(estado.comTermo === null ? ids : ids.filter(id => estado.comTermo!.includes(id))));
vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => estado.termoDela,
  usersComConsentimento: (...args: unknown[]) => usersComConsentimento(...(args as [number[]])),
}));
const matchesBloqueados = vi.fn(async (_userId: number, _ids: number[]) => new Set(estado.bloqueados));
vi.mock("./matching", () => ({
  matchesBloqueadosPelaDemandaExpressa: (...args: unknown[]) => matchesBloqueados(...(args as [number, number[]])),
}));
// O LIMIT e o OFFSET do SQL de verdade: a página que a procedure pede é a que volta.
const getMatchesForUser = vi.fn(async (_userId: number, limite: number, pulo = 0) => estado.linhas.slice(pulo, pulo + limite));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("não deve tocar no banco aqui"); },
  getMatchesForUser: (...args: unknown[]) => getMatchesForUser(...(args as [number, number, number])),
}));

const { profileMatchesRouter } = await import("./routers/profileMatches");

const ctx = (role: string | undefined, extra: Record<string, unknown> = {}) => ({
  user: { id: 1, openId: "dona-1", email: "t@local", role, ...extra },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
}) as never;

/** Uma linha como getMatchesForUser a devolve, com textos-sentinela no lugar dos dados da outra membra. */
const linha = (matchId: number, matchedUserId: number, extra: Record<string, unknown> = {}) => ({
  matchId, matchedUserId, overallScore: 90 - matchId, specialtyScore: 60, objectivesScore: 0, incomeScore: 60,
  locationScore: 75, valuesScore: 50, aiInsight: `Insight-sentinela-${matchedUserId}`, userSeen: false, userDismissed: false,
  createdAt: new Date("2026-11-18T12:00:00Z"), city: `Cidade-sentinela-${matchedUserId}`, country: "BR",
  sector: `Setor-sentinela-${matchedUserId}`, primarySpecialty: `Especialidade-sentinela-${matchedUserId}`,
  seekingTypes: ["parceiro_estrategico"], businessInterests: [], values: ["innovation"],
  connectionId: null, connectionStatus: null, souDestinataria: false, displayName: null, ...extra,
});

// 101 e 102 passam; 103 o portão barra; 104 não tem o termo; 105 já se revelou (nome com o aceite).
const PADRAO = [
  linha(1, 101), linha(2, 103), linha(3, 104),
  linha(4, 105, { connectionId: 9, connectionStatus: "accepted", displayName: "Nome-sentinela-revelado" }),
  linha(5, 102),
];

beforeEach(() => {
  estado.termoDela = true;
  estado.comTermo = [101, 102, 103, 105];
  estado.bloqueados = [103];
  estado.linhas = PADRAO;
  getMatchesForUser.mockClear();
  matchesBloqueados.mockClear();
});

const comoBronze = () => profileMatchesRouter.createCaller(ctx("bronze"));
const comoPrata = () => profileMatchesRouter.createCaller(ctx("silver"));

describe("U3 — a Bronze vê o número e não vê quem", () => {
  it("o número sai das três travas da lista, e matches.list devolve vazio sem nem ler o banco", async () => {
    expect(await comoBronze().conexoesPossiveis()).toEqual({ total: 3, listaLiberada: false });
    getMatchesForUser.mockClear();

    expect(await comoBronze().list({ limit: 50 })).toEqual([]);
    expect(getMatchesForUser).not.toHaveBeenCalled();
  });

  it("a resposta do número não traz campo pessoal, id nem nome", async () => {
    const resposta = await comoBronze().conexoesPossiveis();
    expect(Object.keys(resposta).sort()).toEqual(["listaLiberada", "total"]);
    expect(typeof resposta.total).toBe("number");
    expect(typeof resposta.listaLiberada).toBe("boolean");
    const texto = JSON.stringify(resposta);
    for (const proibido of ["sentinela", "matchId", "matchedUserId", "city", "displayName", "aiInsight", "connectionId"]) {
      expect(texto, proibido).not.toContain(proibido);
    }
  });

  it("a Bronze com o poder de distribuidora continua vendo só o número: o poder não é nível", async () => {
    const distribuidora = profileMatchesRouter.createCaller(ctx("bronze", { isDistributor: true }));
    expect(await distribuidora.list({ limit: 20 })).toEqual([]);
    expect(await distribuidora.conexoesPossiveis()).toEqual({ total: 3, listaLiberada: false });
  });

  it("nível ausente ou desconhecido não vê a lista (lista fechada)", async () => {
    expect(await profileMatchesRouter.createCaller(ctx(undefined)).list({ limit: 20 })).toEqual([]);
    expect(await profileMatchesRouter.createCaller(ctx("user")).list({ limit: 20 })).toEqual([]);
  });

  it("sem o termo do Smart Match dela, o número é zero e nada é lido (etapa 11)", async () => {
    estado.termoDela = false;
    expect(await comoBronze().conexoesPossiveis()).toEqual({ total: 0, listaLiberada: false });
    expect(getMatchesForUser).not.toHaveBeenCalled();
  });
});

describe("U3 — a Prata, a Ouro, a presidente e a admin veem a lista", () => {
  it("a Prata vê os cartões anônimos, sem o id da outra membra", async () => {
    const lista = await comoPrata().list({ limit: 50 });
    expect(lista.map(m => m.matchId)).toEqual([1, 4, 5]);
    expect(lista.every(m => !("matchedUserId" in m))).toBe(true);
    expect(lista[0].city).toBe("Cidade-sentinela-101");
    expect(await comoPrata().conexoesPossiveis()).toEqual({ total: 3, listaLiberada: true });
  });

  it.each(["gold", "president", "admin"])("%s vê a lista como sempre viu (Ouro = Presidente = administradora)", async (role) => {
    const caller = profileMatchesRouter.createCaller(ctx(role));
    expect((await caller.list({ limit: 50 })).map(m => m.matchId)).toEqual([1, 4, 5]);
    expect((await caller.conexoesPossiveis()).listaLiberada).toBe(true);
  });
});

describe("U3 — o número bate com a lista que ela veria ao virar Prata", () => {
  const casos: Array<[string, () => void]> = [
    ["o padrão (portão, sem termo, revelada)", () => {}],
    ["ninguém do outro lado com o termo", () => { estado.comTermo = []; }],
    ["o portão barra todas", () => { estado.bloqueados = [101, 102, 103, 104, 105]; }],
    ["lista vazia", () => { estado.linhas = []; }],
    ["mais de 50 linhas: os dois param na mesma janela", () => {
      estado.comTermo = null;
      estado.bloqueados = [3, 30, 51];
      estado.linhas = Array.from({ length: 70 }, (_, i) => linha(i + 1, i + 1));
    }],
    ["50 escondidas no topo e 10 válidas abaixo", () => {
      estado.comTermo = null;
      estado.bloqueados = Array.from({ length: 50 }, (_, i) => i + 1);
      estado.linhas = Array.from({ length: 60 }, (_, i) => linha(i + 1, i + 1));
    }],
  ];

  it.each(casos)("%s", async (_nome, preparar) => {
    preparar();
    const { total } = await comoBronze().conexoesPossiveis();
    const lista = await comoPrata().list({ limit: 50 });
    expect(total).toBe(lista.length);
  });

  it("os dois leem a mesma página (50) e passam os mesmos ids ao portão", async () => {
    await comoBronze().conexoesPossiveis();
    await comoPrata().list({ limit: 20 });
    expect(getMatchesForUser.mock.calls).toEqual([[1, 50, 0], [1, 50, 0]]);
    expect(matchesBloqueados.mock.calls).toEqual([[1, [101, 103, 105, 102]], [1, [101, 103, 105, 102]]]);
  });
});

/**
 * Achado 1 da revisão do pacote do match (20/11): as travas vinham DEPOIS de
 * cortar nas 50 linhas de nota mais alta. O motor não regrava nem apaga a linha
 * que o portão passou a esconder, e ela fica no topo com a nota velha: com 50
 * dessas, as válidas da 51ª em diante sumiam do número e da lista. A prova contra
 * o banco real está em conexoes-possiveis-janela.integracao.test.ts.
 */
describe("as travas da leitura vêm antes da janela de 50", () => {
  beforeEach(() => {
    estado.comTermo = null;
    // As 50 de cima o portão esconde; as 10 de baixo são válidas.
    estado.bloqueados = Array.from({ length: 50 }, (_, i) => i + 1);
    estado.linhas = Array.from({ length: 60 }, (_, i) => linha(i + 1, i + 1));
  });

  it("50 escondidas no topo e 10 válidas abaixo: o número e a lista dão 10", async () => {
    expect(await comoBronze().conexoesPossiveis()).toEqual({ total: 10, listaLiberada: false });
    const lista = await comoPrata().list({ limit: 50 });
    expect(lista.map(m => m.matchId)).toEqual(Array.from({ length: 10 }, (_, i) => i + 51));
  });

  it("a leitura vai à página seguinte só enquanto faltam visíveis, e para na página incompleta", async () => {
    await comoBronze().conexoesPossiveis();
    expect(getMatchesForUser.mock.calls).toEqual([[1, 50, 0], [1, 50, 50]]);
  });

  it("com 50 visíveis na primeira página, a segunda nem é lida", async () => {
    estado.bloqueados = [];
    expect(await comoBronze().conexoesPossiveis()).toEqual({ total: 50, listaLiberada: false });
    expect(getMatchesForUser.mock.calls).toEqual([[1, 50, 0]]);
  });

  it("as que o outro lado deixou sem termo também não ocupam a janela", async () => {
    estado.bloqueados = [];
    estado.comTermo = Array.from({ length: 10 }, (_, i) => i + 51);
    expect(await comoBronze().conexoesPossiveis()).toEqual({ total: 10, listaLiberada: false });
    // O portão só lê o perfil de quem tem o termo (etapa 11): as 50 de cima nem chegam a ele.
    expect(matchesBloqueados.mock.calls.flatMap(([, ids]) => ids)).toEqual(Array.from({ length: 10 }, (_, i) => i + 51));
  });

  it("a mesma linha lida em duas páginas (uma rodada no meio da leitura) conta uma vez só", async () => {
    // A 50ª o portão esconde: faltam visíveis, e a leitura vai à segunda página,
    // que repete a 49ª, como se a nota dela tivesse caído entre as duas leituras.
    estado.bloqueados = [50];
    estado.linhas = Array.from({ length: 50 }, (_, i) => linha(i + 1, i + 1));
    const paginas = [estado.linhas, [linha(49, 49)]];
    getMatchesForUser.mockImplementation(async () => paginas.shift() ?? []);
    try {
      expect(await comoBronze().conexoesPossiveis()).toEqual({ total: 49, listaLiberada: false });
      paginas.push(estado.linhas, [linha(49, 49)]);
      const ids = (await comoPrata().list({ limit: 50 })).map(m => m.matchId);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      getMatchesForUser.mockImplementation(async (_userId: number, limite: number, pulo = 0) => estado.linhas.slice(pulo, pulo + limite));
    }
  });
});
