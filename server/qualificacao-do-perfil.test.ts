import { describe, expect, it } from "vitest";
import {
  avaliarQualificacaoDoPerfil,
  itensComConteudo,
  MINIMO_DE_PALAVRAS_NA_APRESENTACAO,
  ORDEM_DAS_PENDENCIAS,
  rotuloComConteudo,
  textoComConteudo,
  veAsConexoesSugeridas,
  type PerfilParaQualificar,
} from "@shared/qualificacao-do-perfil";

/**
 * Governança (spec da Glenda de 14/09/2026, itens 2 a 9): a régua que decide
 * quando um perfil Bronze vira Prata. O que este arquivo guarda:
 *
 *  1. As três dimensões (Quem sou, O que tenho, O que preciso) são exigidas
 *     juntas, e a pendência diz qual falta.
 *  2. Quantidade de caracteres não compra nível: repetição, enchimento,
 *     palavra funcional e sequência de teclado não contam (item 9).
 *  3. Nada de status, cargo ou patrimônio no critério (item 2).
 *  4. A régua não discrimina idioma nem nome curto.
 */

const APRESENTACAO = "Advogada tributarista, atendo empresas familiares que exportam café para a Europa.";

const QUALIFICADO: PerfilParaQualificar = {
  displayName: "Ana Souza",
  city: "Lisboa",
  primarySpecialty: "legal",
  bio: APRESENTACAO,
  whatIHave: ["canais_comerciais"],
  whatINeed: ["fornecedores"],
};

const com = (parcial: Partial<PerfilParaQualificar>) => ({ ...QUALIFICADO, ...parcial });

describe("as três dimensões juntas", () => {
  it("perfil completo e com conteúdo: qualificado, sem pendência", () => {
    expect(avaliarQualificacaoDoPerfil(QUALIFICADO)).toEqual({
      qualificado: true,
      pendencias: [],
      dimensoes: { quemSou: true, oQueTenho: true, oQuePreciso: true },
      // "que", "para" e "a" não contam: 8 palavras de conteúdo em APRESENTACAO.
      detalhes: { apresentacao: { contadas: 8, minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO, repetida: false, vazia: false } },
    });
  });

  it("perfil ausente (onboarding não concluído): as seis pendências, na ordem das seções", () => {
    const r = avaliarQualificacaoDoPerfil(null);
    expect(r.qualificado).toBe(false);
    expect(r.pendencias).toEqual([...ORDEM_DAS_PENDENCIAS]);
    expect(r.dimensoes).toEqual({ quemSou: false, oQueTenho: false, oQuePreciso: false });
  });

  it.each([
    ["nome", { displayName: "" }],
    ["cidade", { city: null }],
    ["apresentacao", { bio: undefined }],
    ["oQueTenho", { whatIHave: [] }],
    ["oQuePreciso", { whatINeed: null }],
  ] as const)("falta só %s: não qualifica e a pendência é exatamente essa", (pendencia, parcial) => {
    const r = avaliarQualificacaoDoPerfil(com(parcial));
    expect(r.qualificado).toBe(false);
    expect(r.pendencias).toEqual([pendencia]);
  });

  it("atuação vale por especialidade, área de atuação OU setor; sem nenhum dos três, pende", () => {
    const semAtuacao = { primarySpecialty: null, activityArea: "", sector: "  " };
    expect(avaliarQualificacaoDoPerfil(com(semAtuacao)).pendencias).toEqual(["atuacao"]);
    expect(avaliarQualificacaoDoPerfil(com({ ...semAtuacao, activityArea: "Comércio exterior" })).qualificado).toBe(true);
    expect(avaliarQualificacaoDoPerfil(com({ ...semAtuacao, sector: "Agronegócio" })).qualificado).toBe(true);
    expect(avaliarQualificacaoDoPerfil(com({ ...semAtuacao, primarySpecialty: "tech" })).qualificado).toBe(true);
  });

  it("Quem sou completo sem O que tenho/preciso não basta; e o contrário também não", () => {
    const soQuemSou = avaliarQualificacaoDoPerfil(com({ whatIHave: [], whatINeed: [] }));
    expect(soQuemSou.dimensoes).toEqual({ quemSou: true, oQueTenho: false, oQuePreciso: false });
    expect(soQuemSou.qualificado).toBe(false);

    const soItens = avaliarQualificacaoDoPerfil({ whatIHave: ["imoveis"], whatINeed: ["investidores"] });
    expect(soItens.dimensoes).toEqual({ quemSou: false, oQueTenho: true, oQuePreciso: true });
    expect(soItens.qualificado).toBe(false);
  });
});

describe("qualidade, não quantidade de caracteres (item 9)", () => {
  it(`apresentação: ${MINIMO_DE_PALAVRAS_NA_APRESENTACAO - 1} palavras de conteúdo não bastam, ${MINIMO_DE_PALAVRAS_NA_APRESENTACAO} bastam`, () => {
    expect(MINIMO_DE_PALAVRAS_NA_APRESENTACAO).toBe(6);
    // "de" e "em" são curtas e não contam: aqui são 5 palavras de conteúdo.
    expect(textoComConteudo("Consultora de exportação em vinhos portugueses finos", 6)).toBe(false);
    expect(textoComConteudo("Consultora de exportação em vinhos portugueses finos tintos", 6)).toBe(true);
  });

  it("a pendência da apresentação vem com a contagem feita e o mínimo, para a tela explicar a recusa (item 8 da revisão da #135)", () => {
    // 7 palavras escritas, 5 de conteúdo: "de" e "para" não contam. Sem a
    // contagem, a tela dizia só "pelo menos 6 palavras" a quem escreveu 7.
    const r = avaliarQualificacaoDoPerfil(com({ bio: "Consultora de marketing digital para pequenas empresas" }));
    expect(r.pendencias).toEqual(["apresentacao"]);
    expect(r.detalhes).toEqual({ apresentacao: { contadas: 5, minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO, repetida: false, vazia: false } });
    // Perfil ausente: zero contadas, e o mínimo continua lá para a tela mostrar "0 de 6".
    expect(avaliarQualificacaoDoPerfil(null).detalhes).toEqual({ apresentacao: { contadas: 0, minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO, repetida: false, vazia: true } });
  });

  it("a mesma palavra repetida mil vezes é UMA palavra", () => {
    expect(avaliarQualificacaoDoPerfil(com({ bio: "empresa ".repeat(1000) })).pendencias).toEqual(["apresentacao"]);
  });

  it("mais repetição que conteúdo não passa, mesmo com seis palavras diferentes", () => {
    const repetitiva = "vendas vendas vendas marketing marketing marketing digital digital digital varejo varejo varejo moda moda moda luxo luxo luxo";
    expect(textoComConteudo(repetitiva, 6)).toBe(false);
    // Aqui a contagem atinge o mínimo e a pendência é pela repetição: a tela
    // não pode dizer "6 de 6 palavras" como se faltasse palavra.
    const r = avaliarQualificacaoDoPerfil(com({ bio: repetitiva }));
    expect(r.pendencias).toEqual(["apresentacao"]);
    // `repetida` distingue a recusa por repetição da recusa por falta de palavras: é ela que escolhe o texto na tela.
    expect(r.detalhes.apresentacao).toEqual({ contadas: 6, minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO, repetida: true, vazia: false });
  });

  /**
   * As duas portas da régua (`leituraComConteudo`) podem estar fechadas ao mesmo
   * tempo, e `repetida` não pode depender de a contagem já ter chegado ao
   * mínimo: quem só ouve "faltam palavras" completa as palavras e leva uma
   * segunda recusa que ninguém avisou.
   */
  it("faltar palavra E repetir são dois motivos, e os dois chegam à tela juntos", () => {
    const r = avaliarQualificacaoDoPerfil(com({ bio: "Aulas de inglês. Aulas de inglês. Aulas de inglês." }));
    expect(r.pendencias).toEqual(["apresentacao"]);
    expect(r.detalhes.apresentacao).toEqual({ contadas: 2, minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO, repetida: true, vazia: false });

    // O caso do relato: acrescentar palavras diferentes até o mínimo não basta,
    // e a tela precisa dizer isso desde a primeira recusa.
    const doRelato = avaliarQualificacaoDoPerfil(com({ bio: "Aulas de inglês. Aulas de inglês para crianças. Aulas de inglês para adultos. Aulas de inglês online. Aulas de inglês." }));
    expect(doRelato.detalhes.apresentacao).toMatchObject({ contadas: 5, repetida: true, vazia: false });
  });

  it("campo vazio é vazio; texto escrito que não conta nada NÃO é", () => {
    // Dez palavras escritas, nenhuma de conteúdo: a tela tem de mostrar a
    // contagem, não o texto geral (que é o que a revisão condenou).
    const soPalavrasCurtas = avaliarQualificacaoDoPerfil(com({ bio: "Sou eu, e é tudo o que tenho por aqui." }));
    expect(soPalavrasCurtas.detalhes.apresentacao).toEqual({ contadas: 0, minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO, repetida: false, vazia: false });

    expect(avaliarQualificacaoDoPerfil(com({ bio: "" })).detalhes.apresentacao.vazia).toBe(true);
    expect(avaliarQualificacaoDoPerfil(com({ bio: "   " })).detalhes.apresentacao.vazia).toBe(true);
  });

  it("uma letra só, longa, não é texto", () => {
    expect(avaliarQualificacaoDoPerfil(com({ bio: "a".repeat(900) })).pendencias).toEqual(["apresentacao"]);
    expect(textoComConteudo("kkkkkk aaaaaa zzzzzzz bbbbbbb ccccccc ddddddd", 1)).toBe(false);
  });

  it("palavra funcional não é conteúdo: 'para com que uma dos das pelo pela'", () => {
    expect(textoComConteudo("para com que uma dos das pelo pela the and for with", 1)).toBe(false);
  });

  it("marcador de teste e sequência de teclado não contam", () => {
    expect(textoComConteudo("teste teste asdf qwerty lorem ipsum xxxx hjkl zxcvb asdfgh", 1)).toBe(false);
    // Só a palavra INTEIRA de teclado cai: "property" contém "erty" e é palavra.
    expect(textoComConteudo("property", 1)).toBe(true);
  });

  it("latino sem vogal ou com seis consoantes seguidas não é palavra da apresentação", () => {
    expect(textoComConteudo("brdfg xptzk sdfghjk mnbvcx", 1)).toBe(false);
  });

  it("números e símbolos não contam como palavras", () => {
    expect(textoComConteudo("123456 789 !!! ??? ... 2026 +55 (11) 99999-9999", 1)).toBe(false);
  });

  it("itens: vazio, marcador e repetição não contam; o mesmo item escrito de três jeitos conta uma vez", () => {
    expect(itensComConteudo(["", "   ", "-", "nada", "N/A", "teste", "ok", "tudo", "Não sei", "a definir", "I don't know"])).toEqual([]);
    expect(itensComConteudo(["Fornecedores", "fornecedores", "FORNECEDORES"])).toEqual(["Fornecedores"]);
    expect(avaliarQualificacaoDoPerfil(com({ whatINeed: ["nada", "nenhuma"] })).pendencias).toEqual(["oQuePreciso"]);
  });

  it("itens: valor que não é lista de texto não quebra e não conta", () => {
    expect(itensComConteudo(42)).toEqual([]);
    expect(itensComConteudo({ a: "fornecedores" })).toEqual([]);
    expect(itensComConteudo([7, null, { x: 1 }])).toEqual([]);
    expect(avaliarQualificacaoDoPerfil(com({ whatIHave: "industria" })).qualificado).toBe(true);
  });

  it("todos os ids das opções fixas do Onboarding e do Perfil valem como item", () => {
    const tenho = ["industria", "fazenda", "laboratorio", "tecnologia", "investidores", "acesso_governamental", "commodities", "licencas", "imoveis", "logistica", "canais_comerciais"];
    const preciso = ["fornecedores", "investidores", "compradores", "distribuidores", "parceiros", "tecnologia", "financiamento", "licencas", "consultoria"];
    expect(itensComConteudo(tenho)).toEqual(tenho);
    expect(itensComConteudo(preciso)).toEqual(preciso);
  });

  it("item em texto livre e sigla valem: 'Advocacia tributária', 'TI', 'RH'", () => {
    expect(itensComConteudo(["Advocacia tributária", "TI", "RH"])).toEqual(["Advocacia tributária", "TI", "RH"]);
  });

  it("um item basta: exigir mais empurraria a declarar necessidade que não existe", () => {
    expect(avaliarQualificacaoDoPerfil(com({ whatIHave: ["imoveis"], whatINeed: ["investidores"] })).qualificado).toBe(true);
  });

  it("o texto de 'Outra necessidade', com a opção marcada, vale como O que preciso (como nos motores)", () => {
    const halal = "Certificação halal para exportar ao Oriente Médio";
    const r = avaliarQualificacaoDoPerfil(com({
      whatIHave: ["industria"], whatINeed: [], seekingTypes: ["outra_necessidade"], seekingOtherNeed: halal,
    }));
    expect(r.qualificado).toBe(true);
    expect(r.dimensoes.oQuePreciso).toBe(true);
    // Sem nenhuma tag de O que preciso nem Outra necessidade, a pendência continua.
    expect(avaliarQualificacaoDoPerfil(com({ whatINeed: [], seekingTypes: ["expandir_negocio"] })).pendencias).toEqual(["oQuePreciso"]);
  });

  it("'Outra necessidade' não conta com a opção desmarcada, sem texto ou com texto de enchimento", () => {
    const semTag = { whatINeed: [] };
    expect(avaliarQualificacaoDoPerfil(com({ ...semTag, seekingTypes: ["expandir_negocio"], seekingOtherNeed: "Certificação halal" })).pendencias).toEqual(["oQuePreciso"]);
    expect(avaliarQualificacaoDoPerfil(com({ ...semTag, seekingTypes: null, seekingOtherNeed: "Certificação halal" })).pendencias).toEqual(["oQuePreciso"]);
    expect(avaliarQualificacaoDoPerfil(com({ ...semTag, seekingTypes: ["outra_necessidade"], seekingOtherNeed: "   " })).pendencias).toEqual(["oQuePreciso"]);
    expect(avaliarQualificacaoDoPerfil(com({ ...semTag, seekingTypes: ["outra_necessidade"], seekingOtherNeed: null })).pendencias).toEqual(["oQuePreciso"]);
    for (const enchimento of ["asdf", "nada", "Não sei", "kkkk", "123"]) {
      expect(avaliarQualificacaoDoPerfil(com({ ...semTag, seekingTypes: ["outra_necessidade"], seekingOtherNeed: enchimento })).pendencias).toEqual(["oQuePreciso"]);
    }
  });
});

describe("sem status, cargo ou patrimônio no critério (item 2)", () => {
  it("cargo, empresa, porte, renda e capacidade de investimento não suprem o que falta", () => {
    const poderoso = {
      ...QUALIFICADO, bio: null,
      jobTitle: "CEO", company: "Grande Holding", companySize: "large",
      incomeRange: "30k_plus", investmentCapacity: "200k_plus", experienceYears: 40, educationLevel: "phd",
    } as PerfilParaQualificar;
    expect(avaliarQualificacaoDoPerfil(poderoso).pendencias).toEqual(["apresentacao"]);
  });

  it("e a ausência deles não impede a Prata", () => {
    const semNada = { ...QUALIFICADO, jobTitle: null, company: null, companySize: null, incomeRange: null } as PerfilParaQualificar;
    expect(avaliarQualificacaoDoPerfil(semNada).qualificado).toBe(true);
  });
});

describe("não discrimina idioma nem nome curto", () => {
  it.each([
    ["inglês", "Tax lawyer helping family businesses structure exports to Europe."],
    ["espanhol", "Abogada tributaria que ayuda a empresas familiares a exportar café hacia Europa."],
    ["alemão", "Steuerberaterin, ich begleite Familienunternehmen beim Export nach Europa."],
    ["russo", "Налоговый юрист, помогаю семейным компаниям выходить на рынок Европы."],
    ["árabe", "محامية ضرائب أساعد الشركات العائلية على التصدير إلى أوروبا"],
    ["hindi", "मैं कर वकील हूँ और पारिवारिक कंपनियों को यूरोप में निर्यात करने में मदद करती हूँ"],
    ["chinês", "我是一名税务律师，帮助家族企业向欧洲出口。"],
    ["japonês", "家族経営の企業の輸出を支援する税理士です。"],
  ])("apresentação em %s qualifica", (_idioma, bio) => {
    expect(textoComConteudo(bio, MINIMO_DE_PALAVRAS_NA_APRESENTACAO)).toBe(true);
    const r = avaliarQualificacaoDoPerfil(com({ bio }));
    expect(r.qualificado).toBe(true);
    // A contagem devolvida é a mesma que qualificou: nunca abaixo do mínimo num perfil qualificado.
    expect(r.detalhes.apresentacao.contadas).toBeGreaterThanOrEqual(MINIMO_DE_PALAVRAS_NA_APRESENTACAO);
  });

  it("nome e cidade curtos valem ('Li', 'Yu', 'Ur'); nome de teste ou letra repetida, não", () => {
    expect(rotuloComConteudo("Li")).toBe(true);
    expect(rotuloComConteudo("Sei Tanaka")).toBe(true);
    expect(rotuloComConteudo("Yu Wang")).toBe(true);
    expect(rotuloComConteudo("王芳")).toBe(true);
    expect(rotuloComConteudo("São Paulo")).toBe(true);
    expect(rotuloComConteudo("Teste")).toBe(false);
    expect(rotuloComConteudo("xx")).toBe(false);
    expect(rotuloComConteudo("A")).toBe(false);
    expect(avaliarQualificacaoDoPerfil(com({ displayName: "asdf", city: "zz" })).pendencias).toEqual(["nome", "cidade"]);
  });
});

describe("U3: a lista das conexões sugeridas se libera no nível Prata", () => {
  it("Prata, Ouro, presidente e admin veem a lista; a Bronze, não", () => {
    for (const nivel of ["silver", "gold", "president", "admin"]) expect(veAsConexoesSugeridas(nivel), nivel).toBe(true);
    expect(veAsConexoesSugeridas("bronze")).toBe(false);
  });

  it("lista fechada: nível ausente ou desconhecido não vê a lista", () => {
    for (const nivel of [undefined, null, "", "user", "Silver", "distribuidor"]) expect(veAsConexoesSugeridas(nivel), String(nivel)).toBe(false);
  });
});
