import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O portão da demanda expressa na camada de IA (routers/matching.ts) —
 * pedido do Nicolas, 12/09/2026.
 *
 * O modelo passa a dizer em que TIPO de item de "o que tenho" o match se
 * apoia e, quando é serviço, a citar o trecho do outro lado que declara a
 * necessidade. O código confere a citação no texto que o modelo recebeu:
 * serviço sem citação conferida não sai da tela nem vira alerta, seja qual
 * for a nota. Os outros tipos passam como antes.
 */
const { citacaoAmarradaAoPerfil, citacaoConfere, cortarEmPalavra, exigeCitacao, normalizarTipo, passaNoPortao, perfilDeclarouPrecisarDoServico, reconhecerTipo, REGRA_DA_DEMANDA_EXPRESSA, textoEscritoPelaPessoa, TIPOS_PARA_A_IA } = await import("./portao-da-demanda-expressa");

describe("normalizarTipo — a grafia do modelo vira o enum", () => {
  it("aceita variações e sinônimos", () => {
    for (const valor of ["servico", "Serviço", "SERVICO", "service", "Serviços"]) expect(normalizarTipo(valor)).toBe("servico");
    expect(normalizarTipo("investimento/capital")).toBe("investimento");
    expect(normalizarTipo("Conexão/Network")).toBe("conexao");
    expect(normalizarTipo("nenhuma")).toBe("nenhuma");
    expect(normalizarTipo("none")).toBe("nenhuma");
  });

  it("num valor misto o serviço vence: 'produto/servico' não desliga o portão", () => {
    expect(normalizarTipo("produto/servico")).toBe("servico");
    expect(reconhecerTipo("produto ou serviço")).toBe("servico");
    expect(reconhecerTipo("banana")).toBeNull();
  });

  it("o que não reconhece vira 'outros' (o modelo não disse que era serviço)", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizarTipo("banana")).toBe("outros");
    expect(normalizarTipo(undefined)).toBe("outros");
    expect(normalizarTipo(42)).toBe("outros");
    aviso.mockRestore();
  });

  it("o enum do schema tem os nove tipos mais 'nenhuma'", () => {
    expect(TIPOS_PARA_A_IA).toHaveLength(10);
    expect(TIPOS_PARA_A_IA).toContain("nenhuma");
  });
});

describe("citacaoConfere — a citação precisa estar no texto-fonte", () => {
  const fonte = `[0] ID:7 Título:"Assessoria tributária" Setor:Indústria Tipo:demand Tags:["tributos"] Descrição:"Precisamos revisar nossos tributos e identificar créditos fiscais para 2026"`;

  it("trecho literal, com ou sem acento e caixa, confere", () => {
    expect(citacaoConfere("Precisamos revisar nossos tributos e identificar créditos fiscais", fonte)).toBe(true);
    expect(citacaoConfere("precisamos revisar nossos TRIBUTOS e identificar creditos fiscais", fonte)).toBe(true);
    expect(citacaoConfere("revisar nossos tributos", fonte)).toBe(true);
  });

  it("paráfrase e necessidade inventada não conferem", () => {
    expect(citacaoConfere("a empresa tem questões tributárias típicas de indústria", fonte)).toBe(false);
    expect(citacaoConfere("precisa de advocacia tributária", fonte)).toBe(false);
  });

  it("vazio, só palavras de ligação, uma palavra só ou não-texto: não confere", () => {
    expect(citacaoConfere("", fonte)).toBe(false);
    expect(citacaoConfere("de para com", fonte)).toBe(false);
    expect(citacaoConfere("tributos", fonte)).toBe(false); // uma tag solta é palavra-chave, não declaração
    expect(citacaoConfere(undefined, fonte)).toBe(false);
    expect(citacaoConfere(null, fonte)).toBe(false);
  });

  it("a palavra ausente nunca pode ser de serviço: 'frase real + serviço emendado' não passa", () => {
    expect(citacaoConfere("precisamos revisar nossos tributos advocacia", fonte)).toBe(false);
    expect(citacaoConfere("precisamos revisar nossos tributos consultoria", fonte)).toBe(false);
    expect(citacaoConfere("precisamos revisar nossos tributos hoje", fonte)).toBe(true); // ausente comum, tolerada
  });

  it("tolera UMA palavra ausente a partir de quatro; até três, nenhuma — tolerância fixa, não proporção", () => {
    expect(citacaoConfere("revisar nossos tributos identificar bônus", fonte)).toBe(true); // 4 de 5
    expect(citacaoConfere("precisamos revisar nossos impostos", fonte)).toBe(true); // 3 de 4 (fecha a janela do limiar por baixo)
    expect(citacaoConfere("revisar nossos impostos", fonte)).toBe(false); // 2 de 3
    expect(citacaoConfere("revisar tributos bônus taxas", fonte)).toBe(false); // 2 de 4 (fecha por cima)
    // "frase real + serviço presumido emendado no fim": com 70% proporcional
    // passava (5 de 7); com tolerância fixa, duas inventadas derrubam.
    expect(citacaoConfere("precisamos revisar nossos tributos identificar créditos fiscais advocacia empresarial", fonte)).toBe(false);
  });

  // Item 2 da lista do Nicolas na #135 (15/09): a conferência era por CONJUNTO de palavras, e "revisar tributos"
  // montada de duas frases conferia — é o exemplo 2 da spec da Glenda (serviço tributário × indústria que quer
  // revisar a distribuição). Agora as palavras precisam aparecer NA ORDEM, na MESMA frase, com até duas de
  // conteúdo entre cada par.
  describe("as palavras citadas precisam estar na ordem e na mesma frase", () => {
    const duasFrases = "Indústria com alta carga de tributos. Queremos revisar nossa estratégia de distribuição";

    it("citação montada de duas frases não confere, em nenhuma ordem", () => {
      expect(citacaoConfere("revisar tributos", duasFrases)).toBe(false); // invertida
      expect(citacaoConfere("tributos revisar", duasFrases)).toBe(false); // na ordem, mas de duas frases
      expect(citacaoConfere("tributos queremos revisar", duasFrases)).toBe(false);
    });

    it("a mesma frase, na ordem, confere — com até duas palavras de conteúdo intercaladas", () => {
      expect(citacaoConfere("Queremos revisar nossa estratégia", duasFrases)).toBe(true);
      expect(citacaoConfere("Queremos revisar estratégia", duasFrases)).toBe(true); // "nossa" no meio
      expect(citacaoConfere("Queremos estratégia de distribuição", duasFrases)).toBe(true); // "revisar nossa" no meio
      expect(citacaoConfere("Queremos distribuição", duasFrases)).toBe(false); // três no meio
      expect(citacaoConfere("estratégia revisar", duasFrases)).toBe(false); // mesma frase, ordem trocada
    });

    it("ponto, exclamação, interrogação, ponto e vírgula e quebra de linha separam frases; a barra entre título e descrição não", () => {
      for (const separador of [". ", "! ", "? ", "; ", "\n"]) {
        const fonteSeparada = `Precisamos revisar nossos tributos${separador}queremos identificar créditos fiscais`;
        expect(citacaoConfere("revisar nossos tributos identificar créditos", fonteSeparada), JSON.stringify(separador)).toBe(false);
        expect(citacaoConfere("identificar créditos fiscais", fonteSeparada), JSON.stringify(separador)).toBe(true);
      }
      expect(citacaoConfere("Advogado tributarista para planejamento de holding", "Advogado tributarista | para planejamento de holding")).toBe(true);
    });

    it("a tolerância à palavra ausente continua, mas palavra PRESENTE fora da janela é montagem", () => {
      expect(citacaoConfere("Queremos revisar nossa estratégia urgente", duasFrases)).toBe(true); // "urgente" não está na fonte: tolerada
      expect(citacaoConfere("Queremos revisar nossa estratégia tributos", duasFrases)).toBe(false); // "tributos" está, mas na outra frase
    });
  });
});

describe("textoEscritoPelaPessoa e cortarEmPalavra — a fonte da citação", () => {
  it("é título, tags e descrição; setor, tipo e id ficam de fora", () => {
    const texto = textoEscritoPelaPessoa("Revisão fiscal", ["tributos", 7], "Precisamos revisar nossos tributos");
    expect(texto).toBe("Revisão fiscal | tributos | Precisamos revisar nossos tributos");
    expect(textoEscritoPelaPessoa(null, null, undefined)).toBe(" | ");
  });

  it("corta em fronteira de palavra, com reticência, e não mexe no que cabe", () => {
    expect(cortarEmPalavra("curto", 800)).toBe("curto");
    const cortado = cortarEmPalavra("precisamos revisar nossos tributos e identificar créditos", 30);
    expect(cortado.endsWith("…")).toBe(true);
    expect(cortado.length).toBeLessThanOrEqual(31);
    expect(cortado.slice(0, -1)).toBe("precisamos revisar nossos");
  });
});

describe("passaNoPortao — só serviço precisa de citação", () => {
  const fonte = "Distribuidor para a África | Indústria farmacêutica busca distribuidor para expansão na África";

  it("serviço sem citação conferida não passa, com qualquer nota", () => {
    expect(passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: "" }, fonte)).toBe(false);
    expect(passaNoPortao({ tipoDaOferta: "Serviço", necessidadeExpressa: "toda indústria tem impostos" }, fonte)).toBe(false);
  });

  it("serviço com a necessidade citada da própria oportunidade passa", () => {
    expect(passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: "busca distribuidor para expansão na África" }, fonte)).toBe(true);
  });

  it("setor e tipo não são necessidade: a 'citação' do setor não confere na fonte escrita pela pessoa", () => {
    const fonteEscrita = textoEscritoPelaPessoa("Distribuidor para a África", [], "Indústria farmacêutica busca distribuidor para expansão na África");
    expect(passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: "Setor: Farmacêutico Tipo: demand" }, fonteEscrita)).toBe(false);
  });

  it("produto, ativo, investimento, conexão e 'nenhuma' passam sem citação", () => {
    for (const tipo of ["produto", "ativo", "investimento", "conexao", "tecnologia", "imovel", "outros", "nenhuma"]) {
      expect(passaNoPortao({ tipoDaOferta: tipo, necessidadeExpressa: "" }, fonte), tipo).toBe(true);
    }
  });

  it("o piso determinístico: perfil só de serviço e sem nada em 'preciso'/'busca' exige citação seja qual for o tipo que o modelo escreveu", () => {
    const soServico = { whatIHave: ["Advocacia tributária"], whatINeed: [], seekingTypes: [], lookingForInvestment: false };
    for (const tipo of ["produto", "nenhuma", "outros", "banana", undefined]) {
      expect(exigeCitacao({ tipoDaOferta: tipo, necessidadeExpressa: "" }, soServico), String(tipo)).toBe(true);
      expect(passaNoPortao({ tipoDaOferta: tipo, necessidadeExpressa: "" }, fonte, soServico), String(tipo)).toBe(false);
    }
    // Com citação, o piso abre — desde que a citação peça o serviço. Até 14/09 esta linha usava "busca distribuidor
    // para expansão na África" e passava: é o exemplo 2 da spec da Glenda (serviço tributário × quem procura
    // distribuidor), e a citação de CONTRAPARTE passou a barrar.
    expect(passaNoPortao({ tipoDaOferta: "produto", necessidadeExpressa: "busca distribuidor para expansão na África" }, fonte, soServico)).toBe(false);
    const fonteTributaria = "Revisão fiscal | Precisamos revisar nossos tributos e identificar créditos fiscais";
    expect(passaNoPortao({ tipoDaOferta: "produto", necessidadeExpressa: "revisar nossos tributos e identificar créditos fiscais" }, fonteTributaria, soServico)).toBe(true);
  });

  it("o piso não fecha quando há outra base declarada: necessidade, busca ou 'busco investimento'", () => {
    const item = { tipoDaOferta: "nenhuma", necessidadeExpressa: "" };
    expect(passaNoPortao(item, fonte, { whatIHave: ["Advocacia tributária"], whatINeed: ["distribuidores"] })).toBe(true);
    expect(passaNoPortao(item, fonte, { whatIHave: ["Advocacia tributária"], seekingTypes: ["investor"] })).toBe(true);
    expect(passaNoPortao(item, fonte, { whatIHave: ["Advocacia tributária"], lookingForInvestment: true })).toBe(true);
    expect(passaNoPortao(item, fonte, { whatIHave: ["Advocacia tributária", "fazenda"] })).toBe(true);
    expect(passaNoPortao(item, fonte, { whatIHave: [] })).toBe(true);
  });

  it("tipo irreconhecível com serviço no perfil fecha; sem serviço no perfil, passa", () => {
    expect(exigeCitacao({ tipoDaOferta: "banana" }, { whatIHave: ["Advocacia tributária", "fazenda"], whatINeed: ["tecnologia"] })).toBe(true);
    expect(exigeCitacao({ tipoDaOferta: "banana" }, { whatIHave: ["fazenda"] })).toBe(false);
  });

  it("com 'O que tenho' vazio, o piso lê a área de atuação e a especialidade (que o prompt também recebe)", () => {
    expect(exigeCitacao({ tipoDaOferta: "nenhuma" }, { whatIHave: [], activityArea: "Advocacia tributária", whatINeed: [] })).toBe(true);
    // Qualquer oferta que não seja serviço solta a exigência, inclusive a que o classificador não sabe ler
    // ("vendas", "Agronegócio" — "outros"). Apertar o piso para fechar o caso do item 3 foi MEDIDO e derrubou 24
    // combinações reais de área × especialidade: quem tem "Agronegócio" na área e "Marketing & Vendas" na
    // especialidade parava de passar em oportunidade de imóvel, capital, conexão e tecnologia — tipos em que a
    // regra 6 do prompt PROÍBE citação, então o portão não fica rigoroso, fica impassável. O item 3 fecha pela
    // ÁREA (teste seguinte), não pelo piso.
    expect(exigeCitacao({ tipoDaOferta: "nenhuma" }, { whatIHave: [], activityArea: "Advocacia tributária", primarySpecialty: "vendas" })).toBe(false);
    expect(exigeCitacao({ tipoDaOferta: "imoveis" }, { whatIHave: [], activityArea: "Agronegócio", primarySpecialty: "Marketing & Vendas" })).toBe(false);
    // Tipo reconhecido de verdade na área continua soltando a exigência: ela tem outra coisa a oferecer.
    expect(exigeCitacao({ tipoDaOferta: "nenhuma" }, { whatIHave: [], activityArea: "Indústria farmacêutica", primarySpecialty: "legal" })).toBe(false);
    expect(exigeCitacao({ tipoDaOferta: "nenhuma" }, { whatIHave: ["fazenda"], activityArea: "Advocacia tributária" })).toBe(false);
  });

  it("'Direito' e 'Jurídico' na área contam como serviço: consequência aceita pelo Roberto em 16/09 (item 3, D3)", () => {
    // Na main "Direito" era lido como "outros" e soltava a exigência de quem só presta serviço. Agora a área que
    // nomeia um serviço conta como serviço: sem necessidade declarada e sem outra base, o piso exige a citação —
    // e a IA, que não pode citar fora de serviço, para de sugerir imóvel, capital, conexão e tecnologia.
    for (const activityArea of ["Direito", "Jurídico"]) {
      for (const tipoDaOferta of ["imoveis", "investimento", "conexao", "tecnologia", "nenhuma"]) {
        expect(exigeCitacao({ tipoDaOferta }, { whatIHave: [], activityArea, primarySpecialty: "legal" }), `${activityArea} / ${tipoDaOferta}`).toBe(true);
      }
      // Uma necessidade declarada reabre.
      expect(exigeCitacao({ tipoDaOferta: "imoveis" }, {
        whatIHave: [], activityArea, primarySpecialty: "legal",
        whatINeed: ["outra_necessidade"], seekingTypes: ["outra_necessidade"], seekingOtherNeed: "Preciso de um contador",
      }), activityArea).toBe(false);
    }
    // "Agronegócio" não nomeia serviço: continua sendo outra base.
    expect(exigeCitacao({ tipoDaOferta: "imoveis" }, { whatIHave: [], activityArea: "Agronegócio", primarySpecialty: "legal" })).toBe(false);
  });

  it("quem DECLAROU um ativo ao lado do serviço tem outra base: o piso não exige citação", () => {
    // "Linha de produção" é ativo declarado em O que tenho; o piso existe para
    // quem não tem outra base possível. Exigir a citação aqui suprimiria o
    // match — e seria uma citação que a regra 6 do prompt PROÍBE fora do tipo
    // "servico", que é quando o modelo diz que o match se apoia em serviço.
    const comAtivoDeclarado = { whatIHave: ["logistica", "Linha de produção"] };
    for (const tipoDaOferta of ["ativo", "produto", "conexao", "nenhuma"]) {
      expect(exigeCitacao({ tipoDaOferta }, comAtivoDeclarado), tipoDaOferta).toBe(false);
    }
    // O match que o próprio modelo diz apoiado em serviço continua exigindo.
    expect(exigeCitacao({ tipoDaOferta: "servico" }, comAtivoDeclarado)).toBe(true);
    // E quem só tem serviço continua com o piso de pé.
    expect(exigeCitacao({ tipoDaOferta: "ativo" }, { whatIHave: ["logistica"] })).toBe(true);
  });

  it("nos dois sentidos: oportunidade que OFERECE um serviço só passa para quem declarou precisar de algo", () => {
    const oferta = { type: "offer", title: "Assessoria tributária para indústrias" };
    const item = { tipoDaOferta: "nenhuma", necessidadeExpressa: "" };
    expect(passaNoPortao(item, fonte, { whatIHave: ["fazenda"], whatINeed: [] }, oferta)).toBe(false);
    expect(passaNoPortao(item, fonte, { whatIHave: ["fazenda"], whatINeed: ["consultoria"] }, oferta)).toBe(true);
    expect(passaNoPortao(item, fonte, { whatIHave: ["fazenda"], whatINeed: [] }, { type: "demand", title: "Assessoria tributária para indústrias" })).toBe(true);
    expect(passaNoPortao(item, fonte, { whatIHave: ["fazenda"], whatINeed: [] }, { type: "offer", title: "Café especial da Bahia" })).toBe(true);
  });

  it("a regra escrita para o modelo diz o essencial", () => {
    expect(REGRA_DA_DEMANDA_EXPRESSA).toContain("servico, produto, ativo, oportunidade, investimento, conexao, tecnologia, imovel, outros");
    expect(REGRA_DA_DEMANDA_EXPRESSA).toContain("NÃO conta como necessidade");
    expect(REGRA_DA_DEMANDA_EXPRESSA).toContain("necessidadeExpressa");
    expect(REGRA_DA_DEMANDA_EXPRESSA).toContain("alguém declarou que precisa");
  });
});

// ─── O router de verdade, com IA e banco simulados ───────────────────────────

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));
const createNotification = vi.fn(async () => {});
const filas: unknown[][] = [];
function cadeiaDeSelect() {
  const cadeia: Record<string, unknown> = {};
  for (const metodo of ["from", "where", "innerJoin", "limit", "orderBy"]) cadeia[metodo] = () => cadeia;
  (cadeia as { then?: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(filas.shift() ?? []).then(resolve, reject);
  return cadeia;
}
const fakeDb = { select: () => cadeiaDeSelect() };
vi.mock("./db", () => ({
  getDb: async () => fakeDb as never,
  exigirDb: async () => fakeDb as never,
  createNotification: (...args: unknown[]) => createNotification(...(args as [])),
}));
vi.mock("./routers/consent", () => ({
  hasValidConsent: async () => true,
  usersComConsentimento: async (ids: number[]) => new Set(ids),
}));

const { matchingRouter, notifyHighCompatibilityForOpportunity } = await import("./routers/matching");
const ctx = { user: { id: 1, openId: "dona-1", email: "t@local", role: "silver" }, req: { headers: {}, socket: {} }, res: { cookie: () => {} } } as never;

// Declara uma busca ("investor") de propósito: sem base fora do serviço, o
// piso do portão exigiria citação até para o café — e o teste do piso cobre isso.
const perfilTributarista = { userId: 1, whatIHave: ["Advocacia tributária"], whatINeed: [], seekingTypes: ["investor"], sector: "Jurídico" };
const oportunidades = [
  { id: 10, title: "Revisão fiscal", sector: "Indústria", type: "demand", tags: [], description: "Precisamos revisar nossos tributos e identificar créditos fiscais", status: "active", publishedBy: 9, isConfidential: false },
  { id: 11, title: "Distribuidor para a África", sector: "Farmacêutico", type: "demand", tags: [], description: "Indústria farmacêutica busca distribuidor para expansão na África", status: "active", publishedBy: 9, isConfidential: false },
  { id: 12, title: "Compra de café especial", sector: "Agronegócio", type: "demand", tags: ["café"], description: "Torrefação compra café especial", status: "active", publishedBy: 9, isConfidential: false },
];
const respostaDaIA = (corpo: unknown) => ({ choices: [{ message: { content: JSON.stringify(corpo) } }] });

beforeEach(() => { invokeLLM.mockReset(); createNotification.mockClear(); filas.length = 0; });

describe("matching.getRecommendedOpportunities — o portão na recomendação", () => {
  it("serviço com citação conferida entra; serviço com necessidade presumida sai; produto passa sem citação", async () => {
    filas.push([perfilTributarista], oportunidades);
    invokeLLM.mockResolvedValue(respostaDaIA({ matches: [
      { index: 0, score: 90, reason: "Necessidade declarada", tipoDaOferta: "servico", necessidadeExpressa: "revisar nossos tributos e identificar créditos fiscais" },
      { index: 1, score: 85, reason: "Toda indústria tem impostos", tipoDaOferta: "servico", necessidadeExpressa: "a farmacêutica precisa de assessoria tributária" },
      { index: 2, score: 70, reason: "Café", tipoDaOferta: "produto", necessidadeExpressa: "" },
    ] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const lista = await matchingRouter.createCaller(ctx).getRecommendedOpportunities();

    silencio.mockRestore();
    // A tributarista não tem nada em "preciso": o café (índice 2) só passa
    // porque o perfil deste teste declara uma busca — sem isso o piso fecharia.
    expect(lista.map(o => o.id)).toEqual([10, 12]);
  });

  it("a citação é conferida contra a PRÓPRIA oportunidade: copiar a necessidade de outra do mesmo prompt não libera", async () => {
    filas.push([perfilTributarista], oportunidades);
    invokeLLM.mockResolvedValue(respostaDaIA({ matches: [
      { index: 1, score: 88, reason: "Presumido", tipoDaOferta: "servico", necessidadeExpressa: "revisar nossos tributos e identificar créditos fiscais" },
    ] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const lista = await matchingRouter.createCaller(ctx).getRecommendedOpportunities();

    silencio.mockRestore();
    expect(lista).toEqual([]);
  });

  it("o piso: perfil só de serviço e sem busca declarada exige citação mesmo quando o modelo diz 'produto' ou 'nenhuma'", async () => {
    filas.push([{ ...perfilTributarista, seekingTypes: [] }], oportunidades);
    invokeLLM.mockResolvedValue(respostaDaIA({ matches: [
      { index: 1, score: 85, reason: "Setor", tipoDaOferta: "nenhuma", necessidadeExpressa: "" },
      { index: 2, score: 70, reason: "Café", tipoDaOferta: "produto", necessidadeExpressa: "" },
      { index: 0, score: 90, reason: "Declarada", tipoDaOferta: "outros", necessidadeExpressa: "revisar nossos tributos e identificar créditos fiscais" },
    ] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const lista = await matchingRouter.createCaller(ctx).getRecommendedOpportunities();

    silencio.mockRestore();
    expect(lista.map(o => o.id)).toEqual([10]);
  });

  it("a descrição vai em 800 caracteres em fronteira de palavra: a necessidade antes do corte confere, depois do corte não chega ao modelo", async () => {
    const necessidade = "Precisamos de assessoria tributária para revisar a carga fiscal.";
    const enchimento = "Empresa consolidada no setor. ".repeat(30); // 900 caracteres
    const cabe = { ...oportunidades[0], description: `${necessidade} ${enchimento}` };
    const naoCabe = { ...oportunidades[0], id: 13, description: `${enchimento}${necessidade}` };
    filas.push([perfilTributarista], [cabe, naoCabe]);
    const citacao = { tipoDaOferta: "servico", necessidadeExpressa: "Precisamos de assessoria tributária para revisar a carga fiscal" };
    invokeLLM.mockResolvedValue(respostaDaIA({ matches: [
      { index: 0, score: 90, reason: "Declarada", ...citacao },
      { index: 1, score: 90, reason: "Declarada", ...citacao },
    ] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const lista = await matchingRouter.createCaller(ctx).getRecommendedOpportunities();

    silencio.mockRestore();
    const chamada = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const usuario = chamada.messages.find(m => m.role === "user")!.content;
    expect(usuario).toContain("cortadas em 800 caracteres");
    // a linha da segunda oportunidade termina com reticência e sem a necessidade
    const linhaCortada = usuario.split("\n").find(l => l.startsWith("[1] "))!;
    expect(linhaCortada).toContain("…");
    expect(linhaCortada).not.toContain("carga fiscal");
    expect(lista.map(o => o.id)).toEqual([10]);
  });

  it("a citação é conferida contra o que a pessoa escreveu, não contra a linha do prompt: setor e tipo não valem", async () => {
    filas.push([perfilTributarista], oportunidades);
    invokeLLM.mockResolvedValue(respostaDaIA({ matches: [
      // "Farmacêutico" e "demand" estão na linha do prompt (Setor:/Tipo:), não no texto da oportunidade 11
      { index: 1, score: 88, reason: "Setor", tipoDaOferta: "servico", necessidadeExpressa: "Farmacêutico demand" },
    ] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const lista = await matchingRouter.createCaller(ctx).getRecommendedOpportunities();

    silencio.mockRestore();
    expect(lista).toEqual([]);
  });

  it("o prompt carrega a regra e a resposta pede tipo e citação no schema", async () => {
    filas.push([perfilTributarista], oportunidades);
    invokeLLM.mockResolvedValue(respostaDaIA({ matches: [] }));

    await matchingRouter.createCaller(ctx).getRecommendedOpportunities();

    const chamada = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }>; response_format: { json_schema: { schema: { properties: { matches: { items: { required: string[]; properties: Record<string, unknown> } } } } } } };
    const sistema = chamada.messages.find(m => m.role === "system")!.content;
    expect(sistema).toContain("REGRA DA DEMANDA EXPRESSA");
    expect(sistema).not.toContain("necessidades implícitas");
    const itens = chamada.response_format.json_schema.schema.properties.matches.items;
    expect(itens.required).toEqual(["index", "score", "reason", "tipoDaOferta", "necessidadeExpressa"]);
    expect((itens.properties.tipoDaOferta as { enum: string[] }).enum).toContain("servico");
  });
});

describe("notifyHighCompatibilityForOpportunity — o portão no alerta", () => {
  it("avisa quem oferece o que a oportunidade pede; retém o serviço presumido e o serviço que cita a contraparte", async () => {
    const oportunidade = oportunidades[1]; // distribuidor para a África
    filas.push([oportunidade], [
      { userId: 2, role: "silver", whatIHave: ["Advocacia tributária"], whatINeed: [], sector: "Jurídico", seekingTypes: [], interestSectors: [], activityArea: null },
      { userId: 3, role: "silver", whatIHave: ["Rede de distribuição na África"], whatINeed: [], sector: "Logística", seekingTypes: [], interestSectors: [], activityArea: null },
      { userId: 4, role: "silver", whatIHave: ["Consultoria em distribuição"], whatINeed: [], sector: "Consultoria", seekingTypes: [], interestSectors: [], activityArea: null },
    ]);
    invokeLLM.mockResolvedValue(respostaDaIA({ alerts: [
      { index: 0, score: 88, tipoDaOferta: "servico", necessidadeExpressa: "indústria com obrigações tributárias" },
      { index: 1, score: 92, tipoDaOferta: "conexao", necessidadeExpressa: "" },
      { index: 2, score: 85, tipoDaOferta: "servico", necessidadeExpressa: "busca distribuidor para expansão na África" },
    ] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const r = await notifyHighCompatibilityForOpportunity(11);

    silencio.mockRestore();
    // A descrição vai inteira ao alerta (não mais 300 caracteres).
    const chamada = invokeLLM.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(chamada.messages.find(m => m.role === "user")!.content).toContain(oportunidade.description);
    // A consultoria em distribuição (userId 4) era avisada até 14/09: a citação estava na oportunidade. Mas o que ela
    // declara é precisar de um DISTRIBUIDOR — a contraparte, que serviço nenhum entrega (exemplo 2 da spec da Glenda;
    // o mesmo critério de `perfilDeclarouPrecisarDoServico` no sentido oposto). Quem TEM a rede de distribuição segue avisada.
    expect(r).toEqual({ notified: 1 });
    expect(createNotification.mock.calls.map(c => (c[0] as { userId: number }).userId)).toEqual([3]);
  });

  it("o piso no alerta: perfil só de serviço e sem busca declarada é retido mesmo quando o modelo diz 'produto'", async () => {
    filas.push([oportunidades[1]], [
      { userId: 2, role: "silver", whatIHave: ["Advocacia tributária"], whatINeed: [], sector: "Jurídico", seekingTypes: [], interestSectors: [], activityArea: null, lookingForInvestment: false, primarySpecialty: null },
    ]);
    invokeLLM.mockResolvedValue(respostaDaIA({ alerts: [{ index: 0, score: 90, tipoDaOferta: "produto", necessidadeExpressa: "" }] }));
    const silencio = vi.spyOn(console, "info").mockImplementation(() => {});

    const r = await notifyHighCompatibilityForOpportunity(11);

    silencio.mockRestore();
    expect(r).toEqual({ notified: 0 });
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe("citacaoAmarradaAoPerfil — a citação precisa pedir um serviço que o perfil oferece (defeito c da #101, 13/09)", () => {
  const fonte = textoEscritoPelaPessoa("Crescimento da marca", [], "Precisamos de consultoria em marketing digital para lançar a marca no Brasil.");
  const servico = (citacao: string) => ({ tipoDaOferta: "servico", necessidadeExpressa: citacao });
  const oferece = (...ofertas: string[]) => ({ whatIHave: ofertas, whatINeed: [] });

  it("a citação de OUTRO serviço não passa, nem cortada antes da especialidade", () => {
    expect(passaNoPortao(servico("consultoria em marketing"), fonte, oferece("Consultoria jurídica"))).toBe(false);
    expect(passaNoPortao(servico("Precisamos de consultoria"), fonte, oferece("Consultoria jurídica"))).toBe(false);
  });

  it("o mesmo serviço passa, inclusive quando a necessidade é mais específica que a oferta", () => {
    expect(passaNoPortao(servico("consultoria em marketing digital"), fonte, oferece("Consultoria em marketing"))).toBe(true);
    expect(passaNoPortao(servico("consultoria em marketing digital"), fonte, oferece("Consultoria jurídica", "Consultoria em marketing"))).toBe(true);
  });

  it("a mesma coisa escrita de outro jeito passa; outra profissão com a mesma especialidade não", () => {
    const advogado = "Busca | Precisamos de advogado tributarista para o ICMS";
    const contador = "Busca | Precisamos de contador tributário";
    expect(passaNoPortao(servico("Precisamos de advogado tributarista"), advogado, oferece("Advocacia tributária"))).toBe(true);
    expect(passaNoPortao(servico("Precisamos de contador tributário"), contador, oferece("Advocacia tributária"))).toBe(false);
  });

  it("paráfrase sem palavra de serviço fica com a IA, como antes", () => {
    const revisao = "Revisão fiscal | Precisamos revisar nossos tributos e identificar créditos fiscais";
    expect(passaNoPortao(servico("Precisamos revisar nossos tributos e identificar créditos fiscais"), revisao, oferece("Advocacia tributária"))).toBe(true);
  });

  it("sem perfil, ou perfil sem serviço, a amarração não se aplica", () => {
    expect(citacaoAmarradaAoPerfil("consultoria em marketing", fonte)).toBe(true);
    expect(citacaoAmarradaAoPerfil("consultoria em marketing", fonte, oferece("Soja"))).toBe(true);
    expect(citacaoAmarradaAoPerfil(undefined, fonte, oferece("Consultoria jurídica"))).toBe(true);
  });

  it("citação que não está na fonte em ordem não é julgada isolada: a amarração reprova (item 2 da lista do Nicolas na #135)", () => {
    // Até 15/09 `citacaoPedeServicoOferecido` julgava a frase do MODELO quando não a achava na fonte, e "revisar
    // tributos" (montada de duas frases) declarava o assunto tributário.
    const duasFrases = textoEscritoPelaPessoa("Estratégia de distribuição", [], "Indústria com alta carga de tributos. Queremos revisar nossa estratégia de distribuição");
    expect(citacaoAmarradaAoPerfil("revisar tributos", duasFrases, oferece("Advocacia tributária"))).toBe(false);
    expect(citacaoAmarradaAoPerfil("Queremos revisar nossa estratégia", duasFrases, oferece("Advocacia tributária"))).toBe(true);
  });
});

describe("Portão da IA — revisão adversarial da correção (13/09)", () => {
  const citando = (descricao: string, citacao: string, perfil: Record<string, unknown>) =>
    passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: citacao }, textoEscritoPelaPessoa("Oportunidade", [], descricao), { whatINeed: [], ...perfil });
  const oferece = (...ofertas: string[]) => ({ whatIHave: ofertas });

  it("perfil cuja especialidade é 'legal' (o que o onboarding grava) passa com 'Precisamos de um advogado'", () => {
    expect(citando("Precisamos de um advogado para montar a holding.", "Precisamos de um advogado", { whatIHave: [], primarySpecialty: "legal" })).toBe(true);
    expect(citando("Precisamos de consultoria em marketing digital.", "consultoria em marketing digital", { whatIHave: [], primarySpecialty: "legal" })).toBe(false);
  });

  it("paráfrase com palavra de serviço incidental na mesma frase continua passando", () => {
    expect(citando("Precisamos recuperar créditos de ICMS e contratar um contador.", "recuperar créditos de ICMS", oferece("Advocacia tributária"))).toBe(true);
    expect(citando("Precisamos de agência de marketing e precisamos revisar nossos tributos.", "precisamos revisar nossos tributos", oferece("Advocacia tributária"))).toBe(true);
    expect(citando("Cooperativa precisa de apoio para exportação, com atendimento em inglês.", "precisa de apoio para exportação", oferece("Consultoria em exportação"))).toBe(true);
  });

  it("assessoria + profissão, enumeração com vírgula e artigo em inglês passam para quem oferece o serviço", () => {
    expect(citando("Precisamos de assessoria contábil para sair do MEI.", "Precisamos de assessoria contábil", oferece("Contabilidade"))).toBe(true);
    expect(citando("We need legal support for our expansion into Brazil.", "We need legal support", oferece("Corporate lawyer"))).toBe(true);
    expect(citando("Startup precisa de advogado, contador e designer.", "precisa de advogado, contador e designer", oferece("Advocacia empresarial"))).toBe(true);
    expect(citando("Looking for an accountant for our subsidiary.", "looking for an accountant", oferece("Contabilidade internacional"))).toBe(true);
    expect(citando("We need help with our marketing.", "We need help with our marketing", oferece("Marketing digital"))).toBe(true);
  });

  it("assunto ou público em comum não aprova outro serviço, e citação montada com palavras soltas não serve", () => {
    expect(citando("Buscamos assessoria contábil para pequenas empresas.", "assessoria contábil para pequenas empresas", oferece("Consultoria jurídica para pequenas empresas"))).toBe(false);
    expect(citando("Precisamos de assessoria trabalhista para reduzir passivo.", "assessoria trabalhista para reduzir passivo", oferece("Treinamento em segurança do trabalho"))).toBe(false);
    expect(citando("Precisamos de consultoria com foco em marketing digital.", "consultoria com foco em marketing digital", oferece("Consultoria jurídica"))).toBe(false);
    expect(citando("Startup jurídica busca parceria. Precisamos de consultoria em marketing digital.", "consultoria jurídica", oferece("Consultoria jurídica"))).toBe(false);
  });

  it("a mesma citação em duas frases: vale a ocorrência em que as palavras estão juntas", () => {
    const descricao = "Startup jurídica busca consultoria de marketing. Também precisamos de consultoria jurídica para os termos de uso.";
    expect(citando(descricao, "consultoria jurídica", oferece("Consultoria jurídica"))).toBe(true);
    expect(citando("Advogado tributarista | para planejamento de holding", "Advogado tributarista para planejamento de holding", oferece("Advocacia tributária"))).toBe(true);
  });
});

describe("Portão da IA — citação montada fora de ordem (item 2 da lista do Nicolas na #135, 15/09)", () => {
  // O caso executado: a conferência por conjunto deixava "revisar tributos" passar para a tributarista, com as duas
  // palavras vindas de frases diferentes e em ordem invertida — o exemplo 2 da spec da Glenda de novo.
  const descricao = "Indústria com alta carga de tributos. Queremos revisar nossa estratégia de distribuição";
  const citando = (citacao: string, ...ofertas: string[]) =>
    passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: citacao }, textoEscritoPelaPessoa("Estratégia de distribuição", [], descricao), { whatIHave: ofertas, whatINeed: [] });

  it("a citação montada de duas frases reprova, e o portão não julga a frase do modelo", () => {
    expect(citando("revisar tributos", "Advocacia tributária")).toBe(false);
    expect(citando("tributos revisar", "Advocacia tributária")).toBe(false);
    expect(citando("carga de tributos revisar", "Advocacia tributária")).toBe(false);
  });

  it("a frase inteira, na ordem, passa — inclusive com palavras intercaladas; a de duas frases em ordem não", () => {
    expect(citando("Queremos revisar nossa estratégia", "Advocacia tributária")).toBe(true);
    expect(citando("Queremos revisar estratégia de distribuição", "Advocacia tributária")).toBe(true);
    expect(citando("tributos queremos revisar nossa estratégia", "Advocacia tributária")).toBe(false);
  });

  it("a pontuação de fim de frase do chinês e do japonês também separa frases: a citação que cruza o 。 é montagem", () => {
    // Revisão do item 2: FIM_DE_FRASE só lia a pontuação latina, e "distribuição indústria" montada dos dois lados de
    // um 。 conferia como se fosse uma frase só. A fonte aqui é latina; o ramo literal (citação EM escrita sem espaço)
    // não muda.
    for (const separador of ["。", "！", "？", "；"]) {
      const fonte = `Queremos revisar nossa estratégia de distribuição${separador}Indústria com alta carga de tributos`;
      expect(citacaoConfere("distribuição indústria", fonte), JSON.stringify(separador)).toBe(false);
      expect(citacaoConfere("estratégia de distribuição", fonte), JSON.stringify(separador)).toBe(true); // dentro de uma frase só
    }
  });

  it("em chinês e japonês a ordem vale igual: o ramo literal não devolve antes da conferência (validação de 16/09)", () => {
    // O ramo de escrita sem espaço conferia só presença e devolvia antes de `emOrdemNumaFrase`: a citação montada
    // passava, enquanto o equivalente latino era barrado.
    const fonteChinesa = "我们不需要税务咨询。我们需要非洲的分销商";
    expect(citacaoConfere("需要 税务咨询", fonteChinesa)).toBe(false);
    expect(citacaoConfere("税务咨询 需要", fonteChinesa)).toBe(false);
    expect(citacaoConfere("分销商 税务咨询", fonteChinesa)).toBe(false);
    // O trecho que está mesmo na fonte, na ordem, continua valendo.
    expect(citacaoConfere("税务咨询", fonteChinesa)).toBe(true);
    expect(citacaoConfere("需要非洲的分销商", fonteChinesa)).toBe(true);
    const fonteJaponesa = "弁護士は必要ありません。物流の会社を探しています";
    expect(citacaoConfere("探しています 弁護士", fonteJaponesa)).toBe(false);
    expect(citacaoConfere("物流の会社を探しています", fonteJaponesa)).toBe(true);
  });

  it("citação honesta de DOIS pedaços da mesma oração em chinês e japonês continua passando", () => {
    // A conferência de ordem por janela de TOKENS não serve a esta escrita: a
    // oração inteira é um token só, e a janela só olha tokens posteriores — com
    // ela, TODA citação de dois pedaços em zh/ja era recusada, inclusive a
    // honesta, enquanto a latina equivalente passava. A ordem aqui é por
    // posição no texto da frase.
    expect(citacaoConfere("弁護士 探しています", "弁護士を探しています")).toBe(true);
    expect(citacaoConfere("税務 コンサルティング", "税務コンサルティングを探しています")).toBe(true);
    expect(citacaoConfere("非洲的分销商 物流服务", "我们需要非洲的分销商和物流服务")).toBe(true);
    // E o que é montagem continua barrado, inclusive dentro de uma oração só.
    expect(citacaoConfere("探しています 弁護士", "弁護士を探しています")).toBe(false);
    expect(citacaoConfere("物流服务 非洲的分销商", "我们需要非洲的分销商和物流服务")).toBe(false);
  });

  it("pedaço arrancado de uma negação não conta como citado (不需要 não é 需要)", () => {
    // É o que a ordem sozinha não vê: os dois pedaços estão na mesma oração e na
    // ordem certa, mas a oração diz o CONTRÁRIO do que a citação sugere.
    expect(citacaoConfere("需要 税务咨询", "我们不需要税务咨询")).toBe(false);
    expect(citacaoConfere("需要 税务咨询", "我们没需要税务咨询")).toBe(false);
    // A negação não precisa encostar no termo: 不再, 不太, 暂时不.
    expect(citacaoConfere("需要 税务咨询", "我们不再需要税务咨询")).toBe(false);
    expect(citacaoConfere("需要 税务咨询", "我们不太需要税务咨询")).toBe(false);
    // Sem a negação, a mesma citação é honesta.
    expect(citacaoConfere("需要 税务咨询", "我们需要税务咨询")).toBe(true);
  });

  it("o japonês nega DEPOIS do termo, e isso também desqualifica a citação", () => {
    // 必要ありません / 必要ない: quem lê só o caractere anterior não vê negação
    // nenhuma, e o perfil que oferece 弁護士 passava o portão de uma fonte que
    // diz não precisar de advogado.
    expect(citacaoConfere("弁護士 必要", "弁護士は必要ありません。物流の会社を探しています")).toBe(false);
    expect(citacaoConfere("弁護士 必要", "弁護士は必要ない")).toBe(false);
    // E a citação honesta da mesma fonte continua passando.
    expect(citacaoConfere("物流の会社を探しています", "弁護士は必要ありません。物流の会社を探しています")).toBe(true);
  });

  it("a citação que junta CAMPOS ou orações separadas é montagem, como em português", () => {
    // `textoEscritoPelaPessoa` junta título, tags e descrição com " | "; a vírgula
    // ideográfica separa orações. Sem contá-las como fim de oração, dois pedaços
    // de lugares opostos do texto viravam uma citação só.
    expect(citacaoConfere("税务咨询 分销商", "我们不需要税务咨询 | 我们需要非洲的分销商")).toBe(false);
    expect(citacaoConfere("税务咨询 分销商", "我们不需要税务咨询、我们在扩张、我们需要非洲的分销商")).toBe(false);
  });

  it("citação exata com letra latina maiúscula se acha na fonte (a busca é normalizada)", () => {
    // Os pedaços vêm de `tokensDoTermo`, que baixa a caixa e tira o diacrítico.
    // Procurar no texto CRU fazia a citação exata não se achar na própria fonte.
    expect(citacaoConfere("SAP 税务咨询", "Parceiro SAP | 我们需要SAP 税务咨询")).toBe(true);
    expect(citacaoConfere("sap 税务咨询", "Parceiro SAP | 我们需要SAP 税务咨询")).toBe(true);
  });
});


describe("Portão da IA — revisão adversarial da correção empilhada sobre a #124 (14/09)", () => {
  const citando = (descricao: string, citacao: string, perfil: Record<string, unknown>) =>
    passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: citacao }, textoEscritoPelaPessoa("Oportunidade", [], descricao), { whatINeed: [], ...perfil });
  const oferece = (...ofertas: string[]) => ({ whatIHave: ofertas });

  it("pedido da família com palavra que as listas não leem fica com o modelo", () => {
    expect(citando("Precisamos de um advogado também.", "Precisamos de um advogado também", oferece("Advocacia tributária"))).toBe(true);
    expect(citando("We need a lawyer who speaks Portuguese.", "We need a lawyer", oferece("Tax lawyer"))).toBe(true);
    expect(citando("Nous cherchons un avocat pour notre filiale au Brésil.", "Nous cherchons un avocat", oferece("Tax lawyer"))).toBe(true);
    expect(citando("Precisamos de um advogado para a nossa empresa.", "Precisamos de um advogado para a nossa empresa", oferece("Advocacia tributária"))).toBe(true);
    expect(citando("Precisamos de um advogado e buscamos parceiros comerciais.", "Precisamos de um advogado", oferece("Advocacia empresarial"))).toBe(true);
    expect(citando("Marketing agency requires a lawyer.", "Marketing agency requires a lawyer", oferece("Tax lawyer"))).toBe(true);
    expect(citando("Precisamos de um advogado para montar a holding.", "Precisamos de um advogado", oferece("Consultoria jurídica"))).toBe(true);
  });

  it("outro serviço entendido continua barrado", () => {
    expect(citando("Precisamos de consultoria em marketing jurídico.", "consultoria em marketing jurídico", oferece("Consultoria jurídica"))).toBe(false);
    expect(citando("Precisamos de consultoria em marketing e buscamos parceiros.", "consultoria em marketing", oferece("Consultoria jurídica"))).toBe(false);
    expect(citando("Buscamos consultoria em e-commerce.", "consultoria em e-commerce", oferece("Consultoria jurídica"))).toBe(false);
  });
});

describe("passaNoPortao — oportunidade que oferece serviço exige declaração que possa ser ELE (lacuna depois da #127, 14/09)", () => {
  // Até aqui bastava o perfil ter declarado qualquer coisa: "Consultoria
  // tributária" oferecida passava para quem só procurava distribuidores, com o
  // modelo dizendo "nenhuma".
  const fonte = "Consultoria tributária para indústrias | revisão de tributos e recuperação de créditos";
  const semApoio = { tipoDaOferta: "nenhuma", necessidadeExpressa: "" };
  const oferta = (title: string) => ({ type: "offer", title });
  const tributaria = oferta("Consultoria tributária");

  it("o defeito medido: distribuidores, compradores, investidores e capital não pedem serviço", () => {
    for (const necessidade of ["distribuidores", "compradores", "investidores", "financiamento", "parceiros", "Distribuidor para a África", "Compradores na Europa", "Galpão em Santos", "Capital de giro"]) {
      expect(passaNoPortao(semApoio, fonte, { whatIHave: ["fazenda"], whatINeed: [necessidade] }, tributaria), necessidade).toBe(false);
    }
    expect(passaNoPortao(semApoio, fonte, { whatIHave: ["fazenda"], lookingForInvestment: true }, tributaria)).toBe(false);
    expect(passaNoPortao(semApoio, fonte, { whatIHave: ["fazenda"], seekingTypes: ["investor", "strategic_partner"] }, tributaria)).toBe(false);
  });

  it("outro serviço que o texto entende não é este", () => {
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["Consultoria em marketing"] }, tributaria)).toBe(false);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["Transporte de cargas"] }, tributaria)).toBe(false);
  });

  it("a declaração que nomeia o serviço, ou a opção fixa que ele atende, passa", () => {
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["consultoria"] }, tributaria)).toBe(true);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["Consultor tributário"] }, tributaria)).toBe(true);
    // Basta uma declaração: distribuidores E consultoria.
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["distribuidores", "consultoria"] }, tributaria)).toBe(true);
  });

  it("o que o texto não entende fica com o modelo, como antes (a regra está no prompt)", () => {
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["Aprovação do registro na Anvisa"] }, oferta("Consultoria regulatória"))).toBe(true);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["Planejamento tributário"] }, tributaria)).toBe(true);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["Suporte para obter autorização regulatória"] }, oferta("Consultoria regulatória"))).toBe(true);
  });

  it("a opção fixa 'consultoria' é da assessoria; 'mentor' é da mentoria; logística atende distribuidores", () => {
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["consultoria"] }, oferta("Tradução juramentada"))).toBe(false);
    expect(passaNoPortao(semApoio, fonte, { seekingTypes: ["mentor"] }, oferta("Mentoria para fundadoras"))).toBe(true);
    expect(passaNoPortao(semApoio, fonte, { seekingTypes: ["mentor"] }, tributaria)).toBe(false);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["distribuidores"] }, oferta("Transporte rodoviário de cargas"))).toBe(true);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["compradores"] }, oferta("Transporte rodoviário de cargas"))).toBe(false);
  });

  it("não mexe no que não é oferta de serviço", () => {
    expect(perfilDeclarouPrecisarDoServico({ whatINeed: ["distribuidores"] }, "Consultoria tributária")).toBe(false);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["distribuidores"] }, { type: "demand", title: "Consultoria tributária" })).toBe(true);
    expect(passaNoPortao(semApoio, fonte, { whatINeed: ["distribuidores"] }, oferta("Café especial da Bahia"))).toBe(true);
  });
});

describe("Portão da IA — imóvel pedido pela cabeça (porte da d7fac93 na #135, medição do cético de 15/09)", () => {
  // A d7fac93 tirou casa, sala, loja, vaga e flat da lista IMOVEL, que classifica a OFERTA: ali sobrar palavra tira o
  // item do portão. Do lado do PEDIDO a conta é a oposta, e sem uma leitura própria esses pedidos passavam como
  // necessidade de "Consultoria jurídica" — na #135 antes do porte eram barrados.
  const perfil = { whatIHave: ["Consultoria jurídica"], whatINeed: [], seekingTypes: [] };

  it("o trecho citado que pede imóvel não sustenta o serviço", () => {
    for (const trecho of ["loja de rua no centro", "sala comercial no centro", "casa para a nova filial", "vaga de garagem", "galpão em Santos", "apartamento para a diretora"]) {
      const fonte = `Empresa de cosméticos procura ${trecho} para expandir.`;
      expect(passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: trecho }, fonte, perfil), trecho).toBe(false);
    }
  });

  it("a demanda detalhada de Imóveis / Estrutura não declara precisar do serviço, e a oportunidade que o oferece não vai para ela", () => {
    const oportunidade = { type: "offer", title: "Consultoria jurídica" };
    const semApoio = { tipoDaOferta: "nenhuma", necessidadeExpressa: "" };
    for (const descricao of ["Loja de rua no centro de Campinas", "Sala comercial de 40 m² no centro", "Casa para montar escritório", "Vaga de garagem perto do escritório", "Galpão de 500 m² em Santos"]) {
      const quemPediu = { whatINeed: ["imoveis_estrutura"], whatINeedDetails: [{ id: "d1", category: "imoveis_estrutura", subcategory: "loja", description: descricao }], seekingTypes: [] };
      expect(perfilDeclarouPrecisarDoServico(quemPediu, "Consultoria jurídica"), descricao).toBe(false);
      expect(passaNoPortao(semApoio, "Consultoria jurídica para empresas", quemPediu, oportunidade), descricao).toBe(false);
    }
  });

  it("mas só no sentido de imóvel: casa de consultoria, casa de câmbio, loja virtual, sala de reunião e vaga de emprego não são", () => {
    // "Casa de consultoria" nomeia o serviço; os outros não são imóvel e ficam com o modelo, como antes.
    expect(perfilDeclarouPrecisarDoServico({ whatINeed: ["Casa de consultoria"] }, "Consultoria jurídica")).toBe(true);
    for (const necessidade of ["Loja virtual", "Casa de software", "Sala de reunião", "Vaga de emprego"]) {
      expect(perfilDeclarouPrecisarDoServico({ whatINeed: [necessidade] }, "Desenvolvimento de sites"), necessidade).toBe(true);
    }
  });
});

/**
 * 9e866b9 da #127 (item 6 da revisão de 14/09, portada): chinês e japonês não
 * separam palavras, e a citação inteira chegava como UMA palavra — menos que as
 * duas exigidas. O serviço nunca passava nesses idiomas, nem com a necessidade
 * declarada. E a 0d6643d (revisão de 15/09): a conferência literal vale só para
 * a citação de fato chinesa ou japonesa, não para a frase latina com um nome.
 */
describe("Portão da IA — citação em chinês e japonês, sem espaço (9e866b9 e 0d6643d da #127, portadas)", () => {
  it("confere quando o trecho está literalmente na fonte e tem ao menos quatro caracteres", () => {
    expect(citacaoConfere("我们需要税务咨询服务", "我们需要税务咨询服务")).toBe(true);
    expect(citacaoConfere("我们需要税务咨询服务", "新工厂项目 | 我们需要税务咨询服务，以便处理进口关税。")).toBe(true);
    expect(citacaoConfere("税務コンサルティングが必要です", "当社は税務コンサルティングが必要です。")).toBe(true);
    // Trecho que não está na fonte, ou curto demais para ser declaração, não confere.
    expect(citacaoConfere("我们需要法律咨询服务", "我们需要税务咨询服务")).toBe(false);
    expect(citacaoConfere("咨询", "我们需要税务咨询服务")).toBe(false);
    expect(citacaoConfere("新工厂项目我们需要", "新工厂项目 | 我们需要税务咨询服务")).toBe(false);
  });

  it("e o match apoiado nela passa no portão; citação inventada não", () => {
    const passa = (oferta: string, citacao: string, fonte: string) =>
      passaNoPortao({ tipoDaOferta: "servico", necessidadeExpressa: citacao }, fonte, { whatIHave: [oferta], whatINeed: [] });
    expect(passa("税务咨询", "我们需要税务咨询服务", "新工厂项目 | 我们需要税务咨询服务")).toBe(true);
    expect(passa("税務コンサルティング", "税務コンサルティングが必要です", "当社は税務コンサルティングが必要です。")).toBe(true);
    expect(passa("税务咨询", "我们需要法律咨询服务", "新工厂项目 | 我们需要税务咨询服务")).toBe(false);
  });

  it("frase latina com um nome curto em chinês ou japonês segue a regra das palavras, e o nome só precisa estar na fonte (0d6643d)", () => {
    // Antes o "東京" (dois caracteres) levava a citação inteira para a conferência literal e ela não conferia.
    expect(citacaoConfere("Precisamos de consultoria tributária para a filial de 東京", "Nova filial | Precisamos de consultoria tributária para a filial de 東京")).toBe(true);
    expect(citacaoConfere("We need tax consulting for our 日本橋 office", "New office | We need tax consulting for our 日本橋 office")).toBe(true);
    // A tolerância de uma palavra ausente continua valendo, também com o nome japonês na frase.
    expect(citacaoConfere("Precisamos urgentemente de consultoria tributária para 株式会社トヨタ", "Precisamos de consultoria tributária para 株式会社トヨタ")).toBe(true);
    // O nome que não está na fonte não confere.
    expect(citacaoConfere("Precisamos de consultoria tributária para a filial de 東京", "Precisamos de consultoria tributária para a filial")).toBe(false);
    // Parte latina inventada: com duas palavras cai na regra de sempre; com uma, na conferência literal.
    expect(citacaoConfere("我们需要税务咨询服务 transfer pricing", "我们需要税务咨询服务")).toBe(false);
    expect(citacaoConfere("我们需要税务咨询服务 pricing", "我们需要税务咨询服务")).toBe(false);
    expect(passaNoPortao(
      { tipoDaOferta: "servico", necessidadeExpressa: "Precisamos de consultoria tributária para a filial de 東京" },
      "Nova filial | Precisamos de consultoria tributária para a filial de 東京",
      { whatIHave: ["Consultoria tributária"], whatINeed: [] },
    )).toBe(true);
  });

  it("os invariantes da #135 continuam valendo com a citação em chinês: a contraparte e o serviço lido e diferente barram", () => {
    // O serviço em chinês agora é lido (e6ddfa4): "税务咨询" diante de "consultoria em marketing" é barrado como
    // "Consultoria tributária" seria.
    expect(passaNoPortao(
      { tipoDaOferta: "servico", necessidadeExpressa: "Precisamos de consultoria em marketing" },
      "Nova loja | Precisamos de consultoria em marketing digital",
      { whatIHave: ["税务咨询"], whatINeed: [] },
    )).toBe(false);
    // A citação que pede a contraparte segue barrada, com o perfil em chinês.
    expect(passaNoPortao(
      { tipoDaOferta: "servico", necessidadeExpressa: "busca distribuidor para expansão na África" },
      "Indústria farmacêutica | busca distribuidor para expansão na África",
      { whatIHave: ["税务咨询"], whatINeed: [] },
    )).toBe(false);
  });

  it("e com a CITAÇÃO em chinês ou japonês o portão fecha por padrão: só passa o pedaço que nomeia um serviço do perfil (revisão de 15/09 do porte)", () => {
    // O resto do portão não lê essa escrita: contraparte, capital, imóvel, autodescrição e outro serviço caíam em "não
    // nomeia serviço" e passavam — em português são barrados.
    const passa = (oferta: string, citacao: string, fonte = `新项目 | ${citacao}。`, tipo = "servico") =>
      passaNoPortao({ tipoDaOferta: tipo, necessidadeExpressa: citacao }, fonte, { whatIHave: [oferta], whatINeed: [] });
    for (const oferta of ["Consultoria tributária", "税务咨询"]) {
      for (const [citacao, fonte] of [
        ["我们需要分销商", undefined], ["我们需要投资者", undefined], ["我们需要寻找买家", undefined], ["我们是一家国际贸易公司", undefined],
        ["我们需要律师", undefined], ["我们需要营销咨询", undefined],
        ["非洲扩张的经销商", "寻找非洲扩张的经销商"], ["有国际业务的巴西公司", "我们是一家有国际业务的巴西公司"],
        ["投资者扩建工厂", "寻找投资者扩建工厂"], ["上海的办公室", "我们需要上海的办公室"], ["市场营销咨询", "我们需要市场营销咨询"],
      ] as Array<[string, string | undefined]>) {
        expect(passa(oferta, citacao, fonte), `${oferta} :: ${citacao}`).toBe(false);
      }
    }
    expect(passa("Consultoria em internacionalização", "我们需要分销商")).toBe(false);
    expect(passa("税務コンサルティング", "販売代理店を探しています")).toBe(false);
    expect(passa("税務コンサルティング", "弁護士が必要です")).toBe(false);
    // O piso: perfil só de serviço e o modelo dizendo "produto".
    expect(passa("Consultoria tributária", "我们需要寻找买家", undefined, "produto")).toBe(false);
    // O pedido do serviço oferecido, lido pelo fim do termo, continua passando.
    expect(passa("税务咨询", "我们需要税务咨询服务")).toBe(true);
    expect(passa("Consultoria tributária", "我们需要税务咨询服务")).toBe(true);
    expect(passa("税務コンサルティング", "税務コンサルティングが必要です")).toBe(true);
    expect(passa("会计师事务所", "我们需要会计服务")).toBe(true);
  });
});
