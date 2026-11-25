import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Ouro é a categoria premium da rede, mediante mensalidade (Governança,
 * 14/09/2026), não um selo concedido por mérito. A concessão foi reescrita
 * nesse vocabulário, mas a revogação, o diálogo de concessão do Painel Ouro e o
 * banner do Dashboard continuavam no "Selo de Exclusividade Institucional": a
 * mesma membra lia "Status Ouro, categoria premium" ao ganhar e "Selo de
 * Exclusividade Institucional revogado" ao perder.
 *
 * Aqui: o texto que as rotas gravam de verdade (notificação e mensagem direta)
 * e uma varredura dos textos de tela nos 10 idiomas.
 */

const estado = vi.hoisted(() => ({
  notificacoes: [] as { title?: string | null; body?: string | null; type?: string }[],
  mensagens: [] as { encryptedContent?: string }[],
  nivelDeVolta: "silver" as "silver" | "bronze",
}));

vi.mock("./db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db")>();
  const bancoFalso = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ name: "Ana Souza" }] }) }) }),
    insert: () => ({ values: async (v: { encryptedContent?: string }) => { estado.mensagens.push(v); } }),
  };
  return {
    ...original,
    exigirDb: async () => bancoFalso,
    grantGoldAccess: async () => {},
    revokeGoldAccess: async () => estado.nivelDeVolta,
    createNotification: async (n: (typeof estado.notificacoes)[number]) => { estado.notificacoes.push(n); },
  };
});

vi.mock("./security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./security")>()),
  createAuditLog: async () => {},
}));

// president.ts importa matching.ts (LLM e e-mail); nada daqui o usa.
vi.mock("./routers/matching", () => ({
  notifyHighCompatibilityForOpportunity: async () => ({ notified: 0 }),
}));

const { presidentRouter } = await import("./routers/president");

const req = { headers: {}, socket: {} };
const res = { cookie: () => {} };
const presidente = { user: { id: 1, openId: "p-1", email: "p@local", role: "president", name: "Presidente" }, req, res } as never;

/** O vocabulário antigo, em qualquer grafia que ele tenha tido. */
const SELO = /selo|exclusividade|reconhec|parab[ée]ns/i;

beforeEach(() => {
  estado.notificacoes = [];
  estado.mensagens = [];
  estado.nivelDeVolta = "silver";
});

describe("revokeGold fala de Status Ouro, como a concessão", () => {
  it("título e corpo sem o selo, com o motivo e o nível Prata de volta", async () => {
    const r = await presidentRouter.createCaller(presidente).revokeGold({ userId: 9, reason: "Mensalidade não renovada" });

    expect(r).toEqual({ success: true, novoNivel: "silver" });
    expect(estado.notificacoes).toHaveLength(1);
    const [n] = estado.notificacoes;
    expect(n.type).toBe("gold_revoked");
    expect(n.title).toBe("Status Ouro revogado");
    expect(n.body).toContain("Seu Status Ouro, a categoria premium da Marquesa Global Match, foi revogado por um Presidente da Marquesa Global Match.");
    expect(n.body).not.toMatch(/\bMMM\b/);
    expect(n.body).toContain("Sua conta continua ativa como Prata.");
    expect(n.body).toContain("Motivo: Mensalidade não renovada");
    expect(`${n.title} ${n.body}`).not.toMatch(SELO);
  });

  it("perfil sem a régua da Prata: o corpo diz Bronze, não Prata", async () => {
    estado.nivelDeVolta = "bronze";
    await presidentRouter.createCaller(presidente).revokeGold({ userId: 9, reason: "Mensalidade não renovada" });

    const [n] = estado.notificacoes;
    expect(n.body).toContain("Sua conta continua ativa como Bronze.");
    expect(n.body).not.toContain("Prata");
  });
});

describe("grantGold continua no vocabulário de categoria premium", () => {
  it("notificação e mensagem direta sem selo, mérito ou reconhecimento", async () => {
    await presidentRouter.createCaller(presidente).grantGold({ userId: 9 });

    expect(estado.notificacoes).toHaveLength(1);
    const [n] = estado.notificacoes;
    expect(n.title).toContain("Status Ouro");
    expect(n.body).toContain("Olá, Ana!");
    expect(`${n.title} ${n.body}`).not.toMatch(SELO);
    expect(estado.mensagens).toHaveLength(1);
    expect(estado.mensagens[0].encryptedContent).toContain("categoria premium da Marquesa Global Match");
    expect(estado.mensagens[0].encryptedContent).toContain("Observação: Promovido pelo Presidente da Marquesa Global Match");
    expect(estado.mensagens[0].encryptedContent).not.toMatch(/\bMMM\b/);
    expect(estado.mensagens[0].encryptedContent).not.toMatch(SELO);
  });
});

describe("textos de tela sem o selo de exclusividade", () => {
  const AQUI = path.dirname(fileURLToPath(import.meta.url));
  const PASTA = path.resolve(AQUI, "..", "client", "src", "i18n", "locales");
  // A grafia de "Selo de Exclusividade Institucional" em cada um dos 10 idiomas.
  const ANTIGO = /Exclusividade Institucional|Institutional Exclusivity|Exclusividad Institucional|Exclusivité Institutionnelle|Exklusivitätssiegel|институциональной эксклюзивности|機関限定|机构专属|संस्थागत विशिष्टता|الحصرية المؤسسية/;

  it("nenhum dos 10 idiomas traz o selo, e o banner do Dashboard existe em todos", () => {
    const idiomas = readdirSync(PASTA).filter(f => f.endsWith(".json"));
    expect(idiomas).toHaveLength(10);
    for (const arquivo of idiomas) {
      const bruto = readFileSync(path.join(PASTA, arquivo), "utf8");
      expect(bruto, arquivo).not.toMatch(ANTIGO);
      const { dashboard } = JSON.parse(bruto) as { dashboard: Record<string, string> };
      expect(dashboard.goldBannerTitle, arquivo).toBeTruthy();
      expect(dashboard.goldBannerBody, arquivo).toBeTruthy();
    }
    const ptBR = JSON.parse(readFileSync(path.join(PASTA, "pt-BR.json"), "utf8")) as { dashboard: Record<string, string> };
    expect(`${ptBR.dashboard.goldBannerTitle} ${ptBR.dashboard.goldBannerBody}`).toMatch(/Status Ouro/);
    expect(`${ptBR.dashboard.goldBannerTitle} ${ptBR.dashboard.goldBannerBody}`).not.toMatch(SELO);
  });

  it("o diálogo de concessão do Painel Ouro fala de Status Ouro", () => {
    const painel = readFileSync(path.resolve(AQUI, "..", "client", "src", "pages", "PresidentPanel.tsx"), "utf8");
    expect(painel).not.toMatch(ANTIGO);
    expect(painel).not.toMatch(/Selo Ouro de Exclusividade/);
    expect(painel).toContain("Você está concedendo o <strong className=\"text-amber-400\">Status Ouro</strong>, a categoria premium da rede");
  });
});
