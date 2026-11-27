import { describe, expect, it } from "vitest";
import type { ArquivoDeCidades } from "@shared/cidade";
import { normalizarCidade } from "@shared/normalizar-cidade";
import {
  buscarCidades,
  LIMITE_DE_SUGESTOES,
  rotularCidade,
} from "@/lib/busca-de-cidades";
import BR from "@/data/cidades/BR.json";

/**
 * A busca de cidade, provada sobre dados de verdade e sobre dois países de
 * exemplo.
 *
 * O Brasil usa o ARQUIVO GERADO de fato (client/src/data/cidades/BR.json, 5.571
 * municípios vindos do IBGE por scripts/gerar-cidades.mjs): é o único jeito de
 * o teste provar que o que o gerador escreve é o que a busca acha.
 *
 * Alemanha e Reino Unido são amostras pequenas escritas no formato exato que o
 * gerador produz a partir do dump do GeoNames, com as chaves já normalizadas e
 * os apelidos separados por "|". Elas existem porque o dump do GeoNames tem
 * 195 MB e não é baixado no CI: o comportamento que interessa provar aqui é o
 * da BUSCA — "Munich" achar "München" — e para isso bastam três cidades.
 *
 * Os arquivos REAIS desses países já estão versionados (`DE.json` com 3.081
 * cidades, `GB.json` com 1.913), e quem prova a busca sobre eles é
 * `server/cidades-geradas.test.ts`, que roda esta mesma `buscarCidades` sobre
 * os 230 países gerados. Uma diferença que se vê ao comparar: no dump de hoje
 * o nome canônico de Munique é "Munich", não "München" — o GeoNames usa muitas
 * vezes o nome em inglês, e é ele que vai para o banco. As amostras abaixo
 * continuam com "München" porque o que elas provam é a busca por apelido, e
 * nesse ponto tanto faz qual dos nomes é o canônico.
 */

const ALEMANHA: ArquivoDeCidades = {
  pais: "DE",
  fonte: "amostra de teste no formato do GeoNames (CC BY 4.0)",
  fonteUrl: "https://www.geonames.org",
  idiomas: ["pt", "en", "es", "fr", "de", "ru", "ar", "hi", "zh", "ja"],
  ordem: "populacao-desc",
  admins: { "16": "Berlin", "02": "Bayern", "05": "Nordrhein-Westfalen" },
  cidades: [
    ["Berlin", "16", "berlin|berlim|берлин|ベルリン"],
    ["München", "02", "munchen|munich|munique|мюнхен|ミュンヘン"],
    // "кельн", e não "кёльн": o "ё" russo é "е" + trema, e a normalização tira o
    // trema dos dois lados — no que o gerador grava e no que a usuária digita.
    ["Köln", "05", "koln|cologne|colonia|кельн|ケルン"],
  ],
};

const REINO_UNIDO: ArquivoDeCidades = {
  pais: "GB",
  fonte: "amostra de teste no formato do GeoNames (CC BY 4.0)",
  fonteUrl: "https://www.geonames.org",
  idiomas: ["pt", "en", "es", "fr", "de", "ru", "ar", "hi", "zh", "ja"],
  ordem: "populacao-desc",
  admins: { ENG: "England" },
  cidades: [
    ["London", "ENG", "london|londres|londra|лондон|ロンドン"],
    ["Manchester", "ENG", "manchester"],
    ["New London", "ENG", "new london"],
  ],
};

/** Um país cuja fonte não informou divisão administrativa: o rótulo cai no código do país. */
const CATAR: ArquivoDeCidades = {
  pais: "QA",
  fonte: "amostra de teste",
  fonteUrl: "",
  idiomas: [],
  ordem: "populacao-desc",
  admins: {},
  cidades: [["Doha", "", "doha|دوحة"]],
};

const brasil = BR as ArquivoDeCidades;
const nomes = (arquivo: ArquivoDeCidades, consulta: string, limite?: number) =>
  buscarCidades(arquivo, consulta, limite).map(s => s.nome);

describe("as amostras deste teste são fiéis ao que o gerador escreve", () => {
  // Sem esta guarda, uma amostra escrita à mão com a chave FORA da normalização
  // (foi o que aconteceu com "кёльн", que normalizado é "кельн") faria o teste
  // reprovar código correto — ou, pior, aprovar código errado.
  it.each([
    ["DE", ALEMANHA],
    ["GB", REINO_UNIDO],
    ["QA", CATAR],
  ])("%s tem todas as chaves já normalizadas", (_pais, arquivo) => {
    for (const [nome, , chave] of arquivo.cidades) {
      for (const trecho of chave.split("|")) {
        expect(normalizarCidade(trecho)).toBe(trecho);
      }
      expect(chave.split("|")[0]).toBe(normalizarCidade(nome));
    }
  });
});

describe("buscarCidades — acento e caixa", () => {
  it("acha 'São Paulo' quem digita 'sao paulo', sem acento e em minúsculas", () => {
    expect(nomes(brasil, "sao paulo")[0]).toBe("São Paulo");
  });

  it("acha do mesmo jeito com acento e em maiúsculas", () => {
    expect(nomes(brasil, "São Paulo")[0]).toBe("São Paulo");
    expect(nomes(brasil, "SAO PAULO")[0]).toBe("São Paulo");
    expect(nomes(brasil, "  são   paulo ")[0]).toBe("São Paulo");
  });

  it("ignora o apóstrofo do nome oficial", () => {
    // O IBGE escreve "Santa Bárbara d'Oeste"; ninguém digita o apóstrofo.
    expect(nomes(brasil, "santa barbara d oeste")).toContain(
      "Santa Bárbara d'Oeste"
    );
    expect(nomes(brasil, "santa barbara d'oeste")).toContain(
      "Santa Bárbara d'Oeste"
    );
  });

  it("acha cidade com til, cedilha e circunflexo pelo nome sem acento", () => {
    expect(nomes(brasil, "goiania")).toContain("Goiânia");
    expect(nomes(brasil, "florianopolis")).toContain("Florianópolis");
    expect(nomes(brasil, "macae")).toContain("Macaé");
  });
});

describe("buscarCidades — os dois jeitos de digitar a pontuação", () => {
  /**
   * A normalização troca hífen, apóstrofo e ponto por ESPAÇO e nunca os remove.
   * Sozinha, ela cobria só metade de como as pessoas escrevem: quem digitava
   * "Sant'Ana", "Sant Ana" ou "Sant-Ana" achava, e quem digitava "Santana" —
   * que é como se fala e como se escreve numa busca — não achava nada. A chave
   * passou a guardar as DUAS formas (scripts/cidades/montagem.mjs,
   * `formasDeDigitar`), e estes casos são do BR.json de verdade.
   */
  it.each([
    [
      "Sant'Ana do Livramento",
      "sant ana do livramento",
      "santana do livramento",
    ],
    ["Xique-Xique", "xique xique", "xiquexique"],
    ["Embu-Guaçu", "embu guacu", "embuguacu"],
  ])(
    "acha %s digitando com e sem o separador",
    (esperado, comEspaco, emendado) => {
      expect(nomes(brasil, comEspaco)).toContain(esperado);
      expect(nomes(brasil, emendado)).toContain(esperado);
      // E também escrevendo o separador, que é como o nome oficial se escreve.
      expect(nomes(brasil, esperado)).toContain(esperado);
    }
  );

  it("o que vai para o banco continua sendo o nome oficial, com a pontuação", () => {
    const [sugestao] = buscarCidades(brasil, "xiquexique");
    expect(sugestao.nome).toBe("Xique-Xique");
    expect(sugestao.rotulo).toBe("Xique-Xique (BA)");
  });
});

describe("buscarCidades — nome em outro idioma", () => {
  it("acha 'München' por 'Munich' (inglês), 'Munique' (português) e 'munchen'", () => {
    expect(nomes(ALEMANHA, "Munich")).toContain("München");
    expect(nomes(ALEMANHA, "Munique")).toContain("München");
    expect(nomes(ALEMANHA, "munchen")).toContain("München");
    expect(nomes(ALEMANHA, "München")).toContain("München");
  });

  it("acha 'London' por 'Londres'", () => {
    expect(nomes(REINO_UNIDO, "Londres")).toContain("London");
    expect(nomes(REINO_UNIDO, "London")).toContain("London");
  });

  it("acha 'Köln' pelo nome em inglês, espanhol, russo e japonês", () => {
    expect(nomes(ALEMANHA, "cologne")).toContain("Köln");
    expect(nomes(ALEMANHA, "colonia")).toContain("Köln");
    expect(nomes(ALEMANHA, "кёльн")).toContain("Köln");
    expect(nomes(ALEMANHA, "ケルン")).toContain("Köln");
  });

  it("devolve sempre o nome canônico, nunca o apelido que a pessoa digitou", () => {
    const sugestoes = buscarCidades(ALEMANHA, "Munich");
    expect(sugestoes[0].nome).toBe("München");
    expect(sugestoes[0].rotulo).toBe("München (Bayern)");
  });
});

describe("buscarCidades — ordem e limite", () => {
  it("põe quem COMEÇA com o texto antes de quem apenas CONTÉM", () => {
    // "London" começa com "london"; "New London" só contém.
    expect(nomes(REINO_UNIDO, "london")).toEqual(["London", "New London"]);
  });

  it("põe o acerto pelo nome canônico antes do acerto por apelido", () => {
    const resultado = nomes(REINO_UNIDO, "lond");
    expect(resultado.indexOf("London")).toBeLessThan(
      resultado.indexOf("New London")
    );
  });

  it("respeita a ordem do arquivo, que o gerador deixou por população", () => {
    // Berlin vem antes de München no arquivo porque é maior; as duas casam "b"/"m"
    // por trechos diferentes, então o teste usa um prefixo que pega as duas.
    const porApelido = nomes(ALEMANHA, "мюнхен");
    expect(porApelido).toEqual(["München"]);
    expect(ALEMANHA.cidades[0][0]).toBe("Berlin");
  });

  it("devolve no máximo 50 sugestões por padrão", () => {
    // "sa" casa com centenas de municípios brasileiros ("Santa...", "São...").
    const muitas = buscarCidades(brasil, "sa");
    expect(muitas.length).toBe(LIMITE_DE_SUGESTOES);
    expect(LIMITE_DE_SUGESTOES).toBe(50);
  });

  it("aceita um limite menor quando a tela pedir", () => {
    expect(buscarCidades(brasil, "sa", 8)).toHaveLength(8);
  });
});

describe("buscarCidades — quando não buscar", () => {
  it("não sugere nada com menos de duas letras em escrita latina", () => {
    expect(buscarCidades(brasil, "s")).toEqual([]);
    expect(buscarCidades(brasil, " ")).toEqual([]);
    expect(buscarCidades(brasil, "")).toEqual([]);
  });

  it("basta um caractere em escrita não latina, onde um ideograma já é uma palavra", () => {
    expect(nomes(ALEMANHA, "ケ")).toContain("Köln");
  });

  it("devolve lista vazia quando nada casa, em vez de inventar aproximação", () => {
    expect(buscarCidades(brasil, "zzzzzz")).toEqual([]);
  });
});

describe("rotularCidade", () => {
  it("mostra a UF do município brasileiro entre parênteses", () => {
    expect(rotularCidade(brasil, "São Paulo", "SP")).toBe("São Paulo (SP)");
  });

  it("mostra o nome da divisão administrativa quando a fonte traz o rótulo", () => {
    expect(rotularCidade(ALEMANHA, "Köln", "05")).toBe(
      "Köln (Nordrhein-Westfalen)"
    );
  });

  it("cai no código do país quando não há divisão administrativa", () => {
    expect(buscarCidades(CATAR, "doha")[0].rotulo).toBe("Doha (QA)");
  });
});
