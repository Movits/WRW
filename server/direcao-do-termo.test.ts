import { describe, expect, it, vi } from "vitest";
import { analisarTermo, direcaoEfetiva, ehLugar, saoConcorrentes } from "@shared/direcao-do-termo";
import { scoreMatch } from "./match-service";

const possui = (label: string, category = "Comércio exterior") =>
  ({ slug: label.toLowerCase().replace(/\s+/g, "-"), label, category });

describe("Etapa 11 — direção mora no campo, nunca na palavra parecida", () => {
  it("separa o verbo do objeto quando o termo começa por verbo de direção", () => {
    expect(analisarTermo("Exportar vinho")).toEqual({ direcao: "oferta", objeto: "vinho", verbo: "exportar" });
    expect(analisarTermo("Importar vinho")).toEqual({ direcao: "demanda", objeto: "vinho", verbo: "importar" });
    expect(analisarTermo("Importação de vinho")).toEqual({ direcao: "demanda", objeto: "vinho", verbo: "importacao" });
  });

  it("deixa neutro o termo sem verbo na cabeça, que é a esmagadora maioria", () => {
    expect(analisarTermo("Soja em grande volume").direcao).toBe("neutro");
    expect(analisarTermo("Armazenagem refrigerada").direcao).toBe("neutro");
    expect(analisarTermo("Aporte para expansão").direcao).toBe("neutro");
  });

  it("não confunde ator com direção: substantivo não é verbo", () => {
    // "Compradores no exterior" é uma coisa que alguém pode ter para oferecer.
    // Se atores contassem como direção, este match — que funciona hoje — morria.
    expect(analisarTermo("Compradores no exterior").direcao).toBe("neutro");
    expect(analisarTermo("Fornecedores homologados").direcao).toBe("neutro");
    expect(analisarTermo("Investidores anjo").direcao).toBe("neutro");
  });

  it("só lê o verbo na cabeça do termo, não no meio", () => {
    // Quem oferece assessoria em exportação não está exportando nada.
    expect(analisarTermo("Assessoria em exportação").direcao).toBe("neutro");
    expect(analisarTermo("Seguro de crédito à exportação").direcao).toBe("neutro");
  });

  it("o campo manda quando a palavra é neutra, e a palavra manda quando existe", () => {
    expect(direcaoEfetiva("Vinho tinto", "demanda")).toBe("demanda");
    expect(direcaoEfetiva("Exportar vinho", "demanda")).toBe("oferta");
  });

  it("verbos ambíguos ficam de fora de propósito", () => {
    // "Alugar" serve para quem cede e para quem toma. Classificar seria chutar.
    expect(analisarTermo("Alugar galpão").direcao).toBe("neutro");
  });
});

describe("Etapa 11 — palavras que só anunciam, e não são a coisa", () => {
  it("tira da frente o marcador e revela o objeto", () => {
    // Encontrado em produção: "Terras raras" contra "procura terras raras"
    // dava 60, porque o objeto de um era `terras-raras` e o do outro
    // `procura-terras-raras`. É a mesma coisa dita de dois jeitos.
    expect(analisarTermo("procura terras raras").objeto).toBe("terras-raras");
    expect(analisarTermo("Terras raras").objeto).toBe("terras-raras");
    expect(analisarTermo("possui terras").objeto).toBe("terras");
    expect(analisarTermo("precisa de terras").objeto).toBe("terras");
  });

  it("marcador NÃO é verbo de direção, e por isso nunca acusa concorrência", () => {
    // Uma recrutadora que OFERECE "Procura de talentos" e uma empresa que
    // PROCURA "Procura de talentos" são o negócio, não concorrentes. Se
    // "procura" marcasse direção, as duas seriam lidas como demanda e o motor
    // deixaria de apresentar exatamente quem devia.
    expect(analisarTermo("Procura de talentos").direcao).toBe("neutro");
    expect(saoConcorrentes("Procura de talentos", "Procura de talentos")).toBe(false);
    expect(scoreMatch(possui("Procura de talentos", "RH"), possui("Procura de talentos", "RH")).score).toBe(100);
  });

  it("verbo de direção depois do marcador é quem manda", () => {
    // "Procuro exportar vinho" é oferta: quem escreveu disse o que pretende
    // fazer, e o marcador só anunciava que vinha alguma coisa.
    expect(analisarTermo("procuro exportar vinho")).toEqual({ direcao: "oferta", objeto: "vinho", verbo: "exportar" });
    expect(analisarTermo("procura importar vinho")).toEqual({ direcao: "demanda", objeto: "vinho", verbo: "importar" });
  });

  it("a regra do vinho continua valendo com marcador na frente", () => {
    expect(scoreMatch(possui("Exportar vinho"), possui("procura importar vinho")).score).toBe(100);
    expect(scoreMatch(possui("Exportar vinho"), possui("procura exportar vinho")))
      .toHaveProperty("bloqueio", "concorrentes");
  });

  it("marcador sozinho não vira objeto vazio", () => {
    // Descascar até não sobrar nada faria "Procura" casar com "Possui", e com
    // qualquer outro termo igualmente descascado até o osso.
    expect(analisarTermo("Procura").objeto).toBe("procura");
    expect(analisarTermo("Possui").objeto).toBe("possui");
    expect(scoreMatch(possui("Possui", "A"), possui("Procura", "B")).score).toBe(0);
  });
});

describe("Etapa 11 — lugar não é produto", () => {
  // Achados numa revisão adversarial: todos davam 100, o score máximo, que até
  // então era reservado a quem tem literalmente a mesma coisa. Em comércio
  // exterior o complemento do termo quase sempre é o destino, não a mercadoria,
  // então o erro não era raro — era o caso comum. E 100 passa de
  // EMAIL_THRESHOLD, então o par ainda saía por e-mail como oportunidade.
  const pares: [string, string][] = [
    ["Exportação para a China", "Importação da China"],
    ["Distribuição no Nordeste", "Compras no Nordeste"],
    ["Exportação para o Mercosul", "Compras no Mercosul"],
    ["Venda para o varejo", "Compra no varejo"],
    ["Exportação em grande volume", "Importação em grande volume"],
  ];

  it.each(pares)("%s x %s não vira 100: não têm produto em comum", (ativo, necessidade) => {
    expect(scoreMatch(possui(ativo), possui(necessidade)).score).toBeLessThan(100);
  });

  it("preposição de lugar impede a extração do objeto", () => {
    // "para", "em", "no" apresentam destino ou canal. O genitivo apresenta a
    // coisa — e continua funcionando.
    expect(analisarTermo("Exportação para a China").objeto).toBe("exportacao-para-a-china");
    expect(analisarTermo("Exportação de vinho").objeto).toBe("vinho");
  });

  it("o par que a regra existe para achar continua em 100", () => {
    expect(scoreMatch(possui("Exportar vinho"), possui("Importar vinho")).score).toBe(100);
    expect(scoreMatch(possui("Exportação de vinho"), possui("Vinho")).score).toBe(100);
  });
});

describe("Reverificação de 04/09 — 'a' também é preposição, e lugar nunca é objeto", () => {
  // "a" estava só em ARTIGOS e era descascado antes da guarda dos LOCATIVOS:
  // "Exportar a China" virava objeto "china", e o par com "Importar de China"
  // (rotas opostas, nada em comum) saía em 100 e por e-mail. O mesmo pela
  // porta do modo ("a granel", "a prazo", "a varejo"). E a guarda de lugar só
  // existia no núcleo: "Importação da China" × "Exportação da China" dava 100
  // pelo objeto. (A revisão de 05/09 restringiu a guarda a quem declarou
  // direção: "China" × "Procura China" volta a 100, ver abaixo.)
  const semCategoria = (label: string) => possui(label, "");
  const pares: [string, string][] = [
    ["Exportar a China", "Importar de China"],
    ["Exportação à China", "Importação da China"],
    ["Exportação a granel", "Importação a granel"],
    ["Vender a prazo", "Comprar a prazo"],
    ["Venda a varejo", "Compra a varejo"],
    ["Vender à vista", "Comprar à vista"],
  ];

  it.each(pares)("%s x %s não vira 100: não têm mercadoria em comum", (ativo, necessidade) => {
    expect(scoreMatch(possui(ativo), possui(necessidade)).score).toBeLessThan(100);
  });

  it("'a' diante de lugar ou de modo trava a extração: o termo vale por inteiro, como diante de 'para'", () => {
    expect(analisarTermo("Exportar a China").objeto).toBe("exportar-a-china");
    expect(analisarTermo("Exportação à China").objeto).toBe("exportacao-a-china");
    expect(analisarTermo("Exportação a granel").objeto).toBe("exportacao-a-granel");
    expect(analisarTermo("Vender a prazo")).toEqual({ direcao: "oferta", objeto: "vender-a-prazo", verbo: "vender" });
  });

  it("'a' artigo continua artigo: 'Vender a soja' rende 'soja' e casa com quem compra soja", () => {
    expect(analisarTermo("Vender a soja")).toEqual({ direcao: "oferta", objeto: "soja", verbo: "vender" });
    expect(scoreMatch(possui("Vender a soja"), possui("Comprar soja")).score).toBe(100);
  });

  it("com direção declarada, lugar não é substância nem pelo objeto nem pelo núcleo", () => {
    // "Importação da China" e "Exportação da China" reduzem os dois lados a
    // "china". Mata o mutante que guarda só o objeto: pelo núcleo os dois
    // ainda seriam "china". E mata o que guarda só o núcleo, pelo mesmo motivo
    // ao contrário.
    expect(scoreMatch(possui("Importação da China"), possui("Exportação da China")).score).toBeLessThan(100);
    // Basta UMA ponta ter declarado direção: mata o mutante que exige as duas.
    expect(scoreMatch(semCategoria("Importação da China"), semCategoria("China")).score).toBe(0);
  });

  it("sem direção nas palavras, 'China' × 'Procura China' é a mesma coisa dita de dois jeitos: 100", () => {
    // Revisão adversarial de 05/09: a guarda de lugar valia para todo par e
    // zerava este, que é o mesmo caso de "Terras raras" × "Procura terras
    // raras". Só quem DECLAROU direção não tem o lugar como mercadoria.
    expect(scoreMatch(semCategoria("China"), semCategoria("Procura China")).score).toBe(100);
    expect(scoreMatch(semCategoria("Coreia do Sul"), semCategoria("Procura Coreia do Sul")).score).toBe(100);
  });

  it("tag idêntica de lugar continua casando pelo slug: 'China' × 'China' é 100", () => {
    expect(scoreMatch(semCategoria("China"), semCategoria("China"))).toEqual({ score: 100, type: "exact" });
  });

  it("ehLugar é exportada e reconhece palavra e composto", () => {
    expect(ehLugar(["china"])).toBe(true);
    expect(ehLugar(["coreia", "do", "sul"])).toBe(true);
    expect(ehLugar(["soja"])).toBe(false);
    expect(ehLugar([])).toBe(false);
  });
});

describe("Reverificação de 04/09 — substantivo de ação não é verbo", () => {
  // A cabeça "supply", "import", "compras", "captação" era lida como verbo de
  // direção, e a tag IDÊNTICA dos dois lados saía 0 como "concorrentes". A
  // decisão do Nicolas (04/09): serviço escrito igual dos dois lados como
  // substantivo casa; "Exportar vinho" × idem continua concorrente.
  const exact = { score: 100, type: "exact" };

  it.each([
    "Captação de recursos", "Fornecimento de terras raras", "Contratação de pessoal",
    "Fornecimento de energia", "Supply chain management", "Import license",
    "Export credit insurance", "Purchase order financing", "Vendas online",
    "Compras públicas", "Venda direta",
  ])("'%s' × idem casa em 100: é o serviço que uma presta e a outra procura", termo => {
    expect(scoreMatch(possui(termo), possui(termo))).toEqual(exact);
  });

  it("verbo flexionado dos dois lados continua concorrência", () => {
    expect(scoreMatch(possui("Exportar vinho"), possui("Exportar vinho"))).toHaveProperty("bloqueio", "concorrentes");
    expect(scoreMatch(possui("Export wine"), possui("Export wine"))).toHaveProperty("bloqueio", "concorrentes");
    expect(scoreMatch(possui("Export wine"), possui("Import wine")).score).toBe(100);
    // verbo de um lado e substantivo do outro, mesma direção: sem a forma de
    // serviço dos DOIS lados, a leitura conservadora permanece
    expect(saoConcorrentes("Exportar vinho", "Exportação de vinho")).toBe(true);
    expect(scoreMatch(possui("Importar vinho"), possui("Importação de uva")).score).toBe(0);
  });

  it("a forma das duas pontas decide: substantivo com objeto não concorre, substantivo sozinho concorre", () => {
    expect(saoConcorrentes("Captação de recursos", "Captação de recursos")).toBe(false);
    expect(saoConcorrentes("Exportação de vinho", "Exportação de vinho")).toBe(false);
    expect(saoConcorrentes("Exportação", "Exportação")).toBe(true);
    expect(saoConcorrentes("Exportação para a China", "Exportação para a China")).toBe(true);
  });

  it("substantivo de ação com genitivo segue dando direção e objeto", () => {
    expect(analisarTermo("Exportação de vinho")).toEqual({ direcao: "oferta", objeto: "vinho", verbo: "exportacao" });
    expect(analisarTermo("Captação de recursos")).toEqual({ direcao: "demanda", objeto: "recursos", verbo: "captacao" });
    expect(analisarTermo("Exports of coffee")).toEqual({ direcao: "oferta", objeto: "coffee", verbo: "exports" });
  });

  it("substantivo seguido de palavra justaposta é composto nominal: neutro", () => {
    for (const termo of ["Compras públicas", "Venda direta", "Vendas online", "Ventas minoristas"]) {
      expect(analisarTermo(termo).direcao, termo).toBe("neutro");
    }
    // já com locativo ou modo depois, a ação continua declarada e o termo vale
    // por inteiro — é o pino de "Exportação para a China"
    expect(analisarTermo("Ventas por mayor")).toEqual({ direcao: "oferta", objeto: "ventas-por-mayor", verbo: "ventas" });
    expect(analisarTermo("Venda a prazo")).toEqual({ direcao: "oferta", objeto: "venda-a-prazo", verbo: "venda" });
  });

  it("em inglês, verbo + complemento nominal é composto: neutro", () => {
    for (const termo of ["Supply chain management", "Import license", "Export credit insurance", "Sell-side advisory", "Purchasing department"]) {
      expect(analisarTermo(termo).direcao, termo).toBe("neutro");
    }
    // sem complemento nominal, o verbo inglês continua verbo
    expect(analisarTermo("Export wine")).toEqual({ direcao: "oferta", objeto: "wine", verbo: "export" });
    expect(analisarTermo("Supply of rare earths")).toEqual({ direcao: "oferta", objeto: "rare-earths", verbo: "supply" });
  });

  it("compostos de direções 'opostas' não são o mesmo objeto: ficam abaixo de 100", () => {
    // Antes "Sell-side advisory" × "Buy-side advisory" dava 100 (objeto
    // "side-advisory" dos dois lados) — é o falso positivo do mesmo defeito.
    expect(scoreMatch(possui("Compras públicas"), possui("Vendas públicas")).score).toBeLessThan(100);
    expect(scoreMatch(possui("Venda direta"), possui("Compra direta")).score).toBeLessThan(100);
    expect(scoreMatch(possui("Sell-side advisory"), possui("Buy-side advisory")).score).toBeLessThan(100);
  });

  it("os pinos da etapa 7 seguem de pé: neutro × substantivo de ação casa pelo objeto", () => {
    expect(scoreMatch(possui("Terras raras"), possui("Fornecimento de terras raras")).score).toBe(100);
    expect(scoreMatch(possui("Café"), possui("Exportar café")).score).toBe(100);
  });
});

describe("Revisão adversarial da PR-F (05/09) — o que a primeira rodada deixou passar", () => {
  const exact = { score: 100, type: "exact" };

  describe("'al', 'del', 'from' e 'desde' são locativos: o que vem depois não é mercadoria", () => {
    // "Vender al contado" × "Comprar al contado" reduzia os dois lados a
    // "al-contado" e saía em 100 — o mesmo para a rota ("Exportar al Brasil",
    // "Export from Brazil"). Cada par abaixo pina uma palavra da lista.
    const pares: [string, string][] = [
      ["Vender al contado", "Comprar al contado"],
      ["Vender al por mayor", "Comprar al por mayor"],
      ["Exportar al Brasil", "Importar al Brasil"],
      ["Exportar del Brasil", "Importar del Brasil"],
      ["Export from Brazil", "Import from Brazil"],
      ["Exportar desde Brasil", "Importar desde Brasil"],
    ];

    it.each(pares)("%s x %s não vira 100: não têm mercadoria em comum", (ativo, necessidade) => {
      expect(scoreMatch(possui(ativo), possui(necessidade)).score).toBeLessThan(100);
    });

    it("o termo vale por inteiro, e substantivo + 'al' mantém a direção como 'Ventas por mayor'", () => {
      expect(analisarTermo("Vender al contado")).toEqual({ direcao: "oferta", objeto: "vender-al-contado", verbo: "vender" });
      expect(analisarTermo("Export from Brazil").objeto).toBe("export-from-brazil");
      expect(analisarTermo("Ventas al por mayor")).toEqual({ direcao: "oferta", objeto: "ventas-al-por-mayor", verbo: "ventas" });
    });
  });

  describe("modo sem preposição (inglês) e 'as' + lugar", () => {
    it("'Sell retail' × 'Buy retail' não vira 100: retail é COMO se vende, não o quê", () => {
      // A guarda só olhava a palavra descascada "a"; em inglês o modo vem sem
      // preposição, e "bulk", "retail", "wholesale" eram inalcançáveis.
      expect(scoreMatch(possui("Sell retail"), possui("Buy retail")).score).toBeLessThan(100);
      expect(scoreMatch(possui("Sell wholesale"), possui("Buy wholesale")).score).toBeLessThan(100);
      expect(analisarTermo("Sell retail")).toEqual({ direcao: "oferta", objeto: "sell-retail", verbo: "sell" });
    });

    it("'Exportar às Filipinas' vale por inteiro: 'as' também é preposição", () => {
      expect(analisarTermo("Exportar às Filipinas").objeto).toBe("exportar-as-filipinas");
      expect(analisarTermo("Exportação às Filipinas").objeto).toBe("exportacao-as-filipinas");
      expect(scoreMatch(possui("Exportar às Filipinas"), possui("Importar das Filipinas")).score).toBeLessThan(100);
    });

    it("lugar sem preposição depois de palavra de direção vale por inteiro; depois de marcador fraco, é a coisa", () => {
      expect(analisarTermo("Exportar China").objeto).toBe("exportar-china");
      expect(analisarTermo("Procura China").objeto).toBe("china");
    });
  });

  describe("verbo inglês + 'of' é a forma nominal", () => {
    // "Supply of rare earths" é "fornecimento de terras raras": escrito igual
    // dos dois lados, é o serviço — saía 0 como "concorrentes" porque a mesma
    // grafia era lida como verbo.
    it.each(["Supply of rare earths", "Export of wine", "Purchase of equipment", "Hiring of staff"])(
      "'%s' × idem casa em 100", termo => {
        expect(scoreMatch(possui(termo), possui(termo))).toEqual(exact);
      });

    it("a direção e o objeto continuam: 'Export of wine' × 'Import of wine' é 100", () => {
      expect(analisarTermo("Supply of rare earths")).toEqual({ direcao: "oferta", objeto: "rare-earths", verbo: "supply" });
      expect(scoreMatch(possui("Export of wine"), possui("Import of wine"))).toEqual(exact);
    });

    it("só 'of': em pt/es o 'de' depois de verbo é origem, e a leitura de verbo permanece", () => {
      expect(scoreMatch(possui("Exportar do Brasil"), possui("Exportar do Brasil"))).toHaveProperty("bloqueio", "concorrentes");
      expect(scoreMatch(possui("Exportar do Brasil"), possui("Importar do Brasil")).score).toBeLessThan(100);
    });
  });

  describe("os dois sentidos no mesmo termo nomeiam o fluxo inteiro", () => {
    it.each(["Import/export", "Import export", "Import and export", "Importar e exportar", "Comprar e vender imóveis", "Importação e exportação"])(
      "'%s' × idem casa em 100 (saía 0 como 'concorrentes', lido pela primeira palavra)", termo => {
        expect(scoreMatch(possui(termo), possui(termo))).toEqual(exact);
      });

    it("o termo é neutro e vale por inteiro; mesma direção repetida não é coordenação de opostos", () => {
      expect(analisarTermo("Import/export")).toEqual({ direcao: "neutro", objeto: "import-export", verbo: null });
      expect(analisarTermo("Comprar e vender imóveis")).toEqual({ direcao: "neutro", objeto: "comprar-e-vender-imoveis", verbo: null });
      expect(analisarTermo("Comprar e adquirir imóveis").direcao).toBe("demanda");
    });
  });

  describe("composto nominal só com cabeça ambígua; papéis e organizações; gerúndio", () => {
    it("verbo puro + objeto comum é o negócio: 'Sell insurance' × 'Buy insurance' volta a 100", () => {
      // A lista de complementos aplicada a todo verbo inglês derrubou este par
      // de 100 para 60: "sell" não é substantivo, e "insurance" é o objeto.
      expect(scoreMatch(possui("Sell insurance"), possui("Buy insurance"))).toEqual(exact);
      expect(scoreMatch(possui("Buy data"), possui("Sell data"))).toEqual(exact);
      expect(analisarTermo("Sell insurance")).toEqual({ direcao: "oferta", objeto: "insurance", verbo: "sell" });
    });

    it("'sell-side' e 'buy-side' continuam compostos fixos", () => {
      expect(analisarTermo("Sell-side advisory").direcao).toBe("neutro");
      expect(scoreMatch(possui("Sell-side advisory"), possui("Buy-side advisory")).score).toBeLessThan(100);
    });

    it("papel ou organização depois de cabeça ambígua é composto: 'Export manager' × idem 100, × 'Import manager' < 100", () => {
      expect(scoreMatch(possui("Export manager"), possui("Export manager"))).toEqual(exact);
      expect(scoreMatch(possui("Export manager"), possui("Import manager")).score).toBeLessThan(100);
      for (const termo of [
        "Import director", "Export team", "Supply specialist", "Purchase officer", "Export office",
        "Import declaration", "Export documents", "Import clearance", "Export operations", "Supply unit",
        "Export coordinator", "Import company",
        // e os plurais, cada um pinado de propósito: palavra da lista sem pino some sem ninguém notar
        "Export managers", "Import directors", "Supply teams", "Export companies", "Import specialists",
        "Export officers", "Supply coordinators", "Import units", "Export declarations", "Import document",
      ]) {
        expect(analisarTermo(termo).direcao, termo).toBe("neutro");
      }
    });

    it("gerúndio + substantivo é composto neutro: 'Hiring manager' × idem 100", () => {
      for (const termo of [
        "Hiring manager", "Exporting company", "Purchasing manager", "Importing company", "Supplying team",
        "Selling agents", "Buying office", "Outsourcing company", "Distributing company",
      ]) {
        expect(scoreMatch(possui(termo), possui(termo)), termo).toEqual(exact);
        expect(analisarTermo(termo).direcao, termo).toBe("neutro");
      }
      // gerúndio + objeto comum continua verbo
      expect(analisarTermo("Hiring engineers")).toEqual({ direcao: "demanda", objeto: "engineers", verbo: "hiring" });
    });
  });

  describe("revisão de 06/09 (card): as três guardas não engolem o objeto do negócio", () => {
    it("palavra de direção no fundo do complemento não é coordenação: 'Fornecer software de compras' casa", () => {
      // A varredura solta via "compras" em qualquer posição e devolvia neutro;
      // coordenação de verdade é adjacente à cabeça ou atrás de conjunção.
      expect(analisarTermo("Fornecer software de compras")).toEqual({ direcao: "oferta", objeto: "software-de-compras", verbo: "fornecer" });
      expect(scoreMatch(possui("Fornecer software de compras"), possui("Contratar software de compras"))).toEqual(exact);
      // e a coordenação de verdade continua neutra (pinos da suíte acima)
      expect(analisarTermo("Importar e exportar").direcao).toBe("neutro");
    });

    it("modo sem preposição é só o advérbio inglês: 'Fornecer crédito' e 'Buy bulk' têm objeto", () => {
      // MODOS_E_CONDICOES inteira valia também sem preposição, e "crédito",
      // "bulk", "varejo" sumiam como se fossem "a granel".
      expect(analisarTermo("Fornecer crédito")).toEqual({ direcao: "oferta", objeto: "credito", verbo: "fornecer" });
      expect(scoreMatch(possui("Fornecer crédito"), possui("Contratar crédito"))).toEqual(exact);
      expect(scoreMatch(possui("Buy bulk"), possui("Sell bulk"))).toEqual(exact);
      expect(scoreMatch(possui("Vender varejo"), possui("Comprar varejo"))).toEqual(exact);
    });

    it("com a preposição o modo segue modo: 'Vender a crédito' e 'Vender a varejo' valem por inteiro", () => {
      expect(analisarTermo("Vender a crédito")).toEqual({ direcao: "oferta", objeto: "vender-a-credito", verbo: "vender" });
      expect(analisarTermo("Vender a varejo").objeto).toBe("vender-a-varejo");
      // e o advérbio inglês continua modo mesmo sem preposição
      expect(analisarTermo("Sell retail").objeto).toBe("sell-retail");
      expect(scoreMatch(possui("Sell retail"), possui("Buy retail")).score).toBeLessThan(100);
    });

    it("complemento que pode ser mercadoria só compõe atrás de export/import: 'Purchase insurance' × 'Sell insurance' casa", () => {
      // A lista única de complementos derrubava estes pares para 60.
      expect(scoreMatch(possui("Purchase insurance"), possui("Sell insurance"))).toEqual(exact);
      expect(scoreMatch(possui("Selling data"), possui("Buying data"))).toEqual(exact);
      expect(scoreMatch(possui("Supply credit"), possui("Buy credit"))).toEqual(exact);
      expect(analisarTermo("Purchase insurance")).toEqual({ direcao: "demanda", objeto: "insurance", verbo: "purchase" });
      // atrás de cabeça forte o composto de comércio exterior segue neutro
      expect(analisarTermo("Export credit insurance").direcao).toBe("neutro");
      expect(analisarTermo("Import finance").direcao).toBe("neutro");
    });
  });

  describe("a isenção entre dois substantivos de ação exige o MESMO objeto", () => {
    it("'Captação de recursos' × idem e 'Exportação de vinho' × idem seguem em 100", () => {
      expect(scoreMatch(possui("Captação de recursos"), possui("Captação de recursos"))).toEqual(exact);
      expect(scoreMatch(possui("Exportação de vinho"), possui("Exportação de vinho"))).toEqual(exact);
    });

    it("'Exportação de vinho' × 'Exportação de uva' volta a ser concorrência, como na main", () => {
      expect(saoConcorrentes("Exportação de vinho", "Exportação de uva")).toBe(true);
      expect(scoreMatch(possui("Exportação de vinho"), possui("Exportação de uva"))).toEqual({ score: 0, type: "semantic", bloqueio: "concorrentes" });
    });
  });
});

describe("Etapa 11 — o critério semântico está desligado, e isso tem consequência", () => {
  it("nem a similaridade máxima possível chega a virar sugestão", () => {
    // TRIPWIRE. Este teste falha de propósito no dia em que alguém religar o
    // critério semântico POR PADRÃO — e é aí que se deve reler o termo de
    // consentimento: enquanto ele está desligado, `docs/termos/termo-smart-match.md`
    // afirma que nenhum dado sai da plataforma, e o recálculo nem chama o
    // provedor de embeddings. Desde o N7 ele existe numa faixa estreita, mas só
    // liga com MATCH_SEMANTICO_ESTREITO=1; o stub abaixo garante o padrão
    // mesmo que o .env de quem roda a suíte o ligue. Religar sem republicar o
    // termo transforma o documento numa afirmação falsa.
    vi.stubEnv("MATCH_SEMANTICO_ESTREITO", "");
    expect(scoreMatch(possui("Câmaras frias em Santos", "Logística"),
                      possui("Terrenos licenciados", "Imóveis"), 1).score).toBeLessThan(50);
    vi.unstubAllEnvs();
  });
});

describe("Etapa 11 — a regra dentro do motor de match", () => {
  it("nunca apresenta duas pontas que querem a mesma coisa", () => {
    // A Bodega escreveu no campo de PROCURA, mas o texto diz "exportar": ela
    // está oferecendo. Duas exportadoras são concorrentes.
    const resultado = scoreMatch(possui("Exportar vinho"), possui("Exportar vinho"));
    expect(resultado.score).toBe(0);
    expect(resultado).toHaveProperty("bloqueio", "concorrentes");
  });

  it("bloqueia mesmo com a categoria idêntica, que antes valia 60", () => {
    const resultado = scoreMatch(
      { slug: "importar-vinho", label: "Importar vinho", category: "Comércio exterior" },
      { slug: "importacao-de-uva", label: "Importação de uva", category: "Comércio exterior" },
    );
    expect(resultado.score).toBe(0);
  });

  it("bloqueia mesmo com o texto idêntico, que antes valia 100", () => {
    expect(scoreMatch(possui("Exportar vinho"), possui("Exportar vinho")).score).toBe(0);
  });

  it("dá o score máximo ao par oposto — é onde existe negócio", () => {
    // Mesmo objeto, direções contrárias. Antes disto o par valia só os 60 da
    // categoria, abaixo do par concorrente que valia 100.
    expect(scoreMatch(possui("Exportar vinho"), possui("Importar vinho")))
      .toEqual({ score: 100, type: "exact" });
  });

  it("casa o verbo com o substantivo do mesmo objeto", () => {
    expect(scoreMatch(possui("Exportação de vinho"), possui("Vinho")).score).toBe(100);
  });

  it("não bloqueia quando só uma ponta traz verbo: falta evidência", () => {
    // O campo já separou as duas. Sem verbo dos dois lados não há conflito
    // declarado, e barrar aqui tiraria matches legítimos.
    expect(scoreMatch(possui("Vinho"), possui("Importar vinho")).score).toBe(100);
    expect(scoreMatch(possui("Exportar vinho"), possui("Vinho")).score).toBe(100);
    // Objeto diferente ainda cai na categoria, como sempre caiu — o que importa
    // aqui é que nada foi barrado. "Vinho tinto" não é "vinho": casar sinônimo e
    // variação é o trabalho do vocabulário canônico, não desta regra.
    expect(scoreMatch(possui("Vinho tinto"), possui("Importar vinho")).score).toBe(60);
  });

  it("não mexe em nada que não traga verbo de direção", () => {
    // Os 10 contatos da rede de teste seguem como antes, com uma exceção DE
    // PROPÓSITO: desde que a logística é serviço (decisão de 14/09), a
    // armazenagem oferecida não casa pela categoria com quem procura um galpão —
    // procurar um imóvel não é declarar que precisa do serviço de armazenagem.
    expect(scoreMatch(
      { slug: "compradores-no-exterior", label: "Compradores no exterior", category: "Comércio exterior" },
      { slug: "compradores-no-exterior", label: "Compradores no exterior", category: "Comércio exterior" },
    )).toEqual({ score: 100, type: "exact" });
    expect(scoreMatch(
      { slug: "armazenagem-refrigerada", label: "Armazenagem refrigerada", category: "Logística" },
      { slug: "galpao-alfandegado", label: "Galpão alfandegado", category: "logistica" },
    ).score).toBe(0);
    // O bem físico continua casando pela categoria, como antes.
    expect(scoreMatch(
      { slug: "galpao-alfandegado", label: "Galpão alfandegado", category: "logistica" },
      { slug: "armazem-em-santos", label: "Armazém em Santos", category: "Logística" },
    )).toEqual({ score: 60, type: "category" });
  });

  it("termo que é só o verbo não vira objeto vazio casando com qualquer um", () => {
    // "Exportação" e "Importação" não têm objeto. Se o objeto virasse "", os
    // dois casariam em 100 sem ter nada em comum.
    expect(saoConcorrentes("Exportação", "Exportação")).toBe(true);
    expect(scoreMatch(possui("Exportação"), possui("Importação")).score).toBe(60);
  });
});
