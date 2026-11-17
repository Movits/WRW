import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * N5 — a reunião vira conexões e refina o perfil. As regras puras:
 *
 * 1. "Poderíamos precisar de contador" não é necessidade declarada: o portão
 *    da extração derruba o "preciso" hipotético (o declarado fica).
 * 2. O que confirmar muda no perfil: o "tenho" entra uma vez (o slug não se
 *    repete) e o 51º é recusado; o "preciso" vira demanda, marca a categoria
 *    e chega ao motor de perfis como necessidade escrita; os tetos recusam.
 * 3. Quando a tela pergunta "É você?" (o mesmo e-mail ou o mesmo nome).
 *
 * O caminho com banco (Sou eu, confirmar, a conexão que nasce, as exclusões)
 * está em server/reuniao-no-match.integracao.test.ts.
 */

const { filtrarPelaFonte, necessidadeHipotetica, ValorInvalido } = await import("./network-extracao");
const { MENSAGEM_CATEGORIA_CHEIA, MENSAGEM_DEMANDAS_CHEIAS, MENSAGEM_O_QUE_TENHO_CHEIO, mudancaNoPerfil } = await import("./reuniao-no-match");
const { necessidadesEscritasDoPerfil } = await import("./portao-da-demanda-expressa");
const { LIMITE_DO_QUE_TENHO, mesmoNome, pareceSerADona, CATEGORIAS_DO_PRECISO_DA_REUNIAO } = await import("@shared/reuniao-no-match");
const { LIMITE_DE_DEMANDAS, LIMITE_DE_DEMANDAS_POR_CATEGORIA } = await import("@shared/o-que-preciso");

const preciso = (texto: string, trecho: string) => ({ texto, trecho, confianca: 0.9 });
const proposta = (oQuePreciso: ReturnType<typeof preciso>[], oQueTenho: ReturnType<typeof preciso>[] = []) => ({
  quemSou: { tipoPessoa: "nao_informado" as const, nome: null, telefone: null, email: null }, oQueTenho, oQuePreciso,
});

describe("o portão: necessidade hipotética não é necessidade declarada", () => {
  it("'a gente poderia precisar de contador' não vira 'preciso'; a necessidade declarada na mesma fala fica", () => {
    const fonte = "Eu sou a Ana. A gente poderia precisar de contador no ano que vem. Hoje precisamos de um distribuidor no Chile.";
    const filtrada = filtrarPelaFonte(proposta([
      preciso("Contador", "poderia precisar de contador"),
      preciso("Contador", "contador no ano que vem"),
      preciso("Distribuidor no Chile", "precisamos de um distribuidor no Chile"),
    ]), fonte);
    expect(filtrada.oQuePreciso.map(item => item.texto)).toEqual(["Distribuidor no Chile"]);
  });

  it.each([
    ["Contador", "poderíamos precisar de contador", "Nós poderíamos precisar de contador."],
    ["Contador", "talvez a gente precise de um contador", "Talvez a gente precise de um contador para a filial."],
    ["Contador", "podemos vir a precisar de contador", "Podemos vir a precisar de contador."],
    ["Accountant", "we might need an accountant", "We might need an accountant next year."],
    ["Contador", "quizás necesitemos un contador", "Quizás necesitemos un contador."],
    // Revisão da N5: as formas comuns que passavam como declaradas.
    ["Contador", "pode ser que a gente precise de um contador", "Pode ser que a gente precise de um contador no ano que vem."],
    ["Contador", "é possível que precisemos de um contador", "É possível que precisemos de um contador."],
    ["Contador", "quem sabe a gente precise de um contador", "Quem sabe a gente precise de um contador."],
    ["Contador", "talvez seja necessário um contador", "Talvez seja necessário um contador."],
    ["Contador", "se a gente precisar de contador", "Se a gente precisar de contador, a gente liga."],
    ["Advogado tributarista", "caso precisemos de um advogado tributarista", "Caso precisemos de um advogado tributarista, ligamos."],
    ["Accountant", "if we need an accountant", "If we need an accountant, we will call you."],
    ["Contador", "precisamos de um distribuidor e talvez de um contador", "Precisamos de um distribuidor e talvez de um contador."],
  ])("'%s' de '%s' é hipotética", (texto, trecho, fonte) => {
    expect(necessidadeHipotetica(texto, trecho, fonte)).toBe(true);
  });

  it.each([
    ["Contador", "precisamos de um contador", "Hoje precisamos de um contador."],
    // O mês de maio não é modal: "may" fica fora da lista.
    ["Distributor in Chile", "we need a distributor", "In May we need a distributor in Chile."],
    // O pedido educado sem verbo de necessidade não é tocado.
    ["Investidor", "me apresentar um investidor", "Você poderia me apresentar um investidor?"],
    // "Poderia" de outra oração não alcança o verbo.
    ["Distribuidor", "precisamos de um distribuidor", "Isso poderia ser melhor. Precisamos de um distribuidor."],
    // "Eventualmente" com o verbo no presente é "de vez em quando": necessidade declarada (revisão da N5).
    ["Frete refrigerado", "precisamos de frete refrigerado", "Eventualmente precisamos de frete refrigerado."],
    ["Tradutor para as feiras", "precisamos de um tradutor para as feiras", "Eventualmente precisamos de um tradutor para as feiras."],
    // O "se" e o "caso" só com o verbo que eles regem no subjuntivo; "necessário" sem modal declara.
    ["Vendedor", "o que se precisa é um vendedor", "O que se precisa é um vendedor."],
    ["Contador", "se necesita un contador", "Se necesita un contador."],
    ["Advogado", "nesse caso precisamos de um advogado", "Nesse caso precisamos de um advogado."],
    ["Contador", "é necessário um contador", "É necessário um contador."],
    ["Contador", "quem sabe do assunto diz que precisamos de um contador", "Quem sabe do assunto diz que precisamos de um contador."],
    // O "talvez" depois do item não o alcança.
    ["Contador", "precisamos de um contador que talvez ajude na filial", "Precisamos de um contador que talvez ajude na filial."],
  ])("'%s' de '%s' é declarada", (texto, trecho, fonte) => {
    expect(necessidadeHipotetica(texto, trecho, fonte)).toBe(false);
  });

  // Revisão da N5: o modal tem de reger o verbo do próprio item. O trecho com as duas necessidades derrubava a declarada.
  it.each([
    ["Eu preciso de um distribuidor no Chile, e talvez a gente precise de um contador.", "Eu preciso de um distribuidor no Chile, e talvez a gente precise de um contador."],
    ["Eu sou a Ana. Precisamos de um distribuidor no Chile e talvez a gente precise de um contador no ano que vem.", "Precisamos de um distribuidor no Chile e talvez a gente precise de um contador"],
    ["Talvez a gente precise de contador, mas precisamos mesmo de um distribuidor no Chile.", "Talvez a gente precise de contador, mas precisamos mesmo de um distribuidor no Chile"],
    ["a gente precisa de um distribuidor no Chile, isso é urgente, e talvez a gente precise de um contador lá também", "a gente precisa de um distribuidor no Chile, isso é urgente, e talvez a gente precise de um contador lá também"],
    ["Precisamos de um distribuidor no Chile porque talvez a gente precise expandir.", "precisamos de um distribuidor no Chile porque talvez a gente precise expandir"],
  ])("o verbo hipotético de outra necessidade não derruba a declarada: '%s'", (fonte, trecho) => {
    expect(necessidadeHipotetica("Distribuidor no Chile", trecho, fonte)).toBe(false);
    expect(filtrarPelaFonte(proposta([preciso("Distribuidor no Chile", trecho)]), fonte).oQuePreciso.map(item => item.texto)).toEqual(["Distribuidor no Chile"]);
  });

  it("no mesmo trecho longo, a necessidade que o modal rege cai, também a coordenada ('de um contador e de um advogado')", () => {
    const fonte = "Eu sou a Ana. Precisamos de um distribuidor no Chile e talvez a gente precise de um contador no ano que vem.";
    const trecho = "Precisamos de um distribuidor no Chile e talvez a gente precise de um contador";
    const filtrada = filtrarPelaFonte(proposta([preciso("Distribuidor no Chile", trecho), preciso("Contador", trecho)]), fonte);
    expect(filtrada.oQuePreciso.map(item => item.texto)).toEqual(["Distribuidor no Chile"]);
    expect(necessidadeHipotetica("Advogado", "talvez a gente precise de um contador e de um advogado", "Talvez a gente precise de um contador e de um advogado.")).toBe(true);
  });

  it("a fonte que também DECLARA a necessidade a sustenta: só a ocorrência hipotética não basta para derrubar", () => {
    expect(necessidadeHipotetica("Contador", "de contador", "Talvez a gente precise de contador. Pensando bem, precisamos de contador já.")).toBe(false);
    // Buscar também declara.
    expect(necessidadeHipotetica("Distribuidor no Chile", "distribuidor no Chile", "Buscamos um distribuidor no Chile. Talvez a gente precise de um distribuidor no Chile também.")).toBe(false);
  });

  // Revisão da N5: a menção sem verbo de necessidade não declara nada, e a hipotética que reaparece segue hipotética.
  it.each([
    ["Distribuidor no Chile", "distribuidor no Chile", "Talvez a gente precise de um distribuidor no Chile. Conheci um distribuidor no Chile ano passado."],
    ["Contador tributarista", "contador tributarista", "A gente poderia precisar de um contador tributarista no ano que vem. O contador tributarista da Ana é ótimo."],
    // Outra pessoa da reunião OFERECE o mesmo: é o par que viraria conexão.
    ["Distribuidor no Chile", "distribuidor no Chile", "Carla: Talvez a gente precise de um distribuidor no Chile. Bruno: Eu tenho um distribuidor no Chile."],
    // A ocorrência negada não conta, nem a necessidade negada.
    ["Distribuidor no Chile", "distribuidor no Chile", "Talvez a gente precise de um distribuidor no Chile. Não conheço nenhum distribuidor no Chile."],
    ["Contador", "um contador", "Talvez a gente precise de um contador. Não precisamos ainda de um contador."],
    // Buscar com modal também é oferta ("podemos buscar"): não declara.
    ["Distribuidor no Chile", "distribuidor no Chile", "Talvez a gente precise de um distribuidor no Chile. Podemos buscar um distribuidor no Chile."],
  ])("'%s' que reaparece sem declaração segue hipotética: '%s'", (texto, trecho, fonte) => {
    expect(necessidadeHipotetica(texto, trecho, fonte)).toBe(true);
    expect(filtrarPelaFonte(proposta([preciso(texto, trecho)]), fonte).oQuePreciso).toEqual([]);
  });

  it("a menção neutra sozinha não é tocada: o portão derruba a hipótese, não confere a declaração", () => {
    expect(necessidadeHipotetica("Distribuidor no Chile", "distribuidor no Chile", "Conheci um distribuidor no Chile ano passado.")).toBe(false);
    expect(necessidadeHipotetica("Distribuidor", "podemos buscar um distribuidor para vocês", "Podemos buscar um distribuidor para vocês.")).toBe(false);
  });

  it("vale só para O QUE PRECISO: o 'tenho' com 'poderia' segue as regras de sempre", () => {
    const fonte = "A gente poderia precisar de contador, e temos uma fábrica de chocolate.";
    const filtrada = filtrarPelaFonte(proposta([preciso("Contador", "poderia precisar de contador")], [preciso("Fábrica de chocolate", "temos uma fábrica de chocolate")]), fonte);
    expect(filtrada.oQuePreciso).toEqual([]);
    expect(filtrada.oQueTenho.map(item => item.texto)).toEqual(["Fábrica de chocolate"]);
  });
});

describe("o perfil como destino: o que confirmar muda", () => {
  const perfil = (dados: Partial<{ whatIHave: unknown; whatINeed: unknown; whatINeedDetails: unknown }> = {}) => ({
    whatIHave: [], whatINeed: [], whatINeedDetails: [], ...dados,
  });
  const demanda = (description: string, category: "outra_necessidade" | "distribuidores" = "outra_necessidade") =>
    ({ id: `d-${description}`, category, description });

  it("o 'tenho' entra no fim da lista, sem reescrever o resto; com o mesmo slug, nada muda", () => {
    const antes = perfil({ whatIHave: ["industria", "Exportação de café"] });
    expect(mudancaNoPerfil(antes, "tenho", "Torrefação de café", null)).toEqual({ whatIHave: ["industria", "Exportação de café", "Torrefação de café"] });
    expect(mudancaNoPerfil(antes, "tenho", "exportação  de CAFÉ", null)).toBeNull();
    // O id fixo "industria" e o texto "Indústria" são o mesmo slug.
    expect(mudancaNoPerfil(antes, "tenho", "Indústria", null)).toBeNull();
  });

  it(`o ${LIMITE_DO_QUE_TENHO + 1}º "tenho" é recusado`, () => {
    const cheio = perfil({ whatIHave: Array.from({ length: LIMITE_DO_QUE_TENHO }, (_, i) => `Item ${i + 1}`) });
    expect(() => mudancaNoPerfil(cheio, "tenho", "Mais um item", null)).toThrow(ValorInvalido);
    expect(() => mudancaNoPerfil(cheio, "tenho", "Mais um item", null)).toThrow(MENSAGEM_O_QUE_TENHO_CHEIO);
    // O repetido não conta como item novo: nada muda, sem recusa.
    expect(mudancaNoPerfil(cheio, "tenho", "item 7", null)).toBeNull();
  });

  it("o 'preciso' vira demanda, marca a categoria e chega ao motor de perfis como necessidade escrita", () => {
    const antes = perfil({ whatINeed: ["distribuidores"], whatINeedDetails: [demanda("Distribuidor de vinho no Nordeste", "distribuidores")] });
    const nova = demanda("Contador para abrir filial em Portugal");
    const mudanca = mudancaNoPerfil(antes, "preciso", nova.description, nova);
    expect(mudanca).toEqual({
      whatINeed: ["distribuidores", "outra_necessidade"],
      whatINeedDetails: [demanda("Distribuidor de vinho no Nordeste", "distribuidores"), nova],
    });
    expect(necessidadesEscritasDoPerfil({ ...antes, ...mudanca })).toContain("Contador para abrir filial em Portugal");
    // A mesma descrição de novo: nada muda.
    expect(mudancaNoPerfil({ ...antes, ...mudanca }, "preciso", "contador para abrir FILIAL em Portugal", demanda("contador para abrir FILIAL em Portugal"))).toBeNull();
  });

  it("os tetos das demandas recusam: 50 no total e 10 por categoria", () => {
    const porCategoria = perfil({ whatINeed: ["outra_necessidade"], whatINeedDetails: Array.from({ length: LIMITE_DE_DEMANDAS_POR_CATEGORIA }, (_, i) => demanda(`Necessidade número ${i + 1}`)) });
    expect(() => mudancaNoPerfil(porCategoria, "preciso", "Mais uma necessidade", demanda("Mais uma necessidade"))).toThrow(MENSAGEM_CATEGORIA_CHEIA);
    const total = perfil({ whatINeedDetails: Array.from({ length: LIMITE_DE_DEMANDAS }, (_, i) => ({ id: `x${i}`, category: "lixo", description: `Antiga ${i}` })) });
    expect(() => mudancaNoPerfil(total, "preciso", "Mais uma necessidade", demanda("Mais uma necessidade"))).toThrow(MENSAGEM_DEMANDAS_CHEIAS);
  });

  it("a coluna gravada como texto (MariaDB antigo) é lida, e o valor que a leitura não entende fica como está", () => {
    const antes = perfil({ whatIHave: JSON.stringify(["Exportação de café", { estranho: true }]) });
    expect(mudancaNoPerfil(antes, "tenho", "Torrefação", null)).toEqual({ whatIHave: ["Exportação de café", { estranho: true }, "Torrefação"] });
  });

  it("Compradores fica fora das categorias do 'preciso' da reunião: lá a descrição conta o que a dona vende", () => {
    expect(CATEGORIAS_DO_PRECISO_DA_REUNIAO).not.toContain("compradores");
    expect(CATEGORIAS_DO_PRECISO_DA_REUNIAO).toContain("outra_necessidade");
  });
});

describe("'É você?' — quando a tela pergunta", () => {
  const conta = { nomes: ["Glenda Souza", null], email: "glenda@exemplo.com" };

  it.each([
    [{ fullName: "Glenda" }, true],
    [{ fullName: "glenda souza" }, true],
    // Acento e caixa não contam.
    [{ fullName: "GLÊNDA Souza" }, true],
    [{ fullName: "Maria Souza" }, false],
    [{ fullName: "Fulana", email: "GLENDA@exemplo.com" }, true],
    [{ fullName: "Fulana", email: "outra@exemplo.com" }, false],
  ])("%j → %s", (pessoa, esperado) => {
    expect(pareceSerADona(pessoa, conta)).toBe(esperado);
  });

  it("o mesmo nome: as palavras do mais curto no mais longo, com uma de 3 letras ou mais", () => {
    expect(mesmoNome("Ana Ribeiro", "Ana Paula Ribeiro")).toBe(true);
    expect(mesmoNome("Ana", "Mariana")).toBe(false);
    expect(mesmoNome("Li", "Li Wei")).toBe(false);
    expect(mesmoNome("", "Ana")).toBe(false);
  });
});
