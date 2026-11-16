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
const { extractMeetingData, gravarResultadoDaReuniao, juntarExtracoes, REGRAS_DA_PESSOA_NA_REUNIAO } = await import("./meeting-service");
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
    expect(pessoa.properties.presence).toEqual({ type: "string", enum: ["present", "mentioned"] });
    expect(pessoa.required).toContain("presence");
    expect(messages[0].content).toContain(REGRAS_DA_PESSOA_NA_REUNIAO);
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).toContain("\"mentioned\" quando alguém só fala dela e ela não está na reunião");
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).toContain("Não deduza cargo");
    // os exemplos não são as pessoas da reunião da bancada
    expect(REGRAS_DA_PESSOA_NA_REUNIAO).not.toMatch(/Sônia|Camila|Fernando|Renata|Girassol/);
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
