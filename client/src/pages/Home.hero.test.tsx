import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import Home from "./Home";

/**
 * Home — a primeira tela (Hero) conforme a spec da Glenda de 14/09, com as
 * decisões do Roberto e do grupo por cima dela:
 *
 * - selo: "Rede mundial de negócios entre membros • +30 países • infinitas
 *   possibilidades" (a spec dizia +33; o Rosber pediu 30 em 14/09);
 * - título: "Inteligência que conecta negócios que acontecem" (Rosber, 14/09),
 *   no lugar de "Grandes negócios começam com acesso às pessoas certas.";
 * - os demais textos da spec, palavra por palavra, com "mais de 30 países";
 * - UM só CTA "ENCONTRE SEU BUSINESS MATCH", na mesma rota do antigo
 *   "Criar meu perfil" (/register sem sessão, /dashboard com sessão);
 * - os quatro indicadores da plataforma NÃO aparecem mais na página pública,
 *   e a Home nem consulta stats.platform (os números moram no Dashboard).
 *
 * O globo 3D vira dublê (o jsdom não tem WebGL) e o tRPC também: o teste é da
 * tela, não do banco.
 */

const consultas = vi.hoisted(() => ({
  platform: vi.fn(() => ({ data: { users: 26, opportunities: 11, connections: 42, countries: 7, bronze: 4, silver: 25, gold: 1 } })),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/components/GloboDoMundo", () => ({ default: () => null }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    stats: {
      platform: { useQuery: consultas.platform },
      presencaPorPais: { useQuery: () => ({ data: undefined }) },
    },
    faq: { ask: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, data: undefined }) } },
  },
}));

class IntersectionObserverFalso {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

function comSessao(isAuthenticated: boolean) {
  vi.mocked(useAuth).mockReturnValue({
    user: isAuthenticated ? { id: 1, name: "Ana", role: "silver" } : null,
    loading: false, error: null, isAuthenticated, refresh: vi.fn(), logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
}

/** A Hero é a seção que contém o único h1 da página. */
function hero() {
  render(<Home />);
  const secao = screen.getByRole("heading", { level: 1 }).closest("section");
  if (!secao) throw new Error("o h1 saiu de dentro da seção da Hero");
  return secao;
}

beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", IntersectionObserverFalso);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  consultas.platform.mockClear();
  await i18n.changeLanguage("pt-BR");
  comSessao(false);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage("pt-BR");
});

describe("Home — Hero", () => {
  it("o selo traz a frase inteira com +30 países, e o ponto luminoso continua antes dela", () => {
    const secao = hero();
    const frase = "Rede mundial de negócios entre membros, +30 países, infinitas possibilidades";
    // Leitor de tela recebe a frase inteira com vírgula no lugar dos marcadores
    // (ad81480, portado: o " • " cru era lido em voz alta); na tela ela vem em
    // três trechos (a quebra do celular cai entre eles).
    const inteira = within(secao).getByText(frase);
    expect(inteira).toHaveClass("sr-only");
    const selo = inteira.parentElement as HTMLElement;
    const ponto = selo.firstElementChild as HTMLElement;
    expect(ponto.tagName).toBe("SPAN");
    expect(ponto).toHaveClass("animate-pulse");
    expect(within(selo).getByText("+30 países")).toBeInTheDocument();
    expect(within(selo).getByText("infinitas possibilidades")).toBeInTheDocument();
  });

  it("o título é o novo, e o título da spec não aparece mais", () => {
    const secao = hero();
    const titulo = within(secao).getByRole("heading", { level: 1 });
    expect(titulo).toHaveTextContent(/^Inteligência que conecta negócios que acontecem$/);
    expect(screen.queryByText(/Grandes negócios começam com acesso/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Encontre as oportunidades certas para você/)).not.toBeInTheDocument();
  });

  it("os demais textos da Hero são os da spec, palavra por palavra, com mais de 30 países", () => {
    const s = within(hero());
    for (const texto of [
      // Rosber, 16/09: sem o travessão, dois-pontos depois de "identificar" e "Quem"
      // maiúsculo; e "talvez nunca fossem encontradas" (as conexões), não "você sozinho".
      "Imagine uma rede capaz de identificar: Quem você precisa conhecer e quem precisa conhecer você.",
      "Nossa inteligência artificial cruza perfis, interesses, necessidades e oportunidades para revelar conexões estratégicas que talvez nunca fossem encontradas.",
      "Seu próximo grande negócio pode já estar aqui.",
      "Descubra quem, onde e qual oportunidade combina com você.",
      "Encontre o seu Business Match.",
    ]) {
      expect(s.getByText(texto), texto).toBeInTheDocument();
    }
    // Esta frase é montada em três pedaços (o país vem em negrito), por isso
    // se confere o parágrafo inteiro pelo texto corrido.
    const alcance = s.getByText("mais de 30 países").closest("p");
    expect(alcance).toHaveTextContent(/^Com embaixadores em mais de 30 países, conectamos você a pessoas, oportunidades e negócios em uma rede global sem fronteiras\.$/);
  });

  it("nenhum lugar da página fala em match, fora o nome próprio Business Match (troca por 'conexão', 14/09)", () => {
    render(<Home />);
    const texto = document.body.textContent ?? "";
    // Anti-vacuidade: a página renderizou e o nome próprio continua lá.
    expect(texto).toMatch(/Business Match/);
    expect(texto.replace(/Marquesa Global Match|Smart Match|Business Match(es)?/gi, "")).not.toMatch(/match/i);
  });

  it("nenhum lugar da página fala em 33 países", () => {
    render(<Home />);
    expect(document.body.textContent).not.toMatch(/33 países|\+33|33\+/);
    expect(document.body.textContent).toMatch(/mais de 30 países/);
  });

  it("há um só CTA principal, ENCONTRE SEU BUSINESS MATCH, na rota de sempre do cadastro", () => {
    const s = within(hero());
    const ctas = s.getAllByRole("button", { name: /ENCONTRE SEU BUSINESS MATCH/ });
    expect(ctas).toHaveLength(1);
    expect(ctas[0].closest("a")).toHaveAttribute("href", "/register");
    expect(screen.queryByText(/Criar meu perfil/)).not.toBeInTheDocument();
  });

  it("com sessão, o mesmo CTA leva ao Dashboard, como o botão antigo", () => {
    comSessao(true);
    const s = within(hero());
    const cta = s.getByRole("button", { name: /ENCONTRE SEU BUSINESS MATCH/ });
    expect(cta.closest("a")).toHaveAttribute("href", "/dashboard");
  });

  it("os indicadores da plataforma não aparecem na Home, e ela nem consulta stats.platform", () => {
    render(<Home />);
    for (const rotulo of ["Pessoas cadastradas", "Oportunidades ativas", "Conexões realizadas", "Países representados"]) {
      expect(screen.queryByText(rotulo), rotulo).not.toBeInTheDocument();
    }
    // O dublê devolveria 26, 11, 42 e 7: se a consulta voltasse a ser lida e
    // exibida, algum desses números apareceria.
    expect(consultas.platform).not.toHaveBeenCalled();
    for (const numero of ["26", "11", "42"]) {
      expect(screen.queryByText(numero), numero).not.toBeInTheDocument();
    }
  });

  it("o selo e o título mudam de idioma junto com a página (sem chave crua)", async () => {
    await i18n.changeLanguage("en");
    const s = within(hero());
    expect(s.getByRole("heading", { level: 1 })).toHaveTextContent("Intelligence that connects deals that happen");
    expect(s.getByText("Global business network among members, +30 countries, endless possibilities")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/hero\.\w/);
  });
});

/**
 * Pedidos do Rosber de 16/09 (áudio no grupo, com o print da Hero marcado), nos
 * 10 idiomas. O português segue o pedido ao pé da letra; nos outros, o mesmo
 * desenho (dois-pontos depois de "identificar", sem travessão, as conexões que
 * "talvez nunca fossem encontradas", sem "você sozinho") respeitando a gramática
 * de cada um: inglês, espanhol, francês, alemão e russo põem minúscula depois
 * dos dois-pontos, como manda a norma deles (o que segue não é oração completa);
 * o francês leva espaço inseparável antes dos dois-pontos; chinês e japonês usam
 * os dois-pontos de largura cheia, e o japonês anuncia a lista com 次のような人
 * ("pessoas como estas"; 次の人 se lê "a próxima pessoa").
 */
const TEXTOS_DE_16_09: Record<string, { subtitle: string; ai: string }> = {
  "pt-BR": {
    subtitle: "Imagine uma rede capaz de identificar: Quem você precisa conhecer e quem precisa conhecer você.",
    ai: "Nossa inteligência artificial cruza perfis, interesses, necessidades e oportunidades para revelar conexões estratégicas que talvez nunca fossem encontradas.",
  },
  en: {
    subtitle: "Imagine a network that can identify: who you need to meet and who needs to meet you.",
    ai: "Our artificial intelligence cross-references profiles, interests, needs and opportunities to reveal strategic connections that might never be found.",
  },
  es: {
    subtitle: "Imagina una red capaz de identificar: a quién necesitas conocer y quién necesita conocerte.",
    ai: "Nuestra inteligencia artificial cruza perfiles, intereses, necesidades y oportunidades para revelar conexiones estratégicas que quizá nunca se encontrarían.",
  },
  fr: {
    subtitle: "Imaginez un réseau capable d'identifier\u00a0: qui vous devez rencontrer et qui doit vous rencontrer.",
    ai: "Notre intelligence artificielle croise profils, intérêts, besoins et opportunités pour révéler des connexions stratégiques qui n'auraient peut-être jamais été trouvées.",
  },
  de: {
    subtitle: "Stellen Sie sich ein Netzwerk vor, das erkennen kann: wen Sie kennenlernen sollten und wer Sie kennenlernen sollte.",
    ai: "Unsere künstliche Intelligenz gleicht Profile, Interessen, Bedürfnisse und Chancen ab und macht strategische Verbindungen sichtbar, die vielleicht nie gefunden worden wären.",
  },
  ru: {
    subtitle: "Представьте сеть, которая способна определить: с кем вам нужно познакомиться и кому нужно познакомиться с вами.",
    ai: "Наш искусственный интеллект сопоставляет профили, интересы, потребности и возможности, чтобы открыть стратегические связи, которые, возможно, никогда не были бы найдены.",
  },
  hi: {
    subtitle: "कल्पना कीजिए एक ऐसे नेटवर्क की, जो पहचान सके: आपको किससे मिलना चाहिए और किसे आपसे मिलना चाहिए।",
    ai: "हमारी कृत्रिम बुद्धिमत्ता प्रोफ़ाइल, रुचियों, ज़रूरतों और अवसरों का मिलान करके ऐसे रणनीतिक संपर्क सामने लाती है, जो शायद कभी खोजे ही न जाते।",
  },
  ar: {
    subtitle: "تخيّل شبكة قادرة على تحديد: من تحتاج إلى معرفته ومن يحتاج إلى معرفتك.",
    ai: "يقاطع ذكاؤنا الاصطناعي الملفات الشخصية والاهتمامات والاحتياجات والفرص ليكشف عن علاقات استراتيجية ربما لم تكن لتُكتشف أبدًا.",
  },
  zh: {
    subtitle: "想象一个网络，能识别出：您需要认识的人，以及需要认识您的人。",
    ai: "我们的人工智能交叉比对档案、兴趣、需求与机遇，揭示可能永远不会被发现的战略性连接。",
  },
  ja: {
    subtitle: "次のような人を見つけ出すネットワークを想像してみてください：あなたが知り合うべき人と、あなたと知り合うべき人。",
    ai: "私たちのAIは、プロフィール、関心、ニーズ、機会を照らし合わせ、見つからないままだったかもしれない戦略的なつながりを明らかにします。",
  },
};

describe("Home — textos da Hero pedidos pelo Rosber em 16/09, nos 10 idiomas", () => {
  it("cobre exatamente os 10 idiomas do site", async () => {
    const { LANGUAGES } = await import("@/i18n");
    expect(Object.keys(TEXTOS_DE_16_09).sort()).toEqual(LANGUAGES.map(l => l.code).sort());
  });

  for (const [idioma, esperado] of Object.entries(TEXTOS_DE_16_09)) {
    it(`${idioma}: a Hero mostra a frase com dois-pontos e sem travessão, e a das conexões sem "você sozinho"`, async () => {
      await i18n.changeLanguage(idioma);
      const s = within(hero());
      // Comparação pelo textContent EXATO: o normalizador padrão do Testing
      // Library troca o espaço inseparável do francês por espaço comum.
      const exato = (texto: string) => s.getByText((_, elemento) => elemento?.tagName === "P" && elemento.textContent === texto);
      const subtitulo = exato(esperado.subtitle);
      expect(subtitulo).toBeInTheDocument();
      expect(exato(esperado.ai)).toBeInTheDocument();
      // No texto DESENHADO, e não no do próprio teste.
      expect(subtitulo.textContent).not.toMatch(/—/);
      expect(subtitulo.textContent).toMatch(/[:：]/);
    });
  }
});

describe("Home — as frases de destaque são legíveis no celular (Rosber, 16/09)", () => {
  // O degradê recortado no texto é pintado como FUNDO, e o modo escuro dos
  // navegadores de celular escurece fundo: a frase virou marrom sobre preto.
  // Cor de texto sólida não passa por esse escurecimento.
  const FRASES = [
    "Seu próximo grande negócio pode já estar aqui.",
    "Em algum lugar da nossa rede, alguém pode estar procurando exatamente o que você tem.",
    "Você diz onde quer chegar. Nossa inteligência encontra quem pode ajudar você a chegar lá.",
  ];

  it("as três usam a cor de texto sólida #efcba8 com halo escuro, e não o degradê recortado no texto", () => {
    render(<Home />);
    for (const frase of FRASES) {
      const elemento = screen.getByText(frase);
      expect(elemento, frase).toHaveClass("text-[#efcba8]");
      // Halo escuro: recorta os arcos e pontos claros do globo em volta das letras.
      expect(elemento, frase).toHaveClass("[text-shadow:0_0_3px_rgba(6,11,20,.95),0_0_12px_rgba(6,11,20,.85)]");
      expect(elemento, frase).not.toHaveClass("bg-clip-text");
      expect(elemento, frase).not.toHaveClass("text-transparent");
      expect(elemento.className, frase).not.toMatch(/bg-gradient/);
    }
  });
});
