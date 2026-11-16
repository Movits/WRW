import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * As três travas de `conta.excluirMinhaConta` (server/routers/conta.ts), rodadas
 * de verdade pelo `createCaller`: a palavra digitada, a senha e a última
 * administradora. O que apaga é testado em `exclusao-de-conta.test.ts`; aqui
 * `excluirConta` é dublê, e metade destes testes prova que ele NÃO foi chamado.
 *
 * Por que cada uma existe:
 * - sem conferir a senha, uma sessão roubada (ou um notebook aberto) apaga a
 *   rede de contatos inteira de uma membra, sem volta;
 * - sem a palavra digitada, o botão vira clique sem querer;
 * - sem a trava da última administradora, a plataforma fica sem moderação de
 *   oportunidade e sem painel, um estado do qual não se sai pela interface.
 */

const excluirContaFalso = vi.fn();
const auditoria: Array<Record<string, unknown>> = [];

vi.mock("./exclusao-de-conta", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  excluirConta: (...args: unknown[]) => excluirContaFalso(...args),
}));

vi.mock("./security", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createAuditLog: async (params: Record<string, unknown>) => { auditoria.push(params); },
}));

const compararSenha = vi.fn();
vi.mock("bcryptjs", () => ({
  compare: (...args: unknown[]) => compararSenha(...args),
  default: { compare: (...args: unknown[]) => compararSenha(...args) },
}));

let tentativasNaJanela = 0;
let outrasAdministradoras = 1;

vi.mock("./db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  exigirDb: async () => fakeDb,
}));

import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import { auditLogs, users } from "../drizzle/schema";
import {
  ACAO_EXCLUSAO, ACAO_EXCLUSAO_RECUSADA, LIMITE_DE_TENTATIVAS, TETO_DE_CHAVES_NA_AUDITORIA,
  confirmacaoConfere, confirmacaoEsperada, impressaoDaChave, pastaDaChave,
} from "./routers/conta";

const fakeDb = {
  select: () => ({
    from: (tabela: unknown) => ({
      where: async () => {
        if (tabela === auditLogs) return [{ total: tentativasNaJanela }];
        if (tabela === users) return [{ total: outrasAdministradoras }];
        return [];
      },
    }),
  }),
} as never;

type Usuaria = NonNullable<TrpcContext["user"]>;

function contexto(sobrescreve: Partial<Usuaria> = {}) {
  const cookiesLimpos: string[] = [];
  const user = {
    id: 7,
    openId: "open-7",
    email: "Dona@Exemplo.com",
    name: "Dona",
    passwordHash: "$2a$hash",
    role: "silver",
    loginMethod: "email",
    emailVerified: true,
    isActive: true,
    isVerified: true,
    onboardingCompleted: true,
    country: "BR",
    company: null,
    position: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
    ...sobrescreve,
  } as Usuaria;
  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {}, ip: "203.0.113.9" } as TrpcContext["req"],
    res: { clearCookie: (nome: string) => { cookiesLimpos.push(nome); } } as unknown as TrpcContext["res"],
  };
  return { ctx, cookiesLimpos, caller: appRouter.createCaller(ctx) };
}

const RELATORIO = {
  passos: [{ nome: "users.id + users.openId", linhas: 1 }],
  arquivosApagados: 2,
  arquivosComFalha: [] as string[],
  linhasApagadas: 31,
  googleAgenda: "sem-conexao",
};

beforeEach(() => {
  excluirContaFalso.mockReset();
  excluirContaFalso.mockResolvedValue(RELATORIO);
  compararSenha.mockReset();
  compararSenha.mockResolvedValue(true);
  auditoria.length = 0;
  tentativasNaJanela = 0;
  outrasAdministradoras = 1;
});

describe("a palavra digitada (trava 1)", () => {
  it("o e-mail confere sem ligar para maiúsculas nem espaços", () => {
    expect(confirmacaoConfere("Dona@Exemplo.com", "  dona@exemplo.com ")).toBe(true);
    expect(confirmacaoConfere("Dona@Exemplo.com", "dona@exemplo.co")).toBe(false);
  });

  it("conta sem e-mail confirma pela palavra fixa, e ela não é traduzida", () => {
    expect(confirmacaoEsperada(null)).toBe("EXCLUIR");
    expect(confirmacaoConfere(null, "excluir")).toBe(true);
    expect(confirmacaoConfere("   ", "EXCLUIR")).toBe(true);
    expect(confirmacaoConfere(null, "delete")).toBe(false);
  });

  it("confirmação errada não apaga nada e nem confere a senha", async () => {
    const { caller } = contexto();
    await expect(caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "sim" }))
      .rejects.toThrow(/digite exatamente/i);
    expect(excluirContaFalso).not.toHaveBeenCalled();
    expect(compararSenha).not.toHaveBeenCalled();
    expect(auditoria).toHaveLength(0);
  });
});

describe("a senha (trava 2)", () => {
  it("senha errada registra a tentativa e não apaga nada", async () => {
    compararSenha.mockResolvedValue(false);
    const { caller } = contexto();
    await expect(caller.conta.excluirMinhaConta({ senha: "errada", confirmacao: "dona@exemplo.com" }))
      .rejects.toThrow("Senha incorreta.");
    expect(excluirContaFalso).not.toHaveBeenCalled();
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ action: ACAO_EXCLUSAO_RECUSADA, status: "failure", userId: 7 });
  });

  it("conta sem senha é recusada com instrução, não com erro genérico", async () => {
    const { caller } = contexto({ passwordHash: null });
    await expect(caller.conta.excluirMinhaConta({ senha: "x", confirmacao: "dona@exemplo.com" }))
      .rejects.toThrow(/Esqueci minha senha/);
    expect(excluirContaFalso).not.toHaveBeenCalled();
  });

  it("passando do limite de tentativas, fecha antes de conferir a senha", async () => {
    tentativasNaJanela = LIMITE_DE_TENTATIVAS;
    const { caller } = contexto();
    await expect(caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" }))
      .rejects.toThrow(/Muitas tentativas/);
    expect(compararSenha).not.toHaveBeenCalled();
    expect(excluirContaFalso).not.toHaveBeenCalled();
  });
});

describe("a última administradora (trava 3)", () => {
  it("presidenta sozinha não se apaga", async () => {
    outrasAdministradoras = 0;
    const { caller } = contexto({ role: "president" });
    await expect(caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" }))
      .rejects.toThrow(/últim[oa] administrador/);
    expect(excluirContaFalso).not.toHaveBeenCalled();
  });

  it("com outra administradora no ar, a presidenta pode sair", async () => {
    outrasAdministradoras = 1;
    const { caller } = contexto({ role: "president" });
    await expect(caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" }))
      .resolves.toMatchObject({ sucesso: true });
  });

  it("membra comum sozinha no papel não é barrada (a trava é só da governança)", async () => {
    outrasAdministradoras = 0;
    const { caller } = contexto({ role: "silver" });
    await expect(caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" }))
      .resolves.toMatchObject({ sucesso: true });
  });
});

describe("o caminho feliz", () => {
  it("apaga, limpa o cookie e devolve as contagens", async () => {
    const { caller, cookiesLimpos } = contexto();
    const resposta = await caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "DONA@exemplo.com" });
    expect(excluirContaFalso).toHaveBeenCalledTimes(1);
    expect(excluirContaFalso.mock.calls[0][1]).toEqual({ id: 7, openId: "open-7", email: "Dona@Exemplo.com" });
    expect(resposta).toEqual({ sucesso: true, linhasApagadas: 31, arquivosApagados: 2, arquivosComFalha: 0, googleNaoConfirmou: false });
    expect(cookiesLimpos).toEqual([COOKIE_NAME]);
  });

  it("o registro da exclusão não guarda nome nem e-mail", async () => {
    const { caller } = contexto();
    await caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" });
    const registro = auditoria.find(linha => linha.action === ACAO_EXCLUSAO);
    expect(registro).toBeDefined();
    expect(registro).toMatchObject({ status: "success", riskLevel: "high", resource: "conta" });
    const serializado = JSON.stringify(registro!.details);
    expect(serializado).not.toContain("Dona");
    expect(serializado.toLowerCase()).not.toContain("exemplo.com");
    expect(serializado).toContain("linhasApagadas");
  });

  it("arquivo que o bucket recusou vira status failure, sem esconder a exclusão", async () => {
    excluirContaFalso.mockResolvedValue({ ...RELATORIO, arquivosComFalha: ["sivc/7/9/rg.png"] });
    const { caller } = contexto();
    const resposta = await caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" });
    expect(resposta.arquivosComFalha).toBe(1);
    expect(auditoria.find(linha => linha.action === ACAO_EXCLUSAO)).toMatchObject({ status: "failure" });
  });

  it("o token da Google Agenda que a Google não revogou também vira failure, e o registro diz isso (H16b)", async () => {
    excluirContaFalso.mockResolvedValue({ ...RELATORIO, googleAgenda: "falhou" });
    const { caller } = contexto();
    const resposta = await caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" });
    expect(resposta.sucesso).toBe(true);
    // A tela precisa saber, para dizer à dona como tirar o acesso pela conta Google.
    expect(resposta.googleNaoConfirmou).toBe(true);
    const registro = auditoria.find(linha => linha.action === ACAO_EXCLUSAO);
    expect(registro).toMatchObject({ status: "failure" });
    expect((registro!.details as Record<string, unknown>).googleAgenda).toBe("falhou");
  });

  it("a conexão revogada, nenhuma, ou mantida para outra conta não muda o sucesso do registro nem avisa a tela", async () => {
    for (const googleAgenda of ["revogada", "sem-conexao", "mantida-para-outra-conta"]) {
      auditoria.length = 0;
      excluirContaFalso.mockResolvedValue({ ...RELATORIO, googleAgenda });
      const { caller } = contexto();
      const resposta = await caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" });
      expect(resposta.googleNaoConfirmou).toBe(false);
      const registro = auditoria.find(linha => linha.action === ACAO_EXCLUSAO);
      expect(registro).toMatchObject({ status: "success" });
      expect((registro!.details as Record<string, unknown>).googleAgenda).toBe(googleAgenda);
    }
  });
});

// ══ o que ficou no bucket precisa estar LOCALIZÁVEL, sem virar dado pessoal ══
// Duas revisões de 15/09, nesta ordem.
//
// A primeira: a auditoria gravava só `arquivosComFalha: 2`. Contagem não apaga
// arquivo — quando alguém for limpar o bucket à mão, dias depois e obrigada a
// isso por LGPD, as linhas que diziam ONDE o objeto está já saíram junto com a
// conta, e o único outro lugar em que as chaves aparecem é o console.error do
// processo, que no Render se perde na rolagem do log.
//
// A segunda, do revisor: a lista de chaves CRUAS, que entrou como remédio,
// carrega dado pessoal. O nome do arquivo enviado vira parte da chave em
// deal-rooms, sivc e contexts, e `audit_logs` é imutável e sobrevive à conta —
// então "rg-frente-ana-souza.jpg" ficaria escrito no banco para sempre DEPOIS
// de a dona pedir a exclusão. Daí o formato de hoje: a pasta (só ids) escrita,
// o nome do arquivo virando impressão digital. Dá para achar o objeto (listar a
// pasta, hashear, comparar) e não dá para ler o que ele é.
describe("a auditoria localiza o que ficou no bucket sem escrever o nome do arquivo", () => {
  // Uma chave de cada prefixo em que o nome do arquivo é escolhido por gente:
  // documento de identidade, contrato da sala e mídia de contexto.
  const CHAVES = [
    "sivc/7/9/1757000000000-rg-frente-ana-souza.jpg",
    "deal-rooms/12/1757000001000-Contrato_Ana_Souza_assinado.pdf",
    "contexts/open-7/44/almoco-com-ana-souza.jpg",
  ];

  async function detalhesDaExclusao(arquivosComFalha: string[]) {
    excluirContaFalso.mockResolvedValue({ ...RELATORIO, arquivosComFalha });
    const { caller } = contexto();
    await caller.conta.excluirMinhaConta({ senha: "certa", confirmacao: "dona@exemplo.com" });
    return auditoria.find(linha => linha.action === ACAO_EXCLUSAO)?.details as Record<string, unknown>;
  }

  it("o nome do arquivo NÃO entra no registro — nem o da dona, nem o do documento", async () => {
    const detalhes = await detalhesDaExclusao(CHAVES);
    const serializado = JSON.stringify(detalhes);
    for (const vazamento of ["rg-frente", "Contrato", "Ana_Souza", "ana-souza", "almoco", ".pdf", ".jpg"]) {
      expect(serializado).not.toContain(vazamento);
    }
    expect(serializado).not.toContain("Dona");
    expect(serializado.toLowerCase()).not.toContain("exemplo.com");
  });

  it("a pasta e a contagem ficam escritas: é por onde a limpeza começa", async () => {
    const detalhes = await detalhesDaExclusao(CHAVES);
    expect(detalhes.arquivosComFalha).toBe(3);
    expect(detalhes.pastasQueFicaramNoBucket).toEqual([
      { pasta: "contexts/open-7/44", arquivos: 1 },
      { pasta: "deal-rooms/12", arquivos: 1 },
      { pasta: "sivc/7/9", arquivos: 1 },
    ]);
    expect(detalhes.chavesOmitidas).toBeUndefined();
    expect(detalhes.pastasOmitidas).toBeUndefined();
  });

  it("a impressão digital identifica O OBJETO: duas chaves da MESMA pasta não se confundem", async () => {
    // A pasta de uma sala guarda documento das DUAS pontas (routers/dealRoom.ts):
    // apagar a pasta inteira levaria o arquivo da contraparte. Quem limpa precisa
    // escolher um objeto por vez, e é a impressão que diz qual.
    const daSala = ["deal-rooms/12/1757000001000-meu.pdf", "deal-rooms/12/1757000002000-dela.pdf"];
    const detalhes = await detalhesDaExclusao(daSala);
    expect(detalhes.pastasQueFicaramNoBucket).toEqual([{ pasta: "deal-rooms/12", arquivos: 2 }]);
    const impressoes = detalhes.impressoesDasChaves as string[];
    expect(impressoes).toEqual(daSala.map(impressaoDaChave));
    expect(new Set(impressoes).size).toBe(2);
    for (const impressao of impressoes) expect(impressao).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a impressão é estável: quem listar o bucket depois chega ao mesmo valor", () => {
    expect(impressaoDaChave(CHAVES[0])).toBe(impressaoDaChave(CHAVES[0]));
    expect(impressaoDaChave(CHAVES[0])).not.toBe(impressaoDaChave(CHAVES[1]));
    expect(pastaDaChave("deal-rooms/12/1757000001000-Contrato.pdf")).toBe("deal-rooms/12");
    // Chave sem barra nenhuma não vira nome de arquivo escrito por engano.
    expect(pastaDaChave("legado.jpg")).toBe("(raiz do bucket)");
  });

  it("sem falha nenhuma, nada disso aparece no registro", async () => {
    const detalhes = await detalhesDaExclusao([]);
    expect(detalhes.arquivosComFalha).toBe(0);
    expect("pastasQueFicaramNoBucket" in detalhes).toBe(false);
    expect("impressoesDasChaves" in detalhes).toBe(false);
  });

  it("muitos objetos na mesma pasta: as impressões são cortadas no teto, e o registro conta as que faltam", async () => {
    const muitas = Array.from({ length: TETO_DE_CHAVES_NA_AUDITORIA + 7 }, (_, i) => `contacts/open-7/foto-${i}.jpg`);
    const detalhes = await detalhesDaExclusao(muitas);
    expect(detalhes.arquivosComFalha).toBe(muitas.length);
    expect(detalhes.impressoesDasChaves).toHaveLength(TETO_DE_CHAVES_NA_AUDITORIA);
    expect(detalhes.chavesOmitidas).toBe(7);
    // A contagem da pasta olha TODAS as chaves, não só as que couberam.
    expect(detalhes.pastasQueFicaramNoBucket).toEqual([{ pasta: "contacts/open-7", arquivos: muitas.length }]);
    expect(detalhes.pastasOmitidas).toBeUndefined();
  });

  it("muitas pastas diferentes: a lista de pastas também é cortada, e diz quantas ficaram de fora", async () => {
    const muitas = Array.from({ length: TETO_DE_CHAVES_NA_AUDITORIA + 3 }, (_, i) => `contexts/open-7/${i}/midia.jpg`);
    const detalhes = await detalhesDaExclusao(muitas);
    expect(detalhes.pastasQueFicaramNoBucket).toHaveLength(TETO_DE_CHAVES_NA_AUDITORIA);
    expect(detalhes.pastasOmitidas).toBe(3);
    expect(detalhes.chavesOmitidas).toBe(3);
  });
});

describe("requisitosDaExclusao (o que a tela pergunta antes de oferecer o botão)", () => {
  it("diz o que digitar, se há senha e se ela é a última administradora", async () => {
    outrasAdministradoras = 0;
    const { caller } = contexto({ role: "gold" });
    await expect(caller.conta.requisitosDaExclusao()).resolves.toEqual({
      confirmacaoEsperada: "dona@exemplo.com",
      temSenha: true,
      ultimaAdministradora: true,
    });
  });

  it("membra comum nunca é última administradora, mesmo sem nenhuma no ar", async () => {
    outrasAdministradoras = 0;
    const { caller } = contexto({ role: "bronze", email: null, passwordHash: null });
    await expect(caller.conta.requisitosDaExclusao()).resolves.toEqual({
      confirmacaoEsperada: "EXCLUIR",
      temSenha: false,
      ultimaAdministradora: false,
    });
  });
});

// ══ conta de governança DESATIVADA não conta como governança viva ════════════
// Achado da revisão adversarial de 12/09, confirmado por dois verificadores: a
// contagem filtrava só por papel. Com uma única administradora ATIVA e outra
// desativada, a trava liberava — e a plataforma ficava sem ninguém que
// conseguisse entrar para moderar, porque conta inativa é recusada no login e
// reativá-la exige um procedimento de admin.
describe("a trava da última administradora olha quem está ATIVA", () => {
  it("as duas consultas de governança filtram isActive", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(new URL("./routers/conta.ts", import.meta.url), "utf8");
    const contagens = fonte.split("inArray(users.role");
    expect(contagens.length - 1, "esperava duas contagens de governança").toBe(2);
    for (const trecho of contagens.slice(1)) {
      const janela = trecho.slice(0, 400);
      expect(janela).toContain("eq(users.isActive, true)");
    }
  });
});
