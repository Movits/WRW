// Regras de montagem dos arquivos de cidade, declaradas como módulo PURO para o
// teste prová-las sem baixar 200 MB de dump: nada aqui lê disco, rede ou
// process.env, e não há efeito de topo. Quem faz I/O é só gerar-cidades.mjs.
//
// Por que existe a cópia da normalização abaixo, e não um import de
// shared/normalizar-cidade.ts: o gerador é .mjs (padrão dos scripts do
// repositório, e o CI roda `node --check scripts/*.mjs` neles), e .mjs não
// importa .ts sem tsx. A chave gravada aqui PRECISA ser byte a byte igual à que
// o navegador calcula, senão a busca falha em silêncio — então
// server/cidades-montagem.test.ts importa as duas funções e prova, numa tabela
// de casos, que elas continuam idênticas. Mudou uma, muda a outra.

export const IDIOMAS_DO_SITE = [
  "pt",
  "en",
  "es",
  "fr",
  "de",
  "ru",
  "ar",
  "hi",
  "zh",
  "ja",
];

/**
 * Teto de apelidos por cidade. Uma capital tem nome em 200 idiomas no GeoNames;
 * sem teto, meia dúzia de cidades grandes dobraria o arquivo do país inteiro.
 *
 * O teto conta NOMES vindos do alternateNames, não trechos da chave: as duas
 * formas de digitar um mesmo nome (ver `formasDeDigitar`) são o mesmo nome
 * escrito de dois jeitos, e cortar uma delas cortaria metade de um apelido.
 */
export const TETO_DE_APELIDOS = 12;

/**
 * Nome maior que isto não cabe onde ele vai parar: `user_profiles.city` é
 * `varchar(100)` (drizzle/schema.ts) e o zod do servidor repete o limite
 * (`z.string().max(100)` em server/routers/profile.ts). Sugerir uma cidade que
 * o próprio servidor recusaria seria oferecer um erro de gravação; o gerador
 * descarta e avisa.
 */
export const LIMITE_DO_NOME = 100;

/**
 * O único país cuja lista NÃO sai do GeoNames. O Brasil vem do IBGE, que tem os
 * 5.571 municípios; o GeoNames tem 4.422 registros brasileiros com população
 * ≥ 5.000 e mistura distrito com município.
 */
export const PAIS_DO_IBGE = "BR";

/**
 * A passada do GeoNames deve gerar este país?
 *
 * Existe porque uma rodada mundial (`--entrada <pasta>`, sem `--paises`) passava
 * por cima do `BR.json` do IBGE com a lista menor do GeoNames — o arquivo caía
 * de 5.571 para 4.422 municípios e o teste do Brasil reprovava, sem que nada no
 * comando dissesse que o Brasil estava incluído. Agora a rodada mundial pula o
 * Brasil, e quem quiser mesmo a versão do GeoNames precisa PEDIR pelo nome
 * (`--paises BR`), que é uma escolha explícita e não um efeito colateral.
 */
export function paisSaiDoGeoNames(pais, paisesPedidos = null) {
  if (paisesPedidos) return paisesPedidos.has(pais);
  return pais !== PAIS_DO_IBGE;
}

/**
 * A coluna `isolanguage` do alternateNamesV2 também guarda coisas que não são
 * idioma: link de Wikipédia, id do Wikidata, código postal, código de aeroporto.
 * Nenhuma delas é nome de cidade e nenhuma deve entrar na chave de busca.
 */
export const PSEUDO_IDIOMAS = [
  "link",
  "wkdt",
  "post",
  "iata",
  "icao",
  "faac",
  "unlc",
  "abbr",
  "fr_1793",
];

// ── normalização (cópia de shared/normalizar-cidade.ts — ver cabeçalho) ──────

/**
 * Só MINÚSCULAS, e a consulta é feita com o caractere já em minúscula. A tabela
 * antiga repetia cada letra nas duas caixas e esquecia Ħ, Ŋ e Ŧ: o "Ħ" de
 * "Ħamrun" (Malta) escapava e ficava na chave gerada, que deixava de bater com
 * o que o navegador calcula — quem digitasse "hamrun" não achava a cidade.
 * (Mesmo comentário, mais longo, em shared/normalizar-cidade.ts.)
 */
const LETRAS_SEM_DECOMPOSICAO = {
  ß: "ss",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ŋ: "n",
  ŧ: "t",
  ħ: "h",
};

const PONTUACAO = /[-–—'’‘`´.,;:/\\()[\]{}"«»|]/g;

export function normalizarCidade(texto) {
  if (!texto) return "";
  let saida = "";
  for (const caractere of texto) {
    saida += LETRAS_SEM_DECOMPOSICAO[caractere.toLowerCase()] ?? caractere;
  }
  return saida
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(PONTUACAO, " ")
    .replace(/\s+/g, " ")
    .trim()
    .normalize("NFC");
}

// ── as duas formas de digitar um nome ───────────────────────────────────────

/**
 * As DUAS formas de digitar um nome que tem pontuação, para a chave guardar as
 * duas. A normalização troca hífen, apóstrofo e ponto por ESPAÇO e nunca os
 * remove — então "Xique-Xique" vira só "xique xique", e quem digita
 * "xiquexique" (que é como muita gente escreve) não acha nada. O mesmo valia
 * para "santana do livramento" x "Sant'Ana do Livramento" e "embuguacu" x
 * "Embu-Guaçu".
 *
 * A segunda forma sai do texto CRU com a pontuação apagada em vez de virada em
 * espaço, e passa pela MESMA normalizarCidade(). As duas continuam sendo texto
 * que o navegador consegue reproduzir a partir do que a usuária digitou: uma
 * quando ela escreve o separador (ou um espaço no lugar dele), outra quando ela
 * emenda as palavras.
 *
 * Devolve uma só forma quando o nome não tem pontuação — que é o caso da
 * imensa maioria — e lista vazia quando não sobra nada.
 */
export function formasDeDigitar(texto) {
  const comEspaco = normalizarCidade(texto);
  if (!comEspaco) return [];
  const emendado = normalizarCidade(String(texto).replace(PONTUACAO, ""));
  return emendado && emendado !== comEspaco
    ? [comEspaco, emendado]
    : [comEspaco];
}

// ── seleção de apelidos ─────────────────────────────────────────────────────

/**
 * O apelido serve? Aceita "pt" e "pt-BR", "zh" e "zh-Hans"; recusa pseudo-idioma,
 * idioma fora do site, nome histórico e nome cuja vigência (`to`) já passou.
 * Um nome histórico é o nome ANTIGO da cidade (Leningrado, Bombaim): mostrar
 * isso como sugestão de cadastro é erro, não recurso.
 */
export function apelidoServe(apelido, anoDeHoje) {
  if (!apelido || !apelido.nome || !apelido.nome.trim()) return false;
  if (apelido.historico) return false;
  const idioma = String(apelido.idioma || "").toLowerCase();
  if (!idioma) return false;
  if (PSEUDO_IDIOMAS.includes(idioma)) return false;
  const base = idioma.split("-")[0];
  if (!IDIOMAS_DO_SITE.includes(base)) return false;
  if (apelido.ate) {
    const anoFinal = Number(String(apelido.ate).slice(0, 4));
    if (Number.isFinite(anoFinal) && anoFinal < anoDeHoje) return false;
  }
  return true;
}

/**
 * Monta a chave de busca de uma cidade: nome canônico normalizado, depois os
 * apelidos que servem, separados por "|", sem repetição e com os marcados como
 * preferidos na frente. O "|" também delimita "começa com" na busca: a rodada
 * de prefixo procura por "|" + consulta.
 *
 * Cada nome entra nas duas formas de `formasDeDigitar` quando tem pontuação:
 * "Sant'Ana do Livramento" vira "sant ana do livramento|santana do livramento",
 * e os dois jeitos de digitar acham a cidade.
 */
export function montarChaveDeBusca(
  { nome, asciiname = "", apelidos = [] },
  anoDeHoje = new Date().getUTCFullYear()
) {
  const trechos = [];
  const vistos = new Set();

  /** Acrescenta as formas ainda inéditas de um nome; diz se alguma entrou. */
  const acrescentar = texto => {
    let entrou = false;
    for (const forma of formasDeDigitar(texto)) {
      if (vistos.has(forma)) continue;
      vistos.add(forma);
      trechos.push(forma);
      entrou = true;
    }
    return entrou;
  };

  acrescentar(nome);

  // O asciiname ("Sao Paulo" para "São Paulo") quase sempre já cai na mesma
  // chave do nome canônico depois de normalizado; entra antes dos apelidos
  // para os poucos casos em que difere (transliteração de escrita não latina).
  if (asciiname) acrescentar(asciiname);

  const aceitos = apelidos.filter(apelido => apelidoServe(apelido, anoDeHoje));
  const preferidos = aceitos.filter(apelido => apelido.preferido);
  const demais = aceitos.filter(apelido => !apelido.preferido);
  let apelidosUsados = 0;
  for (const apelido of [...preferidos, ...demais]) {
    if (apelidosUsados >= TETO_DE_APELIDOS) break;
    if (acrescentar(apelido.nome)) apelidosUsados++;
  }

  return trechos.join("|");
}

// ── leitura das linhas do dump ──────────────────────────────────────────────

/**
 * Uma linha de cities5000.txt / cities15000.txt (TSV, colunas na ordem do
 * readme.txt do GeoNames). Devolve null para linha vazia ou truncada.
 */
export function lerLinhaDeCidade(linha) {
  if (!linha || !linha.trim()) return null;
  const c = linha.split("\t");
  if (c.length < 15) return null;
  return {
    id: c[0],
    nome: c[1],
    asciiname: c[2],
    pais: c[8],
    admin1: c[10] || "",
    populacao: Number(c[14]) || 0,
  };
}

/** Uma linha de alternateNamesV2.txt. Devolve null para linha vazia ou truncada. */
export function lerLinhaDeApelido(linha) {
  if (!linha || !linha.trim()) return null;
  const c = linha.split("\t");
  if (c.length < 4) return null;
  return {
    id: c[1],
    idioma: c[2] || "",
    nome: c[3] || "",
    preferido: c[4] === "1",
    historico: c[7] === "1",
    ate: c[9] || "",
  };
}

/** Uma linha de admin1CodesASCII.txt ("BR.SP<TAB>São Paulo<TAB>Sao Paulo<TAB>3448433"). */
export function lerLinhaDeAdmin1(linha) {
  if (!linha || !linha.trim()) return null;
  const c = linha.split("\t");
  if (c.length < 2) return null;
  const [pais, codigo] = c[0].split(".");
  if (!pais || !codigo) return null;
  return { pais, codigo, rotulo: c[1] };
}

// ── montagem do arquivo do país ─────────────────────────────────────────────

/**
 * Ordena e monta o objeto que vai virar <CC>.json, e devolve junto o que teve de
 * ser DESCARTADO. As cidades chegam com população para a ordenação e saem como
 * tupla de três campos: a população só serve para decidir a ORDEM (a maior
 * primeiro), e guardá-la no arquivo seria peso morto, já que a busca preserva a
 * ordem do arquivo dentro de cada grau de acerto.
 *
 * O cabeçalho é de propósito ESTÁVEL: só a origem do dado, nunca a data de
 * hoje. Com a data, rodar o gerador duas vezes sobre a mesma fonte dava dois
 * arquivos diferentes, o diff de uma regeração mentia e ninguém conseguia
 * provar que o JSON versionado é o que o script escreve (é o que
 * server/cidades-geradas.test.ts faz agora, para o Brasil).
 *
 * Devolve `{ arquivo, descartadas }`, e não só o arquivo, porque descartar em
 * silêncio é o defeito que se quer evitar: quem chama tem de poder avisar.
 */
export function montarArquivoDePais({
  pais,
  fonte,
  fonteUrl = "",
  ordem,
  admins = {},
  cidades,
}) {
  const descartadas = [];
  const aceitas = cidades.filter(cidade => {
    // Nome que não cabe em user_profiles.city seria sugestão impossível de
    // gravar: a usuária escolheria da lista e o servidor recusaria.
    if (cidade.nome.length > LIMITE_DO_NOME) {
      descartadas.push(cidade.nome);
      return false;
    }
    return true;
  });

  if (ordem === "populacao-desc") {
    aceitas.sort(
      (a, b) => b.populacao - a.populacao || a.nome.localeCompare(b.nome)
    );
  } else {
    aceitas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  }

  return {
    arquivo: {
      pais,
      fonte,
      fonteUrl,
      idiomas: [...IDIOMAS_DO_SITE],
      ordem,
      admins,
      cidades: aceitas.map(cidade => [
        cidade.nome,
        cidade.admin || "",
        cidade.chave,
      ]),
    },
    descartadas,
  };
}

/**
 * Lê uma entrada de client/src/data/municipios-br.json, que é uma lista de
 * strings "Nome (UF)". A UF sai do nome e vira código administrativo: ela é
 * rótulo de desambiguação na lista ("Bom Jesus (PI)" x "Bom Jesus (RS)") e
 * nunca entra no valor gravado no banco — o defeito que o campo antigo tinha
 * era justamente arrancar a UF a cada tecla digitada.
 */
export function lerMunicipioDoIbge(entrada) {
  const casado = /^(.*?)\s*\(([A-Z]{2})\)$/.exec(String(entrada).trim());
  if (!casado) return null;
  return { nome: casado[1].trim(), admin: casado[2], populacao: 0 };
}

/** Origem do BR.json, gravada no cabeçalho e mostrada como crédito na tela. */
export const FONTE_DO_BRASIL = "IBGE — municípios brasileiros (dado público)";
export const URL_DA_FONTE_DO_BRASIL = "https://www.ibge.gov.br";

/**
 * Nome de cada UF, para o seletor de estado da cascata país → estado → cidade.
 * O arquivo do IBGE só traz a sigla ("São Paulo (SP)"), e a lista de 27 UFs é
 * fixa pela Constituição: não envelhece como uma lista de cidades. UF fora da
 * tabela continua com a sigla como rótulo, em vez de sumir.
 */
export const NOMES_DAS_UFS = {
  AC: "Acre", AL: "Alagoas", AM: "Amazonas", AP: "Amapá", BA: "Bahia",
  CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
  MA: "Maranhão", MG: "Minas Gerais", MS: "Mato Grosso do Sul", MT: "Mato Grosso",
  PA: "Pará", PB: "Paraíba", PE: "Pernambuco", PI: "Piauí", PR: "Paraná",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RO: "Rondônia", RR: "Roraima",
  RS: "Rio Grande do Sul", SC: "Santa Catarina", SE: "Sergipe", SP: "São Paulo",
  TO: "Tocantins",
};

/**
 * Monta o BR.json inteiro a partir da lista crua de
 * client/src/data/municipios-br.json ("São Paulo (SP)", "Xique-Xique (BA)"...).
 *
 * Está aqui, e não dentro do gerador, porque é PURO: recebe a lista já lida e
 * devolve o arquivo. É o que permite a server/cidades-geradas.test.ts montar o
 * Brasil de novo e comparar, campo a campo, com o BR.json versionado — prova ao
 * mesmo tempo que o arquivo não foi editado à mão e que rodar o gerador duas
 * vezes dá exatamente o mesmo resultado.
 *
 * Devolve `{ arquivo, descartadas, foraDoFormato }`: quem chama decide como
 * avisar.
 */
export function montarArquivoDoBrasil(bruto) {
  const cidades = [];
  const admins = {};
  const foraDoFormato = [];

  for (const entrada of bruto) {
    const municipio = lerMunicipioDoIbge(entrada);
    if (!municipio) {
      foraDoFormato.push(String(entrada));
      continue;
    }
    // O rótulo da UF é o nome por extenso ("São Paulo"), que é o que o seletor
    // de estado mostra; a sigla segue como código e como o que a busca acha.
    admins[municipio.admin] = NOMES_DAS_UFS[municipio.admin] ?? municipio.admin;
    cidades.push({
      nome: municipio.nome,
      admin: municipio.admin,
      populacao: 0,
      // Sem apelido em outro idioma nesta versão: o arquivo do IBGE só tem o
      // nome. Quem quiser que a japonesa ache São Paulo digitando サンパウロ
      // precisa cruzar IBGE × GeoNames por nome+UF — está em docs/arquitetura/cidades.md.
      chave: montarChaveDeBusca({ nome: municipio.nome }),
    });
  }

  const { arquivo, descartadas } = montarArquivoDePais({
    pais: "BR",
    fonte: FONTE_DO_BRASIL,
    fonteUrl: URL_DA_FONTE_DO_BRASIL,
    // Sem população no arquivo do IBGE, a ordem é alfabética: é a ordem que a
    // lista já tinha e a que a leitora espera quando as cidades empatam.
    ordem: "alfabetica",
    admins,
    cidades,
  });

  return { arquivo, descartadas, foraDoFormato };
}
