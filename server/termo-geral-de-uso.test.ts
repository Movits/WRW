import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Termo Geral de Uso, Proteção de Dados e Intermediação Digital (Dr. Ronei,
 * grupo "Projetos IA", 14/09 19:59–20:02): "para ser incluído como última etapa
 * do processo cadastramento e criação do usuário".
 *
 * Prova que:
 *   1. o cadastro NÃO conclui sem o termo vigente aceito, e sem versão publicada
 *      também não (ao contrário do Smart Match, aqui ausência de texto barra);
 *   2. o aceite registra a versão que a TELA mostrou: versão trocada no meio da
 *      leitura dá CONFLICT e nada é gravado;
 *   3. o tipo existe nas três listas que precisam andar juntas (schema, router,
 *      script de publicação), e o documento em docs/ termina com a frase que o
 *      checkbox mostra em português;
 *   4. "Outra necessidade" em "O que você busca?" exige o texto, e desmarcar
 *      apaga o texto antigo.
 */

import { consents, documentVersions } from "../drizzle/schema";

const leituras = new Map<unknown, unknown[][]>();
const inserido = vi.fn(async (_valores: unknown) => {});
const tabelasInseridas: unknown[] = [];
const upsertUserProfile = vi.fn(async (_userId: number, _dados: Record<string, unknown>) => {});
const atualizacoes: unknown[] = [];
let bancoFora = false;

function proximaLeitura(tabela: unknown): unknown[] {
  const fila = leituras.get(tabela);
  if (!fila || fila.length === 0) return [];
  return fila.length === 1 ? fila[0] : (fila.shift() as unknown[]);
}

const dbFalso = {
  select: (_campos?: unknown) => ({
    from: (tabela: unknown) => ({
      where: () => ({
        limit: async () => proximaLeitura(tabela),
      }),
    }),
  }),
  insert: (tabela: unknown) => {
    tabelasInseridas.push(tabela);
    return { values: inserido };
  },
  update: (tabela: unknown) => ({ set: (dados: unknown) => { atualizacoes.push({ tabela, dados }); return { where: async () => {} }; } }),
};

vi.mock("./db", async () => {
  const { BancoIndisponivel } = await import("./banco-indisponivel");
  return {
    exigirDb: async () => {
      if (bancoFora) throw new BancoIndisponivel();
      return dbFalso;
    },
    getUserProfile: vi.fn(async () => null),
    upsertUserProfile: (userId: number, dados: Record<string, unknown>) => upsertUserProfile(userId, dados),
  };
});
vi.mock("./nivel-do-perfil", () => ({ reavaliarNivelPeloPerfil: async () => ({ promovidaAPrata: false }) }));
vi.mock("./matching", () => ({ generateMatchesForUser: async () => {} }));

const { exigirAceiteDoTermoGeral, MENSAGEM_TERMO_GERAL_NAO_PUBLICADO, MENSAGEM_TERMO_GERAL_SEM_ACEITE, TIPO_TERMO_GERAL } =
  await import("./termo-geral-de-uso");
const { consentRouter, DOCUMENT_TYPES } = await import("./routers/consent");
const { profileRouter } = await import("./routers/profile");
const { BancoIndisponivel } = await import("./banco-indisponivel");

const TERMO = { id: "termo-v1", type: "termo_geral_de_uso", version: 1, text: "# TERMO GERAL\n\n1.1. Texto." };

const ctx = (id: number) => ({
  user: { id, openId: `u-${id}`, email: "t@local", role: "bronze" },
  req: { headers: { "user-agent": "Vitest/1.0" }, socket: { remoteAddress: "127.0.0.1" } },
  res: { cookie: () => {} },
}) as never;

const ONBOARDING_MINIMO = { displayName: "Ana Souza", city: "Brasília", country: "BR", declaraMaioridade: true };

beforeEach(() => {
  leituras.clear();
  inserido.mockClear();
  upsertUserProfile.mockClear();
  tabelasInseridas.length = 0;
  atualizacoes.length = 0;
  bancoFora = false;
});

describe("exigirAceiteDoTermoGeral", () => {
  it("sem versão publicada, barra com a mensagem que diz isso", async () => {
    await expect(exigirAceiteDoTermoGeral(1)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: MENSAGEM_TERMO_GERAL_NAO_PUBLICADO,
    });
  });

  it("com versão publicada e sem aceite, barra", async () => {
    leituras.set(documentVersions, [[TERMO]]);
    leituras.set(consents, [[]]);
    await expect(exigirAceiteDoTermoGeral(1)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: MENSAGEM_TERMO_GERAL_SEM_ACEITE,
    });
  });

  it("com o aceite da versão vigente, passa e diz QUAL versão foi aceita", async () => {
    leituras.set(documentVersions, [[TERMO]]);
    leituras.set(consents, [[{ id: 9 }]]);
    // É essa versão que a declaração de maioridade registra (server/maioridade.ts).
    await expect(exigirAceiteDoTermoGeral(1)).resolves.toEqual({ id: "termo-v1", version: 1 });
  });

  it("banco fora do ar é erro, nunca 'sem termo'", async () => {
    bancoFora = true;
    await expect(exigirAceiteDoTermoGeral(1)).rejects.toBeInstanceOf(BancoIndisponivel);
  });
});

describe("profile.completeOnboarding exige o Termo Geral", () => {
  it("sem aceite, não grava perfil nem marca o cadastro como concluído", async () => {
    leituras.set(documentVersions, [[TERMO]]);
    leituras.set(consents, [[]]);
    await expect(profileRouter.createCaller(ctx(7)).completeOnboarding(ONBOARDING_MINIMO))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(upsertUserProfile).not.toHaveBeenCalled();
    expect(atualizacoes).toHaveLength(0);
  });

  it("com aceite, conclui", async () => {
    leituras.set(documentVersions, [[TERMO]]);
    leituras.set(consents, [[{ id: 9 }]]);
    await expect(profileRouter.createCaller(ctx(7)).completeOnboarding(ONBOARDING_MINIMO)).resolves.toMatchObject({ success: true });
    expect(upsertUserProfile).toHaveBeenCalledTimes(1);
  });
});

describe("consent.accept guarda a versão que a tela mostrou", () => {
  it("versão diferente da vigente: CONFLICT, nada gravado", async () => {
    leituras.set(documentVersions, [[{ ...TERMO, id: "termo-v2", version: 2 }]]);
    await expect(consentRouter.createCaller(ctx(3)).accept({ type: TIPO_TERMO_GERAL, documentVersionId: "termo-v1" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(inserido).not.toHaveBeenCalled();
  });

  it("mesma versão: grava o consentimento dela", async () => {
    leituras.set(documentVersions, [[TERMO]]);
    leituras.set(consents, [[]]);
    await consentRouter.createCaller(ctx(3)).accept({ type: TIPO_TERMO_GERAL, documentVersionId: "termo-v1" });
    expect(tabelasInseridas).toEqual([consents]);
    expect(inserido.mock.calls[0][0]).toMatchObject({ userId: 3, documentVersionId: "termo-v1" });
  });

  it("sem versão publicada: NOT_FOUND, como os outros termos", async () => {
    await expect(consentRouter.createCaller(ctx(3)).accept({ type: TIPO_TERMO_GERAL }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("o tipo e o texto andam juntos", () => {
  const AQUI = path.dirname(fileURLToPath(import.meta.url));
  const ler = (...partes: string[]) => readFileSync(path.resolve(AQUI, "..", ...partes), "utf8");

  it("termo_geral_de_uso está no router, no enum do schema e no script de publicação", () => {
    expect(DOCUMENT_TYPES).toContain("termo_geral_de_uso");
    expect(ler("drizzle", "schema.ts")).toMatch(/"termo_geral_de_uso",\s*\]\)\.notNull\(\)/);
    expect(ler("scripts", "publicar-documento.mjs")).toMatch(/const TIPOS = \[[^\]]*"termo_geral_de_uso"/);
  });

  it("o documento termina com a linha do aceite, e o checkbox em português diz a mesma frase", () => {
    const linhas = ler("docs", "termos", "termo-geral-de-uso.md").replace(/\r\n/g, "\n").trimEnd().split("\n");
    const ultima = linhas[linhas.length - 1];
    const ptBR = JSON.parse(ler("client", "src", "i18n", "locales", "pt-BR.json"));
    expect(ultima).toBe(`☐ ${ptBR.termoGeral.aceite}`);
    expect(ptBR.termoGeral.aceite).toBe("LI E ACEITO integralmente este Termo Geral de Uso, Proteção de Dados e Intermediação Digital.");
  });

  it("o documento tem as 27 cláusulas com título (1 a 26, mais a 5-A)", () => {
    const titulos = ler("docs", "termos", "termo-geral-de-uso.md").replace(/\r\n/g, "\n").match(/^## .+$/gm) ?? [];
    expect(titulos).toHaveLength(27);
    expect(titulos[0]).toBe("## 1. IDENTIFICAÇÃO DAS PARTES");
    expect(titulos).toContain("## 5-A. ÁREA PRIVADA DE NETWORKING, OPORTUNIDADES E DEMANDAS");
    expect(titulos[titulos.length - 1]).toBe("## 26. ACEITE ÚNICO E DECLARAÇÕES ESPECÍFICAS DE CONSENTIMENTO");
  });
});

/**
 * Pedido do Rosber (Roberto, 15/09): a palavra "Match" não aparece para a
 * usuária. O termo é a ÚLTIMA etapa do cadastro, então é a primeira e a última
 * tela em que ela leria a palavra — o texto jurídico passa a dizer CONEXÃO.
 *
 * O que NÃO muda: SMART MATCH é nome próprio do produto e continua escrito
 * assim nas 29 ocorrências. Se Dr. Ronei revisar o texto e esse número mudar,
 * o número aqui muda junto — é pino de contagem, não regra de negócio.
 */
describe("o termo diz CONEXÃO, e só SMART MATCH sobra com a palavra", () => {
  const AQUI = path.dirname(fileURLToPath(import.meta.url));
  const termo = () => readFileSync(path.resolve(AQUI, "..", "docs", "termos", "termo-geral-de-uso.md"), "utf8");

  it("tirando SMART MATCH e a marca MARQUESAMATCH (23/11/2026), a palavra não aparece em caixa alta, baixa nem no plural", () => {
    const sobra = termo().replace(/SMART MATCH|\bMARQUESAMATCH\b/g, "");
    expect(sobra.match(/match\w*/gi) ?? []).toEqual([]);
  });

  it("SMART MATCH, nome do produto, fica de pé nas 29 ocorrências", () => {
    expect(termo().match(/SMART MATCH/g) ?? []).toHaveLength(29);
  });

  it("a definição da Cláusula 2 e as remissões a ela acompanham o gênero novo", () => {
    const texto = termo();
    expect(texto).toContain("**CONEXÃO.** Potencial compatibilidade identificada pela PLATAFORMA");
    expect(texto).toContain("**NEGÓCIO DECORRENTE DA CONEXÃO.**");
    expect(texto).toContain("## 13. NEGÓCIO DECORRENTE DA CONEXÃO E NEGÓCIOS REALIZADOS FORA DA PLATAFORMA");
    expect(texto).toContain("## 17. REGISTROS ELETRÔNICOS, PROVA E CERTIFICADO DA CONEXÃO");
    expect(texto).toContain("“Certificado da Conexão”");
    expect(texto).toContain("6.1. A CONEXÃO não constitui sociedade");
  });
});

describe("O que você busca? — Outra necessidade", () => {
  beforeEach(() => {
    leituras.set(documentVersions, [[TERMO]]);
    leituras.set(consents, [[{ id: 9 }]]);
  });

  it("marcada sem texto: BAD_REQUEST, nada gravado", async () => {
    await expect(profileRouter.createCaller(ctx(8)).completeOnboarding({
      ...ONBOARDING_MINIMO, seekingTypes: ["outra_necessidade"], seekingOtherNeed: "  ",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(upsertUserProfile).not.toHaveBeenCalled();
  });

  it("marcada com texto: grava o texto aparado como necessidade declarada", async () => {
    await profileRouter.createCaller(ctx(8)).completeOnboarding({
      ...ONBOARDING_MINIMO, seekingTypes: ["expandir_negocio", "outra_necessidade"], seekingOtherNeed: "  Armazém refrigerado em Santos  ",
    });
    expect(upsertUserProfile.mock.calls[0][1]).toMatchObject({
      seekingTypes: ["expandir_negocio", "outra_necessidade"],
      seekingOtherNeed: "Armazém refrigerado em Santos",
    });
  });

  it("desmarcada: o texto velho vira null", async () => {
    await profileRouter.createCaller(ctx(8)).completeOnboarding({
      ...ONBOARDING_MINIMO, seekingTypes: ["expandir_negocio"], seekingOtherNeed: "sobrou do clique anterior",
    });
    expect(upsertUserProfile.mock.calls[0][1]).toMatchObject({ seekingOtherNeed: null });
  });

  it("chave desconhecida é recusada; as antigas ainda passam (cliente em cache no deploy)", async () => {
    const caller = profileRouter.createCaller(ctx(8));
    await expect(caller.completeOnboarding({ ...ONBOARDING_MINIMO, seekingTypes: ["qualquer_coisa"] }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.completeOnboarding({ ...ONBOARDING_MINIMO, seekingTypes: ["investor", "job", "be_mentor"] }))
      .resolves.toMatchObject({ success: true });
  });
});

/**
 * A página pública /termos mostra o MESMO documento que o cadastro apresenta.
 *
 * Até 15/09 ela dizia que o termo "está em elaboração", texto escrito no
 * código, enquanto o cadastro já exigia o aceite do documento do Dr. Ronei:
 * quem clicava no rodapé lia o contrário do que a plataforma fazia. O
 * procedimento é público de propósito — quem ainda não tem conta precisa poder
 * ler o que vai aceitar — e por isso a conferência mais importante aqui é a de
 * que ele não devolve NADA além do documento.
 */
describe("termo vigente na página pública", () => {
  it("devolve versão, texto e data sem nenhuma sessão", async () => {
    leituras.set(documentVersions, [[TERMO]]);

    const publico = await consentRouter.createCaller({
      user: null,
      req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      res: { cookie: () => {} },
    } as never).termoGeralPublico();

    expect(publico).toEqual({
      version: TERMO.version,
      text: TERMO.text,
      publishedAt: TERMO.publishedAt,
    });
  });

  it("não deixa escapar id do documento nem dado de usuária", async () => {
    leituras.set(documentVersions, [[TERMO]]);

    const publico = await consentRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as never).termoGeralPublico();

    expect(Object.keys(publico ?? {}).sort()).toEqual(["publishedAt", "text", "version"]);
  });

  it("sem versão publicada devolve null, e a tela diz isso em vez de inventar texto", async () => {
    leituras.set(documentVersions, [[]]);

    const publico = await consentRouter.createCaller({ user: null, req: { headers: {} }, res: {} } as never).termoGeralPublico();

    expect(publico).toBeNull();
  });
});
