import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizarCidade } from "@shared/normalizar-cidade";
import { buscarCidades } from "@/lib/busca-de-cidades";
import type { ArquivoDeCidades } from "@shared/cidade";
// @ts-expect-error módulo .mjs sem tipos (mesmo caso de server/cidades-montagem.test.ts)
import * as montagem from "../scripts/cidades/montagem.mjs";

/**
 * Confere os arquivos de cidade VERSIONADOS em client/src/data/cidades/, os
 * mesmos que o navegador baixa — hoje o mundo inteiro: 230 países, 70.221
 * cidades (5.571 do IBGE no Brasil, 64.650 do GeoNames no resto).
 *
 * Por que isto existe: os arquivos são gerados por um comando que ninguém roda
 * no CI (`node scripts/gerar-cidades.mjs`, que precisa de 200 MB de dump), e um
 * arquivo gerado por uma versão antiga do script, ou editado à mão "só para
 * acrescentar uma cidade", quebra a busca em silêncio — a chave deixa de bater
 * com a normalização do navegador e o campo simplesmente para de sugerir. Aqui
 * a chave de cada cidade é RECALCULADA e comparada com a que está no arquivo.
 *
 * As conferências varrem o conjunto TODO e juntam os defeitos numa lista, em
 * vez de um `expect` por cidade: 70 mil cidades vezes seis regras dariam meio
 * milhão de asserções e um relatório ilegível. Quando algo falha, a mensagem
 * nomeia o país e a cidade.
 */

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASTA = path.join(RAIZ, "client", "src", "data", "cidades");

const nomesDeArquivo = readdirSync(PASTA)
  .filter(nome => nome.endsWith(".json"))
  .sort();

interface Lista {
  nome: string;
  bytes: number;
  arquivo: ArquivoDeCidades;
}

const listas: Lista[] = nomesDeArquivo.map(nome => ({
  nome,
  bytes: statSync(path.join(PASTA, nome)).size,
  arquivo: JSON.parse(
    readFileSync(path.join(PASTA, nome), "utf8")
  ) as ArquivoDeCidades,
}));

const listaDe = (pais: string): ArquivoDeCidades => {
  const achada = listas.find(l => l.arquivo.pais === pais);
  if (!achada) throw new Error(`sem lista gerada para ${pais}`);
  return achada.arquivo;
};

const totalDeCidades = listas.reduce((s, l) => s + l.arquivo.cidades.length, 0);
const pesoTotal = listas.reduce((s, l) => s + l.bytes, 0);

/** Os cinco primeiros defeitos e a conta do resto: o erro precisa caber na tela. */
function amostraDe(problemas: string[], quantos = 5): string[] {
  if (problemas.length <= quantos) return problemas;
  return [
    ...problemas.slice(0, quantos),
    `...e mais ${problemas.length - quantos}`,
  ];
}

/** Varre cidade por cidade de todos os países, acumulando o que estiver errado. */
function varrer(
  regra: (
    cidade: readonly [string, string, string],
    arquivo: ArquivoDeCidades
  ) => string | null
): string[] {
  const problemas: string[] = [];
  for (const { arquivo } of listas) {
    for (const cidade of arquivo.cidades) {
      const erro = regra(cidade, arquivo);
      if (erro) problemas.push(`${arquivo.pais}: ${erro}`);
    }
  }
  return problemas;
}

// ── o conjunto ──────────────────────────────────────────────────────────────

describe("o conjunto de listas em client/src/data/cidades/", () => {
  it("cobre o mundo, e não um país só", () => {
    // Antes só havia BR.json, e quem marcava outro país digitava no escuro.
    expect(listas.length).toBeGreaterThanOrEqual(200);
    expect(totalDeCidades).toBeGreaterThanOrEqual(60_000);
  });

  it("tem lista para TODOS os países que a tela de cadastro oferece", () => {
    // Estes são os 16 do seletor de país de Onboarding.tsx (o "XX", de "Outro",
    // não é país e cai em texto livre). Uma lista faltando não dá erro nenhum:
    // o campo só volta a ser texto livre naquele país, e ninguém percebe até
    // alguém reclamar.
    const doCadastro = [
      "BR",
      "PT",
      "US",
      "AR",
      "CL",
      "MX",
      "CO",
      "DE",
      "FR",
      "GB",
      "ES",
      "IT",
      "JP",
      "CN",
      "IN",
      "AE",
    ];
    // E mais os de fora do seletor onde a rede tem gente, que chegam pelo dia
    // em que a lista de países deixar de ser escrita à mão.
    const outros = ["AO", "MZ", "CV", "CH", "CA", "ZA", "AU"];
    const paises = new Set(listas.map(l => l.arquivo.pais));
    expect([...doCadastro, ...outros].filter(p => !paises.has(p))).toEqual([]);
  });

  it("o nome do arquivo é sempre o código do país que está lá dentro", () => {
    // `carregarCidadesDoPais` monta o caminho com o código do país: se o nome
    // do arquivo divergir do campo `pais`, o país carrega a lista de outro.
    const problemas = listas
      .filter(
        l =>
          l.arquivo.pais !== l.nome.replace(".json", "") ||
          !/^[A-Z]{2}$/.test(l.arquivo.pais)
      )
      .map(l => `${l.nome} diz pais="${l.arquivo.pais}"`);
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("nenhum país fica pesado demais para o navegador", () => {
    // O navegador baixa UM país por vez (o glob do Vite gera um pedaço com
    // hash por arquivo), então o que conta para quem se cadastra é o arquivo do
    // país dela: o maior hoje é o US.json, com 512 KB crus e 196 KB no gzip que
    // o servidor envia. O teto do conjunto é do repositório, não da tela —
    // 3,8 MB hoje, e quem baixar o dump com --minimo menor precisa ver o
    // estrago antes de commitar.
    const gordos = listas
      .filter(l => l.bytes > 1_000_000)
      .map(l => `${l.nome} com ${Math.round(l.bytes / 1024)} KB`);
    expect(amostraDe(gordos)).toEqual([]);
    expect(pesoTotal).toBeLessThan(8 * 1024 * 1024);
  });
});

// ── o crédito que a licença exige ───────────────────────────────────────────

describe("cabeçalho: o crédito que a licença exige", () => {
  it("todo arquivo diz de onde o dado veio, com endereço", () => {
    // PaisEstadoCidade monta o crédito com `fonte` e `fonteUrl`. Arquivo sem eles
    // é arquivo que aparece na tela sem creditar ninguém — e os dados do
    // GeoNames são CC BY 4.0, que exige atribuição visível com link.
    const problemas = listas
      .filter(
        l =>
          !l.arquivo.fonte ||
          typeof l.arquivo.fonteUrl !== "string" ||
          !/^https:\/\//.test(l.arquivo.fonteUrl)
      )
      .map(
        l => `${l.nome}: fonte="${l.arquivo.fonte}" url="${l.arquivo.fonteUrl}"`
      );
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("todo país fora do Brasil credita o GeoNames E a licença", () => {
    // O nome da licença faz parte do crédito: "GeoNames" sozinho não diz sob
    // que condição o dado pode ser usado.
    const problemas = listas
      .filter(l => l.arquivo.pais !== "BR")
      .filter(
        l =>
          !l.arquivo.fonte.includes("GeoNames") ||
          !l.arquivo.fonte.includes("CC BY 4.0") ||
          l.arquivo.fonteUrl !== "https://www.geonames.org"
      )
      .map(l => `${l.nome}: "${l.arquivo.fonte}"`);
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("declara em todo país os 10 idiomas cujos nomes entraram na chave", () => {
    const problemas = listas
      .filter(
        l => l.arquivo.idiomas.join(",") !== montagem.IDIOMAS_DO_SITE.join(",")
      )
      .map(l => `${l.nome}: ${l.arquivo.idiomas.join(",")}`);
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("declara uma ordem conhecida e nunca vem vazio", () => {
    const problemas = listas
      .filter(
        l =>
          !["populacao-desc", "alfabetica"].includes(l.arquivo.ordem) ||
          !Array.isArray(l.arquivo.cidades) ||
          l.arquivo.cidades.length === 0
      )
      .map(
        l =>
          `${l.nome}: ordem="${l.arquivo.ordem}" cidades=${l.arquivo.cidades?.length}`
      );
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("não carimba a data de geração, que faria a regeração mentir no diff", () => {
    // Com a data de hoje no cabeçalho, rodar o gerador duas vezes sobre a mesma
    // fonte dava dois arquivos diferentes e ninguém conseguia distinguir
    // "a lista mudou" de "alguém rodou o script".
    const problemas = listas
      .filter(
        l =>
          "gerado" in l.arquivo ||
          /\d{4}-\d{2}-\d{2}/.test(JSON.stringify(l.arquivo).slice(0, 400))
      )
      .map(l => l.nome);
    expect(amostraDe(problemas)).toEqual([]);
  });
});

// ── cada linha de cidade, nos 230 arquivos ──────────────────────────────────

describe("cada linha de cidade, no conjunto inteiro", () => {
  it("é uma tupla [nome, admin, chave] sem campo vazio", () => {
    const problemas = varrer(cidade => {
      if (cidade.length !== 3) return `linha com ${cidade.length} campos`;
      const [nome, admin, chave] = cidade;
      if (typeof nome !== "string" || !nome || nome.trim() !== nome)
        return `nome inválido: "${nome}"`;
      if (typeof admin !== "string") return `admin inválido em "${nome}"`;
      if (typeof chave !== "string" || !chave)
        return `chave vazia em "${nome}"`;
      return null;
    });
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("tem toda chave JÁ normalizada — é o que faz a busca achar", () => {
    // A conferência que dá sentido ao arquivo inteiro: a chave gravada pelo
    // gerador (.mjs) precisa ser byte a byte a que o navegador calcula
    // (shared/normalizar-cidade.ts) a cada tecla digitada.
    const problemas = varrer(([nome, , chave]) => {
      if (chave.split("|")[0] !== normalizarCidade(nome))
        return `"${nome}": a chave não começa pelo nome normalizado (${chave.split("|")[0]})`;
      for (const trecho of chave.split("|")) {
        if (!trecho) return `"${nome}": trecho vazio na chave`;
        if (normalizarCidade(trecho) !== trecho)
          return `"${nome}": trecho fora da normalização ("${trecho}")`;
      }
      return null;
    });
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("não repete o mesmo apelido dentro de uma chave", () => {
    const problemas = varrer(([nome, , chave]) => {
      const trechos = chave.split("|");
      return new Set(trechos).size === trechos.length
        ? null
        : `"${nome}": trecho repetido em "${chave}"`;
    });
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("só usa código de divisão administrativa que tenha rótulo", () => {
    // Sem rótulo a sugestão mostraria o código cru do GeoNames ("Köln (07)").
    const problemas = varrer(([nome, admin], arquivo) =>
      !admin || admin in arquivo.admins
        ? null
        : `"${nome}": divisão "${admin}" sem rótulo`
    );
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("não sugere cidade que o banco recusaria: nome dentro de varchar(100)", () => {
    // `user_profiles.city` é varchar(100) e o zod do servidor repete o max(100).
    // Uma sugestão maior que isso seria escolhida da lista e recusada na
    // gravação — erro entregue pronto a quem fez tudo certo.
    const problemas = varrer(([nome]) =>
      nome.length <= montagem.LIMITE_DO_NOME
        ? null
        : `"${nome}" tem ${nome.length} caracteres`
    );
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("nunca guarda a divisão administrativa dentro do nome", () => {
    // O campo antigo mostrava "São Paulo (SP)" na lista e arrancava o " (SP)" a
    // cada tecla digitada. Agora a UF é rótulo e o nome é só o nome: se um
    // "(SP)" voltar para dentro do nome, é isso que vai parar no banco.
    const problemas = varrer(([nome]) =>
      /\([A-Z]{2}\)$/.test(nome) ? `"${nome}"` : null
    );
    expect(amostraDe(problemas)).toEqual([]);
  });

  it("está na ordem que o cabeçalho declara, onde dá para conferir", () => {
    // Só a alfabética é conferível pelo arquivo: a população, que ordena as
    // demais, fica de fora de propósito (seria peso morto no JSON).
    const problemas: string[] = [];
    for (const { nome, arquivo } of listas) {
      if (arquivo.ordem !== "alfabetica") continue;
      const nomes = arquivo.cidades.map(c => c[0]);
      const ordenados = [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR"));
      if (nomes.join("|") !== ordenados.join("|"))
        problemas.push(`${nome} fora da ordem alfabética`);
    }
    expect(amostraDe(problemas)).toEqual([]);
  });
});

// ── os casos reais, lidos dos arquivos que o gerador escreveu ───────────────

/**
 * Aqui a busca de verdade (client/src/lib/busca-de-cidades.ts) roda sobre os
 * arquivos de verdade. É a diferença entre "a chave tem o texto certo" e "quem
 * digita acha a cidade": os testes de client/src/lib/busca-de-cidades.test.ts
 * provam a BUSCA sobre amostras de três cidades; estes provam o CONJUNTO
 * GERADO, com a cidade que a usuária escreveria.
 *
 * Uma coisa salta aos olhos e é da FONTE, não do gerador: o nome canônico do
 * GeoNames é muitas vezes o nome em inglês — "Munich", "Lisbon", "Rome",
 * "Mexico City" —, e é ele que vai para o banco quando a usuária escolhe da
 * lista. Os nomes em português estão na chave (a busca acha "Munique" e
 * "Lisboa"), mas não são os mostrados. Está anotado em docs/arquitetura/cidades.md
 * como decisão em aberto; os testes abaixo afirmam o que o arquivo tem HOJE.
 */
describe("casos reais, lidos dos arquivos gerados", () => {
  const alemanha = listaDe("DE");
  const reinoUnido = listaDe("GB");
  const brasil = listaDe("BR");

  it("'Munich', 'München', 'Munique' e 'ミュンヘン' acham a MESMA cidade alemã", () => {
    const grafias = ["Munich", "München", "Munique", "ミュンヘン"];
    const primeiras = grafias.map(g => buscarCidades(alemanha, g)[0]);
    expect(primeiras.filter(Boolean)).toHaveLength(grafias.length);
    // Uma cidade só, e é a da Baviera — não uma homônima qualquer.
    expect(new Set(primeiras.map(s => s.nome)).size).toBe(1);
    expect(primeiras[0].nome).toBe("Munich");
    expect(primeiras[0].rotulo).toBe("Munich (Bavaria)");
  });

  it("'Londres' e 'London' acham a mesma cidade inglesa", () => {
    const [porPortugues] = buscarCidades(reinoUnido, "Londres");
    const [porIngles] = buscarCidades(reinoUnido, "London");
    expect(porPortugues.nome).toBe("London");
    expect(porIngles.nome).toBe("London");
    expect(porIngles.rotulo).toBe("London (England)");
    // E a mesma cidade responde em russo e em japonês, que estão na chave.
    expect(buscarCidades(reinoUnido, "лондон")[0].nome).toBe("London");
    expect(buscarCidades(reinoUnido, "ロンドン")[0].nome).toBe("London");
  });

  it("'sao paulo', sem acento e em minúsculas, acha São Paulo", () => {
    expect(buscarCidades(brasil, "sao paulo")[0]).toEqual({
      nome: "São Paulo",
      rotulo: "São Paulo (SP)",
    });
  });

  it("'santana do livramento', como se fala, acha Sant'Ana do Livramento", () => {
    // A normalização vira o apóstrofo em espaço; a segunda forma da chave é o
    // que salva quem digita emendado.
    for (const digitado of [
      "santana do livramento",
      "sant ana do livramento",
      "Sant'Ana do Livramento",
    ]) {
      expect(buscarCidades(brasil, digitado)[0].nome).toBe(
        "Sant'Ana do Livramento"
      );
    }
  });

  it("o nome que não cabe no banco não entra, e o de 97 caracteres entra", () => {
    // O dump de hoje não tem nenhum nome acima de 100 caracteres: o maior do
    // mundo é um município canadense com 97, e ele ESTÁ na lista. Então a prova
    // do descarte é feita com esse nome real esticado além do limite, pelo
    // mesmo caminho de código que escreveu os 230 arquivos.
    const nomes = listas.flatMap(l => l.arquivo.cidades.map(c => c[0]));
    const maior = nomes.reduce((a, b) => (b.length > a.length ? b : a));
    expect(maior.length).toBeGreaterThan(90);
    expect(maior.length).toBeLessThanOrEqual(montagem.LIMITE_DO_NOME);

    const esticado = maior.padEnd(montagem.LIMITE_DO_NOME + 1, "s");
    const { arquivo, descartadas } = montagem.montarArquivoDePais({
      pais: "XX",
      fonte: "teste",
      fonteUrl: "https://exemplo.invalido",
      ordem: "alfabetica",
      admins: {},
      cidades: [
        {
          nome: maior,
          admin: "",
          populacao: 0,
          chave: normalizarCidade(maior),
        },
        {
          nome: esticado,
          admin: "",
          populacao: 0,
          chave: normalizarCidade(esticado),
        },
      ],
    });
    expect(arquivo.cidades.map((c: string[]) => c[0])).toEqual([maior]);
    expect(descartadas).toEqual([esticado]);
  });
});

// ── o Brasil ────────────────────────────────────────────────────────────────

describe("BR.json — a lista do IBGE", () => {
  const brasil = listaDe("BR");

  it("tem os 5.571 municípios brasileiros", () => {
    expect(brasil.cidades).toHaveLength(5571);
  });

  it("tem as 27 unidades da federação, com o nome por extenso como rótulo", () => {
    expect(Object.keys(brasil.admins)).toHaveLength(27);
    expect(brasil.admins.SP).toBe("São Paulo");
    expect(brasil.admins.DF).toBe("Distrito Federal");
    // Nenhuma UF ficou só com a sigla: o seletor de estado mostraria "SP".
    for (const [sigla, nome] of Object.entries(brasil.admins)) expect(nome).not.toBe(sigla);
  });

  it("credita o IBGE", () => {
    expect(brasil.fonte).toContain("IBGE");
    expect(brasil.fonteUrl).toBe("https://www.ibge.gov.br");
  });

  it("guarda São Paulo com o nome que vai para o banco e a UF à parte", () => {
    const saoPaulo = brasil.cidades.find(c => c[0] === "São Paulo");
    expect(saoPaulo).toEqual(["São Paulo", "SP", "sao paulo"]);
  });

  it("mantém os homônimos separados pela UF", () => {
    const bonsJesus = brasil.cidades.filter(c => c[0] === "Bom Jesus");
    expect(bonsJesus.length).toBeGreaterThan(1);
    expect(new Set(bonsJesus.map(c => c[1])).size).toBe(bonsJesus.length);
  });

  it("guarda as duas formas de digitar o nome com pontuação", () => {
    // Antes a chave só tinha a forma com espaço, e quem digitava "santana",
    // "xiquexique" ou "embuguacu" — que é como se fala — não achava nada.
    const chaveDe = (nomeDaCidade: string) =>
      brasil.cidades.find(c => c[0] === nomeDaCidade)?.[2];
    expect(chaveDe("Sant'Ana do Livramento")).toBe(
      "sant ana do livramento|santana do livramento"
    );
    expect(chaveDe("Xique-Xique")).toBe("xique xique|xiquexique");
    expect(chaveDe("Embu-Guaçu")).toBe("embu guacu|embuguacu");
  });

  it("é EXATAMENTE o que o gerador escreve hoje a partir do arquivo do IBGE", () => {
    // O teste mais importante deste arquivo. Ele prova as duas coisas de uma
    // vez: que o BR.json versionado não foi editado à mão nem gerado por uma
    // versão antiga do script, e que rodar `node scripts/gerar-cidades.mjs
    // --ibge` de novo dá byte a byte o mesmo arquivo — o que só passou a valer
    // quando o cabeçalho deixou de carimbar a data de hoje.
    const bruto = JSON.parse(
      readFileSync(
        path.join(RAIZ, "client", "src", "data", "municipios-br.json"),
        "utf8"
      )
    );
    const { arquivo, descartadas, foraDoFormato } =
      montagem.montarArquivoDoBrasil(bruto);
    expect(descartadas).toEqual([]);
    expect(foraDoFormato).toEqual([]);
    expect(JSON.stringify(arquivo)).toBe(JSON.stringify(brasil));
  });

  it("não foi trocado pela lista menor do GeoNames na rodada mundial", () => {
    // `node scripts/gerar-cidades.mjs --entrada <pasta>` percorre o mundo
    // inteiro, e o dump tem 4.422 registros brasileiros: sem a guarda de
    // `paisSaiDoGeoNames`, uma rodada mundial substituía os 5.571 municípios do
    // IBGE por eles, misturando distrito com município, sem que o comando
    // dissesse em lugar nenhum que o Brasil estava incluído.
    expect(brasil.fonte).not.toContain("GeoNames");
    expect(brasil.ordem).toBe("alfabetica");
    expect(brasil.cidades.length).toBeGreaterThan(5000);
  });
});

// ── higiene dos arquivos de código da busca ────────────────────────────────

describe("o código da busca de cidade não tem byte nulo", () => {
  /**
   * `client/src/lib/busca-de-cidades.ts` chegou a trazer um byte 0x00 LITERAL
   * dentro da classe de caracteres que separa escrita latina do resto — o byte
   * escrito com a tecla, em vez da forma de seis caracteres que começa com uma
   * barra invertida. O código funcionava, e era justamente esse o
   * problema: o git e o grep passam a tratar o arquivo como BINÁRIO ("Binary
   * file ... matches"), o diff some da revisão e ninguém vê o que mudou ali.
   */
  // Os testes entram na lista junto com o código: escrever a forma de seis
  // caracteres é fácil de errar justamente em quem FALA sobre ela, e este
  // arquivo já nasceu com um byte nulo no comentário que explica o defeito.
  const ARQUIVOS = [
    "client/src/lib/busca-de-cidades.ts",
    "client/src/lib/busca-de-cidades.test.ts",
    "client/src/components/CampoComBusca.tsx",
    "client/src/components/PaisEstadoCidade.tsx",
    "client/src/components/PaisEstadoCidade.test.tsx",
    "client/src/lib/cascata-de-local.ts",
    "shared/normalizar-cidade.ts",
    "shared/cidade.ts",
    "shared/paises.ts",
    "scripts/gerar-cidades.mjs",
    "scripts/cidades/montagem.mjs",
    "server/cidades-geradas.test.ts",
    "server/cidades-montagem.test.ts",
  ];

  it.each(ARQUIVOS)("%s", arquivo => {
    const bytes = readFileSync(path.join(RAIZ, arquivo));
    const posicao = bytes.indexOf(0);
    expect(
      posicao,
      posicao === -1
        ? ""
        : `byte nulo no deslocamento ${posicao}; escreva \\u0000 em vez do caractere`
    ).toBe(-1);
  });
});
