import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * intelligentMatches.list manda à tela, além da frase gravada em português (reasonText), QUEM possui O QUÊ em cada
 * sugestão (motivo), para a frase sair no idioma da tela (conferência de tela do pacote do match, 20/11/2026: em
 * árabe saía "Contato K3 Exportar possui Exportar café, que Contato K2 Importadora procura.").
 *
 * O banco é um dublê por tabela: cada select devolve as linhas registradas para a tabela dele. O termo do Smart Match
 * está aceito; a origem na reunião (N5) não entra aqui.
 */
const linhas = vi.hoisted(() => new Map<unknown, unknown[]>());

vi.mock("./db", async () => {
  const consulta = (resultado: unknown[]): unknown => Object.assign(Promise.resolve(resultado), {
    where: () => consulta(resultado),
    orderBy: () => consulta(resultado),
  });
  const db = { select: () => ({ from: (tabela: unknown) => consulta(linhas.get(tabela) ?? []) }) };
  return { getDb: vi.fn(async () => db), exigirDb: vi.fn(async () => db) };
});
vi.mock("./routers/consent", () => ({ hasValidConsent: vi.fn(async () => true) }));
vi.mock("./reuniao-no-match", () => ({ origemDasConexoes: vi.fn(async () => new Map()) }));

const { aiMatchSuggestions, contactAssets, privateContacts } = await import("../drizzle/schema");
const { intelligentMatchesRouter } = await import("./routers/matches");

const ctx = {
  user: { id: 1, openId: "dona-1", email: "dona@local", role: "silver" },
  req: { headers: {}, socket: {} },
  res: { cookie: () => {} },
} as never;

const sugestao = (id: string, contactAId: number, contactBId: number, matchType: string, rotulos: string[], reasonText: string) => ({
  id, ownerId: "dona-1", contactAId, contactBId, matchScore: 100, matchType, status: "pending",
  matchedAssets: rotulos.map(label => ({ slug: "", label, category: null })), matchedNeeds: [], reasonText,
});

describe("intelligentMatches.list — o motivo vai também como dado", () => {
  it("um sentido e mútuo: de quem para quem, e o que cada um possui", async () => {
    linhas.set(aiMatchSuggestions, [
      sugestao("s-1", 13, 12, "exact", ["Exportar café"], "Contato K3 Exportar possui Exportar café, que Contato K2 Importadora procura."),
      sugestao("s-2", 11, 14, "mutual", ["Torrefação", "Armazém em Santos"], "Ana possui Torrefação, que Bia procura; Bia possui Armazém em Santos, que Ana procura."),
    ]);
    linhas.set(privateContacts, [
      { id: 11, fullName: "Ana", company: null, jobTitle: null },
      { id: 12, fullName: "Contato K2 Importadora", company: null, jobTitle: null },
      { id: 13, fullName: "Contato K3 Exportar", company: null, jobTitle: null },
      { id: 14, fullName: "Bia", company: null, jobTitle: null },
    ]);
    linhas.set(contactAssets, [
      { contactId: 13, slug: "exportar-cafe", label: "Exportar café" },
      { contactId: 11, slug: "torrefacao", label: "Torrefação" },
      { contactId: 14, slug: null, label: "Armazém em Santos" },
    ]);

    const lista = await intelligentMatchesRouter.createCaller(ctx).list();

    expect(lista.map(match => match.motivo)).toEqual([
      [{ deId: 13, paraId: 12, possui: ["Exportar café"] }],
      [{ deId: 11, paraId: 14, possui: ["Torrefação"] }, { deId: 14, paraId: 11, possui: ["Armazém em Santos"] }],
    ]);
    // A frase gravada continua indo (a tela a usa quando não há direção), e os nomes também.
    expect(lista[0]).toMatchObject({ reasonText: expect.stringContaining("possui"), contactA: { name: "Contato K3 Exportar" }, contactB: { name: "Contato K2 Importadora" } });
  });
});
