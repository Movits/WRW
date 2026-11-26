import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Regra da demanda expressa no motor PRIVADO (contatos da mesma dona) —
 * pedido do Nicolas, 12/09/2026.
 *
 * "Advocacia tributária" registrada em "o que possui" casava por CATEGORIA com
 * qualquer necessidade de mesma categoria ("Distribuidor para a África", ambos
 * em "Serviços"): 60, acima do corte de 50, e virava sugestão. É o match
 * presumido que o pedido veta. Serviço agora só casa quando a necessidade o
 * NOMEIA — tag, objeto ou núcleo, que é o que já valia 100 — e a categoria em
 * comum deixa de ser evidência para esse tipo. Para os outros tipos nada muda.
 */
const { scoreMatch, slugifyMatchTag } = await import("./match-service");
const { nucleoDoTermo, nomeiamAMesmaCoisa, slugDoTermo } = await import("@shared/direcao-do-termo");
const { regraNaoLeOPar } = await import("@shared/tipo-da-oferta");

const item = (label: string, category: string | null = null) =>
  ({ slug: slugifyMatchTag(label), label, category });

describe("Serviço × necessidade presumida — os exemplos do pedido NÃO casam", () => {
  it("exemplo 2: serviços jurídicos tributários × indústria farmacêutica que procura distribuidor (mesma categoria)", () => {
    const r = scoreMatch(
      item("Serviços jurídicos especializados em Direito Tributário", "Serviços"),
      item("Distribuidor para expansão na África", "Serviços"),
    );
    expect(r.score).toBe(0);
    expect((r as { bloqueio?: string }).bloqueio).toBe("servico-sem-demanda-expressa");
  });

  it("exemplo 3: consultoria em internacionalização × empresa que procura investidor para a fábrica (mesma categoria)", () => {
    const r = scoreMatch(
      item("Consultoria em internacionalização de empresas", "Consultoria"),
      item("Investidor para ampliação da fábrica", "Consultoria"),
    );
    expect(r.score).toBe(0);
    expect((r as { bloqueio?: string }).bloqueio).toBe("servico-sem-demanda-expressa");
  });

  it("a categoria digitada como 'Serviços' basta para classificar: 'Direito tributário' [Serviços] × 'Compradores' [Serviços] não casa", () => {
    expect(scoreMatch(item("Direito tributário", "Serviços"), item("Compradores no exterior", "Serviços")).score).toBe(0);
  });
});

describe("Serviço × necessidade que o NOMEIA — casa em 100", () => {
  it("tag igual, objeto igual atrás de marcador fraco, e núcleo atravessando 'serviços de'", () => {
    expect(scoreMatch(item("Consultoria tributária"), item("Consultoria tributária")).score).toBe(100);
    expect(scoreMatch(item("Serviços jurídicos tributários"), item("Procura serviços jurídicos tributários")).score).toBe(100);
    expect(scoreMatch(item("Serviços de tradução"), item("Tradução")).score).toBe(100);
    expect(scoreMatch(item("Prestação de serviços de contabilidade"), item("Contabilidade")).score).toBe(100);
  });

  it("a necessidade genérica que nomeia a família do serviço é demanda expressa, e vale 60 — não 100", () => {
    // Valia 100 até 13/09, e era o terceiro defeito do relato sobre a #101:
    // "Consultoria" procurado dava 100 para consultoria tributária, de
    // marketing E de segurança do trabalho, empatado com quem tivesse pedido
    // exatamente aquilo. 100 é a nota de quem tem a MESMA coisa. O par
    // CONTINUA existindo, acima do corte de 50 — derrubar para 0 repetiria o
    // defeito que a regra da especialidade consertou.
    expect(scoreMatch(item("Consultoria jurídica", "Serviços"), item("Consultoria", "Serviços"))).toEqual({ score: 60, type: "category" });
    // Este valia 60 até 14/09 e passou a valer 100, junto com o conserto de
    // "Contabilidade" × "Contador" — é a MESMA regra, e a mudança é deliberada.
    // O defeito 3 era necessidade genérica contra oferta ESPECIALIZADA
    // ("Consultoria" pedido dando 100 para consultoria tributária, de marketing
    // e de segurança do trabalho, as três empatadas). Aqui os dois lados são
    // genéricos: uma empresa de consultoria diante de quem procura consultoria
    // não está a uma especialidade de distância — é o mesmo serviço. Manter 60
    // aqui exigiria um critério que separasse este par de "Contabilidade" ×
    // "Contador", e não existe: "empresa" e "procura" são estrutura.
    expect(scoreMatch(item("Empresa de consultoria"), item("Procura consultoria")).score).toBe(100);
    // Outra especialidade pedida é outra necessidade; outra família também.
    expect(scoreMatch(item("Consultoria jurídica"), item("Consultoria em marketing")).score).toBe(0);
    expect(scoreMatch(item("Consultoria jurídica", "Serviços"), item("Advocacia", "Serviços")).score).toBe(0);
    // A família junta as flexões: "Advogado" procurado × "Advocacia tributária" possuído.
    expect(scoreMatch(item("Advocacia tributária", "Jurídico"), item("Advogado", "Jurídico")).score).toBe(60);
    expect(scoreMatch(item("Serviços jurídicos tributários"), item("Advogada")).score).toBe(60);
  });

  it("atividade e profissional da MESMA família, sem mais nada, são a mesma coisa: 100", () => {
    // Achado na revisão de 14/09 da #124 (commit 9615971, portado para a leitura
    // da #127): com as duas especialidades vazias o par caía na regra da
    // família, valendo 60. Abaixo do EMAIL_THRESHOLD de 70 — o match existia e
    // a pessoa NÃO era avisada.
    //
    // Quem oferece "Contabilidade" e quem procura "Contador" não estão a uma
    // especialidade de distância: é o mesmo serviço dito de dois jeitos.
    for (const categoria of [undefined, "Serviços"]) {
      expect(scoreMatch(item("Contabilidade", categoria), item("Contador", categoria)), `Contabilidade × Contador [${categoria}]`)
        .toEqual({ score: 100, type: "exact" });
      expect(scoreMatch(item("Advocacia", categoria), item("Advogado", categoria)), `Advocacia × Advogado [${categoria}]`)
        .toEqual({ score: 100, type: "exact" });
    }

    // E o que separa esses de "Consultoria jurídica" NÃO é ter especialidade
    // escrita — é nomearem uma SEGUNDA coisa além da família (o objeto do
    // serviço). Se esta distinção se perder, o teste da família genérica acima
    // cai junto.
    expect(scoreMatch(item("Consultoria jurídica", "Serviços"), item("Consultoria", "Serviços")).score).toBe(60);
    expect(scoreMatch(item("Consultoria de marketing", "Serviços"), item("Consultoria", "Serviços")).score).toBe(60);
    // Dois serviços na oferta seguem na família.
    expect(scoreMatch(item("Tradução e interpretação"), item("Intérprete")).score).toBe(60);
    // "律师" valia 60 enquanto a oferta em chinês era lida por substring, sem saber a especialidade. Com a leitura pelo
    // fim do termo (9e027bf e e6ddfa4 da #127, portadas) ela é a advocacia sem especialidade, a regra de
    // "Contabilidade" × "Contador"; com a especialidade escrita ("税务咨询" × "咨询"), segue na família.
    expect(scoreMatch(item("律师"), item("Advogado")).score).toBe(100);
    expect(scoreMatch(item("税务咨询"), item("咨询")).score).toBe(60);
    // Com especialidade de um lado só, nada muda: a necessidade genérica vale 60, a especializada diante da oferta genérica, 0.
    expect(scoreMatch(item("Advocacia tributária"), item("Advogado")).score).toBe(60);
    expect(scoreMatch(item("Advocacia"), item("Advogado trabalhista")).score).toBe(0);
    // Cabeça neutra é estrutura, como "empresa" e "procura" no teste acima (76cd7da da #127, portada).
    expect(scoreMatch(item("Escritório de contabilidade"), item("Contador"))).toEqual({ score: 100, type: "exact" });
    // Na #127 "Contabilidade" × "Contábil" fica em 60 (a necessidade tem de nomear o serviço por substantivo). Na #135 o
    // adjetivo sozinho dos dois lados nomeia só a família e vale 100, como na main — ver "adjetivo sozinho e lugar dos DOIS
    // lados genéricos" abaixo. A diferença é deliberada e fica fixada nos dois lugares.
    expect(scoreMatch(item("Contabilidade"), item("Contábil")).score).toBe(100);
    // Mas o qualificador de quem presta, na necessidade, é algo além da família: 60, como na #127 (que lê a necessidade
    // ao pé da letra, 76cd7da e ff9564f). Com o critério "pedido genérico" estes valiam 100 e mandavam e-mail (revisão de
    // 15/09 do porte).
    for (const [oferta, necessidade] of [
      ["Contabilidade", "Contador sênior"], ["Contabilidade", "Contador urgente"], ["Contabilidade", "Contador de confiança"],
      ["Contabilidade", "Contador com CRC"], ["Contabilidade", "Bom contador"], ["Contabilidade", "Contador online"],
      ["Advocacia", "Advogado especializado"], ["Consultoria", "Consultoria especializada"], ["Accounting services", "Experienced accountant"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 60, type: "category" });
    }
    // Artigo e verbo de quem pede seguem estrutura.
    expect(scoreMatch(item("Contabilidade"), item("Precisamos de um contador"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Lawyer"), item("Looking for a lawyer"))).toEqual({ score: 100, type: "exact" });
  });

  it("do lado da OFERTA, público e lugar não são especialidade: 100 diante da necessidade que nomeia só o serviço (ff9564f, portada)", () => {
    // Revisão de 14/09 na #127: "Contabilidade para pequenas empresas" × "Contador" ficava em 60, abaixo do
    // EMAIL_THRESHOLD, e o mesmo em inglês e espanhol. "Contabilidade em São Paulo" × "Contador" valia 60 por um teste da
    // integração da 9615971 (76cd7da), e passa a 100 pela mesma regra.
    for (const [oferta, necessidade] of [
      ["Contabilidade para pequenas empresas", "Contador"], ["Contabilidade em São Paulo", "Contador"],
      ["Accounting services", "Accountant"], ["Despacho de abogados", "Abogado"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
    // O que diz algo a mais sobre O QUE se presta segue na nota da família: a especialidade (o conserto do defeito 3), o
    // público que é especialidade curada ("divórcio" é família) e o público que nomeia outro serviço.
    for (const [oferta, necessidade] of [
      ["Consultoria tributária", "Consultoria"], ["Advogado para divórcio", "Advogado"], ["Marketing para advogados", "Marketing"],
    ] as Array<[string, string]>) {
      for (const categoria of [null, "Serviços"]) {
        expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade} [${categoria}]`).toEqual({ score: 60, type: "category" });
      }
    }
  });

  it("o mesmo serviço com escritório, 'firm' ou adjetivo de estilo vale 100; o falso positivo provado segue fechado (ff9564f, portada)", () => {
    // Revisão de 14/09 na #127: a regra estrita da palavra desconhecida cortava estes pares. Só saem da especialidade a
    // cabeça neutra (inclusive colada depois do serviço, "law FIRM") e "estratégica" ao lado de especialidade reconhecida.
    for (const [oferta, necessidade] of [
      ["Escritório de advocacia", "Escritório de advogados"], ["Tax law firm", "Tax lawyer"],
      ["Advocacia tributária estratégica", "Advogado tributarista"], ["Boutique de advocacia tributária", "Advogado tributarista"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
    // Sozinha, "estratégica" é o assunto da consultoria, não a genérica.
    expect(scoreMatch(item("Consultoria estratégica"), item("Consultoria"))).toEqual({ score: 60, type: "category" });
    for (const [oferta, necessidade] of [
      ["Consultoria em segurança do trabalho", "Consultoria trabalhista"], ["Consultoria em seguros empresariais", "Consultoria empresarial"],
      ["Sell-side advisory", "Buy-side advisory"], ["Consultoria publicitária imobiliária", "Consultoria imobiliária"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços")).score, `${oferta} × ${necessidade}`).toBe(0);
    }
  });

  it("\"cobertura\" não é imóvel: reportagem não escapa do portão", () => {
    // Também da revisão de 14/09. "cobertura" tinha entrado em IMOVEL junto com
    // apartamento e casa; fora do mercado imobiliário ela é reportagem, seguro
    // ou telhado. Classificado como imóvel, o item SAI do portão da demanda
    // expressa e volta a casar por categoria — o vazamento que a #101 fecha.
    expect(scoreMatch(item("Cobertura jornalística", "Serviços"), item("Compradores", "Serviços")).score).toBe(0);
    // 46c79b8 da #127 (portada): "house" no fim do composto em inglês é a empresa, não o imóvel.
    expect(scoreMatch(item("Consulting house", "Consulting"), item("Buyers", "Consulting")).score).toBe(0);
  });

  it("mas a necessidade que nomeia a ESPECIALIDADE, e não só a família, segue valendo 100", () => {
    // A separação das duas notas é o conserto do defeito 3: pedir "Advogado"
    // é pedir a família; pedir "Advogado tributarista" é pedir este serviço.
    expect(scoreMatch(item("Advocacia tributária", "Jurídico"), item("Advogado tributarista", "Jurídico"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Consultoria tributária"), item("Consultor tributário")).score).toBe(100);
  });

  it("item coordenado ('Mina e consultoria mineral') fica com a mina e segue nos 60 por categoria", () => {
    expect(scoreMatch(item("Mina e consultoria mineral", "Mineração"), item("Britagem", "Mineração"))).toEqual({ score: 60, type: "category" });
  });

  it("exemplo 1 do pedido casa também no motor privado: assessoria numa área da profissão (mudou em 14/09)", () => {
    // Até 14/09 este teste dizia o contrário ("o motor privado não adivinha
    // paráfrase") e esperava 0. A spec da Glenda de 14/09 dá este par como
    // MATCH, e ele não é parecença de texto: quem pede ASSESSORIA TRIBUTÁRIA
    // pede um serviço que a advocacia tributária presta
    // (`AREAS_DAS_PROFISSOES` em shared/tipo-da-oferta.ts). Os casos detalhados
    // estão em demanda-expressa-exemplos-da-spec.test.ts.
    const r = scoreMatch(
      item("Serviços jurídicos especializados em Direito Tributário", "Jurídico"),
      item("Assessoria tributária para revisão da carga fiscal da empresa", "Jurídico"),
    );
    expect(r).toEqual({ score: 100, type: "exact" });
  });

  it("a similaridade (quando religada) é a compatibilidade semântica DEPOIS do portão", () => {
    // "Gestão de caixa" não declara assunto do vocabulário curado: só a similaridade decidiria.
    expect(scoreMatch(item("Consultoria tributária"), item("Gestão de caixa"), 0.71)).toEqual({ score: 45, type: "semantic" });
    // "Revisão de tributos" pede uma ação sobre o assunto do serviço: 60 pelo vocabulário, sem similaridade nenhuma.
    expect(scoreMatch(item("Consultoria tributária"), item("Revisão de tributos"))).toEqual({ score: 60, type: "semantic" });
  });
});

describe("Os outros tipos continuam casando por categoria", () => {
  it("investimento, mineração, produto: 60 pela categoria, como sempre", () => {
    expect(scoreMatch(item("Capital semente", "investimento"), item("Venture capital", "investimento"))).toEqual({ score: 60, type: "category" });
    expect(scoreMatch(item("Lavra", "Mineração"), item("Britagem", "mineracao"))).toEqual({ score: 60, type: "category" });
    expect(scoreMatch(item("Café especial", "Alimentos"), item("Fornecedor de cacau", "Alimentos"))).toEqual({ score: 60, type: "category" });
  });

  it("produto com palavra de serviço atrás de preposição segue nos 60 por categoria (não virou serviço)", () => {
    expect(scoreMatch(item("Peças de manutenção", "Produto"), item("Peças automotivas", "Produto"))).toEqual({ score: 60, type: "category" });
    expect(scoreMatch(item("Centro de treinamento", "Infraestrutura"), item("Galpão", "Infraestrutura"))).toEqual({ score: 60, type: "category" });
  });

  it("a necessidade pode ser serviço: quem TEM a categoria em comum é o ativo, não o pedido", () => {
    // O portão é sobre o que se OFERECE. Uma fábrica (ativo) diante de uma
    // necessidade de mesma categoria segue nos 60 de sempre.
    expect(scoreMatch(item("Fábrica de embalagens", "Indústria"), item("Consultoria industrial", "Indústria")).score).toBe(60);
  });

  it("sem categoria em comum, serviço ou não, é zero sem bloqueio nomeado para os outros tipos", () => {
    const r = scoreMatch(item("Lavra", "Mineração"), item("Frete", "Logística"));
    expect(r.score).toBe(0);
    expect((r as { bloqueio?: string }).bloqueio).toBeUndefined();
  });
});

describe("Núcleo do termo — o serviço nomeado pelo genitivo", () => {
  it("'serviços de X' e 'prestação de serviços de X' reduzem a X", () => {
    expect(nucleoDoTermo("Serviços de tradução")).toBe("traducao");
    expect(nucleoDoTermo("Prestação de serviços de contabilidade")).toBe("contabilidade");
    expect(nucleoDoTermo("Services of translation")).toBe("translation");
  });

  it("locativo e lugar continuam protegidos", () => {
    expect(nucleoDoTermo("Serviços para a China")).toBe("servicos-para-a-china");
    expect(nucleoDoTermo("Serviços da China")).toBe("servicos-da-china");
  });

  it("os casos antigos não mudam", () => {
    expect(nucleoDoTermo("Mina de terras raras")).toBe("terras-raras");
    expect(nucleoDoTermo("Sapatos de couro")).toBe("sapatos-de-couro");
    expect(nucleoDoTermo("Exportação para a China")).toBe("exportacao-para-a-china");
    expect(nucleoDoTermo("Terras raras")).toBe("terras-raras");
  });
});

describe("nomeiamAMesmaCoisa — a equivalência compartilhada com o motor de perfis", () => {
  it("mesmo objeto em direções opostas, marcador fraco e cabeça transparente", () => {
    expect(nomeiamAMesmaCoisa("Exportar vinho", "Importar vinho")).toBe(true);
    expect(nomeiamAMesmaCoisa("Terras raras", "Procura terras raras")).toBe(true);
    expect(nomeiamAMesmaCoisa("Mina de terras raras", "Fornecedor de terras raras")).toBe(true);
  });

  it("lugar não é mercadoria de quem declarou direção", () => {
    expect(nomeiamAMesmaCoisa("Importação da China", "Exportação da China")).toBe(false);
    expect(nomeiamAMesmaCoisa("China", "Procura China")).toBe(true);
  });

  it("coisas diferentes não casam", () => {
    expect(nomeiamAMesmaCoisa("Armazenagem refrigerada", "Terrenos com outorga")).toBe(false);
    expect(nomeiamAMesmaCoisa("Sapatos de couro", "Bolsa de couro")).toBe(false);
  });
});

describe("Fiação", () => {
  const fonte = (arquivo: string) => readFileSync(join(__dirname, arquivo), "utf8");

  it("slugifyMatchTag é o slugDoTermo compartilhado", () => {
    for (const tag of ["Mineração de Terras Raras", "Nº 5", "شراب", "Import/export"]) {
      expect(slugifyMatchTag(tag)).toBe(slugDoTermo(tag));
    }
    expect(slugifyMatchTag("Mineração de Terras Raras")).toBe("mineracao-de-terras-raras");
  });

  it("o chat de enriquecimento manda a IA não deduzir o que ninguém disse", () => {
    const prompt = fonte(join("routers", "enrichment.ts"));
    expect(prompt).toContain("NUNCA deduza o que a pessoa oferece ou procura");
  });

  it("os prompts de oportunidade deixaram de pedir 'necessidades implícitas' e carregam a regra", () => {
    const rotas = fonte(join("routers", "matching.ts"));
    expect(rotas).not.toContain("necessidades implícitas");
    expect(rotas.split("REGRA_DA_DEMANDA_EXPRESSA").length - 1).toBeGreaterThanOrEqual(3); // import + 2 prompts
    expect(rotas.split("passaNoPortao(").length - 1).toBe(2); // recomendação e alerta
  });

  it("o insight do Dashboard recebe o que cada perfil tem/precisa e a ordem de não presumir", () => {
    const motor = fonte("matching.ts");
    expect(motor).toContain("nunca presuma que alguém precisa de um serviço");
    // Desde a separação instrução × dados do insight (defesa contra injeção pelo
    // texto do perfil), os dois lados saem do mesmo molde, com a letra do perfil.
    expect(motor).toContain("O que ${letra} precisa:");
  });
});

/**
 * Defeito relatado em 13/09, depois de a #101 entrar em produção: a regra
 * passou a barrar pares em que a necessidade FOI declarada, só porque a
 * redação mudava. "Advocacia tributária" possuído × "Advogado tributarista"
 * procurado caía de 60 para 0 — e 0 não é só esconder: abaixo de
 * SAVE_THRESHOLD a linha não entra em `pares` e a limpeza de órfãos remove a
 * sugestão que havia. Quem escrevia a necessidade de forma MAIS específica
 * perdia o match; quem escrevia "Advogado" (genérico) continuava achando.
 */
describe("Serviço × necessidade declarada com outra flexão — casa (defeito da #101)", () => {
  it("a mesma família com a mesma especialidade casa em 100, escrita como for", () => {
    for (const [oferta, necessidade] of [
      ["Advocacia tributária", "Advogado tributarista"],
      ["Advocacia tributária", "Advogado de tributos"],
      ["Consultoria tributária", "Consultor tributário"],
      ["Advocacia trabalhista", "Advogado trabalhista"],
    ] as const) {
      const r = scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços"));
      expect(r.score, `${oferta} × ${necessidade}`).toBe(100);
      expect(r.type, `${oferta} × ${necessidade}`).toBe("exact");
    }
  });

  it("e o que a #101 veio barrar continua barrado: outra família, outra especialidade, e a categoria em comum", () => {
    for (const [oferta, necessidade] of [
      ["Advocacia tributária", "Distribuidor para a África"],
      ["Advocacia tributária", "Contador"],
      ["Consultoria tributária", "Consultoria de marketing"],
      ["Advocacia trabalhista", "Advogado tributarista"],
      ["Sell-side advisory", "Buy-side advisory"],
    ] as const) {
      expect(scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços")).score, `${oferta} × ${necessidade}`).toBe(0);
    }
  });
});

/**
 * Quarto ponto do mesmo relato de 13/09: a regra só existia em português,
 * inglês e espanhol. Nos outros 7 idiomas nada era classificado como serviço,
 * então o portão NUNCA disparava — a regra da cliente simplesmente não valia
 * para quem escreve neles, e um serviço casava por categoria como antes da #101.
 *
 * e6ddfa4 da #127 (itens 3 e 6 da revisão de 14/09, portada na #135): com a
 * categoria "Serviços" o par já dava 0 na main, porque a categoria sozinha
 * classifica o item como serviço — o teste não provava nada sobre o idioma. Com
 * a categoria escrita no idioma, na main o par valia 60. E o conserto não pode
 * ter levado a zero o que casava: o mesmo serviço nesses idiomas vale 100, e o
 * que as listas não leem vale a categoria, como na main (`regraNaoLeOPar`).
 */
describe("O portão dispara nos 10 idiomas (defeito da #101)", () => {
  it.each([
    ["pt", "Consultoria tributária", "Compradores", "Finanças"],
    ["en", "Tax consulting", "Buyers", "Finance"],
    ["es", "Asesoría fiscal", "Compradores", "Finanzas"],
    ["de", "Steuerberatung", "Maschinen", "Finanzen"],
    ["fr", "Conseil fiscal", "Machines", "Finances"],
    ["ru", "Налоговый консалтинг", "Покупатели", "Финансы"],
    ["hi", "कर परामर्श", "खरीदार", "वित्त"],
    ["ar", "استشارات ضريبية", "مشترون", "مالية"],
    ["zh", "税务咨询", "买家", "财务"],
    ["ja", "税務コンサルティング", "買い手", "財務"],
  ])("%s: serviço × necessidade presumida, com a categoria no idioma, não casa", (_idioma, oferta, necessidade, categoria) => {
    const r = scoreMatch(item(oferta, categoria), item(necessidade, categoria));
    expect(r.score).toBe(0);
    expect((r as { bloqueio?: string }).bloqueio).toBe("servico-sem-demanda-expressa");
    // A categoria "Serviços" de antes continua dando zero.
    expect(scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços")).score).toBe(0);
  });

  it.each([
    ["ru", "Налоговый консалтинг", "Налоговая консультация", "Финансы"],
    ["fr", "Avocat fiscaliste", "Avocat fiscal", "Finances"],
    ["fr", "Conseil fiscal", "Conseil en fiscalité", "Finances"],
    ["zh", "税务咨询", "税务顾问", "财务"],
    ["zh", "税务咨询", "税务咨询服务", "财务"],
    ["ja", "税務コンサルティング", "税務コンサル", "財務"],
    ["zh", "律师事务所", "律师", "财务"],
    ["de", "Steuerberatung", "Suche Steuerberater", "Finanzen"],
  ])("%s: o mesmo serviço escrito de outro jeito vale 100, com e sem categoria — %s × %s", (_idioma, oferta, necessidade, categoria) => {
    for (const cat of [categoria, null]) {
      expect(scoreMatch(item(oferta, cat), item(necessidade, cat)), `[${cat}]`).toEqual({ score: 100, type: "exact" });
    }
  });

  it("o que as listas não leem num idioma novo não é bloqueado: vale a categoria, como na main", () => {
    expect(scoreMatch(item("Steuerberatung für Erbschaften", "Finanzen"), item("Steuerberater für Erbschaftsteuer", "Finanzen"))).toEqual({ score: 60, type: "category" });
    // Como na #127. O assunto curado ("fiscalité" entrou no lema tributário com a e6ddfa4) NÃO decide antes da exceção:
    // se decidisse, o par valia 60 também sem categoria e virava sugestão, enquanto o mesmo par em português segue
    // barrado (revisão de 15/09 do porte).
    expect(scoreMatch(item("Conseil en fiscalité internationale", "Finances"), item("Conseil en fiscalité des entreprises", "Finances"))).toEqual({ score: 60, type: "category" });
    // Sem categoria em comum, zero sem o bloqueio nomeado — também como a main.
    for (const [oferta, necessidade] of [
      ["Steuerberatung für Erbschaften", "Steuerberater für Erbschaftsteuer"],
      ["Conseil en fiscalité", "Conseil en fiscalité des entreprises"], ["Conseil en fiscalité internationale", "Conseil en fiscalité des entreprises"],
      ["استشارات ضريبية دولية", "استشارات ضريبية للشركات"], ["Consultoria tributária internacional", "Conseil en fiscalité des entreprises"],
    ] as Array<[string, string]>) {
      const semCategoria = scoreMatch(item(oferta), item(necessidade));
      expect(semCategoria.score, `${oferta} × ${necessidade}`).toBe(0);
      expect((semCategoria as { bloqueio?: string }).bloqueio, `${oferta} × ${necessidade}`).toBeUndefined();
    }
    // O mesmo par em português segue barrado.
    expect(scoreMatch(item("Consultoria tributária"), item("Consultoria tributária de empresas"))).toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
  });

  it("'les' e 'une' são espanhol: a frase em espanhol segue estrita e barrada (revisão de 15/09 do porte)", () => {
    for (const [oferta, necessidade] of [
      ["Consultoria em comércio exterior", "Consultoría en recursos humanos que les ayude a contratar"],
      ["Consultoria em gestão", "Busco consultoría para pymes que les falta estructura"], ["Consultoria", "Consultor que une ventas y marketing"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta, "Consultoria"), item(necessidade, "Consultoria")), `${oferta} × ${necessidade}`)
        .toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    }
  });

  it("o 'D' de R&D, P&D e I+D não é o 'd'' do francês (revisão de 15/09 do porte da 9e027bf)", () => {
    expect(scoreMatch(item("Consultoria", "Consultoria"), item("Consultoría en I+D", "Consultoria"))).toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    expect(scoreMatch(item("Consultoria tributária"), item("Consultoría en I+D"))).toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    expect(scoreMatch(item("R&D services", "Technology"), item("Distributors in Africa", "Technology"))).toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    // O "d'" com apóstrofo, reto ou curvo, segue genitivo.
    expect(scoreMatch(item("Cabinet d’avocats"), item("Avocat"))).toEqual({ score: 100, type: "exact" });
  });

  it("serviço em chinês com a cidade entre parênteses, depois de ' - ' ou separada por espaço segue serviço (revisão de 15/09 do porte)", () => {
    expect(scoreMatch(item("税务咨询（上海）", "Tecnologia"), item("经销商", "Tecnologia"))).toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    expect(scoreMatch(item("律师事务所（北京）"), item("律师"))).toEqual({ score: 100, type: "exact" });
  });

  it("e o que o motor entende continua barrado: outra família, outra especialidade entendida, e o português segue estrito", () => {
    for (const [oferta, necessidade, categoria] of [
      ["Налоговый консалтинг", "Юрист", "Финансы"], ["Налоговый консалтинг", "Юридическая консультация", "Финансы"],
      ["税务咨询", "法律咨询", "财务"],
      ["Consultoria em segurança do trabalho", "Consultoria trabalhista", "Finanças"],
      // A palavra desconhecida do lado em português ("segurança") continua valendo contra o par, mesmo diante de francês.
      ["Consultoria em segurança do trabalho", "Conseil en droit du travail", "Services"],
    ] as Array<[string, string, string]>) {
      const r = scoreMatch(item(oferta, categoria), item(necessidade, categoria));
      expect(r.score, `${oferta} × ${necessidade}`).toBe(0);
      expect((r as { bloqueio?: string }).bloqueio, `${oferta} × ${necessidade}`).toBe("servico-sem-demanda-expressa");
    }
    // Na #127 "Consultoria em exportação" × "Consultoria em comércio exterior" [Serviços] é 0 com bloqueio: palavra
    // desconhecida em português. Na #135 "comércio exterior" é movimento para fora e "exportação" é internacionalização
    // no vocabulário curado de assunto (exemplo 4 da spec da Glenda): a necessidade declara o assunto do serviço, 60 com o
    // selo de significados parecidos. Não é a exceção dos idiomas novos, que segue sem valer em português.
    expect(scoreMatch(item("Consultoria em exportação", "Serviços"), item("Consultoria em comércio exterior", "Serviços"))).toEqual({ score: 60, type: "semantic" });
    expect(regraNaoLeOPar("Consultoria em exportação", "Serviços", "Consultoria em comércio exterior")).toBe(false);
  });
});

describe("A mesma coisa escrita de outro jeito casa em 100; serviço diferente não (defeitos a e c da #101, 13/09)", () => {
  it("(a) mesma família e mesma especialidade, com ou sem categoria: 'Advocacia tributária' × 'Advogado tributarista'", () => {
    const pares: Array<[string, string]> = [
      ["Advocacia tributária", "Advogado tributarista"],
      ["Advogado tributarista", "Advocacia tributária"],
      ["Contabilidade tributária", "Contador tributário"],
      ["Tradução jurídica", "Tradutor jurídico"],
      ["Advocacia previdenciária", "Advogado previdenciarista"],
      ["Tax lawyer", "Advogado tributarista"],
      ["Advocacia tributária", "Procuro advogado tributarista"],
      ["Advocacia tributária", "Contratar advogado tributarista"],
      ["Advocacia tributária em São Paulo", "Advogado tributarista"],
      ["Advocacia tributária e trabalhista", "Advogado trabalhista"],
      ["Consultoria jurídica tributária", "Consultoria tributária"],
    ];
    for (const [oferta, necessidade] of pares) {
      for (const categoria of [null, "Jurídico", "Serviços"]) {
        expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)).score, `${oferta} × ${necessidade} [${categoria}]`).toBe(100);
      }
    }
  });

  it("(c) outra especialidade, outro lema ou oferta genérica: zero com o bloqueio nomeado, com ou sem categoria", () => {
    const pares: Array<[string, string]> = [
      ["Consultoria jurídica", "Consultor de marketing"],
      ["Consultoria jurídica", "Assessoria em marketing"],
      ["Consultoria jurídica", "Assessoria"],
      ["Consultoria em marketing", "Advisory"],
      ["Assessoria de imprensa", "Consultoria"],
      ["Assistência jurídica", "Suporte"],
      ["Interpretação de exames laboratoriais", "Tradutor"],
      ["Consultoria em marketing para advogados", "Consultoria jurídica"],
      ["Consultoria para PMEs", "Consultoria jurídica para PMEs"],
      ["Mentoria para mulheres", "Mentoria financeira para mulheres"],
      ["Advocacia", "Advogado tributarista"],
      ["Advocacia tributária", "Advogado trabalhista"],
    ];
    for (const [oferta, necessidade] of pares) {
      for (const categoria of [null, "Serviços"]) {
        const r = scoreMatch(item(oferta, categoria), item(necessidade, categoria));
        expect(r.score, `${oferta} × ${necessidade} [${categoria}]`).toBe(0);
        expect((r as { bloqueio?: string }).bloqueio, `${oferta} × ${necessidade}`).toBe("servico-sem-demanda-expressa");
      }
    }
  });
});

describe("Serviço com adjetivo de outro tipo não escapa do portão (revisão de 13/09)", () => {
  it("'Consultoria financeira' e 'Consultoria logística' não casam pela categoria; com a necessidade nomeada, casam", () => {
    const r = scoreMatch(item("Consultoria financeira", "Consultoria"), item("Distribuidor para a África", "Consultoria"));
    expect(r.score).toBe(0);
    expect((r as { bloqueio?: string }).bloqueio).toBe("servico-sem-demanda-expressa");
    expect(scoreMatch(item("Consultoria logística", "Logística"), item("Frete marítimo", "Logística")).score).toBe(0);
    expect(scoreMatch(item("Consultoria financeira"), item("Consultor financeiro")).score).toBe(100);
  });
});

describe("Necessidade que coordena serviços diferentes casa com cada um (revisão de 13/09)", () => {
  it("'Advocacia tributária' e 'Contabilidade' × 'Advogado e contador' casam em 60, a nota da família (cada parte pedida só nomeia a família)", () => {
    for (const categoria of [null, "Serviços"]) {
      expect(scoreMatch(item("Advocacia tributária", categoria), item("Advogado e contador", categoria)).score, String(categoria)).toBe(60);
      expect(scoreMatch(item("Contabilidade", categoria), item("Advogado e contador", categoria)).score, String(categoria)).toBe(60);
    }
  });
});

describe("Correção dos defeitos da #101 por cima da #124 — motor privado (14/09)", () => {
  it("o que a regeneração apagaria volta: a especialidade escrita de outro jeito vale 100", () => {
    const pares: Array<[string, string]> = [
      ["Advocacia tributária", "Advogado tributarista em São Paulo"], ["Advocacia tributária", "Precisamos de advogado tributarista"],
      ["Advocacia tributária", "Advogada tributarista experiente"], ["Advocacia tributária", "Advogado especializado em direito tributário"],
      ["Advocacia tributária", "Advocacia jurídica tributária"], ["Tradução jurídica", "Tradutor jurídico"],
      ["Consultoria em planejamento financeiro", "Consultoria financeira"], ["Advocacia tributária e trabalhista", "Advogado trabalhista"],
    ];
    for (const [oferta, necessidade] of pares) {
      for (const categoria of [null, "Serviços"]) {
        expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade} [${categoria}]`).toEqual({ score: 100, type: "exact" });
      }
    }
  });

  it("a necessidade que nomeia só a família vale 60 e fica no banco: serviços coordenados, oferta especializada", () => {
    const pares: Array<[string, string]> = [
      ["Tradução e interpretação", "Intérprete"], ["Advocacia tributária", "Advogado e contador"], ["Advocacia tributária", "Jurídico"],
    ];
    for (const [oferta, necessidade] of pares) {
      for (const categoria of [null, "Serviços"]) {
        expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade} [${categoria}]`).toEqual({ score: 60, type: "category" });
      }
    }
  });

  it("adjetivo sozinho e lugar dos DOIS lados genéricos são o mesmo serviço: 100 (valiam 60 até o porte do 9615971)", () => {
    // Estes quatro estavam na lista de 60 acima. Os dois lados só nomeiam a
    // família — "Jurídico" é advocacia, "Contábil" é contabilidade, e o lugar
    // não é especialidade —, a mesma situação de "Contabilidade" × "Contador".
    const pares: Array<[string, string]> = [
      ["Advocacia", "Jurídico"], ["Jurídico", "Advogado"], ["Contabilidade", "Contábil"], ["Contabilidade", "Contador em Campinas/SP"],
    ];
    for (const [oferta, necessidade] of pares) {
      for (const categoria of [null, "Serviços"]) {
        expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade} [${categoria}]`).toEqual({ score: 100, type: "exact" });
      }
    }
  });

  it("serviço diferente escrito com 'para', idioma ou lema que colide fica em zero com o bloqueio", () => {
    for (const [oferta, necessidade] of [
      ["Advocacia tributária", "Advogado para divórcio"], ["Tradução de alemão", "Tradutor de japonês"],
      ["Consultoria em segurança do trabalho", "Consultoria trabalhista"], ["Consultoria digital", "Consultoria em direito digital"],
      ["Assessoria de imprensa", "Consultoria"], ["Interpretação de exames laboratoriais", "Tradutor"],
    ] as Array<[string, string]>) {
      const r = scoreMatch(item(oferta, "Serviços"), item(necessidade, "Serviços"));
      expect(r.score, `${oferta} × ${necessidade}`).toBe(0);
      expect((r as { bloqueio?: string }).bloqueio).toBe("servico-sem-demanda-expressa");
    }
  });
});

describe("'Direito tributário' sem categoria também passa pelo portão (14/09)", () => {
  it("casa em 100 com a necessidade que o nomeia", () => {
    expect(scoreMatch(item("Direito tributário"), item("Advogado tributarista"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Direito do trabalho"), item("Advocacia trabalhista"))).toEqual({ score: 100, type: "exact" });
  });
});


describe("Revisão adversarial da correção empilhada sobre a #124 — notas do motor privado (14/09)", () => {
  it("o mesmo serviço escrito de outro jeito vale 100; a necessidade que nomeia só a família, 60", () => {
    expect(scoreMatch(item("Tradutora-intérprete de Libras"), item("Intérprete de Libras"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Property lawyer"), item("Advogado imobiliário"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Advocacia tributária"), item("Assessoria jurídica tributária"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Advogada consultora"), item("Advogada"))).toEqual({ score: 60, type: "category" });
    // Valia 60 até a e6ddfa4 da #127 (portada): "律师" (advogado) e "Advogado" são o mesmo serviço sem mais nada dos
    // dois lados, a regra de "Contabilidade" × "Contador", agora lida também em chinês ("律师事务所" × "律师").
    expect(scoreMatch(item("律师"), item("Advogado"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Advocacia trabalhista"), item("Assessoria jurídica e tributária"))).toEqual({ score: 60, type: "category" });
  });

  it("serviço diferente fica abaixo do corte e a linha não é gravada", () => {
    for (const [oferta, necessidade] of [
      ["Consultoria trabalhista", "Consultoria para segurança do trabalho"], ["Traduction juridique", "Avocat"],
      ["Advocacia de família", "Advogado para pensão por morte"], ["Consultoria em gestão", "Consultoria em gestão pública"],
      ["Consultoria jurídica", "Consultoria de seleção"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)).score, `${oferta} × ${necessidade}`).toBeLessThan(50);
    }
  });
});

describe("scoreMatch — lacunas do classificador depois da #127: serviço que casava pela categoria (14/09)", () => {
  it("serviço que o classificador não lia casava em 60 pela categoria digitada; agora só com necessidade que o nomeie", () => {
    const presumidos: Array<[string, string, string, string]> = [
      ["Fisioterapia", "Saúde", "Distribuidor de equipamentos hospitalares", "Saúde"],
      ["Psicóloga", "Saúde", "Clínica à venda", "Saúde"],
      ["Projeto arquitetônico", "Imóveis", "Terreno", "Imóveis"],
      ["Comércio exterior", "Comex", "Compradores na China", "Comex"],
      ["Desenvolvimento de software", "Tecnologia", "Investidores", "Tecnologia"],
      // Logística é serviço desde 14/09 (decisão do Nicolas).
      ["Serviços de logística", "Logística", "Armazém em Santos", "Logística"],
      ["Transporte rodoviário", "Logística", "Frete", "Logística"],
    ];
    for (const [oferta, categoriaDaOferta, necessidade, categoriaDaNecessidade] of presumidos) {
      const r = scoreMatch(item(oferta, categoriaDaOferta), item(necessidade, categoriaDaNecessidade));
      expect(r.score, `${oferta} × ${necessidade}`).toBe(0);
      expect(r.bloqueio, `${oferta} × ${necessidade}`).toBe("servico-sem-demanda-expressa");
    }
  });

  it("a necessidade que nomeia a família do serviço novo passa a casar (era 0: o serviço não tinha família)", () => {
    // Atividade e profissional sem mais nada dos dois lados: o mesmo serviço, 100 (porte do 9615971, como "Contabilidade" × "Contador").
    expect(scoreMatch(item("Fisioterapia", "Saúde"), item("Fisioterapeuta")).score).toBe(100);
    expect(scoreMatch(item("Fisioterapia respiratória", "Saúde"), item("Fisioterapeuta")).score).toBe(60);
    expect(scoreMatch(item("Transporte rodoviário", "Logística"), item("Transportadora")).score).toBe(60);
  });

  it("o bem físico da logística continua casando pela categoria, como antes", () => {
    expect(scoreMatch(item("Galpão alfandegado", "Logística"), item("Armazém em Santos", "Logística"))).toEqual({ score: 60, type: "category" });
  });
});

/**
 * Revisão de 15/09 dos consertos da #127 (116bb56), portada para a leitura desta
 * branch. Ficam os achados que valem para este código: o adjetivo de serviço
 * junto de cabeça genérica ou neutra, o destinatário comum na oferta, a leitura
 * do complemento da cabeça neutra, e o abacate. Os pares dos idiomas novos que
 * dependiam da exceção do que as listas não leem (`regraNaoLeOPar`) e da leitura
 * do chinês pelo fim do termo estão em "O portão dispara nos 10 idiomas" e nos
 * testes da e6ddfa4, portada em 15/09.
 */
describe("Revisão de 15/09 dos consertos da #127 — motor privado", () => {
  it("o serviço nomeado pelo adjetivo junto de cabeça genérica ou neutra é o mesmo serviço: 100, nos dois sentidos", () => {
    for (const [oferta, necessidade] of [
      ["Serviços jurídicos", "Advogado"], ["Legal services", "Lawyer"], ["Servicios jurídicos", "Abogado"], ["Escritório jurídico", "Advogado"],
      ["Serviços contábeis", "Contador"], ["Escritório contábil", "Contador"], ["Servicios contables", "Contador"], ["Services juridiques", "Avocat"],
      ["Lawyer", "Legal services"], ["Contador", "Escritório contábil"],
      // "contable" e "comptable" na cabeça do termo são também o contador
      ["Contable", "Contador"], ["Contabilidad", "Contable"], ["Comptabilité", "Comptable"], ["Comptable", "Comptabilité"], ["Comptabilité", "Un comptable"],
    ] as Array<[string, string]>) {
      for (const categoria of [null, "Serviços"]) {
        expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade} [${categoria}]`).toEqual({ score: 100, type: "exact" });
      }
    }
    // A especialidade segue na nota da família.
    expect(scoreMatch(item("Serviços jurídicos tributários"), item("Advogada"))).toEqual({ score: 60, type: "category" });
    // Diferença desta branch para a #127: o adjetivo sozinho dos dois lados nomeia só a família, como na main
    // ("os dois lados só com a família", `mesmaFamiliaEEspecialidade`), e vale 100; na #127 ficava em 60.
    for (const [oferta, necessidade] of [["Contabilidade", "Contábil"], ["Jurídico", "Advogado"]] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
  });

  it("na oferta, o público comum é o destinatário; finalidade e setor depois de 'para' seguem na nota da família", () => {
    for (const [oferta, necessidade] of [
      ["Consultoria para exportação", "Consultoria"], ["Advogado para causas do trabalho", "Advogado"], ["Advogado para recuperação judicial", "Advogado"],
      ["Consultoria para o setor público", "Consultoria"], ["Marketing para restaurantes", "Marketing"], ["Consulting for exporters", "Consulting"],
      ["Consultoria para o agronegócio", "Consultoria"], ["Contabilidade para o agronegócio", "Contador"], ["Mentoria para fundadoras", "Mentoria"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 60, type: "category" });
    }
    for (const [oferta, necessidade] of [
      ["Contabilidade para pequenas empresas", "Contador"], ["Contabilidade para MEI", "Contador"], ["Accounting for small businesses", "Accountant"],
      ["Advocacia para empresas", "Advogado"], ["Contabilidad para pymes", "Contable"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
  });

  it("oferta genérica diante de finalidade ou outro público: a nota da família (decisão de 16/09)", () => {
    // Validação de 16/09 na #135: a oferta genérica diante da necessidade que diz PARA QUÊ caía para 0 e a
    // sugestão nem era gravada (corte de 50), enquanto na main valia 60 pela categoria em comum. Quem oferece a
    // família não provou a finalidade, mas atende quem pede aquela família: 60, abaixo do corte de e-mail.
    for (const [oferta, necessidade] of [
      ["Logística", "Preciso de logística para exportar meu café"], ["Marketing", "Marketing para restaurantes"],
      ["Advocacia", "Advogado para causas do trabalho"], ["Consultoria", "Consultoria para exportação"],
      ["Contabilidade", "Contabilidade para o agronegócio"], ["Contabilidade", "Contador para pequenas empresas do agronegócio"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 60, type: "category" });
    }
  });

  it("oferta genérica diante do DESTINATÁRIO comum: o mesmo serviço, 100, com qualquer preposição (D2 e D4 de 16/09)", () => {
    // Decisão do Roberto de 16/09: o público de DESTINATARIOS_COMUNS vale 100 dos dois lados. Na main, "Contador para
    // MEI" valia 60 e "Contador de MEI", "Contador MEI" e "Contador pra MEI" valiam 0 — a mesma necessidade
    // decidida pela preposição; o delta da validação pôs as cinco em 60. Agora as cinco mandam e-mail (corte de 70).
    for (const [oferta, necessidade] of [
      ["Contabilidade", "Contador para MEI"], ["Contabilidade", "Contador de MEI"], ["Contabilidade", "Contador MEI"],
      ["Contabilidade", "Contador pra MEI"], ["Contabilidade", "Contador para pequenas empresas"],
      ["Contabilidade", "Contador de pequenas empresas"], ["Advocacia", "Advogado de startups"], ["Advocacia", "Advogado para empresas"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
    // Do lado da oferta, a preposição também deixou de decidir: "Contabilidade DE MEI" é "Contabilidade PARA MEI".
    for (const oferta of ["Contabilidade para MEI", "Contabilidade de MEI", "Contabilidade MEI"]) {
      expect(scoreMatch(item(oferta), item("Contador")), oferta).toEqual({ score: 100, type: "exact" });
    }
    // O qualificador de quem presta continua sendo algo além da família, com ou sem destinatário.
    expect(scoreMatch(item("Contabilidade"), item("Preciso de um bom contador para MEI"))).toEqual({ score: 60, type: "category" });
    // "empresa" é destinatário na lista e também a especialidade curada "empresarial": sem "para", é o direito
    // empresarial, e a oferta genérica continua não atendendo — como na main (o delta dava 60).
    for (const necessidade of ["Advogado empresarial", "Advogado de empresas", "Preciso de advogado empresarial"]) {
      expect(scoreMatch(item("Advocacia"), item(necessidade)), necessidade)
        .toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    }
    expect(scoreMatch(item("Contabilidade empresarial"), item("Contador"))).toEqual({ score: 60, type: "category" });
    // Consultoria e assessoria só se atendem pela especialidade: a oferta genérica de uma não atende o destinatário
    // da outra (o delta dava 60 a "Consultoria" × "Assessoria de MEI"; com o 100 do destinatário, mandaria e-mail).
    expect(scoreMatch(item("Consultoria"), item("Assessoria de MEI")).score).toBe(0);
  });

  it("o pedido da família + complemento que as listas não conhecem: 60, salvo a contraparte (D1 de 16/09)", () => {
    // Decisão do Roberto de 16/09: quem declarou precisar da família com um complemento desconhecido é atendido
    // por quem oferece a família, com a nota do bom palpite. Na main os quatro davam 0.
    for (const [oferta, necessidade] of [
      ["Advocacia", "Preciso de advogado marítimo"], ["Contabilidade", "Procuro contador rural"],
      ["Consultoria", "Preciso de consultoria de moda"], ["Logística", "Preciso de logística de exportação para meu café"],
      ["Logística", "Procuramos logística de cabotagem"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 60, type: "category" });
    }
    // O complemento que nomeia CONTRAPARTE continua 0: serviço nenhum entrega o distribuidor, e é a mesma lista do
    // portão (PAPEIS_DE_COMERCIO e SOCIOS). O delta da validação dava 60 a todos estes.
    for (const [oferta, necessidade] of [
      ["Consultoria", "Preciso de consultoria de distribuidor"], ["Advocacia", "Procuro advogado de investidor"],
      ["Consultoria", "Preciso de consultoria de fornecedores"], ["Consultoria", "Busco consultoria de compradores"],
      ["Advocacia", "Preciso de advogado de importador"], ["Consultoria", "Procuro consultoria de exportadores"],
      ["Advocacia", "Procuro advogado de sócios"], ["Consultoria", "Preciso de consultoria de revendedores"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`)
        .toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    }
    // Especialidade curada continua fora, mesmo com verbo: "internacional" é especialidade de verdade.
    expect(scoreMatch(item("Logística"), item("Preciso de logística internacional para meu café")).score).toBe(0);
    expect(scoreMatch(item("Advocacia"), item("Preciso de advogado tributarista")).score).toBe(0);
    // E o rótulo solto, sem verbo, segue como era: ninguém está pedindo.
    expect(scoreMatch(item("Logística"), item("logística de exportação")).score).toBe(0);
    expect(scoreMatch(item("Advocacia"), item("advogado marítimo")).score).toBe(0);
    // A abertura é só da oferta GENÉRICA: quem tem outra especialidade não atende o complemento desconhecido.
    expect(scoreMatch(item("Advocacia tributária"), item("Preciso de advogado marítimo")).score).toBe(0);
    // O que a #124 fixou continua valendo: especialidade pedida não é atendida por quem só tem a família.
    for (const [oferta, necessidade] of [
      ["Advocacia", "Advogado tributarista"], ["Consultoria", "Consultoria trabalhista"],
      ["Logística", "Preciso de um advogado"], ["Advocacia", "Juristische Person"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`)
        .toEqual({ score: 0, type: "semantic", bloqueio: "servico-sem-demanda-expressa" });
    }
  });

  it("o que a classificação diz serviço, a leitura do serviço também lê: não é barrado diante do próprio profissional", () => {
    for (const [oferta, necessidade, categoria] of [
      ["Empresa de gestão contábil", "Contador", "Contabilidade"], ["Escritório de soluções jurídicas", "Advogado", "Jurídico"],
      ["Gestão contábil", "Contador", "Contabilidade"], ["Gestion comptable", "Comptable", "Comptabilité"],
    ] as Array<[string, string, string]>) {
      expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade}`).toEqual({ score: 60, type: "category" });
    }
    // "Expertise" qualifica quem presta nesta branch (QUALIFICA_O_ASSUNTO): "Expertise comptable" é a contabilidade e nada mais.
    expect(scoreMatch(item("Comptable", "Comptabilité"), item("Expertise comptable", "Comptabilité"))).toEqual({ score: 100, type: "exact" });
    // "Cabinet d'expertise comptable" valia 60 aqui antes do porte da 9e027bf da #127: "cabinet" era cabeça desconhecida e
    // ficava como especialidade. Com "cabinet" neutra e o "d'" genitivo, é o escritório, e "expertise" qualifica quem
    // presta (acima): a contabilidade e nada mais, 100 — a mudança deliberada da 9e027bf, "Cabinet d'avocats" × "Avocat"
    // de 60 para 100. Na #127, sem "expertise" em QUALIFICA_O_ASSUNTO, o par fica em 60.
    expect(scoreMatch(item("Cabinet d'expertise comptable", "Comptabilité"), item("Comptable", "Comptabilité"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Cabinet d'avocats"), item("Avocat"))).toEqual({ score: 100, type: "exact" });
    // A cabeça desconhecida fica como especialidade: quem PROCURA "Pessoa jurídica" não pediu a advocacia genérica.
    for (const [oferta, necessidade] of [["Advocacia", "Pessoa jurídica"], ["Advocacia", "Estrutura jurídica em Portugal"], ["Contabilidade", "Dados contábeis"]] as Array<[string, string]>) {
      const r = scoreMatch(item(oferta), item(necessidade));
      expect(r.score, `${oferta} × ${necessidade}`).toBe(0);
      expect((r as { bloqueio?: string }).bloqueio, `${oferta} × ${necessidade}`).toBe("servico-sem-demanda-expressa");
    }
  });

  it("a loja e o abacate não são serviço: seguem casando pela categoria", () => {
    for (const [oferta, necessidade, categoria] of [
      ["Boutique de joias de design", "Joias finas", "Joias"], ["Boutique de móveis de design", "Móveis", "Móveis"],
      ["Boutique de muebles de diseño", "Compradores", "Moda"],
      ["Avocats Hass export international", "Importateur de fruits", "Fruits"], ["Avocats frais, qualité fiscal", "Acheteurs de fruits", "Fruits"],
    ] as Array<[string, string, string]>) {
      expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade}`).toEqual({ score: 60, type: "category" });
    }
    // O advogado continua serviço.
    expect(scoreMatch(item("Avocat fiscaliste"), item("Avocat fiscal"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Avocat d'affaires"), item("Avocat"))).toEqual({ score: 60, type: "category" });
  });

  it("idiomas novos: o que o motor entende continua barrado — pedido que não é de serviço, outra especialidade e o desconhecido diante de especialidade entendida", () => {
    for (const [oferta, necessidade, categoria] of [
      ["Consultoria tributária", "Консультация по логистике", "Consultoria"], ["Advocacia tributária", "Юрист по семейным делам", "Jurídico"],
      ["Consultoria tributária", "电商咨询", "Serviços"],
      ["Consultoria tributária", "Консультация по маркетингу", "Consultoria"], ["税务咨询", "招聘咨询", "财务"],
      ["Advogado", "Bureaux pour avocats", "Imobiliário"], ["Advocacia", "Juristische Person", "Recht"], ["Contabilidade", "Software für Buchhaltung", "Contabilidade"],
      ["Consultoria", "Conseil d'administration", "Consultoria"], ["Advogado", "वकील के लिए कार्यालय", "कार्यालय"],
      // o rótulo bilíngue não solta a parte em português
      ["Consultoria em segurança do trabalho / 安全咨询", "Consultoria trabalhista", "Serviços"],
      ["Consultoria em segurança do trabalho (Beratung)", "Consultoria trabalhista", "Serviços"],
    ] as Array<[string, string, string]>) {
      const r = scoreMatch(item(oferta, categoria), item(necessidade, categoria));
      expect(r.score, `${oferta} × ${necessidade}`).toBe(0);
      expect((r as { bloqueio?: string }).bloqueio, `${oferta} × ${necessidade}`).toBe("servico-sem-demanda-expressa");
    }
    // A genérica que alguém escreveu, e o par que só não casa pelo que as listas não leem, seguem valendo a categoria
    // (`regraNaoLeOPar`, e6ddfa4 e 116bb56 da #127, portadas): "电商咨询" é consultoria com assunto que as listas não leem.
    expect(scoreMatch(item("Consultoria", "Serviços"), item("电商咨询", "Serviços"))).toEqual({ score: 60, type: "category" });
    expect(scoreMatch(item("Steuerberatung für Erbschaften", "Finanzen"), item("Steuerberater für Erbschaftsteuer", "Finanzen"))).toEqual({ score: 60, type: "category" });
  });

  it("idiomas novos: a forma usual do profissional é lida, e '税务' vale entre grafias e idiomas (e6ddfa4 e 116bb56, portadas)", () => {
    for (const [oferta, necessidade, categoria] of [
      ["税務コンサルティング", "税務コンサルタント", "財務"], ["Бухгалтерские услуги", "Ищем бухгалтера", "Финансы"], ["Steuerberatung", "Steuerberaterin gesucht", "Finanzen"],
      ["Cabinet d'avocats", "Juriste", "Droit"], ["خدمات محاسبة", "المحاسب", "مالية"], ["लेखा सेवाएं", "लेखाकार चाहिए", "वित्त"], ["Conseil fiscal", "Conseillère fiscale", "Finances"],
      // francês e alemão escritos com o empréstimo do inglês também são idioma novo
      ["Conseil en fiscalité internationale", "Consultant en fiscalité des entreprises", "Finances"], ["Beratung für Datenschutz", "Consulting zum Datenschutz", "IT"],
    ] as Array<[string, string, string]>) {
      expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)).score, `${oferta} × ${necessidade}`).toBeGreaterThanOrEqual(60);
    }
    // Com a especialidade curada apagada, estes caem de 100 para 0: o teste precisa quebrar (os pares com "税务" igual dos
    // dois lados não quebravam).
    for (const [oferta, necessidade] of [
      ["税務コンサルティング", "税务咨询"], ["税务咨询", "Consultoria tributária"], ["税务律师", "Advogado tributarista"], ["Consultoria tributária", "税務コンサルティング"],
    ] as Array<[string, string]>) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
  });
});

/**
 * Faltas do porte achadas pelo cético na #135 (15/09). Cada par abaixo falhava
 * na árvore do porte antes da correção.
 */
describe("Porte da madrugada de 15/09 na #135 — faltas do cético", () => {
  const barrado = (oferta: string, necessidade: string, categoria: string | null = null) => {
    const r = scoreMatch(item(oferta, categoria), item(necessidade, categoria));
    expect(r.score, `${oferta} × ${necessidade} [${categoria}]`).toBe(0);
    expect((r as { bloqueio?: string }).bloqueio, `${oferta} × ${necessidade} [${categoria}]`).toBe("servico-sem-demanda-expressa");
  };

  it("idiomas novos: com o vocabulário da 116bb56, a forma usual do profissional é o mesmo serviço", () => {
    // Na árvore do porte os cinco eram 0 com bloqueio; na main valiam ao menos 60.
    for (const [oferta, necessidade, categoria] of [
      ["Advogado", "Juriste", null], ["Serviços de tradução", "Traductrice", null], ["Conseil fiscal", "Conseillère fiscale", "Finances"],
      ["خدمات محاسبة", "المحاسب", "مالية"],
    ] as Array<[string, string, string | null]>) {
      expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
    // Valia 60 antes do porte da 9e027bf da #127 ("cabinet" desconhecida era especialidade); com "cabinet" neutra e o
    // "d'" genitivo, "Cabinet d'avocats" é a advocacia sem mais nada, e "Juriste" também: 100.
    expect(scoreMatch(item("Cabinet d'avocats", "Droit"), item("Juriste", "Droit"))).toEqual({ score: 100, type: "exact" });
    // "مستشار" é o consultor: "مستشار قانوني" é a consultoria jurídica, e não atende "محامي", como "Consultoria jurídica"
    // não atende "Advogado" (na árvore do porte valia 60 pela categoria vazando).
    barrado("مستشار قانوني", "محامي");
    barrado("Consultoria jurídica", "Advogado");
  });

  it("a casa de quem presta não impede a leitura do serviço: não é barrada diante do próprio profissional", () => {
    // Na árvore do porte todos eram 0 com bloqueio; na main, 100.
    for (const [oferta, necessidade, categoria] of [
      ["Casa de consultoria", "Consultoria", "Consultoria"], ["Ateliê de arquitetura", "Arquiteto", "Arquitetura"], ["Studio de design", "Designer", "Design"],
      ["Hub de marketing", "Marketing", "Marketing"], ["Instituto de mentoria", "Mentoria", "Serviços"],
      ["Boutique de advocacia tributária", "Advogado tributarista", "Jurídico"], ["Boutique de advocacia tributária", "Advogado tributarista", null],
    ] as Array<[string, string, string | null]>) {
      expect(scoreMatch(item(oferta, categoria), item(necessidade, categoria)), `${oferta} × ${necessidade} [${categoria}]`).toEqual({ score: 100, type: "exact" });
    }
    // Com a especialidade na oferta, a necessidade que só nomeia a família fica na nota da família.
    expect(scoreMatch(item("Boutique de advocacia tributária", "Jurídico"), item("Advogado", "Jurídico"))).toEqual({ score: 60, type: "category" });
    // A cabeça neutra colada DEPOIS do serviço também é quem presta (ff9564f): na árvore do porte, 0 com bloqueio e 60.
    for (const [oferta, necessidade] of [["Tax law firm", "Tax lawyer"], ["Advocacia tributária", "Tax law firm"], ["Advogado", "Law firm"], ["Law firm", "Advogado"]]) {
      expect(scoreMatch(item(oferta), item(necessidade)), `${oferta} × ${necessidade}`).toEqual({ score: 100, type: "exact" });
    }
    // A loja e a casa de câmbio seguem casando pela categoria.
    expect(scoreMatch(item("Boutique de joias de design", "Joias"), item("Joias finas", "Joias"))).toEqual({ score: 60, type: "category" });
    expect(scoreMatch(item("Casa de câmbio", "Financeiro"), item("Compradores", "Financeiro"))).toEqual({ score: 60, type: "category" });
  });

  it("'Pessoa jurídica' oferecida não é a advocacia: o adjetivo qualifica o conceito, não a prestação", () => {
    // Na árvore do porte a oferta "Pessoa jurídica" [Serviços] casava com os pedidos jurídicos em 60.
    for (const necessidade of ["Advogado", "Advocacia", "Lawyer", "Serviços jurídicos"]) barrado("Pessoa jurídica", necessidade, "Serviços");
    barrado("Estrutura jurídica em Portugal", "Advogado", "Jurídico");
    // A cabeça que não é conceito segue lida: "Gestão contábil" [Contabilidade] vale a nota da família diante de "Contador".
    expect(scoreMatch(item("Gestão contábil", "Contabilidade"), item("Contador", "Contabilidade"))).toEqual({ score: 60, type: "category" });
  });

  it("'estratégica' ao lado de especialidade reconhecida sai da oferta; sozinha no pedido é o assunto (ff9564f, portada)", () => {
    // Na árvore do porte os dois primeiros valiam 100, acima do corte de e-mail; na main e na #127, 0 com bloqueio.
    barrado("Consultoria tributária estratégica", "Consultoria estratégica");
    barrado("Consultoria financeira estratégica", "Consultoria estratégica");
    expect(scoreMatch(item("Advocacia tributária estratégica"), item("Advogado tributarista"))).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(item("Consultoria estratégica"), item("Consultoria"))).toEqual({ score: 60, type: "category" });
  });
});
