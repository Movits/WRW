// server/matching.ts:12 resolve VAULT_ENCRYPTION_KEY no import (senão lança). O
// `.env` seta vazio, então `||=` (não `??=`) garante um valor mesmo no CI.
process.env.VAULT_ENCRYPTION_KEY ||= "chave-de-teste-sem-valor";
process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfile } from "../drizzle/schema";

/**
 * Regra da demanda expressa no motor de PERFIS (Dashboard) — pedido do
 * Nicolas, 12/09/2026.
 *
 * As seis dimensões somam nota mesmo sem encaixe nenhum: setor adjacente,
 * capacidade de investimento "neutra", valores, cidade. Um perfil cujo "o que
 * tenho" é só serviço ("Advocacia tributária", texto livre que o zod aceita e
 * "falar sobre o negócio" grava) virava match com quem "poderia precisar" —
 * por setor, nunca por necessidade declarada. Agora o par sustentado só por
 * serviço sem demanda expressa dá zero (bloqueio nomeado), não é gravado no
 * "Reanalisar" e some da leitura (a linha antiga fica, com a dispensa da dona
 * preservada). Base expressa por outro caminho
 * (produto que a outra declarou precisar, investimento buscado × capacidade
 * declarada) mantém o par: a regra é específica de serviço.
 */

vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => true,
  usersComConsentimento: async (ids: number[]) => new Set(ids),
}));
vi.mock("./_core/llm", () => ({ invokeLLM: async () => ({ choices: [{ message: { content: "insight" } }] }) }));

// Banco simulado por fila: cada SELECT terminado devolve a próxima resposta.
// Na rodada do motor de perfis a ordem é: o perfil da dona, as linhas que ela já tem em `matches` e as
// páginas de candidatas (sem o teto de 50, as linhas existentes passaram a ser lidas antes da comparação).
const filas: unknown[][] = [];
const upserts: Array<{ values: Record<string, unknown> }> = [];
const deletes: unknown[] = [];
function cadeiaDeSelect() {
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ["from", "where", "innerJoin", "limit", "orderBy"]) cadeia[metodo] = () => cadeia;
  (cadeia as { then?: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(filas.shift() ?? []).then(resolve, reject);
  return cadeia;
}
// Conta as consultas: "não consulta o banco" só é prova se a contagem existir
// (a fila vazia é verdadeira antes e depois, e não discrimina nada).
let selects = 0;
// As colunas de cada SELECT: a leitura só enxerga a especialidade se a pedir ao banco.
const colunasPedidas: string[][] = [];
const fakeDb = {
  select: (colunas?: Record<string, unknown>) => { selects += 1; colunasPedidas.push(Object.keys(colunas ?? {})); return cadeiaDeSelect(); },
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      onDuplicateKeyUpdate: () => { upserts.push({ values }); return Promise.resolve(); },
    }),
  }),
  update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  delete: () => ({ where: (condicao: unknown) => { deletes.push(condicao); return Promise.resolve(); } }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb as never, exigirDb: async () => fakeDb as never }));
// O registro PLATFORM_MATCH tem teste próprio (registro-de-conexoes-nos-motores.test.ts); aqui os upserts são só os de `matches`.
vi.mock("./network-registro", () => ({ registrarConexoesEntreMembrasDepoisDoCalculo: async () => undefined }));

const { calculateCompatibilityScore, generateMatchesForUser, matchesBloqueadosPelaDemandaExpressa } = await import("./matching");

const perfil = (extra: Partial<UserProfile>) => ({ whatIHave: null, whatINeed: null, ...extra }) as unknown as UserProfile;

beforeEach(() => { filas.length = 0; upserts.length = 0; deletes.length = 0; selects = 0; colunasPedidas.length = 0; });

describe("calculateCompatibilityScore — serviço sem demanda expressa dá zero", () => {
  it("advocacia tributária × quem procura distribuidores: bloqueado, nota zero", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], sector: "Jurídico" }),
      perfil({ whatINeed: ["distribuidores"], sector: "Farmacêutico" }),
    );
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
    expect(r.overall).toBe(0);
    expect(r.complementarity).toBe(0);
  });

  it("vale nos dois sentidos: quem só oferece serviço do lado B também não vira match presumido", () => {
    const r = calculateCompatibilityScore(
      perfil({}),
      perfil({ whatIHave: ["Consultoria em exportação"] }),
    );
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
    expect(r.overall).toBe(0);
  });

  it("setor igual, valores iguais e mesma cidade não salvam o serviço sem demanda", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], sector: "Saúde", values: ["innovation"], country: "BR", city: "São Paulo" }),
      perfil({ whatINeed: ["fornecedores"], sector: "Saúde", values: ["innovation"], country: "BR", city: "São Paulo" }),
    );
    expect(r.overall).toBe(0);
  });
});

describe("calculateCompatibilityScore — necessidade expressa libera o serviço", () => {
  it("a opção fixa 'Consultoria' declara precisar de assessoria: advocacia tributária atende", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"] }),
      perfil({ whatINeed: ["consultoria"] }),
    );
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(60); // uma via
    expect(r.overall).toBeGreaterThanOrEqual(40);
  });

  it("texto livre que nomeia o serviço também é demanda expressa", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"] }),
      perfil({ whatINeed: ["Procura advocacia tributária"] }),
    );
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(60);
  });

  it("necessidade genérica em texto livre também é demanda expressa: 'Consultoria' × 'Consultoria jurídica', 'Advogado' × 'Advocacia tributária'", () => {
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria jurídica"] }), perfil({ whatINeed: ["Consultoria"] })).complementarity).toBe(60);
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Advocacia tributária"] }), perfil({ whatINeed: ["Advogado"] })).complementarity).toBe(60);
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Advocacia tributária"] }), perfil({ whatINeed: ["Consultoria"] })).complementarity).toBe(60); // assessoria
  });

  it("'busco investimento' × capacidade menor que o valor buscado não é base expressa", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], lookingForInvestment: false, investmentCapacity: "under_10k" }),
      perfil({ lookingForInvestment: true, investmentAmountSeeking: "1m_plus" }),
    );
    expect(r.investment).not.toBe(90);
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
  });

  it("'Consultoria' não é atendida por qualquer serviço: marketing não é assessoria", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Marketing digital"] }),
      perfil({ whatINeed: ["consultoria"] }),
    );
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
  });
});

describe("calculateCompatibilityScore — a regra é específica de serviço", () => {
  it("oferta mista: a fazenda atende 'fornecedores' e o par passa (o serviço só não soma)", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária", "fazenda"] }),
      perfil({ whatINeed: ["fornecedores"] }),
    );
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(60);
  });

  it("a outra tem o que esta declarou precisar: base expressa no sentido contrário mantém o par", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], whatINeed: ["tecnologia"] }),
      perfil({ whatIHave: ["tecnologia"] }),
    );
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(60);
  });

  it("investimento buscado × capacidade declarada é base expressa (categoria investimento)", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], lookingForInvestment: false, investmentCapacity: "200k_plus" }),
      perfil({ lookingForInvestment: true, investmentAmountSeeking: "under_50k" }),
    );
    expect(r.bloqueio).toBeUndefined();
    expect(r.investment).toBe(90);
  });

  it("'busco investimento' sem capacidade DECLARADA do outro lado não é base expressa (capacidade em branco ou 'none')", () => {
    // A nota 90 sai mesmo com capacidade em branco (o `?? 2` do rank); a
    // base expressa exige declaração — senão um perfil só de serviço que
    // marcasse "busco investimento" casaria com qualquer perfil.
    const emBranco = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], lookingForInvestment: true }),
      perfil({ lookingForInvestment: false, investmentCapacity: null }),
    );
    expect(emBranco.investment).toBe(90);
    expect(emBranco.bloqueio).toBe("servico-sem-demanda-expressa");
    const none = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária"], lookingForInvestment: true }),
      perfil({ lookingForInvestment: false, investmentCapacity: "none" }),
    );
    expect(none.bloqueio).toBe("servico-sem-demanda-expressa");
  });

  it("oferta mista SEM encaixe: o ativo continua pontuando como na main (serviço ao lado de outro tipo reconhecido não bloqueia)", () => {
    // Mata o mutante que bloqueia só por haver serviço na lista: com "industria"
    // (ativo) ao lado, a oferta não é só de serviço, então nada bloqueia — e a
    // nota é a de sempre para um ativo sem encaixe (complementaridade 20,
    // overall 32 com o resto vazio).
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: ["Advocacia tributária", "industria"] }),
      perfil({ whatINeed: ["tecnologia"] }),
    );
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(20);
    expect(r.overall).toBe(32);
  });

  it("perfil sem nada em 'o que tenho' segue como sempre: não oferece serviço nenhum", () => {
    const r = calculateCompatibilityScore(perfil({}), perfil({}));
    expect(r.bloqueio).toBeUndefined();
    expect(r.overall).toBe(41);
  });

  it("ativo sem encaixe continua pontuando como antes (não é serviço)", () => {
    const r = calculateCompatibilityScore(perfil({ whatIHave: ["industria"] }), perfil({ whatINeed: ["tecnologia"] }));
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(20);
    expect(r.overall).toBe(32);
  });
});

const dona = { userId: 1, whatIHave: ["Advocacia tributária"], whatINeed: [], sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"] };
const candidata = (userId: number, extra: Record<string, unknown>) => ({ userId, sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"], whatIHave: [], whatINeed: [], ...extra });

describe("generateMatchesForUser — o par bloqueado não é gravado nem apagado", () => {
  it("candidata sem demanda expressa: nenhum upsert e NENHUM delete (a dispensa da dona sobrevive); candidata com 'consultoria': upsert", async () => {
    filas.push([dona], [], [candidata(2, { whatINeed: ["fornecedores"] }), candidata(3, { whatINeed: ["consultoria"] })]);

    const criados = await generateMatchesForUser(1);

    expect(criados).toBe(1);
    expect(upserts.map(u => u.values.matchedUserId)).toEqual([3]);
    // Apagar levaria junto userDismissed: quando o bloqueio cessasse, o
    // upsert reinseriria o par e o match dispensado voltaria à tela.
    expect(deletes).toHaveLength(0);
  });
});

describe("matchesBloqueadosPelaDemandaExpressa — a leitura enxerga o portão", () => {
  it("devolve só os ids cujo par está bloqueado hoje, em duas consultas (perfil próprio + inArray)", async () => {
    filas.push([dona], [
      { userId: 2, whatIHave: [], whatINeed: ["fornecedores"], investmentCapacity: null, lookingForInvestment: false, investmentAmountSeeking: null },
      { userId: 3, whatIHave: [], whatINeed: ["consultoria"], investmentCapacity: null, lookingForInvestment: false, investmentAmountSeeking: null },
    ]);
    const bloqueados = await matchesBloqueadosPelaDemandaExpressa(1, [2, 3]);
    expect([...bloqueados]).toEqual([2]);
    expect(selects).toBe(2);
  });

  it("sem ids não consulta o banco", async () => {
    expect(await matchesBloqueadosPelaDemandaExpressa(1, [])).toEqual(new Set());
    expect(selects).toBe(0);
  });
});

describe("satisfaz — serviço escrito de outro jeito e serviço diferente, a mesma regra do motor privado (defeitos a e c da #101, 13/09)", () => {
  const umaVia = (have: string, need: string) =>
    calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: [need] }));

  it("(a) a mesma coisa escrita de outro jeito libera o serviço: 'Advocacia tributária' × 'Advogado tributarista'", () => {
    const pares: Array<[string, string]> = [
      ["Advocacia tributária", "Advogado tributarista"],
      ["Contabilidade tributária", "Contador tributário"],
      ["Tax lawyer", "Advogado tributarista"],
      ["Advocacia tributária", "Direito tributário"],
      ["Consultoria tributária", "Assessoria tributária"],
    ];
    for (const [have, need] of pares) {
      const r = umaVia(have, need);
      expect(r.bloqueio, `${have} × ${need}`).toBeUndefined();
      expect(r.complementarity, `${have} × ${need}`).toBe(60);
    }
  });

  it("(c) serviço diferente continua bloqueado, mesmo com a palavra igual", () => {
    const pares: Array<[string, string]> = [
      ["Consultoria jurídica", "Consultoria em marketing"],
      ["Consultoria jurídica", "Assessoria"],
      ["Assessoria de imprensa", "Consultoria"],
      ["Interpretação de exames laboratoriais", "Tradutor"],
      ["Consultoria digital", "Consultoria em marketing digital"],
    ];
    for (const [have, need] of pares) {
      const r = umaVia(have, need);
      expect(r.bloqueio, `${have} × ${need}`).toBe("servico-sem-demanda-expressa");
      expect(r.complementarity, `${have} × ${need}`).toBe(0);
    }
  });

  it("a opção fixa 'consultoria' é decidida pela cabeça: marketing e tradução não atendem; advocacia e auditoria sim", () => {
    for (const have of ["Marketing para advogados", "Tradução jurídica", "Marketing digital"]) {
      expect(umaVia(have, "consultoria").bloqueio, have).toBe("servico-sem-demanda-expressa");
    }
    for (const have of ["Advocacia tributária", "Auditoria"]) {
      expect(umaVia(have, "consultoria").complementarity, have).toBe(60);
    }
  });
});

describe("calculateCompatibilityScore — serviço com adjetivo de outro tipo não escapa do portão (revisão de 13/09)", () => {
  it("'Consultoria financeira' só casa com quem declarou precisar dela", () => {
    const presumido = calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria financeira"] }), perfil({ whatINeed: ["distribuidores"] }));
    expect(presumido.bloqueio).toBe("servico-sem-demanda-expressa");
    const declarado = calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria financeira"] }), perfil({ whatINeed: ["Consultor financeiro"] }));
    expect(declarado.bloqueio).toBeUndefined();
    expect(declarado.complementarity).toBe(60);
  });
});

describe("calculateCompatibilityScore — revisão adversarial da correção (13/09)", () => {
  it("'Jurídico' e 'Legal services' voltam a atender a opção fixa 'consultoria'; 'Assessoria de viagens' não", () => {
    for (const have of ["Jurídico", "Legal services"]) {
      expect(calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: ["consultoria"] })).complementarity, have).toBe(60);
    }
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Assessoria de viagens"] }), perfil({ whatINeed: ["consultoria"] })).bloqueio).toBe("servico-sem-demanda-expressa");
  });

  it("serviço diferente escrito com 'para' ou com lema que colide continua bloqueado", () => {
    for (const [have, need] of [["Advocacia tributária", "Advogado para divórcio"], ["Consultoria em segurança do trabalho", "Consultoria trabalhista"]] as Array<[string, string]>) {
      expect(calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: [need] })).bloqueio, `${have} × ${need}`).toBe("servico-sem-demanda-expressa");
    }
  });
});

describe("calculateCompatibilityScore — necessidade que coordena serviços diferentes (revisão de 13/09)", () => {
  it("'Advogado e contador' libera quem oferece advocacia", () => {
    const r = calculateCompatibilityScore(perfil({ whatIHave: ["Advocacia tributária"] }), perfil({ whatINeed: ["Advogado e contador"] }));
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(60);
  });
});

describe("calculateCompatibilityScore — 'Direito tributário' sem categoria é serviço (14/09)", () => {
  it("perfil que só oferece 'Direito tributário' não vira match presumido, e atende 'Advogado tributarista'", () => {
    const presumido = calculateCompatibilityScore(
      perfil({ whatIHave: ["Direito tributário"], sector: "Jurídico" }),
      perfil({ whatINeed: ["distribuidores"], sector: "Farmacêutico" }),
    );
    expect(presumido.bloqueio).toBe("servico-sem-demanda-expressa");
    const declarado = calculateCompatibilityScore(perfil({ whatIHave: ["Direito tributário"] }), perfil({ whatINeed: ["Advogado tributarista"] }));
    expect(declarado.bloqueio).toBeUndefined();
    expect(declarado.complementarity).toBe(60);
  });
});


describe("calculateCompatibilityScore — revisão adversarial da correção empilhada (14/09)", () => {
  it("em chinês a oferta atende a necessidade genérica da família; serviço diferente segue bloqueado", () => {
    const zh = calculateCompatibilityScore(perfil({ whatIHave: ["律师"] }), perfil({ whatINeed: ["Advogado"] }));
    expect(zh.bloqueio).toBeUndefined();
    expect(zh.complementarity).toBe(60);
    const diferente = calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria trabalhista"] }), perfil({ whatINeed: ["Consultoria para segurança do trabalho"] }));
    expect(diferente.bloqueio).toBe("servico-sem-demanda-expressa");
  });
});

describe("calculateCompatibilityScore — o serviço que mora na especialidade (lacuna depois da #127, 14/09)", () => {
  // A tela de cadastro não tem opção de serviço em "O que tenho": a advogada põe
  // o serviço na especialidade e na área de atuação. Até aqui o bloqueio exigia
  // "o que tenho" preenchido, e o par passava pelas seis dimensões.
  it("especialidade de serviço com 'o que tenho' vazio × farmacêutica que procura distribuidores: bloqueado (era 57, gravado)", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: [], primarySpecialty: "Advocacia tributária", sector: "Jurídico" }),
      perfil({ whatINeed: ["distribuidores"], sector: "Farmacêutico" }),
    );
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
    expect(r.overall).toBe(0);
  });

  it("vale para a chave da especialidade do onboarding ('legal') e para a área de atuação, nos dois lados", () => {
    expect(calculateCompatibilityScore(perfil({ primarySpecialty: "legal" }), perfil({ whatINeed: ["compradores"] })).bloqueio)
      .toBe("servico-sem-demanda-expressa");
    expect(calculateCompatibilityScore(perfil({ whatINeed: ["fornecedores"] }), perfil({ activityArea: "Transporte rodoviário de cargas" })).bloqueio)
      .toBe("servico-sem-demanda-expressa");
  });

  it("a especialidade atende o que a outra DECLAROU: é base expressa e o par passa", () => {
    const consultoria = calculateCompatibilityScore(perfil({ primarySpecialty: "legal" }), perfil({ whatINeed: ["consultoria"] }));
    expect(consultoria.bloqueio).toBeUndefined();
    const contador = calculateCompatibilityScore(perfil({ whatINeed: ["Contador"] }), perfil({ activityArea: "Escritório de contabilidade" }));
    expect(contador.bloqueio).toBeUndefined();
  });

  it("especialidade que não é serviço, ou área mista, segue pelas seis dimensões como antes", () => {
    expect(calculateCompatibilityScore(perfil({ primarySpecialty: "tech" }), perfil({ whatINeed: ["distribuidores"] })).bloqueio).toBeUndefined();
    expect(calculateCompatibilityScore(perfil({ primarySpecialty: "legal", activityArea: "Indústria farmacêutica" }), perfil({ whatINeed: ["distribuidores"] })).bloqueio)
      .toBeUndefined();
  });

  it("'o que tenho' preenchido manda: a especialidade não é lida por cima dele", () => {
    // A fazenda atende "fornecedores"; a especialidade jurídica não entra na conta.
    const r = calculateCompatibilityScore(perfil({ whatIHave: ["fazenda"], primarySpecialty: "legal" }), perfil({ whatINeed: ["fornecedores"] }));
    expect(r.bloqueio).toBeUndefined();
    expect(r.complementarity).toBe(60);
  });

  it("a opção fixa 'Logística' passou a serviço (decisão de 14/09): casa com quem declarou distribuidores, não com quem procura compradores", () => {
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["logistica"] }), perfil({ whatINeed: ["distribuidores"] })).bloqueio).toBeUndefined();
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["logistica"] }), perfil({ whatINeed: ["compradores"] })).bloqueio)
      .toBe("servico-sem-demanda-expressa");
  });
});

describe("calculateCompatibilityScore — área de atuação que o classificador não lê não desliga o bloqueio (item 3 da lista do Nicolas na #135, 15/09)", () => {
  // "Direito" solto só é advocacia seguido de área curada (tipo-da-oferta.ts):
  // a área de atuação "Direito" cai em "outros". Com `every(ehServico)`, esse
  // item ilegível derrubava o bloqueio, e a advogada (especialidade legal, "o
  // que tenho" vazio) diante da indústria que só procura distribuidores dava
  // 41 — acima do corte 40 — e o par era gravado. A regra agora: bloqueia
  // quando ALGUMA oferta é serviço e NENHUMA é de outro tipo reconhecido;
  // "outros" não é tipo reconhecido.
  it("advogada com área 'Direito' e especialidade legal × indústria que só procura distribuidores: bloqueado, nota zero", () => {
    const r = calculateCompatibilityScore(
      perfil({ whatIHave: [], activityArea: "Direito", primarySpecialty: "legal", sector: "Jurídico" }),
      perfil({ whatINeed: ["distribuidores"], sector: "Indústria" }),
    );
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
    expect(r.overall).toBe(0);
  });

  it("vale também em 'o que tenho': o serviço ao lado de um item que o classificador não lê segue bloqueado", () => {
    const r = calculateCompatibilityScore(perfil({ whatIHave: ["Advocacia tributária", "Abacate"] }), perfil({ whatINeed: ["distribuidores"] }));
    expect(r.bloqueio).toBe("servico-sem-demanda-expressa");
    expect(r.overall).toBe(0);
  });

  it("um produto reconhecido ao lado do serviço NÃO é bloqueado por esta regra", () => {
    const r = calculateCompatibilityScore(perfil({ whatIHave: ["Advocacia tributária", "Produtos orgânicos"] }), perfil({ whatINeed: ["distribuidores"] }));
    expect(r.bloqueio).toBeUndefined();
    expect(r.overall).toBeGreaterThan(0);
  });

  it("no 'Reanalisar' o par da advogada com a indústria não é gravado", async () => {
    const advogada = { userId: 1, whatIHave: [], whatINeed: [], activityArea: "Direito", primarySpecialty: "legal", sector: "Jurídico", country: "BR", city: "Brasília", values: ["innovation"] };
    filas.push([advogada], [], [candidata(2, { whatINeed: ["distribuidores"], sector: "Indústria" })]);

    const criados = await generateMatchesForUser(1);

    expect(criados).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});

describe("matchesBloqueadosPelaDemandaExpressa — a especialidade chega à leitura (14/09)", () => {
  it("pede a área de atuação e a especialidade ao banco, e esconde o par sustentado só por elas", async () => {
    const donaSemTenho = { userId: 1, whatIHave: [], whatINeed: [], primarySpecialty: "Advocacia tributária", activityArea: null };
    filas.push([donaSemTenho], [
      { userId: 2, whatIHave: [], whatINeed: ["distribuidores"], activityArea: null, primarySpecialty: null, investmentCapacity: null, lookingForInvestment: false, investmentAmountSeeking: null },
      { userId: 3, whatIHave: [], whatINeed: ["consultoria"], activityArea: null, primarySpecialty: null, investmentCapacity: null, lookingForInvestment: false, investmentAmountSeeking: null },
    ]);
    const bloqueados = await matchesBloqueadosPelaDemandaExpressa(1, [2, 3]);
    expect([...bloqueados]).toEqual([2]);
    for (const colunas of colunasPedidas) {
      expect(colunas).toContain("activityArea");
      expect(colunas).toContain("primarySpecialty");
    }
  });
});

describe("calculateCompatibilityScore — revisão de 15/09 dos consertos da #127 (116bb56, portada)", () => {
  it("nos idiomas novos, o desconhecido não vira genérico diante de especialidade entendida, e o pedido que não é de serviço não solta o portão", () => {
    for (const [have, need] of [
      ["Consultoria tributária", "Консультация по логистике"], ["Consultoria tributária", "Консультация по маркетингу"], ["税务咨询", "招聘咨询"],
      ["Advocacia", "Juristische Person"], ["Contabilidade", "Software für Buchhaltung"], ["Consultoria", "Conseil d'administration"],
      ["Consultoria em segurança do trabalho / 安全咨询", "Consultoria trabalhista"],
    ] as Array<[string, string]>) {
      expect(calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: [need] })).bloqueio, `${have} × ${need}`).toBe("servico-sem-demanda-expressa");
    }
    // O que a classificação não chama de serviço (a loja, o abacate) não é barrado, e o mesmo serviço escrito de outro jeito atende.
    for (const [have, need] of [
      ["Expert-comptable", "Expertise comptable"], ["Boutique de joias de design", "Joias finas"], ["Avocats Hass export international", "Importateur de fruits"],
      ["Contabilidade para pequenas empresas", "Contador"], ["Empresa de gestão contábil", "Contador"],
    ] as Array<[string, string]>) {
      expect(calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: [need] })).bloqueio, `${have} × ${need}`).toBeUndefined();
    }
  });
});

describe("calculateCompatibilityScore — idiomas novos (e6ddfa4 e 116bb56 da #127, portadas)", () => {
  it("o mesmo serviço escrito de outro jeito atende; o que as listas não leem não bloqueia; o presumido segue bloqueado", () => {
    const ru = calculateCompatibilityScore(perfil({ whatIHave: ["Налоговый консалтинг"] }), perfil({ whatINeed: ["Налоговая консультация"] }));
    expect(ru.bloqueio).toBeUndefined();
    expect(ru.complementarity).toBe(60);
    // Como na main: sem bloqueio, e sem contar como necessidade atendida.
    const naoLe = calculateCompatibilityScore(perfil({ whatIHave: ["Steuerberatung für Erbschaften"] }), perfil({ whatINeed: ["Steuerberater für Erbschaftsteuer"] }));
    expect(naoLe.bloqueio).toBeUndefined();
    expect(naoLe.complementarity).toBe(20);
    for (const [have, need] of [["Steuerberatung", "Maschinen"], ["税务咨询", "买家"], ["Налоговый консалтинг", "Юрист"]] as Array<[string, string]>) {
      expect(calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: [need] })).bloqueio, `${have} × ${need}`).toBe("servico-sem-demanda-expressa");
    }
  });

  it("o mesmo serviço entre idiomas atende, e a exceção vale também para a especialidade que é a oferta", () => {
    const zh = calculateCompatibilityScore(perfil({ whatIHave: ["税务咨询"] }), perfil({ whatINeed: ["Consultoria tributária"] }));
    expect(zh.bloqueio).toBeUndefined();
    expect(zh.complementarity).toBe(60);
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Steuerberatung"] }), perfil({ whatINeed: ["Steuerberaterin gesucht"] })).bloqueio).toBeUndefined();
    // Nesta branch, com "o que tenho" vazio a especialidade é a oferta (lacuna depois da #127): o par que a regra não lê
    // num idioma novo também não é bloqueado por ela.
    const naEspecialidade = calculateCompatibilityScore(perfil({ primarySpecialty: "Steuerberatung für Erbschaften" }), perfil({ whatINeed: ["Steuerberater für Erbschaftsteuer"] }));
    expect(naEspecialidade.bloqueio).toBeUndefined();
    const presumido = calculateCompatibilityScore(perfil({ primarySpecialty: "Steuerberatung" }), perfil({ whatINeed: ["Maschinen"] }));
    expect(presumido.bloqueio).toBe("servico-sem-demanda-expressa");
  });
});

describe("calculateCompatibilityScore — revisão de 15/09 do porte da #127", () => {
  it("o par que a regra não lê num idioma novo não conta como necessidade atendida, nem pelo assunto curado", () => {
    for (const [have, need] of [
      ["Conseil en fiscalité", "Conseil en fiscalité des entreprises"], ["Conseil en fiscalité internationale", "Conseil en fiscalité des entreprises"],
      ["استشارات ضريبية دولية", "استشارات ضريبية للشركات"],
    ] as Array<[string, string]>) {
      const r = calculateCompatibilityScore(perfil({ whatIHave: [have] }), perfil({ whatINeed: [need] }));
      expect(r.bloqueio, `${have} × ${need}`).toBeUndefined();
      expect(r.complementarity, `${have} × ${need}`).toBe(20);
    }
    // O mesmo par em português segue bloqueado.
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria tributária"] }), perfil({ whatINeed: ["Consultoria tributária de empresas"] })).bloqueio)
      .toBe("servico-sem-demanda-expressa");
  });

  it("'les' em espanhol não joga a descrição nos idiomas novos: o serviço presumido segue bloqueado", () => {
    const descricao = "Necesitamos una consultoría de recursos humanos que les ayude a los gerentes a contratar";
    const detalhada = perfil({ whatINeed: ["especialistas_servicos"], whatINeedDetails: [{ id: "d1", category: "especialistas_servicos", service: "recursos_humanos", description: descricao }] } as unknown as Partial<UserProfile>);
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria em comércio exterior"] }), detalhada).bloqueio).toBe("servico-sem-demanda-expressa");
    expect(calculateCompatibilityScore(perfil({ primarySpecialty: "Consultoria em comércio exterior" }), detalhada).bloqueio).toBe("servico-sem-demanda-expressa");
    const outra = perfil({ seekingTypes: ["outra_necessidade"], seekingOtherNeed: descricao } as unknown as Partial<UserProfile>);
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria em comércio exterior"] }), outra).bloqueio).toBe("servico-sem-demanda-expressa");
  });

  it("R&D, I+D e o serviço em chinês com a cidade seguem serviço e não casam com a contraparte", () => {
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["R&D tax consulting"] }), perfil({ whatINeed: ["Distribuidor para expansão na África"] })).bloqueio).toBe("servico-sem-demanda-expressa");
    expect(calculateCompatibilityScore(perfil({ whatIHave: ["Consultoria tributária"] }), perfil({ whatINeed: ["Consultoría en I+D"] })).bloqueio).toBe("servico-sem-demanda-expressa");
    const distribuidores = perfil({ whatINeed: ["distribuidores"], whatINeedDetails: [{ id: "d1", category: "distribuidores", description: "寻找非洲市场的经销商" }] } as unknown as Partial<UserProfile>);
    expect(calculateCompatibilityScore(perfil({ primarySpecialty: "律师事务所（北京）" }), distribuidores).bloqueio).toBe("servico-sem-demanda-expressa");
  });
});
