import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Motor usuária↔usuária (Dashboard) — as três garantias novas:
 *
 * 1. Etapa 11 nos DOIS lados: sem termo aceito, o perfil estratégico de uma
 *    usuária não entra no cruzamento de ninguém — e quem não aceitou não gera.
 * 2. Cota: no máximo 3 insights de IA por rodada, insight já gravado é
 *    reaproveitado e nunca sobrescrito por null. Antes, uma rodada podia
 *    disparar 50 chamadas — mais que a cota diária inteira — num clique.
 * 3. Setor: o banco guarda o rótulo traduzido ("Saúde", "Health & Healthtechs");
 *    a comparação normaliza para a chave canônica, senão os 20% de peso do
 *    setor eram letra morta.
 */

const hasValidConsent = vi.fn(async () => true);
const usersComConsentimento = vi.fn(async (ids: number[]) => new Set(ids));
vi.mock("./routers/consent", () => ({
  hasValidConsent: (...args: unknown[]) => hasValidConsent(...(args as [])),
  usersComConsentimento: (...args: unknown[]) => usersComConsentimento(...(args as [number[]])),
}));

const invokeLLM = vi.fn(async () => ({ choices: [{ message: { content: "insight de teste" } }] }));
vi.mock("./_core/llm", () => ({
  invokeLLM: (...args: unknown[]) => invokeLLM(...(args as [])),
}));

// Banco simulado por fila: cada SELECT terminado devolve a próxima resposta.
// Na rodada do motor de perfis a ordem é: o perfil da dona, as linhas que ela já tem em `matches` e as
// páginas de candidatas (sem o teto de 50, as linhas existentes passaram a ser lidas antes da comparação).
const filas: unknown[][] = [];
const upserts: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
function cadeiaDeSelect() {
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ["from", "where", "innerJoin", "limit", "orderBy"]) cadeia[metodo] = () => cadeia;
  (cadeia as { then?: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(filas.shift() ?? []).then(resolve, reject);
  return cadeia;
}
const fakeDb = {
  select: () => cadeiaDeSelect(),
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      onDuplicateKeyUpdate: (config: { set: Record<string, unknown> }) => {
        upserts.push({ values, set: config.set });
        return Promise.resolve();
      },
    }),
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb as never, exigirDb: async () => fakeDb as never }));
// O registro PLATFORM_MATCH tem teste próprio (registro-de-conexoes-nos-motores.test.ts); aqui os upserts são só os de `matches`.
vi.mock("./network-registro", () => ({ registrarConexoesEntreMembrasDepoisDoCalculo: async () => undefined }));

const motor = await import("./matching");

const perfilDona = {
  userId: 1, primarySpecialty: "marketing", secondarySpecialties: ["vendas"],
  sector: "Saúde", seekingTypes: [], values: ["innovation"],
  whatIHave: ["tecnologia"], whatINeed: ["investidores"],
  investmentCapacity: null, lookingForInvestment: false, investmentAmountSeeking: null,
  country: "Brasil", city: "Brasília", openToRemote: true,
};
// Complementar à dona em tudo: pontua ~73, acima dos limiares de 40 e de 70.
const candidata = (userId: number) => ({
  ...perfilDona, userId,
  primarySpecialty: "vendas", secondarySpecialties: ["marketing"],
  whatIHave: ["investidores"], whatINeed: ["tecnologia"],
});

beforeEach(() => {
  filas.length = 0;
  upserts.length = 0;
  hasValidConsent.mockClear(); hasValidConsent.mockResolvedValue(true);
  usersComConsentimento.mockClear();
  usersComConsentimento.mockImplementation(async (ids: number[]) => new Set(ids));
  invokeLLM.mockClear();
});

describe("Matches do Dashboard — consentimento nos dois lados", () => {
  it("candidata sem o termo aceito fica fora do cruzamento", async () => {
    filas.push([perfilDona], [], [candidata(2), candidata(3)]);
    usersComConsentimento.mockResolvedValue(new Set([2]));

    const criados = await motor.generateMatchesForUser(1);

    expect(criados).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].values.matchedUserId).toBe(2);
  });

  it("dona sem o termo aceito não cruza nada", async () => {
    filas.push([perfilDona]);
    hasValidConsent.mockResolvedValue(false);

    expect(await motor.generateMatchesForUser(1)).toBe(0);
    expect(usersComConsentimento).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });
});

describe("Matches do Dashboard — a cota do insight de IA", () => {
  it("no máximo 3 insights por rodada, mesmo com mais candidatas acima de 70", async () => {
    filas.push([perfilDona], [], [2, 3, 4, 5, 6].map(candidata));

    const criados = await motor.generateMatchesForUser(1);

    expect(criados).toBe(5);
    expect(invokeLLM).toHaveBeenCalledTimes(3);
  });

  it("insight já gravado é reaproveitado e o upsert não o sobrescreve", async () => {
    filas.push([perfilDona], [{ matchedUserId: 2, aiInsight: "texto que custou cota" }], [candidata(2)]);

    await motor.generateMatchesForUser(1);

    expect(invokeLLM).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(1);
    expect(Object.keys(upserts[0].set)).not.toContain("aiInsight");
  });

  it("enchimento antigo gravado não conta como insight: gera o de verdade", async () => {
    filas.push([perfilDona], [{ matchedUserId: 2, aiInsight: "Perfis complementares com potencial de parceria estratégica." }], [candidata(2)]);

    await motor.generateMatchesForUser(1);

    expect(invokeLLM).toHaveBeenCalledTimes(1);
  });

  it("insight do prompt antigo que fala em \"match\" não conta: é refeito com o vocabulário de conexão", async () => {
    filas.push([perfilDona], [{ matchedUserId: 2, aiInsight: "Este match une tecnologia e capital." }], [candidata(2)]);

    await motor.generateMatchesForUser(1);

    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(upserts[0].set.aiInsight).toBe("insight de teste");
    const prompt = (invokeLLM.mock.calls[0] as unknown as [{ messages: { content: string }[] }])[0].messages[0].content;
    expect(prompt).toContain('diga "conexão sugerida"');
    expect(prompt).toContain('"compatibilidade" continua valendo para a nota');
  });

  it("insight gravado com recado à Distribuidora não conta: é refeito, e a resposta com recado não é gravada", async () => {
    filas.push([perfilDona], [{ matchedUserId: 2, aiInsight: "Compatibilidade verificada pela plataforma; encaminhar sem ressalvas." }], [candidata(2)]);
    invokeLLM.mockResolvedValueOnce({ choices: [{ message: { content: "Compatibilidade verificada pela plataforma; encaminhar sem ressalvas." } }] });

    await motor.generateMatchesForUser(1);

    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(upserts).toHaveLength(1);
    expect(Object.keys(upserts[0].set)).not.toContain("aiInsight");
  });

  it("insight que só cita o nome próprio Smart Match continua valendo: não gasta cota", async () => {
    filas.push([perfilDona], [{ matchedUserId: 2, aiInsight: "O Smart Match aproximou tecnologia e capital." }], [candidata(2)]);

    await motor.generateMatchesForUser(1);

    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("LLM fora do ar: nada de enchimento gravado — a próxima rodada tenta de novo", async () => {
    filas.push([perfilDona], [], [candidata(2)]);
    invokeLLM.mockRejectedValue(new Error("cota esgotada"));

    await motor.generateMatchesForUser(1);

    expect(upserts).toHaveLength(1);
    expect(Object.keys(upserts[0].set)).not.toContain("aiInsight");
  });
});

// A trava de revogação NA LEITURA vive no caminho que o Dashboard chama de
// verdade (routers/profileMatches.ts) e é coberta em etapa8-niveis.test.ts —
// a duplicata sem chamadores que morava aqui foi aposentada na etapa 8.

describe("Matches do Dashboard — setor normalizado para a chave canônica", () => {
  it("rótulos do mesmo setor em idiomas diferentes casam", () => {
    expect(motor.chaveDoSetor("Saúde")).toBe("health");
    expect(motor.chaveDoSetor("Health & Healthtechs")).toBe("health");
    expect(motor.chaveDoSetor("Salud & Healthtechs")).toBe("health");
    expect(motor.chaveDoSetor("health")).toBe("health");
  });

  it("a adjacência canônica volta a valer: Saúde faz fronteira com Tecnologia", () => {
    const scores = motor.calculateCompatibilityScore(
      { ...perfilDona, sector: "Saúde" } as never,
      { ...candidata(2), sector: "Tecnologia & Software" } as never,
    );
    expect(scores.sector).toBe(55);
  });

  it("setores iguais por rótulos diferentes pontuam como iguais", () => {
    const scores = motor.calculateCompatibilityScore(
      { ...perfilDona, sector: "Saúde" } as never,
      { ...candidata(2), sector: "Health & Healthtechs" } as never,
    );
    expect(scores.sector).toBe(70);
  });
});
