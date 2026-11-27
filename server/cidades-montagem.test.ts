import { describe, expect, it } from "vitest";
import { normalizarCidade } from "@shared/normalizar-cidade";

// O módulo do gerador é .mjs sem declaração de tipos, como os de scripts/exame/.
// O tsconfig exclui *.test.ts do `pnpm check` e o Vitest só transpila, então o
// import funciona em execução; a diretiva existe para o editor.
// @ts-expect-error módulo .mjs sem tipos (ver comentário acima)
import * as montagem from "../scripts/cidades/montagem.mjs";

/**
 * Regras de montagem das listas de cidade, provadas sem baixar o dump de 195 MB
 * do GeoNames: scripts/cidades/montagem.mjs é um módulo puro, e aqui ele recebe
 * linhas escritas no formato exato do dump.
 *
 * O primeiro bloco é o mais importante do arquivo. A chave de busca é gravada
 * no JSON pelo gerador (.mjs) e recalculada no navegador a cada tecla
 * (shared/normalizar-cidade.ts). Se as duas normalizações divergirem, a busca
 * para de achar cidade e NADA quebra de forma visível: não há erro, não há
 * exceção, só um campo que deixou de sugerir. Este teste é a única coisa entre
 * o repositório e esse silêncio.
 */

const CASOS_DE_NORMALIZACAO = [
  ["São Paulo", "sao paulo"],
  ["SÃO PAULO", "sao paulo"],
  ["  são   paulo  ", "sao paulo"],
  ["Goiânia", "goiania"],
  ["Santa Bárbara d'Oeste", "santa barbara d oeste"],
  ["Mogi-Guaçu", "mogi guacu"],
  ["München", "munchen"],
  ["Köln", "koln"],
  ["Kassel", "kassel"],
  // Letras que o NFD NÃO decompõe: sem a tabela própria elas sobreviveriam.
  ["Gießen", "giessen"],
  ["Łódź", "lodz"],
  ["Malmö", "malmo"],
  ["Ålesund", "alesund"],
  ["Tromsø", "tromso"],
  ["Þórshöfn", "thorshofn"],
  // As mesmas letras em MAIÚSCULA: a tabela é consultada em minúscula, então
  // nenhuma caixa depende de alguém ter lembrado de escrevê-la duas vezes.
  ["TROMSØ", "tromso"],
  ["Ærøskøbing", "aeroskobing"],
  // Maltês: o "Ħ" só existia na tabela em minúscula e sobrevivia à
  // normalização (ver o teste de idempotência logo abaixo).
  ["Ħamrun", "hamrun"],
  ["Ħaż-Żabbar", "haz zabbar"],
  ["Ŋ", "n"],
  ["Ŧ", "t"],
  // Russo: o "ё" é "е" + trema, então perde o trema dos dois lados da busca.
  ["Кёльн", "кельн"],
  ["Москва", "москва"],
  // Escritas sem caixa nem diacrítico latino atravessam inteiras.
  ["東京", "東京"],
  ["ケルン", "ケルン"],
  ["ロンドン", "ロンドン"],
  ["الدوحة", "الدوحة"],
  ["नई दिल्ली", "नई दिल्ली"],
  ["", ""],
];

describe("a normalização do gerador é a mesma do navegador", () => {
  it.each(CASOS_DE_NORMALIZACAO)(
    "%s → %s nas duas pontas",
    (entrada, esperado) => {
      expect(normalizarCidade(entrada)).toBe(esperado);
      expect(montagem.normalizarCidade(entrada)).toBe(esperado);
    }
  );

  it("normalizar de novo não muda mais nada, nas duas pontas", () => {
    /**
     * A chave gravada no JSON é texto JÁ normalizado, e o navegador normaliza o
     * que a usuária digita: se normalizar um texto normalizado ainda o mudasse,
     * os dois lados chegariam a resultados diferentes e a busca não acharia a
     * cidade — sem erro nenhum na tela.
     *
     * Foi o que aconteceu com Malta quando as listas do mundo inteiro foram
     * geradas: a tabela de letras tinha "ħ" e não "Ħ", então "Ħamrun" virava
     * "ħamrun" na chave, e "ħamrun" normalizado de novo virava "hamrun".
     */
    for (const [entrada] of CASOS_DE_NORMALIZACAO) {
      const uma = normalizarCidade(entrada);
      expect(normalizarCidade(uma)).toBe(uma);
      expect(montagem.normalizarCidade(uma)).toBe(uma);
    }
  });

  it("nenhuma normalização deixa passar o separador de apelidos", () => {
    // Um "|" sobrevivente partiria a chave em dois e faria a busca casar pedaço
    // de nome com pedaço de outro.
    expect(normalizarCidade("São Paulo | Sampa")).not.toContain("|");
    expect(montagem.normalizarCidade("São Paulo | Sampa")).not.toContain("|");
  });
});

// ── as duas formas de digitar ───────────────────────────────────────────────

describe("formasDeDigitar", () => {
  /**
   * A normalização troca a pontuação por ESPAÇO e nunca a remove. Sozinha, ela
   * só cobre metade de como as pessoas escrevem: quem digita "Sant'Ana",
   * "Sant Ana" ou "Sant-Ana" acha, mas quem digita "Santana" — que é como se
   * fala — não achava nada. A chave passou a guardar as duas formas.
   */
  it.each([
    [
      "Sant'Ana do Livramento",
      "sant ana do livramento",
      "santana do livramento",
    ],
    ["Xique-Xique", "xique xique", "xiquexique"],
    ["Embu-Guaçu", "embu guacu", "embuguacu"],
    ["Santa Bárbara d'Oeste", "santa barbara d oeste", "santa barbara doeste"],
    [
      "Frankfurt am Main-Höchst",
      "frankfurt am main hochst",
      "frankfurt am mainhochst",
    ],
  ])("%s dá as duas formas", (nome, comEspaco, emendado) => {
    expect(montagem.formasDeDigitar(nome)).toEqual([comEspaco, emendado]);
  });

  it("dá uma forma só quando o nome não tem pontuação — que é o caso comum", () => {
    expect(montagem.formasDeDigitar("São Paulo")).toEqual(["sao paulo"]);
    expect(montagem.formasDeDigitar("東京")).toEqual(["東京"]);
  });

  it("não devolve nada para texto vazio, em vez de um trecho em branco na chave", () => {
    expect(montagem.formasDeDigitar("")).toEqual([]);
    expect(montagem.formasDeDigitar("   ")).toEqual([]);
    expect(montagem.formasDeDigitar("-")).toEqual([]);
  });

  it("as duas formas continuam normalizadas, senão a busca do navegador não as reproduz", () => {
    for (const forma of montagem.formasDeDigitar("Sant'Ana do Livramento")) {
      expect(normalizarCidade(forma)).toBe(forma);
    }
  });
});

// ── montagem da chave de busca ──────────────────────────────────────────────

const apelido = (
  idioma: string,
  nome: string,
  extras: Record<string, unknown> = {}
) => ({
  idioma,
  nome,
  preferido: false,
  historico: false,
  ate: "",
  ...extras,
});

describe("montarChaveDeBusca", () => {
  it("começa sempre pelo nome canônico normalizado", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "München",
      apelidos: [apelido("en", "Munich")],
    });
    expect(chave.split("|")[0]).toBe("munchen");
  });

  it("guarda o nome nos 10 idiomas do site e descarta os outros", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "Köln",
      apelidos: [
        apelido("en", "Cologne"),
        apelido("ja", "ケルン"),
        apelido("el", "Κολωνία"), // grego: não é idioma do site
        apelido("hy", "Քյոլն"), // armênio: idem
        apelido("he", "קלן"), // hebraico: idem
      ],
    });
    const trechos = chave.split("|");
    expect(trechos).toContain("cologne");
    expect(trechos).toContain("ケルン");
    expect(chave).not.toContain("Κολωνία");
    expect(chave).not.toContain("קלן");
  });

  it("aceita a variante de país do idioma (pt-BR, zh-Hans, en-US)", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "London",
      apelidos: [
        apelido("pt-BR", "Londres"),
        apelido("zh-Hans", "伦敦"),
        apelido("en-US", "London Town"),
      ],
    });
    expect(chave.split("|")).toEqual(
      expect.arrayContaining(["londres", "伦敦", "london town"])
    );
  });

  it("recusa nome histórico: a cidade não se chama mais assim", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "Sankt-Peterburg",
      apelidos: [
        apelido("ru", "Ленинград", { historico: true }),
        apelido("pt", "São Petersburgo"),
      ],
    });
    expect(chave).toContain("sao petersburgo");
    expect(chave).not.toContain("ленинград");
  });

  it("recusa nome cuja vigência já terminou", () => {
    const chave = montagem.montarChaveDeBusca(
      {
        nome: "Mumbai",
        apelidos: [
          apelido("en", "Bombay", { ate: "1995" }),
          apelido("pt", "Bombaim"),
        ],
      },
      2026
    );
    expect(chave).toContain("bombaim");
    expect(chave).not.toContain("bombay");
  });

  it("recusa os pseudo-idiomas do dump (link, wkdt, post, iata...)", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "London",
      apelidos: [
        apelido("link", "https://en.wikipedia.org/wiki/London"),
        apelido("wkdt", "Q84"),
        apelido("iata", "LON"),
        apelido("post", "EC1"),
        apelido("pt", "Londres"),
      ],
    });
    expect(chave).toBe("london|londres");
  });

  it("põe o nome marcado como preferido na frente dos demais", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "Köln",
      apelidos: [
        apelido("en", "Cologne town"),
        apelido("en", "Cologne", { preferido: true }),
      ],
    });
    expect(chave.split("|")[1]).toBe("cologne");
  });

  it("não repete o mesmo nome duas vezes", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "São Paulo",
      asciiname: "Sao Paulo",
      apelidos: [
        apelido("pt", "São Paulo"),
        apelido("en", "Sao Paulo"),
        apelido("es", "SAO PAULO"),
      ],
    });
    expect(chave).toBe("sao paulo");
  });

  it("corta em 12 apelidos, para uma capital não inflar o arquivo do país", () => {
    const muitos = Array.from({ length: 40 }, (_, i) =>
      apelido("en", `Nome ${i}`)
    );
    const chave = montagem.montarChaveDeBusca({
      nome: "London",
      apelidos: muitos,
    });
    expect(chave.split("|")).toHaveLength(1 + montagem.TETO_DE_APELIDOS);
    expect(montagem.TETO_DE_APELIDOS).toBe(12);
  });

  it("ignora apelido vazio ou só com espaço", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "Doha",
      apelidos: [apelido("en", "   "), apelido("pt", "")],
    });
    expect(chave).toBe("doha");
  });

  it("guarda o nome com pontuação nas duas formas de digitar", () => {
    expect(
      montagem.montarChaveDeBusca({ nome: "Sant'Ana do Livramento" })
    ).toBe("sant ana do livramento|santana do livramento");
    expect(montagem.montarChaveDeBusca({ nome: "Xique-Xique" })).toBe(
      "xique xique|xiquexique"
    );
  });

  it("guarda as duas formas também dos apelidos em outros idiomas", () => {
    const chave = montagem.montarChaveDeBusca({
      nome: "Ciudad Juárez",
      apelidos: [apelido("en", "Juarez-City")],
    });
    expect(chave.split("|")).toEqual([
      "ciudad juarez",
      "juarez city",
      "juarezcity",
    ]);
  });

  it("o teto de 12 conta APELIDOS, não trechos: a segunda forma não come a vaga de ninguém", () => {
    // Doze apelidos com hífen dão 24 trechos, e os doze continuam inteiros.
    const muitos = Array.from({ length: 20 }, (_, i) =>
      apelido("en", `Nome-${i}`)
    );
    const chave = montagem.montarChaveDeBusca({
      nome: "London",
      apelidos: muitos,
    });
    const trechos = chave.split("|");
    expect(trechos[0]).toBe("london");
    expect(trechos).toHaveLength(1 + montagem.TETO_DE_APELIDOS * 2);
    expect(trechos).toContain("nome 11");
    expect(trechos).toContain("nome11");
    expect(trechos).not.toContain("nome 12");
  });
});

// ── leitura das linhas do dump ──────────────────────────────────────────────

describe("leitura das linhas do dump do GeoNames", () => {
  it("lê uma linha de cities5000.txt pelas colunas do readme", () => {
    const linha = [
      "2886242", // geonameid
      "Köln", // name
      "Cologne", // asciiname
      "Cologne,Colonia,Köln", // alternatenames (sem código de idioma: não serve)
      "50.93333",
      "6.95",
      "P",
      "PPLA2",
      "DE", // country code
      "",
      "05", // admin1
      "053",
      "05315",
      "",
      "1060582", // population
      "",
      "58",
      "Europe/Berlin",
      "2023-01-01",
    ].join("\t");
    expect(montagem.lerLinhaDeCidade(linha)).toEqual({
      id: "2886242",
      nome: "Köln",
      asciiname: "Cologne",
      pais: "DE",
      admin1: "05",
      populacao: 1060582,
    });
  });

  it("devolve null para linha vazia ou truncada, em vez de cidade pela metade", () => {
    expect(montagem.lerLinhaDeCidade("")).toBeNull();
    expect(montagem.lerLinhaDeCidade("   ")).toBeNull();
    expect(montagem.lerLinhaDeCidade("2886242\tKöln")).toBeNull();
  });

  it("lê uma linha de alternateNamesV2.txt, inclusive as marcas de preferido e histórico", () => {
    const linha = [
      "1580000",
      "2886242",
      "ja",
      "ケルン",
      "1",
      "",
      "",
      "",
      "",
      "",
    ].join("\t");
    expect(montagem.lerLinhaDeApelido(linha)).toEqual({
      id: "2886242",
      idioma: "ja",
      nome: "ケルン",
      preferido: true,
      historico: false,
      ate: "",
    });
  });

  it("lê o rótulo da divisão administrativa de admin1CodesASCII.txt", () => {
    const linha = [
      "DE.05",
      "Nordrhein-Westfalen",
      "Nordrhein-Westfalen",
      "2861876",
    ].join("\t");
    expect(montagem.lerLinhaDeAdmin1(linha)).toEqual({
      pais: "DE",
      codigo: "05",
      rotulo: "Nordrhein-Westfalen",
    });
  });
});

// ── que países a passada do GeoNames gera ───────────────────────────────────

describe("paisSaiDoGeoNames", () => {
  /**
   * A rodada mundial (`--entrada <pasta>`, sem `--paises`) passava por cima do
   * BR.json: o dump tem 4.422 registros brasileiros com população ≥ 5.000, e
   * eles substituíam os 5.571 municípios do IBGE sem que o comando dissesse em
   * lugar nenhum que o Brasil estava incluído.
   */
  it("deixa o Brasil de fora da rodada mundial, que é onde o estrago acontecia", () => {
    expect(montagem.paisSaiDoGeoNames("BR")).toBe(false);
    expect(montagem.paisSaiDoGeoNames("BR", null)).toBe(false);
    expect(montagem.PAIS_DO_IBGE).toBe("BR");
  });

  it("gera todo o resto do mundo na rodada sem --paises", () => {
    for (const pais of ["DE", "GB", "PT", "US", "JP", "AO"])
      expect(montagem.paisSaiDoGeoNames(pais)).toBe(true);
  });

  it("gera o Brasil pelo GeoNames quando alguém PEDE por --paises BR", () => {
    // Escolha explícita continua valendo: quem quiser comparar as duas fontes
    // escreve o nome do país e sabe o que está sobrescrevendo.
    expect(montagem.paisSaiDoGeoNames("BR", new Set(["BR"]))).toBe(true);
    expect(montagem.paisSaiDoGeoNames("BR", new Set(["BR", "PT"]))).toBe(true);
  });

  it("com --paises, gera só os pedidos", () => {
    const pedidos = new Set(["DE", "GB"]);
    expect(montagem.paisSaiDoGeoNames("DE", pedidos)).toBe(true);
    expect(montagem.paisSaiDoGeoNames("FR", pedidos)).toBe(false);
  });
});

describe("lerMunicipioDoIbge", () => {
  it("separa o nome da UF, que é rótulo e nunca valor gravado", () => {
    expect(montagem.lerMunicipioDoIbge("São Paulo (SP)")).toEqual({
      nome: "São Paulo",
      admin: "SP",
      populacao: 0,
    });
  });

  it("não se engana com parêntese que faz parte do nome", () => {
    expect(montagem.lerMunicipioDoIbge("Santa Isabel do Pará (PA)")?.nome).toBe(
      "Santa Isabel do Pará"
    );
  });

  it("devolve null para entrada fora do formato", () => {
    expect(montagem.lerMunicipioDoIbge("São Paulo")).toBeNull();
    expect(montagem.lerMunicipioDoIbge("São Paulo (São Paulo)")).toBeNull();
  });
});

describe("montarArquivoDePais", () => {
  const base = {
    pais: "XX",
    fonte: "teste",
    fonteUrl: "https://exemplo.invalido",
    admins: {},
  };
  const cidades = [
    { nome: "Pequena", admin: "A", populacao: 6000, chave: "pequena" },
    { nome: "Grande", admin: "A", populacao: 900000, chave: "grande" },
    { nome: "Media", admin: "B", populacao: 50000, chave: "media" },
  ];

  it("põe a cidade maior primeiro quando a fonte informa população", () => {
    const { arquivo } = montagem.montarArquivoDePais({
      ...base,
      ordem: "populacao-desc",
      cidades,
    });
    expect(arquivo.cidades.map((c: string[]) => c[0])).toEqual([
      "Grande",
      "Media",
      "Pequena",
    ]);
  });

  it("ordena em ordem alfabética quando não há população (caso do IBGE)", () => {
    const { arquivo } = montagem.montarArquivoDePais({
      ...base,
      ordem: "alfabetica",
      cidades,
    });
    expect(arquivo.cidades.map((c: string[]) => c[0])).toEqual(
      ["Grande", "Media", "Pequena"].sort()
    );
  });

  it("guarda três campos por cidade e NÃO guarda a população, que só serviu para ordenar", () => {
    const { arquivo } = montagem.montarArquivoDePais({
      ...base,
      ordem: "populacao-desc",
      cidades,
    });
    expect(arquivo.cidades[0]).toEqual(["Grande", "A", "grande"]);
    expect(JSON.stringify(arquivo)).not.toContain("900000");
  });

  it("não mexe na lista que recebeu: quem chama pode usá-la depois", () => {
    const entrada = [...cidades];
    montagem.montarArquivoDePais({
      ...base,
      ordem: "populacao-desc",
      cidades: entrada,
    });
    expect(entrada.map(c => c.nome)).toEqual(["Pequena", "Grande", "Media"]);
  });

  // ── o limite de 100 caracteres ────────────────────────────────────────────
  //
  // `user_profiles.city` é varchar(100) e o zod do servidor repete o max(100).
  // Sugerir na lista um nome que o próprio servidor recusaria seria entregar um
  // erro de gravação a quem escolheu da lista: o gerador descarta e RELATA.

  const nomeDe = (tamanho: number) => "A".repeat(tamanho);

  it("descarta o nome que não cabe em user_profiles.city e o devolve no relatório", () => {
    const gigante = nomeDe(montagem.LIMITE_DO_NOME + 1);
    const { arquivo, descartadas } = montagem.montarArquivoDePais({
      ...base,
      ordem: "alfabetica",
      cidades: [
        { nome: gigante, admin: "A", populacao: 0, chave: "gigante" },
        { nome: "Cabe", admin: "A", populacao: 0, chave: "cabe" },
      ],
    });
    expect(arquivo.cidades.map((c: string[]) => c[0])).toEqual(["Cabe"]);
    expect(descartadas).toEqual([gigante]);
  });

  it("aceita o nome de exatamente 100 caracteres: o limite é inclusivo, como o varchar", () => {
    const limite = nomeDe(montagem.LIMITE_DO_NOME);
    const { arquivo, descartadas } = montagem.montarArquivoDePais({
      ...base,
      ordem: "alfabetica",
      cidades: [{ nome: limite, admin: "A", populacao: 0, chave: "limite" }],
    });
    expect(arquivo.cidades).toHaveLength(1);
    expect(descartadas).toEqual([]);
    expect(montagem.LIMITE_DO_NOME).toBe(100);
  });

  it("descarta em silêncio nunca: sem nome grande, o relatório vem vazio", () => {
    const { descartadas } = montagem.montarArquivoDePais({
      ...base,
      ordem: "populacao-desc",
      cidades,
    });
    expect(descartadas).toEqual([]);
  });

  // ── cabeçalho estável ─────────────────────────────────────────────────────

  it("grava a origem do dado, e nenhuma data: o mesmo dado dá o mesmo arquivo", () => {
    const uma = montagem.montarArquivoDePais({
      ...base,
      ordem: "populacao-desc",
      cidades,
    }).arquivo;
    const outra = montagem.montarArquivoDePais({
      ...base,
      ordem: "populacao-desc",
      cidades,
    }).arquivo;
    expect(JSON.stringify(uma)).toBe(JSON.stringify(outra));
    expect(uma.fonte).toBe("teste");
    expect(uma.fonteUrl).toBe("https://exemplo.invalido");
    // A data de hoje quebrava a promessa: dois arquivos diferentes do mesmo dado.
    expect(Object.keys(uma)).not.toContain("gerado");
    expect(JSON.stringify(uma)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// ── o Brasil inteiro, montado sem tocar em disco ────────────────────────────

describe("montarArquivoDoBrasil", () => {
  const bruto = ["São Paulo (SP)", "Xique-Xique (BA)", "Bom Jesus (PI)"];

  it("monta o arquivo do país a partir da lista crua do IBGE", () => {
    const { arquivo } = montagem.montarArquivoDoBrasil(bruto);
    expect(arquivo.pais).toBe("BR");
    expect(arquivo.ordem).toBe("alfabetica");
    expect(arquivo.fonte).toContain("IBGE");
    expect(arquivo.fonteUrl).toBe("https://www.ibge.gov.br");
    expect(arquivo.cidades).toEqual([
      ["Bom Jesus", "PI", "bom jesus"],
      ["São Paulo", "SP", "sao paulo"],
      ["Xique-Xique", "BA", "xique xique|xiquexique"],
    ]);
    expect(arquivo.admins).toEqual({ SP: "São Paulo", BA: "Bahia", PI: "Piauí" });
  });

  it("relata a entrada fora do formato em vez de engoli-la", () => {
    const { arquivo, foraDoFormato } = montagem.montarArquivoDoBrasil([
      ...bruto,
      "Cidade sem UF",
    ]);
    expect(foraDoFormato).toEqual(["Cidade sem UF"]);
    expect(arquivo.cidades).toHaveLength(3);
  });

  it("relata o nome que passa de 100 caracteres", () => {
    const gigante = `${"A".repeat(101)} (SP)`;
    const { arquivo, descartadas } = montagem.montarArquivoDoBrasil([
      ...bruto,
      gigante,
    ]);
    expect(descartadas).toEqual(["A".repeat(101)]);
    expect(arquivo.cidades).toHaveLength(3);
  });
});
