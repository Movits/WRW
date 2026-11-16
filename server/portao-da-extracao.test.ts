import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O portão da extração da reunião, com a reunião sintética da bancada de texto
 * de 16/11 (inventada: nenhuma pessoa, empresa ou reunião real). Os achados 5
 * a 7 do relatório da bancada, que valem para qualquer modelo:
 *
 * 5. O "não" que restringe o item ("uma embalagem que não seja de plástico")
 *    derrubava o item nas 6 rodadas, e com a frase inteira de trecho levava
 *    junto o "distribuidor em São Paulo". O prompt dizia "pode resumir" e o
 *    portão exigia cada palavra do item no trecho: agora os dois dizem o
 *    mesmo — o item é feito com as palavras do trecho, e a restrição com
 *    "não" fica, sem trocar de lado.
 * 6. Cargo e empresa da IA não passavam por conferência e iam sozinhos para
 *    o contato no "Criar contato" ("fundadora", "Consultor"). Agora só ficam
 *    se a transcrição os diz como estão escritos (e viram pendência: ver
 *    network-extracao.test.ts e reuniao-reprocessar-rota.test.ts).
 * 7. A pessoa citada e ausente (a Sônia) virava um cartão igual ao das
 *    participantes. Agora a extração marca a presença e a linha a guarda.
 */

const invokeLLM = vi.hoisted(() => vi.fn());
vi.mock("./_core/llm", () => ({ invokeLLM }));

const { expressaoEstaNaFonte, pendenciasDaPessoaNaReuniao, REGRAS_DAS_TRES_DIMENSOES, textoSustentadoPeloTrecho, trechoEstaNaFonte } = await import("./network-extracao");
const {
  extractMeetingData, gravarResultadoDaReuniao, juntarExtracoes, JANELA_DA_EXTRACAO, REGRA_DOS_ROTULOS_NA_EXTRACAO, REGRAS_DA_PESSOA_NA_REUNIAO,
} = await import("./meeting-service");
const { meetingContactSuggestions, meetingTranscripts, networkSugestoes } = await import("../drizzle/schema");
type MeetingExtraction = import("./meeting-service").MeetingExtraction;

// As falas 0, 2 a 5, 39 a 42 e 71 do gabarito da bancada (o campo "n" de
// bancada-lite/gabarito.json), uma por linha, como a transcrição montada das
// partes (montarTranscricao).
const REUNIAO_SINTETICA = [
  "Boa noite, gente. Vamos começar? Hoje é quarta-feira, onze de novembro, e este é o encontro de mentoria do nosso núcleo. Eu sou a Renata Albuquerque, vou facilitar a conversa, e hoje estamos em três: a Camila, que já conhece todo mundo, e o Fernando, que veio como mentor convidado.",
  "Antes, como sempre, uma rodada rápida: cada um diz o que tem para oferecer e o que está procurando. Eu começo. Eu tenho a Tecelagem Aurora. A gente faz tecido de algodão orgânico aqui em Minas, com tingimento natural. O que eu tenho para oferecer: tecido em metro, saquinhos e bolsas sob encomenda, e uma rede muito boa de costureiras. O que eu procuro: clientes para encomendas de fim de ano e alguém que entenda de certificação orgânica para exportação.",
  "Bom, eu sou a Camila Duarte, da Cacau Tupinã. A gente faz chocolate artesanal com cacau do sul da Bahia, lá de Ilhéus. O que eu tenho: chocolate de origem, em barras e bombons, e agora um kit de presente para empresas. O que eu procuro: um distribuidor em São Paulo e uma embalagem que não seja de plástico, porque os meus clientes estão cobrando isso.",
  "Boa noite. Eu sou o Fernando Okada, da Ponte Sul Consultoria. Trabalho com finanças para pequenos negócios e com comércio exterior. O que eu ofereço: mentoria em preço, margem e fluxo de caixa, e contatos com importadoras de Portugal. O que eu procuro: negócios com produto pronto para crescer. E, sinceramente, um bom chocolate para os meus presentes de fim de ano.",
  "Então você já é o primeiro cliente do kit, Fernando.",
  "Isso, uma caixinha de acetato com fita de cetim. Fica bonita, mas é plástico, e eu já perdi uma venda por causa disso. Uma empresa de energia solar queria o kit, mas exigiu tudo sem plástico.",
  "Então, aqui tem duas possibilidades. A primeira é a Sônia Pacheco, da Embalagens Girassol. Ela faz caixa de papelão reciclado, muito bem acabada, com impressão em uma cor. Ela não pôde vir hoje, mas me pediu para falar dela.",
  "Eu não conheço a Sônia.",
  "Eu te apresento. Mando um e-mail apresentando vocês duas até sexta.",
  "O Empório Vila Serena é uma loja grande de produtos naturais, com duas unidades em São Paulo. O comprador provou o chocolate numa feira em Salvador e gostou muito. Ele quer começar com 60 caixas por mês e, se vender bem, aumentar.",
].join("\n");

const FRASE_DA_CAMILA = "O que eu procuro: um distribuidor em São Paulo e uma embalagem que não seja de plástico, porque os meus clientes estão cobrando isso.";
const RESTRICAO = "uma embalagem que não seja de plástico";

beforeEach(() => {
  invokeLLM.mockReset();
});

describe("achado 5 — o 'não' que restringe o item não o derruba, nem troca de lado", () => {
  // Os pares texto/trecho da bancada (X = Flash, Y = Lite; r = rodada) que o portão derrubava.
  it.each([
    ["X r1", "Distribuidor em São Paulo e embalagem sem plástico", FRASE_DA_CAMILA],
    ["X r2", "Distribuidor em São Paulo", "O que eu procuro: um distribuidor em São Paulo"],
    ["X r2", "Embalagem sem plástico", "uma embalagem que não seja de plástico, porque os meus clientes estão cobrando isso."],
    ["X r3", "Distribuidor em São Paulo", FRASE_DA_CAMILA],
    ["X r3", "Embalagem sem plástico", FRASE_DA_CAMILA],
    ["Y r1", "Distribuidor em São Paulo", "um distribuidor em São Paulo"],
    ["Y r1", "Embalagem que não seja de plástico", RESTRICAO],
    ["Y r2", "Embalagem que não seja de plástico", FRASE_DA_CAMILA],
  ])("%s: \"%s\" passa", (_rodada, texto, trecho) => {
    expect(trechoEstaNaFonte(trecho, REUNIAO_SINTETICA)).toBe(true);
    expect(textoSustentadoPeloTrecho(texto, trecho, REUNIAO_SINTETICA)).toBe(true);
  });

  it("a restrição pode sair do item, nunca trocar de lado: 'Embalagem de plástico' não passa", () => {
    expect(textoSustentadoPeloTrecho("Embalagem", RESTRICAO, REUNIAO_SINTETICA)).toBe(true);
    for (const trecho of [RESTRICAO, FRASE_DA_CAMILA]) {
      expect(textoSustentadoPeloTrecho("Embalagem de plástico", trecho, REUNIAO_SINTETICA)).toBe(false);
      expect(textoSustentadoPeloTrecho("Plástico", trecho, REUNIAO_SINTETICA)).toBe(false);
    }
    expect(textoSustentadoPeloTrecho("Distribuidor em São Paulo e embalagem de plástico", FRASE_DA_CAMILA, REUNIAO_SINTETICA)).toBe(false);
    // o "sem" do item precisa da negação do trecho, e sobre a palavra certa
    expect(textoSustentadoPeloTrecho("Embalagem sem papel", RESTRICAO, REUNIAO_SINTETICA)).toBe(false);
    expect(textoSustentadoPeloTrecho("Distribuidor sem São Paulo", FRASE_DA_CAMILA, REUNIAO_SINTETICA)).toBe(false);
    // o "sem pressa" está fora do trecho: não sustenta o "sem" do item
    expect(textoSustentadoPeloTrecho("Embalagem sem plástico", "uma embalagem de plástico", "Procuro uma embalagem de plástico, sem pressa.")).toBe(false);
    // o item afirma alguma coisa: só a negação não é item
    expect(textoSustentadoPeloTrecho("Sem plástico", RESTRICAO, REUNIAO_SINTETICA)).toBe(false);
    expect(textoSustentadoPeloTrecho("Embalagem sem", RESTRICAO, REUNIAO_SINTETICA)).toBe(false);
  });

  it("a negação que desmente a declaração segue derrubando o trecho", () => {
    // o verbo depois do "não" é a declaração de quem fala
    expect(trechoEstaNaFonte("um distribuidor que não temos", "Falta um distribuidor que não temos.")).toBe(false);
    expect(trechoEstaNaFonte("um fornecedor que nós não temos", "Falta um fornecedor que nós não temos.")).toBe(false);
    // antes do "que" não há nome, ou o "não" nem vem logo depois do "que"
    expect(trechoEstaNaFonte("a gente que não tem distribuidor", "A gente que não tem distribuidor sofre mais.")).toBe(false);
    expect(trechoEstaNaFonte("o que a gente não tem é distribuidor", "O que a gente não tem é distribuidor.")).toBe(false);
    // a fala do gabarito em que a Camila diz que não conhece a Sônia
    expect(trechoEstaNaFonte("não conheço a Sônia", REUNIAO_SINTETICA)).toBe(false);
    // negação logo antes do trecho, como sempre
    expect(trechoEstaNaFonte(RESTRICAO, "Não queremos uma embalagem que não seja de plástico.")).toBe(false);
  });

  it("'sem' e 'nem' dentro do trecho: a palavra que eles alcançam não vira item afirmativo", () => {
    const semDistribuidor = "Hoje estamos sem distribuidor no Chile.";
    // dentro do trecho o "sem" é qualidade: o trecho vale...
    expect(trechoEstaNaFonte("estamos sem distribuidor no Chile", semDistribuidor)).toBe(true);
    // ...mas o que ele nega não vira item que afirma, nem item só de negação
    expect(textoSustentadoPeloTrecho("Distribuidor no Chile", "estamos sem distribuidor no Chile", semDistribuidor)).toBe(false);
    expect(textoSustentadoPeloTrecho("Sem distribuidor no Chile", "estamos sem distribuidor no Chile", semDistribuidor)).toBe(false);
    expect(textoSustentadoPeloTrecho("Produtos sem glúten", "produtos sem glúten", "Vendemos produtos sem glúten.")).toBe(true);
    expect(textoSustentadoPeloTrecho("Produtos com glúten", "produtos sem glúten", "Vendemos produtos sem glúten.")).toBe(false);

    const tecido = "Procuro um tecido que não tenha poliéster nem elastano.";
    expect(trechoEstaNaFonte("um tecido que não tenha poliéster nem elastano", tecido)).toBe(true);
    expect(textoSustentadoPeloTrecho("Tecido sem poliéster nem elastano", "um tecido que não tenha poliéster nem elastano", tecido)).toBe(true);
    expect(textoSustentadoPeloTrecho("Tecido de elastano", "um tecido que não tenha poliéster nem elastano", tecido)).toBe(false);
    // "nem" sem restrição aberta continua desmentindo
    expect(trechoEstaNaFonte("nem distribuidor nem representante", "Não temos nem distribuidor nem representante.")).toBe(false);
  });

  it("o prompt pede o que o portão aceita: as palavras do trecho, um item por coisa, a restrição com 'não' ou 'sem'", () => {
    expect(REGRAS_DAS_TRES_DIMENSOES).toContain("Um item por coisa");
    expect(REGRAS_DAS_TRES_DIMENSOES).toContain("O texto do item é feito com as palavras do trecho");
    expect(REGRAS_DAS_TRES_DIMENSOES).toContain("Não troque palavra por sinônimo nem acrescente palavra que o trecho não tem");
    expect(REGRAS_DAS_TRES_DIMENSOES).toContain("\"Tecido que não tenha poliéster\" ou \"Tecido sem poliéster\"");
    expect(REGRAS_DAS_TRES_DIMENSOES).not.toContain("pode resumir");
    // os exemplos não são os da reunião da bancada: o modelo não recebe a prova pronta
    expect(REGRAS_DAS_TRES_DIMENSOES).not.toMatch(/plástico|São Paulo/);
  });

  it("palavra que o trecho não tem continua caindo, como o prompt agora diz (os resumos do Flash na bancada)", () => {
    const certificacao = "alguém que entenda de certificação orgânica para exportação";
    expect(textoSustentadoPeloTrecho("Especialista em certificação orgânica para exportação", certificacao, REUNIAO_SINTETICA)).toBe(false);
    expect(textoSustentadoPeloTrecho("Alguém que entenda de certificação orgânica para exportação", certificacao, REUNIAO_SINTETICA)).toBe(true);
    expect(textoSustentadoPeloTrecho("Certificação orgânica para exportação", certificacao, REUNIAO_SINTETICA)).toBe(true);
    const financas = "Trabalho com finanças para pequenos negócios e com comércio exterior.";
    expect(textoSustentadoPeloTrecho("Serviços de finanças para pequenos negócios e comércio exterior", financas, REUNIAO_SINTETICA)).toBe(false);
    expect(textoSustentadoPeloTrecho("Finanças para pequenos negócios e comércio exterior", financas, REUNIAO_SINTETICA)).toBe(true);
  });

  it("a Camila sai da reunião com os dois itens que procura (a extração do Lite na rodada 1)", () => {
    const linhas = pendenciasDaPessoaNaReuniao({
      tipoPessoa: "fisica", fullName: "Camila Duarte", company: "Cacau Tupinã",
      oQuePreciso: [
        { texto: "Distribuidor em São Paulo", categoria: null, trecho: "um distribuidor em São Paulo", confianca: 1 },
        { texto: "Embalagem que não seja de plástico", categoria: null, trecho: RESTRICAO, confianca: 1 },
      ],
    }, REUNIAO_SINTETICA);
    expect(linhas.filter(l => l.campo === "preciso").map(l => l.valor)).toEqual(["Distribuidor em São Paulo", "Embalagem que não seja de plástico"]);
  });
});

/**
 * Revisão da IA3 (16/11): três furos do portão novo, cada um com as frases
 * que o abriram. O "não" que desmente a necessidade não pode virar restrição,
 * o alcance da negação para no item seguinte, e a negação de antes do trecho
 * não é salva pela restrição de dentro dele.
 */
describe("revisão da IA3 — a necessidade negada não vira item", () => {
  it("verbo de opinião antes do 'que' não é nome: 'acho que não' desmente a necessidade", () => {
    const casos: Array<[fonte: string, trecho: string, texto: string]> = [
      ["E vocês precisam de distribuidor no Chile? Acho que não.", "precisam de distribuidor no Chile? Acho que não", "Distribuidor no Chile"],
      ["Investidor, por enquanto acho que não é prioridade.", "Investidor, por enquanto acho que não é prioridade", "Investidor"],
      ["Sobre investidor a gente acha que não precisa agora.", "Sobre investidor a gente acha que não precisa agora", "Investidor"],
      ["Um distribuidor no Chile eu sinto que não é o momento.", "Um distribuidor no Chile eu sinto que não é o momento", "Distribuidor no Chile"],
      // outros verbos e locuções do mesmo jeito
      ["Investidor eu sei que nunca vamos precisar.", "Investidor eu sei que nunca vamos precisar", "Investidor"],
      ["Investidor o pessoal acha que não é prioridade.", "Investidor o pessoal acha que não é prioridade", "Investidor"],
      ["Distribuidor no Chile tenho a impressão que não é necessário.", "Distribuidor no Chile tenho a impressão que não é necessário", "Distribuidor no Chile"],
      ["Investidor é um assunto que não está na pauta.", "Investidor é um assunto que não está na pauta", "Investidor"],
      ["An investor I think that not now.", "An investor I think that not now", "Investor"],
    ];
    for (const [fonte, trecho, texto] of casos) {
      expect(trechoEstaNaFonte(trecho, fonte), fonte).toBe(false);
      expect(textoSustentadoPeloTrecho(texto, trecho, fonte), fonte).toBe(false);
    }
    // o cenário inteiro, com as falas em linhas, como a transcrição montada: a pendência não nasce
    expect(pendenciasDaPessoaNaReuniao({
      oQuePreciso: [{ texto: "Distribuidor no Chile", categoria: null, trecho: "precisam de distribuidor no Chile? Acho que não", confianca: 1 }],
    }, "E vocês precisam de distribuidor no Chile?\nAcho que não.")).toEqual([]);
  });

  it("a restrição pede o artigo antes do nome, lido na fonte: o trecho pode começar no nome", () => {
    const fonte = "Procuro uma embalagem que não seja de plástico.";
    expect(textoSustentadoPeloTrecho("Embalagem que não seja de plástico", "embalagem que não seja de plástico", fonte)).toBe(true);
    expect(textoSustentadoPeloTrecho("Supplier that does not use plastic", "a supplier that does not use plastic", "We need a supplier that does not use plastic.")).toBe(true);
    // sem artigo na fonte, o "não" desmente: o item cai, do lado conservador
    expect(trechoEstaNaFonte("embalagem que não seja de plástico", "Procuro embalagem que não seja de plástico.")).toBe(false);
  });

  it("o alcance do 'sem' e do 'que não' para no 'e um…'; o do 'sem', também na preposição do complemento", () => {
    const semPrimeiro = "O que eu procuro: uma embalagem sem plástico e um distribuidor em São Paulo.";
    const restricaoPrimeiro = "O que eu procuro: uma embalagem que não seja de plástico e um distribuidor em São Paulo.";
    for (const fonte of [semPrimeiro, restricaoPrimeiro]) {
      // a frase inteira de trecho, como o Lite (r2) e o Flash (r1, r3) citaram na bancada, e o trecho curto
      expect(textoSustentadoPeloTrecho("Distribuidor em São Paulo", fonte, fonte), fonte).toBe(true);
      expect(textoSustentadoPeloTrecho("Distribuidor em São Paulo", "um distribuidor em São Paulo", fonte), fonte).toBe(true);
      expect(textoSustentadoPeloTrecho("Embalagem sem plástico", fonte, fonte), fonte).toBe(true);
      expect(textoSustentadoPeloTrecho("Embalagem de plástico", fonte, fonte), fonte).toBe(false);
    }
    const hoteis = "Vendemos produtos sem glúten para hotéis.";
    expect(textoSustentadoPeloTrecho("Produtos para hotéis", hoteis, hoteis)).toBe(true);
    expect(textoSustentadoPeloTrecho("Venda de produtos para hotéis", hoteis, hoteis)).toBe(true);
    expect(textoSustentadoPeloTrecho("Produtos com glúten para hotéis", hoteis, hoteis)).toBe(false);
    const brasil = "Distribuímos produtos sem glúten em todo o Brasil.";
    expect(textoSustentadoPeloTrecho("Distribuição de produtos no Brasil", brasil, brasil)).toBe(true);
    // "de" não fecha o "sem"
    expect(textoSustentadoPeloTrecho("Chocolate com açúcar", "chocolate sem adição de açúcar", "Fazemos chocolate sem adição de açúcar.")).toBe(false);
    // duas restrições em seguida: a primeira não alcança a segunda
    const duas = "Quero uma embalagem que não seja de plástico e uma caixa que não seja de isopor.";
    expect(textoSustentadoPeloTrecho("Caixa que não seja de isopor", "uma caixa que não seja de isopor", duas)).toBe(true);
    // o "não" que nega a frase segue até o fim da oração: normalizado, "é um" seria "e um"
    expect(trechoEstaNaFonte("um distribuidor no Chile", "O que não temos é um distribuidor no Chile.")).toBe(false);
  });

  it("o complemento do 'sem' sozinho não é item: 'Chile', de 'estamos sem distribuidor no Chile'", () => {
    const chile = "Hoje estamos sem distribuidor no Chile e na Argentina.";
    expect(textoSustentadoPeloTrecho("Chile", "estamos sem distribuidor no Chile", chile)).toBe(false);
    expect(textoSustentadoPeloTrecho("Chile e Argentina", "Chile e na Argentina", chile)).toBe(false);
    expect(textoSustentadoPeloTrecho("Distribuidor no Chile", "estamos sem distribuidor no Chile", chile)).toBe(false);
    expect(textoSustentadoPeloTrecho("Hotéis", "Vendemos produtos sem glúten para hotéis", "Vendemos produtos sem glúten para hotéis.")).toBe(false);
  });

  it("a negação de antes do trecho, mesmo longe dele, não é salva pela restrição de dentro", () => {
    expect(pendenciasDaPessoaNaReuniao({
      oQuePreciso: [
        { texto: "Investidor que não entenda do setor", categoria: null, trecho: "investidor que não entenda do setor", confianca: 1 },
        { texto: "Investidor", categoria: null, trecho: "investidor que não entenda do setor", confianca: 1 },
      ],
    }, "Não precisamos de um investidor que não entenda do setor.")).toEqual([]);
    expect(trechoEstaNaFonte("um investidor que não entenda do setor", "Não precisamos agora de um investidor que não entenda do setor.")).toBe(false);
    expect(textoSustentadoPeloTrecho("Sócio", "um sócio que não entenda do setor", "Não temos um distribuidor e um sócio que não entenda do setor.")).toBe(false);
    // sem a negação de fora, a mesma restrição vale
    const precisamos = "Precisamos de um investidor que não entenda só de finanças.";
    expect(textoSustentadoPeloTrecho("Investidor que não entenda só de finanças", "um investidor que não entenda só de finanças", precisamos)).toBe(true);
    expect(textoSustentadoPeloTrecho("Investidor", "um investidor que não entenda só de finanças", precisamos)).toBe(true);
  });
});

/**
 * Revisão do pacote P2B: a janela de 5 palavras em volta do trecho afirmava a
 * palavra que o PRÓPRIO trecho nega, quando ela aparecia na frase vizinha
 * ("Temos um distribuidor em São Paulo." logo antes de "Estamos sem
 * distribuidor no Chile"), e o item invertido passava — inclusive no
 * completar por texto e por voz, que usam o mesmo portão.
 */
describe("revisão do pacote P2B — a frase vizinha não troca o lado da negação", () => {
  it.each([
    ["vizinha antes", "Distribuidor no Chile", "Estamos sem distribuidor no Chile", "Temos um distribuidor em São Paulo. Estamos sem distribuidor no Chile."],
    ["vizinha antes, item curto", "Distribuidor", "Estamos sem distribuidor no Chile", "Temos um distribuidor em São Paulo. Estamos sem distribuidor no Chile."],
    ["vizinha depois", "Distribuidor no Chile", "Estamos sem distribuidor no Chile", "Estamos sem distribuidor no Chile. O distribuidor de Lima atende."],
    ["mesma oração", "Distribuidor no Chile", "estamos sem distribuidor no Chile", "Temos distribuidor em São Paulo mas estamos sem distribuidor no Chile."],
    ["restrição, vizinha antes", "Embalagem de plástico", RESTRICAO, "Hoje usamos embalagem de plástico. Procuro uma embalagem que não seja de plástico."],
    ["restrição, vizinha depois", "Embalagem de plástico", RESTRICAO, "Procuro uma embalagem que não seja de plástico. A de plástico sai."],
    ["restrição, mesma oração", "Embalagem de plástico", RESTRICAO, "Usamos plástico mas procuro uma embalagem que não seja de plástico."],
    ["'nem', vizinha depois", "Tecido de elastano", "um tecido que não tenha poliéster nem elastano", "Procuro um tecido que não tenha poliéster nem elastano. O elastano estraga."],
    ["'sem', vizinha depois", "Produtos com glúten", "produtos sem glúten", "Vendemos produtos sem glúten. O glúten faz mal."],
    // o trecho que cobre as duas frases tem o "distribuidor" afirmado, mas o
    // "Chile" é complemento do "sem" que negou o distribuidor
    ["trecho com as duas frases", "Distribuidor no Chile", "Temos um distribuidor em São Paulo. Estamos sem distribuidor no Chile", "Temos um distribuidor em São Paulo. Estamos sem distribuidor no Chile."],
    ["trecho com a oração inteira", "Distribuidor no Chile", "Temos distribuidor em São Paulo mas estamos sem distribuidor no Chile", "Temos distribuidor em São Paulo mas estamos sem distribuidor no Chile."],
    // o "sem" fica antes do trecho, e o trecho é só o complemento dele
    ["trecho só com o complemento", "Distribuidor na Argentina", "no Chile e na Argentina", "Estamos sem distribuidor no Chile e na Argentina."],
  ])("%s: '%s' não passa", (_caso, item, trecho, fonte) => {
    expect(trechoEstaNaFonte(trecho, fonte)).toBe(true);
    expect(textoSustentadoPeloTrecho(item, trecho, fonte)).toBe(false);
  });

  it("o que a fonte afirma continua passando, e a janela segue sustentando a palavra que o trecho não tem", () => {
    const duas = "Temos um distribuidor em São Paulo. Estamos sem distribuidor no Chile.";
    expect(textoSustentadoPeloTrecho("Distribuidor em São Paulo", "Temos um distribuidor em São Paulo", duas)).toBe(true);
    expect(textoSustentadoPeloTrecho("Distribuidor em São Paulo", "Temos um distribuidor em São Paulo. Estamos sem distribuidor no Chile", duas)).toBe(true);
    expect(textoSustentadoPeloTrecho("Embalagem que não seja de plástico", RESTRICAO, "Hoje usamos embalagem de plástico. Procuro uma embalagem que não seja de plástico.")).toBe(true);
    // "em todo o Brasil" vem logo depois do trecho: a palavra que ele não tem se lê na janela
    expect(textoSustentadoPeloTrecho("Distribuição de medicamentos no Brasil", "distribuição de medicamentos", "A gente atua na distribuição de medicamentos em todo o Brasil.")).toBe(true);
    // o "nem" continua o "sem": o complemento não afirma nenhuma das duas palavras negadas
    const cadeia = "Procuro caixas sem plástico nem isopor para presentes.";
    expect(textoSustentadoPeloTrecho("Caixas para presentes", cadeia, cadeia)).toBe(true);
    expect(textoSustentadoPeloTrecho("Caixas sem plástico nem isopor para presentes", cadeia, cadeia)).toBe(true);
    expect(textoSustentadoPeloTrecho("Isopor para presentes", cadeia, cadeia)).toBe(false);
    expect(textoSustentadoPeloTrecho("Plástico para presentes", cadeia, cadeia)).toBe(false);
    // o mesmo complemento dito fora do "sem" vale: a primeira frase afirma o distribuidor no Chile
    const contraditoria = "Temos distribuidor no Chile. Estamos sem distribuidor no Chile.";
    expect(textoSustentadoPeloTrecho("Distribuidor no Chile", contraditoria, contraditoria)).toBe(true);
  });

  it("o roteiro do teste manual, ponta a ponta, por pendenciasDaPessoaNaReuniao: o antigo e o novo", () => {
    const item = (texto: string, trecho: string) => ({ texto, categoria: null, trecho, confianca: 1 });
    const antigo = [
      "Eu sou a Ana, diretora comercial da Vinícola Serra Alta.",
      "Eu preciso de uma embalagem que não seja de plástico e um distribuidor em São Paulo.",
      "Estamos sem distribuidor no Chile.",
      "Acho que não precisamos de investidor.",
    ].join("\n");
    expect(pendenciasDaPessoaNaReuniao({
      oQuePreciso: [
        item("Embalagem que não seja de plástico", RESTRICAO),
        item("Distribuidor em São Paulo", "um distribuidor em São Paulo"),
        item("Distribuidor no Chile", "Estamos sem distribuidor no Chile"),
        item("Distribuidor", "Estamos sem distribuidor no Chile"),
        item("Embalagem de plástico", RESTRICAO),
        item("Investidor", "Acho que não precisamos de investidor"),
      ],
    }, antigo).map(p => p.valor)).toEqual(["Embalagem que não seja de plástico", "Distribuidor em São Paulo"]);

    // o roteiro novo, com frases que não estão no prompt nem na reunião da bancada
    const novo = [
      "Oi, aqui é o Rui Fontes, gerente de compras da Laticínios Boa Vista.",
      "A gente procura um fornecedor que não use conservante e um transportador refrigerado para o Paraná.",
      "Temos armazém em Londrina. Estamos sem armazém em Curitiba.",
      "Acho que não precisamos de sócio agora.",
    ].join("\n");
    const pendencias = pendenciasDaPessoaNaReuniao({
      oQueTenho: [item("Armazém em Londrina", "Temos armazém em Londrina")],
      oQuePreciso: [
        item("Fornecedor sem conservante", "um fornecedor que não use conservante"),
        item("Transportador refrigerado para o Paraná", "um transportador refrigerado para o Paraná"),
        item("Fornecedor que use conservante", "um fornecedor que não use conservante"),
        item("Armazém em Curitiba", "Estamos sem armazém em Curitiba"),
        item("Armazém", "Estamos sem armazém em Curitiba"),
        item("Sócio", "Acho que não precisamos de sócio agora"),
      ],
    }, novo);
    expect(pendencias.map(p => [p.campo, p.valor])).toEqual([
      ["tenho", "Armazém em Londrina"],
      ["preciso", "Fornecedor sem conservante"],
      ["preciso", "Transportador refrigerado para o Paraná"],
    ]);
  });
});

describe("achado 6 — cargo e empresa só como a transcrição diz", () => {
  it("o que a reunião disse fica; o cargo deduzido cai", () => {
    for (const dito of ["mentor convidado", "Mentor convidado", "Ponte Sul Consultoria", "Cacau Tupinã", "CACAU TUPINA", "Tecelagem Aurora", "Embalagens Girassol"]) {
      expect(expressaoEstaNaFonte(dito, REUNIAO_SINTETICA)).toBe(true);
    }
    // "facilitadora" é paráfrase de "vou facilitar"; "Consultor" é pedaço de "Consultoria"
    for (const naoDito of ["fundadora", "Consultor", "Facilitadora", "Consultoria Okada", "Diretora comercial", "", "   ", "60", null, undefined]) {
      expect(expressaoEstaNaFonte(naoDito, REUNIAO_SINTETICA)).toBe(false);
    }
  });

  it("negação na mesma oração derruba aquela ocorrência; outra ocorrência sem negação vale", () => {
    expect(expressaoEstaNaFonte("diretora", "Eu não sou mais a diretora da cooperativa.")).toBe(false);
    expect(expressaoEstaNaFonte("diretora", "Eu não sou mais a diretora. Hoje a diretora é a Ana.")).toBe(true);
    expect(expressaoEstaNaFonte("Farmabras", "Não, eu sou da Farmabras.")).toBe(true);
  });
});

describe("achado 7 — participou ou só foi citada", () => {
  it("o schema pedido ao modelo traz a presença, obrigatória, e o prompt explica cada valor", async () => {
    invokeLLM.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ entities: [], contacts: [] }) } }] });
    await extractMeetingData(REUNIAO_SINTETICA);
    const [{ messages, response_format }] = invokeLLM.mock.calls[0];
    const pessoa = response_format.json_schema.schema.properties.contacts.items;
    // "unknown" é a dúvida (revisão do pacote P2B): a linha a grava sem marca
    expect(pessoa.properties.presence).toEqual({ type: "string", enum: ["present", "mentioned", "unknown"] });
    expect(pessoa.required).toContain("presence");
    expect(messages[0].content).toContain(REGRAS_DA_PESSOA_NA_REUNIAO);
    // sem rótulos de voz no texto, o prompt não fala deles
    expect(messages[0].content).not.toContain(REGRA_DOS_ROTULOS_NA_EXTRACAO);
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).toContain("\"mentioned\": SÓ quando a reunião diz que ela não está ali");
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).toContain("Na dúvida, \"unknown\"");
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).not.toContain("Na dúvida, \"mentioned\"");
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).toContain("Não deduza cargo");
    // os exemplos não são as pessoas da reunião da bancada nem as frases do roteiro do teste manual
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).not.toMatch(/Sônia|Camila|Fernando|Renata|Girassol|não pôde vir|Rui|Marcos|Patrícia|Joana|Laticínios/);
  });

  it("na junção das janelas, quem participou em alguma janela participou", () => {
    const pessoa = (fullName: string, presence?: "present" | "mentioned") => ({
      fullName, jobTitle: null, company: null, phone: null, email: null, confidence: 0.9, tipoPessoa: "fisica" as const, oQueTenho: [], oQuePreciso: [], presence,
    });
    const r = juntarExtracoes([
      { entities: [], contacts: [pessoa("Sônia Pacheco", "mentioned"), pessoa("Bia Lima", "mentioned"), pessoa("Caio Reis")] },
      { entities: [], contacts: [pessoa("Sônia Pacheco", "present"), pessoa("Bia Lima", "mentioned"), pessoa("Caio Reis", "mentioned")] },
    ]);
    expect(Object.fromEntries(r.contacts.map(c => [c.fullName, c.presence]))).toEqual({ "Sônia Pacheco": "present", "Bia Lima": "mentioned", "Caio Reis": "mentioned" });
  });
});

/**
 * Revisão do pacote P2B: a presença era decidida janela a janela, sem o
 * rótulo de quem fala e com "na dúvida, 'mentioned'". Na reunião longa, a
 * janela 2 não vê o "Eu sou a Ana Ribeiro" da janela 1, devolve "Ana" como
 * citada, e a tela punha quem participou em "Pessoas citadas", com o selo
 * "Não participou".
 */
describe("revisão do pacote P2B — a ausência só com o que foi dito", () => {
  const pessoa = (fullName: string, presence?: "present" | "mentioned" | "unknown", extra: Record<string, unknown> = {}) => ({
    fullName, jobTitle: null, company: null, phone: null, email: null, confidence: 0.9, tipoPessoa: "fisica" as const, oQueTenho: [], oQuePreciso: [], presence, ...extra,
  });
  const resposta = (contacts: unknown[], entities: unknown[] = []) => ({ choices: [{ message: { content: JSON.stringify({ entities, contacts }) } }] });

  it("junção: a citada com o primeiro nome de quem participou em outra janela fica sem a marca, e as duas não se fundem", () => {
    const r = juntarExtracoes([
      { entities: [], contacts: [pessoa("Ana Ribeiro", "present")] },
      { entities: [], contacts: [pessoa("Ana", "mentioned")] },
    ]);
    expect(r.contacts.map(c => [c.fullName, c.presence])).toEqual([["Ana Ribeiro", "present"], ["Ana", "unknown"]]);
  });

  it("junção: a ausência dita de OUTRA pessoa continua (outro sobrenome); a dita numa janela vale mais que a dúvida de outra", () => {
    const r = juntarExtracoes([
      { entities: [], contacts: [pessoa("Ana Ribeiro", "present"), pessoa("Otávio Lins", "unknown")] },
      { entities: [], contacts: [pessoa("Ana Souza", "mentioned"), pessoa("Otávio Lins", "mentioned")] },
    ]);
    expect(Object.fromEntries(r.contacts.map(c => [c.fullName, c.presence]))).toEqual({ "Ana Ribeiro": "present", "Ana Souza": "mentioned", "Otávio Lins": "mentioned" });
  });

  it("uma janela só: a mesma regra vale para a resposta do modelo", async () => {
    invokeLLM.mockResolvedValueOnce(resposta([pessoa("Ana Ribeiro", "present"), pessoa("Ana", "mentioned"), pessoa("Marcos Teles", "mentioned")]));
    const r = await extractMeetingData("Eu sou a Ana Ribeiro. O Marcos Teles está de férias. A Ana manda a planilha.");
    expect(r.contacts.map(c => [c.fullName, c.presence])).toEqual([["Ana Ribeiro", "present"], ["Ana", "unknown"], ["Marcos Teles", "mentioned"]]);
  });

  it("'unknown' vai ao banco sem marca: a tela mostra a pessoa com as participantes", async () => {
    const ficha = 1_700_000_000_010;
    const inseridos: Array<Record<string, unknown>> = [];
    const resolvido = () => Promise.resolve([{ affectedRows: 1 }]);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "processing", updatedAt: ficha }] }) }) }),
      insert: (tabela: unknown) => ({
        values: (valores: unknown) => {
          if (tabela === meetingContactSuggestions) inseridos.push(...(valores as Array<Record<string, unknown>>));
          return Object.assign(resolvido(), { onDuplicateKeyUpdate: resolvido });
        },
      }),
      update: () => ({ set: () => ({ where: resolvido }) }),
      delete: () => ({ where: resolvido }),
    };
    await gravarResultadoDaReuniao(db as never, {
      meetingId: "reuniao-9", ownerId: "dona-1", ficha, limparAntes: false, durationSeconds: 60,
      transcription: { text: "A Paula fica com o contrato. Fechado.", segments: [], language: "pt-BR" },
      extraction: { entities: [], contacts: [pessoa("Paula", "unknown")] } as never,
    });
    expect(inseridos).toEqual([expect.objectContaining({ fullName: "Paula", presence: null })]);
  });

  it("com a transcrição rotulada, o prompt explica os rótulos; o rótulo sai do trecho, e a entidade que é só rótulo não entra", async () => {
    const rotulada = [
      "{F1}: Bom dia. Paula, você fica com o contrato?",
      "{F2}: Fico, sim. A gente precisa de um transportador refrigerado para o Paraná.",
    ].join("\n");
    invokeLLM.mockResolvedValueOnce(resposta(
      [pessoa("Paula", "present", { oQuePreciso: [{ texto: "Transportador refrigerado para o Paraná", trecho: "{F2}: A gente precisa de um transportador refrigerado para o Paraná", confianca: 0.9 }] })],
      [{ type: "person", value: "{F2}", normalizedValue: null, confidence: 0.5 }, { type: "person", value: "Falante 1", normalizedValue: null, confidence: 0.5 }, { type: "person", value: "Paula", normalizedValue: null, confidence: 0.9 }],
    ));
    const r = await extractMeetingData(rotulada, { rotulada: true });
    const [{ messages }] = invokeLLM.mock.calls[0];
    expect(messages[0].content).toContain(REGRA_DOS_ROTULOS_NA_EXTRACAO);
    expect(messages[1].content).toContain("{F2}: Fico, sim.");
    expect(r.entities.map(e => e.value)).toEqual(["Paula"]);
    expect(r.contacts[0].oQuePreciso).toEqual([expect.objectContaining({ trecho: "A gente precisa de um transportador refrigerado para o Paraná" })]);
    // e o item, com o trecho limpo, passa pelo portão contra a transcrição sem rótulos
    const semRotulos = "Bom dia. Paula, você fica com o contrato?\nFico, sim. A gente precisa de um transportador refrigerado para o Paraná.";
    expect(pendenciasDaPessoaNaReuniao(r.contacts[0], semRotulos).filter(p => p.campo === "preciso").map(p => p.valor)).toEqual(["Transportador refrigerado para o Paraná"]);
  });

  // A reunião longa em duas janelas: o cargo deduzido na janela 1 ("Consultor")
  // tomava o lugar do dito na janela 2 e caía depois, sem deixar nenhum.
  it("cargo e empresa conferidos na própria janela: fica o primeiro DITO, e a empresa mais completa", async () => {
    const enchimento = (n: number, de: number) => Array.from({ length: n }, (_, i) => `Fala ${de + i} da reunião longa, sem corte.`).join("\n");
    const transcricao = `Boa noite, eu sou o Fernando Okada, da Ponte Sul Consultoria.\n${enchimento(800, 0)}\nNa Ponte Sul Consultoria, eu vim aqui hoje como mentor convidado.`;
    // a apresentação cai na janela 1, e o "mentor convidado", só na 2
    expect(transcricao.indexOf("mentor convidado")).toBeGreaterThan(JANELA_DA_EXTRACAO);
    invokeLLM
      .mockResolvedValueOnce(resposta([pessoa("Fernando Okada", "present", { jobTitle: "Consultor", company: "Ponte Sul" })]))
      .mockResolvedValueOnce(resposta([pessoa("Fernando Okada", "present", { jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" })]));
    const r = await extractMeetingData(transcricao);
    expect(invokeLLM).toHaveBeenCalledTimes(2);
    expect(r.contacts).toEqual([expect.objectContaining({ fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" })]);
  });
});

describe("gravarResultadoDaReuniao — o que vai ao banco com a extração da bancada", () => {
  // Um banco que só captura (molde da bancada): a releitura acha a reunião desta execução.
  function bancoQueCaptura(ficha: number) {
    const inseridos: Array<{ tabela: unknown; valores: unknown }> = [];
    const resposta = () => Promise.resolve([{ affectedRows: 1 }]);
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "processing", updatedAt: ficha }] }) }) }),
      insert: (tabela: unknown) => ({
        values: (valores: unknown) => {
          inseridos.push({ tabela, valores });
          return Object.assign(resposta(), { onDuplicateKeyUpdate: resposta });
        },
      }),
      update: () => ({ set: () => ({ where: resposta }) }),
      delete: () => ({ where: resposta }),
    };
    const de = (tabela: unknown) => inseridos.filter(i => i.tabela === tabela).flatMap(i => (Array.isArray(i.valores) ? i.valores : [i.valores])) as Array<Record<string, unknown>>;
    return { db, de };
  }

  const item = (texto: string, trecho: string) => ({ texto, trecho, confianca: 1 });
  const pessoa = (dados: Partial<MeetingExtraction["contacts"][number]> & { fullName: string }): MeetingExtraction["contacts"][number] => ({
    jobTitle: null, company: null, phone: null, email: null, confidence: 1, tipoPessoa: "fisica", oQueTenho: [], oQuePreciso: [], presence: "present", ...dados,
  });

  it("cargo deduzido sai, empresa dita fica, a citada sai marcada e a Camila leva os dois itens", async () => {
    const ficha = 1_700_000_000_000;
    const { db, de } = bancoQueCaptura(ficha);
    const extraction: MeetingExtraction = {
      entities: [],
      contacts: [
        // cargos e empresas como o Lite (r1) e o Flash (r2) devolveram
        pessoa({ fullName: "Renata Albuquerque", jobTitle: "facilitadora", company: "Tecelagem Aurora" }),
        pessoa({
          fullName: "Camila Duarte", jobTitle: "fundadora", company: "Cacau Tupinã",
          oQuePreciso: [item("Distribuidor em São Paulo", FRASE_DA_CAMILA), item("Embalagem sem plástico", FRASE_DA_CAMILA)],
        }),
        pessoa({ fullName: "Fernando Okada", jobTitle: "Consultor", company: "Ponte Sul Consultoria" }),
        pessoa({
          fullName: "Sônia Pacheco", company: "Embalagens Girassol", presence: "mentioned",
          oQueTenho: [item("Caixa de papelão reciclado", "Ela faz caixa de papelão reciclado")],
        }),
        // presença fora do enum (o modelo nem sempre obedece): fica sem marca
        pessoa({ fullName: "Empório Vila Serena", tipoPessoa: "juridica", presence: "talvez" as never }),
      ],
    };
    await gravarResultadoDaReuniao(db as never, {
      meetingId: "reuniao-1", ownerId: "dona-1", ficha, limparAntes: false, durationSeconds: 1232,
      transcription: { text: REUNIAO_SINTETICA, segments: [], language: "pt-BR" }, extraction,
    });

    expect(de(meetingTranscripts)).toHaveLength(1);
    const sugestoes = Object.fromEntries(de(meetingContactSuggestions).map(s => [s.fullName, s]));
    expect(sugestoes["Renata Albuquerque"]).toMatchObject({ jobTitle: null, company: "Tecelagem Aurora", presence: "present", status: "pending" });
    expect(sugestoes["Camila Duarte"]).toMatchObject({ jobTitle: null, company: "Cacau Tupinã", presence: "present" });
    expect(sugestoes["Fernando Okada"]).toMatchObject({ jobTitle: null, company: "Ponte Sul Consultoria", presence: "present" });
    expect(sugestoes["Sônia Pacheco"]).toMatchObject({ company: "Embalagens Girassol", presence: "mentioned" });
    expect(sugestoes["Empório Vila Serena"]).toMatchObject({ presence: null });

    const pendencias = de(networkSugestoes);
    const daCamila = pendencias.filter(p => p.meetingSuggestionId === sugestoes["Camila Duarte"].id);
    expect(daCamila.filter(p => p.campo === "preciso").map(p => p.valor)).toEqual(["Distribuidor em São Paulo", "Embalagem sem plástico"]);
    // nada entra sozinho: pendência sem contato, à espera da dona
    expect(daCamila.every(p => p.status === "pendente" && p.contactId === null)).toBe(true);
    // a citada também leva o que tem, como sugestão
    expect(pendencias.filter(p => p.meetingSuggestionId === sugestoes["Sônia Pacheco"].id).map(p => p.valor)).toContain("Caixa de papelão reciclado");
  });

  it("o cargo dito fica: 'mentor convidado' (Lite, r1)", async () => {
    const ficha = 1_700_000_000_001;
    const { db, de } = bancoQueCaptura(ficha);
    await gravarResultadoDaReuniao(db as never, {
      meetingId: "reuniao-2", ownerId: "dona-1", ficha, limparAntes: false, durationSeconds: 60,
      transcription: { text: REUNIAO_SINTETICA, segments: [], language: "pt-BR" },
      extraction: { entities: [], contacts: [pessoa({ fullName: "Fernando Okada", jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" })] },
    });
    expect(de(meetingContactSuggestions)[0]).toMatchObject({ jobTitle: "mentor convidado", company: "Ponte Sul Consultoria" });
  });

  it("resposta antiga, sem a presença: a sugestão entra sem marca, como antes", async () => {
    const ficha = 1_700_000_000_002;
    const { db, de } = bancoQueCaptura(ficha);
    const { presence: _semPresenca, ...antiga } = pessoa({ fullName: "Renata Albuquerque" });
    await gravarResultadoDaReuniao(db as never, {
      meetingId: "reuniao-3", ownerId: "dona-1", ficha, limparAntes: false, durationSeconds: 60,
      transcription: { text: REUNIAO_SINTETICA, segments: [], language: "pt-BR" },
      extraction: { entities: [], contacts: [antiga] },
    });
    expect(de(meetingContactSuggestions)[0]).toMatchObject({ fullName: "Renata Albuquerque", presence: null });
  });
});
