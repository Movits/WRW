import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O portão da demanda expressa na LEITURA dos matches do Dashboard: a linha
 * gravada antes da regra some da lista sem esperar "Reanalisar" — o mesmo
 * lugar (routers/profileMatches.ts) em que a trava de consentimento mora.
 */
const usersComConsentimento = vi.fn(async (ids: number[]) => new Set(ids));
vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => true,
  usersComConsentimento: (...args: unknown[]) => usersComConsentimento(...(args as [number[]])),
}));
const matchesBloqueados = vi.fn(async (_userId: number, _ids: number[]) => new Set<number>([3]));
vi.mock("./matching", () => ({
  matchesBloqueadosPelaDemandaExpressa: (...args: unknown[]) => matchesBloqueados(...(args as [number, number[]])),
}));
const getMatchesForUser = vi.fn(async (_userId: number, _limit: number) => [
  { matchId: 1, matchedUserId: 2, overallScore: 90 },
  { matchId: 2, matchedUserId: 3, overallScore: 80 },
]);
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => { throw new Error("não deve tocar no banco aqui"); },
  getMatchesForUser: (...args: unknown[]) => getMatchesForUser(...(args as [number, number])),
}));

const { profileMatchesRouter } = await import("./routers/profileMatches");
const ctx = { user: { id: 1, openId: "dona-1", email: "t@local", role: "silver" }, req: { headers: {}, socket: {} }, res: { cookie: () => {} } } as never;

describe("profileMatches.list — serviço casado por presunção não volta à tela", () => {
  it("filtra os pares que o portão bloqueia hoje, passando os ids da lista", async () => {
    const lista = await profileMatchesRouter.createCaller(ctx).list({ limit: 20 });
    // O `matchedUserId` não atravessa mais para o navegador: é id real, e toda
    // conta Ouro tem o painel que lista usuárias por nome. A linha passa a ser
    // identificada na tela pelo `matchId` — matchId 1 é o par com a usuária 2.
    expect(lista.map(m => m.matchId)).toEqual([1]);
    expect(lista.every(m => !("matchedUserId" in m))).toBe(true);
    expect(matchesBloqueados).toHaveBeenCalledWith(1, [2, 3]);
  });

  it("lê a página (50) e corta no limite DEPOIS do portão: a linha bloqueada não ocupa a vaga de um match legítimo", async () => {
    getMatchesForUser.mockResolvedValueOnce([
      { matchId: 1, matchedUserId: 3, overallScore: 95 }, // bloqueada, nota velha e alta
      { matchId: 2, matchedUserId: 2, overallScore: 90 },
      { matchId: 3, matchedUserId: 4, overallScore: 80 },
    ]);
    const lista = await profileMatchesRouter.createCaller(ctx).list({ limit: 2 });
    // A primeira página; incompleta, ela é a última (as páginas seguintes estão em conexoes-possiveis.test.ts).
    expect(getMatchesForUser).toHaveBeenCalledWith(1, 50, 0);
    expect(lista.map(m => m.matchId)).toEqual([2, 3]);
  });

  it("insight gravado pelo prompt antigo que fala em \"match\" não vai à tela; o que fala em conexão vai", async () => {
    getMatchesForUser.mockResolvedValueOnce([
      { matchId: 1, matchedUserId: 2, overallScore: 90, aiInsight: "Este match une vinho e capital." },
      { matchId: 2, matchedUserId: 4, overallScore: 85, aiInsight: "Esta conexão sugerida une vinho e capital." },
    ] as never);
    const lista = await profileMatchesRouter.createCaller(ctx).list({ limit: 20 });
    expect(lista.map(m => [m.matchId, m.aiInsight])).toEqual([[1, null], [2, "Esta conexão sugerida une vinho e capital."]]);
  });

  it("só os ids COM termo chegam ao portão: o perfil de quem revogou não é cruzado nem para decidir", async () => {
    matchesBloqueados.mockClear();
    usersComConsentimento.mockResolvedValueOnce(new Set([2]));
    const lista = await profileMatchesRouter.createCaller(ctx).list({ limit: 20 });
    expect(lista.map(m => m.matchId)).toEqual([1]);
    expect(matchesBloqueados).toHaveBeenCalledWith(1, [2]);
  });
});
