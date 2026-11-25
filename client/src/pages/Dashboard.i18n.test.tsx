import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Dashboard from "./Dashboard";

/**
 * Dashboard em outro idioma (reverificação de 04/09, major 25): a tela é uma
 * das 13 traduzidas, mas dezenas de textos eram português fixo — inclusive o
 * plural feito à mão da saudação ("novo{s} match{es}") e do botão de convites.
 * Em inglês, a usuária via "Hello, Ana" seguido de "3 novos matches esperando
 * pela sua atenção", "1 convite para responder", barras "Objetivos/…", aba
 * "Salas de Negociação" e o banner Ouro em português.
 *
 * Renderiza em inglês e prova cada trecho pela tela. O dublê do tRPC é o
 * mesmo de erros-de-consulta.test.tsx: qualquer `trpc.a.b.useQuery` responde
 * o que o teste registrou em `respostas["a.b"]`, e o `select` das stats é
 * aplicado como no React Query.
 */

type Resposta = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };

const duble = vi.hoisted(() => {
  const respostas: Record<string, Resposta | ((input: unknown) => Resposta)> = {};
  const refetches: Record<string, ReturnType<typeof vi.fn>> = {};
  const refetchDe = (caminho: string) => (refetches[caminho] ??= vi.fn());

  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";

  const procedimento = (caminho: string) => ({
    useQuery: (input: unknown, opcoes?: { select?: (dados: never) => unknown }) => {
      const registrada = respostas[caminho];
      const parcial = (typeof registrada === "function" ? registrada(input) : registrada) ?? {};
      const resultado = { data: undefined as unknown, isLoading: false, isPending: false, isError: false, error: null as unknown, refetch: refetchDe(caminho), ...parcial };
      if (opcoes?.select && resultado.data !== undefined) resultado.data = opcoes.select(resultado.data as never);
      return resultado;
    },
    useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => undefined), isPending: false, isError: false, error: null, data: undefined }),
  });

  const utils = new Proxy({}, {
    get: (_, router) => ignorar(router) ? undefined : new Proxy({}, {
      get: (_, proc) => ignorar(proc) ? undefined : new Proxy({}, {
        get: (_, metodo) => ignorar(metodo) ? undefined : vi.fn(async () => undefined),
      }),
    }),
  });

  const trpc = new Proxy({}, {
    get: (_, router) => {
      if (ignorar(router)) return undefined;
      if (router === "useUtils") return () => utils;
      return new Proxy({}, { get: (_, proc) => ignorar(proc) ? undefined : procedimento(`${String(router)}.${String(proc)}`) });
    },
  });

  return { respostas, trpc };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("@/components/AppHeader", () => ({ AppHeader: () => null, GlobalMenu: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/SmartMatchConsent", () => ({ SmartMatchConsent: () => null }));

const EU = 1;

function usuaria(role: "silver" | "gold") {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: EU, name: "Ana", role },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

// O cartão de match é ANÔNIMO até o interesse mútuo: `matches.list` não traz
// mais nome, foto, bio nem o id da outra usuária. O `displayName` só vem
// preenchido quando `connectionStatus` é "accepted" — e é o servidor que decide,
// pelo portão em db.ts.
function match(matchId: number, userSeen: boolean, extra: Record<string, unknown> = {}) {
  return {
    matchId, overallScore: 85, userSeen,
    specialtyScore: 90, objectivesScore: 80, incomeScore: 70, locationScore: 60, valuesScore: 50,
    aiInsight: null, city: "Lisboa", country: "PT",
    primarySpecialty: "tech",
    seekingTypes: [], businessInterests: [], values: [], sector: null,
    connectionId: null, connectionStatus: null, souDestinataria: null, displayName: null,
    ...extra,
  };
}

const perfil = { profile: { displayName: "Ana", jobTitle: "CEO", city: "Lisboa", profileCompleteness: 80 } };

// A tela tem dois atrasos de tempo real: o banner Ouro entra 500 ms depois
// de montar e a troca de aba leva 180 ms (animação). Todo `findBy*` que espera
// por um deles usa esta janela — sob carga (CI, suíte inteira) o 1 s padrão
// do Testing Library já estourou. Nada mais na tela depende de tempo: as
// animações de entrada só mudam opacidade, nunca o texto.
const ESPERA = { timeout: 3000 };

// Palavras que a tela mostrava em português fixo antes desta PR — saudação,
// convites, aba, botão dos cartões, título das recomendações — e os textos de
// fallback ("Usuária"; "Membro" é o que um tradutor apressado escreveria).
// Com a tela em inglês nenhuma pode aparecer no texto do documento; o teste
// em português prova que o regex reconhece o texto de verdade (não é vazio).
const PORTUGUES = /oportunidades|Salas|Ver detalhes|novos|novas|conexõ|convite|Boas-vindas|Recomendadas|Usuário|Membro|Identidade|revelar/i;
function semPortugues(onde: string) {
  expect(document.body.textContent, onde).not.toMatch(PORTUGUES);
}

// "match" virou "conexão" em todas as telas (grupo Projetos IA, 14/09). Ficam de
// fora só os nomes próprios Smart Match, Business Match e a marca Marquesa Global Match. A saudação e o convite
// de boas-vindas são conferidos palavra por palavra, e a varredura garante que
// "match" não sobrou em canto nenhum da tela.
function semMatch(onde: string) {
  const texto = (document.body.textContent ?? "").replace(/Marquesa Global Match|Smart Match|Business Match(es)?/g, "");
  expect(texto, onde).not.toMatch(/match/i);
}

// Três matches não vistos, um convite pendente dirigido a mim, uma
// recomendação do tipo "other" e uma sala ativa "com Beatriz".
function cenarioPadrao() {
  duble.respostas["profile.get"] = { data: perfil };
  duble.respostas["matches.list"] = {
    data: [
      match(1, false, { aiInsight: "Vocês duas exportam vinho.", seekingTypes: ["investor"], businessInterests: ["alimentos", "Beleza & Cosméticos", "Financeiro & Fintechs"] }),
      match(2, false),
      match(3, false),
    ],
  };
  duble.respostas["connections.list"] = {
    // Pendente dirigido a mim: o servidor manda `souDestinataria` no lugar dos
    // ids reais, e `displayName` vem NULO enquanto não há aceite.
    data: [{ id: 7, status: "pending", souDestinataria: true, outraParteId: null, displayName: null, primarySpecialty: "finance", city: "Porto", message: null }],
  };
  duble.respostas["consent.status"] = { data: { accepted: true, document: null } };
  duble.respostas["matching.getRecommendedOpportunities"] = {
    data: [{ id: 9, title: "Cacau fino", sector: "agronegocio", type: "other", complianceLevel: "green", compatibilityScore: 77, compatibilityReason: "Mesmo setor." }],
  };
  duble.respostas["dealRoom.listRooms"] = {
    data: [{ id: 3, opportunityTitle: "Cacau fino", otherPartyName: "Beatriz", status: "active" }],
  };
  duble.respostas["notifications.list"] = { data: [] };
}

beforeEach(() => {
  for (const chave of Object.keys(duble.respostas)) delete duble.respostas[chave];
  usuaria("silver");
  cenarioPadrao();
});

afterEach(async () => {
  await i18n.changeLanguage("pt-BR");
});

describe("Dashboard em inglês — nada em português fixo", () => {
  it("saudação com plural por chave, botão de convites, aba de salas e recomendações", async () => {
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    // Saudação: a parte destacada é o plural certo, o complemento vem de outra chave.
    expect(screen.getByText("3 new suggested connections")).toBeInTheDocument();
    expect(screen.getByText(/waiting for your attention/)).toBeInTheDocument();
    expect(screen.queryByText(/novas conexões|novos matches/)).not.toBeInTheDocument();
    semMatch("saudação em inglês");
    expect(screen.queryByText(/esperando pela sua atenção/)).not.toBeInTheDocument();

    // Convite pendente dirigido a mim: singular.
    expect(screen.getByRole("button", { name: "1 invitation to answer" })).toBeInTheDocument();
    expect(screen.queryByText(/convite/)).not.toBeInTheDocument();

    // Aba das salas.
    expect(screen.getByRole("button", { name: "🔐 Deal Rooms" })).toBeInTheDocument();
    expect(screen.queryByText(/Salas de Negociação/)).not.toBeInTheDocument();

    // Recomendações: título, rótulo de tipo "other" (chave que faltava),
    // confiabilidade, "compatible", prefixo da IA e o botão.
    expect(screen.getByRole("heading", { name: "Opportunities Recommended for You" })).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("High Reliability")).toBeInTheDocument();
    expect(screen.getByText("compatible")).toBeInTheDocument();
    expect(screen.getAllByText("✦ AI:").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "View Opportunity →" })).toBeInTheDocument();
    expect(screen.queryByText(/Oportunidades Recomendadas/)).not.toBeInTheDocument();
    expect(screen.queryByText("Outro")).not.toBeInTheDocument();
  });

  it("cartão de match: interesses pelo termo cru, 'View details' e barras de score em inglês", async () => {
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    // "alimentos" e o rótulo antigo "Beleza & Cosméticos" viram a chave de
    // interesse e saem em inglês; "investor" é chave antiga de "O que você
    // busca?" e sai com o rótulo da opção nova equivalente (investimento_capital,
    // troca de 14/09, sem migrar dado); texto livre sem sinônimo passa intacto.
    expect(screen.getByText("Food & Beverage")).toBeInTheDocument();
    expect(screen.getByText("Beauty & Cosmetics")).toBeInTheDocument();
    expect(screen.getByText("Investment / Capital")).toBeInTheDocument();
    expect(screen.getByText("Financeiro & Fintechs")).toBeInTheDocument();
    expect(screen.queryByText("Alimentos & Bebidas")).not.toBeInTheDocument();

    const verDetalhes = screen.getAllByRole("button", { name: "View details" });
    expect(verDetalhes.length).toBe(3);
    expect(screen.queryByRole("button", { name: "Ver detalhes" })).not.toBeInTheDocument();
    fireEvent.click(verDetalhes[0]);

    for (const rotulo of ["Goals", "Specialty", "Values", "Location", "Income"]) {
      expect(screen.getByText(rotulo)).toBeInTheDocument();
    }
    for (const rotulo of ["Objetivos", "Especialidade", "Valores", "Localização", "Renda"]) {
      expect(screen.queryByText(rotulo)).not.toBeInTheDocument();
    }
  });

  it("aba de salas: aviso do sigilo, 'with Beatriz' e status 'Active' — Ouro vê 'All Rooms (Gold)' e '2 rooms on the platform'", async () => {
    usuaria("gold");
    duble.respostas["dealRoom.listAllRooms"] = {
      data: [
        { id: 3, opportunityTitle: "Cacau fino", otherPartyName: "Beatriz", status: "active" },
        { id: 4, opportunityTitle: "Azeite", otherPartyName: "Dora", status: "awaiting_nda" },
      ],
    };
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    fireEvent.click(screen.getByRole("button", { name: "🔐 Deal Rooms" }));
    // A troca de aba tem um pequeno atraso (animação).
    expect(await screen.findByText(/Private conversation rooms/, {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("with Beatriz")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText(/com Beatriz/)).not.toBeInTheDocument();
    expect(screen.queryByText("Ativa")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "⭐ All Rooms (Gold)" }));
    expect(await screen.findByText("2 rooms on the platform", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("Awaiting NDA signatures")).toBeInTheDocument();
    expect(screen.getByText(/non-disclosure agreement still needs your signature/)).toBeInTheDocument();
    expect(screen.queryByText(/sala\(s\) na plataforma/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Falta assinar/)).not.toBeInTheDocument();
  });

  it("banner do Status Ouro e saudação de boas-vindas sem matches", async () => {
    duble.respostas["matches.list"] = { data: [] };
    duble.respostas["connections.list"] = { data: [] };
    duble.respostas["notifications.list"] = { data: [{ id: 1, type: "gold_granted", isRead: false, body: null }] };
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    expect(screen.getByText("Welcome to Marquesa Global Match! Generate your first suggested connections below")).toBeInTheDocument();
    semMatch("boas-vindas em inglês");
    // O banner entra meio segundo depois (tempo real: por isso a ESPERA de 3 s).
    // Ouro é categoria premium (Governança, 14/09/2026): o banner fala de
    // status ativo, não de selo concedido por reconhecimento.
    expect(await screen.findByText("Welcome to Gold Status!", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("Your Gold Status, Marquesa Global Match's premium tier, is now active.")).toBeInTheDocument();
    expect(screen.queryByText(/Seal/)).not.toBeInTheDocument();
    expect(screen.getByTitle("Close")).toBeInTheDocument();
    expect(screen.queryByText(/Status Ouro/)).not.toBeInTheDocument();
  });
});

describe("Dashboard em português — o que a usuária lia continua igual", () => {
  it("saudação e convite no plural/singular de sempre, aba e barras", async () => {
    render(<Dashboard />);

    expect(screen.getByText("3 novas conexões sugeridas")).toBeInTheDocument();
    semMatch("saudação em português");
    expect(screen.getByText(/esperando pela sua atenção/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1 convite para responder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "🔐 Salas de Negociação" })).toBeInTheDocument();
    expect(screen.getByText("Alimentos & Bebidas")).toBeInTheDocument();
    // "investor" gravado antes de 14/09 sai com o rótulo da opção nova.
    expect(screen.getByText("Investimento / Capital")).toBeInTheDocument();
    // O regex da varredura em inglês reconhece o português de verdade: se
    // parasse de casar aqui, a varredura passaria à toa.
    expect(document.body.textContent).toMatch(PORTUGUES);

    fireEvent.click(screen.getAllByRole("button", { name: "Ver detalhes" })[0]);
    await waitFor(() => expect(screen.getByText("Objetivos")).toBeInTheDocument());
    expect(screen.getByText("Renda")).toBeInTheDocument();
  });

  it("uma única conexão sugerida não vista: singular", () => {
    duble.respostas["matches.list"] = { data: [match(1, false)] };
    render(<Dashboard />);
    expect(screen.getByText("1 nova conexão sugerida")).toBeInTheDocument();
  });

  it("boas-vindas sem conexões sugeridas: convite a gerar as primeiras conexões, sem 'match'", () => {
    duble.respostas["matches.list"] = { data: [] };
    duble.respostas["connections.list"] = { data: [] };
    render(<Dashboard />);
    expect(screen.getByText("Boas-vindas à Marquesa Global Match! Gere suas primeiras conexões sugeridas abaixo")).toBeInTheDocument();
    semMatch("boas-vindas em português");
  });

  it("todos vistos: total de oportunidades compatíveis, no plural certo", () => {
    duble.respostas["matches.list"] = { data: [match(1, true), match(2, true)] };
    render(<Dashboard />);
    expect(screen.getByText("2 oportunidades compatíveis encontradas para você")).toBeInTheDocument();
  });
});

describe("aba Perfil — estilo de trabalho, anos de experiência e setor no idioma da tela", () => {
  // Perfil como o onboarding grava: estilo de trabalho pela CHAVE ("remote"),
  // setor pelo RÓTULO do idioma em que foi preenchido (aqui, português) e os
  // anos como número. Antes, o rótulo do estilo apontava para o NÓ
  // onboarding.workStyle (remote/hybrid/…) e a tela mostrava "key
  // 'onboarding.workStyle (pt-BR)' returned an object instead of string." com o
  // valor cru "remote" embaixo — para toda usuária que concluiu o onboarding,
  // em todos os idiomas; os anos saíam "1 anos"/"1 years"/"1 лет" e o setor
  // ficava no idioma do onboarding.
  async function abrirPerfil(idioma: string, nomeDaAba: string, perfilExtra: Record<string, unknown> = {}) {
    duble.respostas["profile.get"] = {
      data: { profile: { ...perfil.profile, workStyle: "remote", experienceYears: 1, sector: "Tecnologia & Software", ...perfilExtra } },
    };
    await i18n.changeLanguage(idioma);
    render(<Dashboard />);
    // A troca de aba tem um pequeno atraso (animação): quem chama usa findBy* com ESPERA.
    fireEvent.click(screen.getByRole("button", { name: nomeDaAba }));
  }

  it("português: '100% Remoto', '1 ano' e 'Tecnologia & Software' — nunca 'returned an object' nem 'remote'", async () => {
    await abrirPerfil("pt-BR", "Meu Perfil");
    expect(await screen.findByText("100% Remoto", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("Estilo de trabalho")).toBeInTheDocument();
    expect(screen.getByText("1 ano")).toBeInTheDocument();
    expect(screen.getByText("Tecnologia & Software")).toBeInTheDocument();
    expect(screen.queryByText(/returned an object/)).not.toBeInTheDocument();
    expect(screen.queryByText("remote")).not.toBeInTheDocument();
    expect(screen.queryByText("1 anos")).not.toBeInTheDocument();
  });

  it("inglês: '100% Remote', '1 year' e o setor gravado em português sai 'Technology & SaaS'", async () => {
    await abrirPerfil("en", "My Profile");
    expect(await screen.findByText("100% Remote", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("Work style")).toBeInTheDocument();
    expect(screen.getByText("1 year")).toBeInTheDocument();
    expect(screen.getByText("Technology & SaaS")).toBeInTheDocument();
    expect(screen.queryByText("Tecnologia & Software")).not.toBeInTheDocument();
    expect(screen.queryByText("1 years")).not.toBeInTheDocument();
    expect(screen.queryByText(/returned an object/)).not.toBeInTheDocument();
  });

  it("russo: '1 год' e '100% удалённо'; setor gravado em inglês também volta para a chave e traduz", async () => {
    await abrirPerfil("ru", "Мой профиль", { sector: "Technology & SaaS" });
    expect(await screen.findByText("1 год", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("100% удалённо")).toBeInTheDocument();
    expect(screen.getByText("Технологии и SaaS")).toBeInTheDocument();
    expect(screen.queryByText("1 лет")).not.toBeInTheDocument();
    expect(screen.queryByText(/returned an object/)).not.toBeInTheDocument();
  });

  it("setor personalizado (texto livre) passa intacto; 3 anos sai no plural", async () => {
    await abrirPerfil("en", "My Profile", { sector: "Cerâmica artesanal", experienceYears: 3 });
    expect(await screen.findByText("Cerâmica artesanal", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("3 years")).toBeInTheDocument();
  });

  it("cartão de match: o setor da outra membra, gravado em português, sai em inglês", async () => {
    duble.respostas["matches.list"] = { data: [match(1, false, { sector: "Tecnologia & Software" })] };
    await i18n.changeLanguage("en");
    render(<Dashboard />);
    expect(screen.getByText(/Technology & SaaS/)).toBeInTheDocument();
    expect(screen.queryByText(/Tecnologia & Software/)).not.toBeInTheDocument();
  });
});

describe("estados vazios e rótulos de fallback no idioma da tela", () => {
  // Usuária Ouro sem recomendações, sem salas (nem as da plataforma), com um
  // único match de membra SEM nome e interesse "tech": os textos de vazio, o
  // o rótulo anônimo do cartão, o toggle Ouro das salas e — na tela, não só
  // na lib — o sinônimo resolvido ANTES de traduzir ("tech" é também chave de
  // especialidade do onboarding, "Technology & Software"; ver
  // lib/interesses.test.ts).
  function cenarioVazio() {
    usuaria("gold");
    duble.respostas["matches.list"] = { data: [match(1, false, { displayName: null, businessInterests: ["tech"] })] };
    duble.respostas["connections.list"] = { data: [] };
    duble.respostas["matching.getRecommendedOpportunities"] = { data: [] };
    duble.respostas["dealRoom.listRooms"] = { data: [] };
    duble.respostas["dealRoom.listAllRooms"] = { data: [] };
  }

  it("inglês: 'Network member', 'Technology', 'No recommendations yet', 'My Rooms', 'No deal rooms yet' e 'No deal rooms on the platform' — e nada em português", async () => {
    cenarioVazio();
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    // O cartão não mostra mais nome nem fallback de nome: até o interesse mútuo
    // o cabeçalho é o rótulo anônimo, igual para todas.
    expect(screen.getByRole("heading", { name: "Network member" })).toBeInTheDocument();
    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(screen.queryByText("Technology & Software")).not.toBeInTheDocument();
    expect(screen.getByText(/No recommendations yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explore opportunities" })).toBeInTheDocument();
    semPortugues("aba de matches, sem recomendações");

    fireEvent.click(screen.getByRole("button", { name: "🔐 Deal Rooms" }));
    expect(await screen.findByRole("button", { name: "My Rooms" }, ESPERA)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No deal rooms yet" })).toBeInTheDocument();
    expect(screen.getByText(/When you show interest in an opportunity/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View Opportunities" })).toBeInTheDocument();
    semPortugues("aba de salas, sem salas");

    fireEvent.click(screen.getByRole("button", { name: "⭐ All Rooms (Gold)" }));
    expect(await screen.findByRole("heading", { name: "No deal rooms on the platform" }, ESPERA)).toBeInTheDocument();
    expect(screen.getByText(/No deal rooms have been created on the platform yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View Opportunities" })).not.toBeInTheDocument();
    semPortugues("todas as salas (Ouro), sem salas");
  });

  it("português: 'Membro da rede', 'Tecnologia', 'Nenhuma recomendação por enquanto', 'Minhas Salas' e 'Nenhuma sala de negociação ainda'", async () => {
    cenarioVazio();
    render(<Dashboard />);

    expect(screen.getByRole("heading", { name: "Membro da rede" })).toBeInTheDocument();
    expect(screen.getByText("Tecnologia")).toBeInTheDocument();
    expect(screen.queryByText("Tecnologia & Software")).not.toBeInTheDocument();
    expect(screen.getByText(/Nenhuma recomendação por enquanto/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explorar oportunidades" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "🔐 Salas de Negociação" }));
    expect(await screen.findByRole("button", { name: "Minhas Salas" }, ESPERA)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nenhuma sala de negociação ainda" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver Oportunidades" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "⭐ Todas as Salas (Ouro)" }));
    expect(await screen.findByRole("heading", { name: "Nenhuma sala de negociação na plataforma" }, ESPERA)).toBeInTheDocument();
  });
});

describe("Dashboard em inglês — varredura do texto inteiro, aba por aba", () => {
  // Cenário cheio (3 matches, convite, recomendação, sala ativa, sala da
  // plataforma aguardando NDA) MAIS o banner Ouro: em nenhuma das quatro
  // abas, com o cartão expandido, o documento contém uma das palavras do
  // português fixo de antes. O dado do servidor pode vir em português
  // (o insight "Vocês duas exportam vinho."): o regex mira o texto da tela.
  it("nenhuma palavra do português fixo de antes, em nenhuma aba, com o banner Ouro no ar", async () => {
    usuaria("gold");
    duble.respostas["notifications.list"] = { data: [{ id: 1, type: "gold_granted", isRead: false, body: null }] };
    duble.respostas["dealRoom.listAllRooms"] = {
      data: [{ id: 4, opportunityTitle: "Azeite", otherPartyName: "Dora", status: "awaiting_nda" }],
    };
    await i18n.changeLanguage("en");
    render(<Dashboard />);

    expect(await screen.findByText("Welcome to Gold Status!", {}, ESPERA)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "View details" })[0]);
    expect(screen.getByText("Goals")).toBeInTheDocument();
    semPortugues("aba de matches, cartão expandido, banner Ouro");
    semMatch("aba de conexões sugeridas, cartão expandido, banner Ouro");

    // A aba conta as conexões EFETIVADAS (item 6.1): nenhuma aceita, nenhum número.
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    expect(await screen.findByRole("button", { name: "Accept and reveal" }, ESPERA)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    semPortugues("aba de conexões");

    fireEvent.click(screen.getByRole("button", { name: "🔐 Deal Rooms" }));
    expect(await screen.findByText(/Private conversation rooms/, {}, ESPERA)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "⭐ All Rooms (Gold)" }));
    expect(await screen.findByText("1 room on the platform", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByText("Awaiting NDA signatures")).toBeInTheDocument();
    semPortugues("aba de salas, todas as salas");

    fireEvent.click(screen.getByRole("button", { name: "My Profile" }));
    expect(await screen.findByText("Profile complete", {}, ESPERA)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "✏️ Edit full profile" })).toBeInTheDocument();
    semPortugues("aba de perfil");
  });
});

describe("o passo do distribuidor no idioma da tela", () => {
  it("inglês: 'Our consultant will contact you soon' no cartão e 'Under review' na aba Conexões, nada em português", async () => {
    await i18n.changeLanguage("en");
    duble.respostas["matches.list"] = { data: [match(1, false, { connectionId: 7, connectionStatus: "in_review", souDestinataria: false })] };
    duble.respostas["connections.list"] = {
      data: [{ id: 7, status: "in_review", souDestinataria: false, outraParteId: null, displayName: null, primarySpecialty: "finance", city: "Porto", message: null }],
    };
    render(<Dashboard />);
    // O cartão diz o que a pessoa precisa saber (o consultor fará contato); o
    // selo da aba Conexões continua sendo o estado do pedido ("Under review").
    expect(screen.getByRole("button", { name: "Our consultant will contact you soon" })).toBeDisabled();
    expect(screen.queryByText(/Em análise/)).not.toBeInTheDocument();
    semPortugues("cartão em análise");

    // A aba conta as conexões EFETIVADAS (item 6.1): nenhuma aceita, nenhum número.
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    // Cabeçalho do grupo e selo do cartão, desde o agrupamento por status.
    expect((await screen.findAllByText("🔎 Under review")).length).toBeGreaterThan(0);
    semPortugues("aba Conexões em análise");
  });

  it("português: o toast do interesse enviado agora avisa que um distribuidor confere antes de encaminhar", () => {
    expect(i18n.t("dashboard.interestSent")).toMatch(/distribuidor confere/);
    expect(i18n.t("dashboard.interestNotForwarded")).toBe("Interesse não encaminhado");
  });
});
