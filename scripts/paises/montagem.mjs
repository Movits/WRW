// Regras de montagem da lista de países de shared/paises-gerados.ts, declaradas
// como módulo PURO — nada aqui lê disco, rede ou process.env, e não há efeito de
// topo. Quem faz I/O é só scripts/gerar-paises.mjs.
//
// É o mesmo desenho de scripts/cidades/montagem.mjs, e pelo mesmo motivo: o
// teste (server/paises-montagem.test.ts) prova as regras sem precisar do dump, e
// server/paises-gerados.test.ts monta o módulo de novo e compara, caractere a
// caractere, com o arquivo versionado. Arquivo gerado que ninguém consegue
// refazer é arquivo escrito à mão com outro nome.
//
// LICENÇA: os dados vêm do countryInfo.txt do GeoNames, publicado em CC BY 4.0 —
// uso comercial liberado, CRÉDITO VISÍVEL OBRIGATÓRIO. O crédito é automático:
// FONTE e FONTE_URL abaixo entram no cabeçalho do módulo gerado, `shared/paises.ts`
// os reexporta e as telas que usam esta lista o mostram embaixo do seletor.

/** Origem da lista, gravada no módulo gerado e mostrada como crédito na tela. */
export const FONTE = "GeoNames countryInfo (CC BY 4.0)";
export const FONTE_URL = "https://www.geonames.org";

/** Colunas do countryInfo.txt que interessam (o arquivo tem 19, separadas por tabulação). */
const COLUNA_ISO = 0;
const COLUNA_NOME = 4;

/**
 * Códigos que o countryInfo.txt ainda lista e que NÃO existem mais — o próprio
 * cabeçalho do arquivo diz isso, em duas linhas:
 *
 *   "CS (Serbia and Montenegro) with geonameId = 8505033 no longer exists."
 *   "AN (the Netherlands Antilles) ... was dissolved on 10 October 2010."
 *
 * Não é purismo: o rótulo de cada país sai do navegador, e o navegador resolve
 * código extinto pelo SUCESSOR. `Intl.DisplayNames` devolve "Sérvia" tanto para
 * CS quanto para RS, e "Curaçao" tanto para AN quanto para CW — o seletor
 * mostraria duas vezes o mesmo país, com códigos diferentes, e quem escolhesse o
 * errado gravaria um país que deixou de existir em 2006. Fora eles, os 250
 * códigos restantes têm rótulo único nos 10 idiomas do site
 * (server/paises.test.ts confere).
 */
export const CODIGOS_EXTINTOS = ["CS", "AN"];

/**
 * Lê uma linha do countryInfo.txt. Devolve `null` para comentário, linha vazia,
 * cabeçalho e qualquer linha cuja primeira coluna não seja um código ISO 3166-1
 * alfa-2 — é o que descarta as 50 linhas de explicação que abrem o arquivo.
 */
export function lerLinhaDePais(linha) {
  if (!linha || linha.startsWith("#")) return null;
  const colunas = linha.split("\t");
  const codigo = (colunas[COLUNA_ISO] || "").trim();
  const nome = (colunas[COLUNA_NOME] || "").trim();
  if (!/^[A-Z]{2}$/.test(codigo)) return null;
  if (!nome) return null;
  return { codigo, nome };
}

/**
 * Monta a lista inteira a partir das linhas cruas do countryInfo.txt.
 *
 * A ordem do arquivo gerado é a do CÓDIGO, e não a do nome: a ordem que a tela
 * usa depende do idioma de quem está olhando (ver `listarPaises` em
 * shared/paises.ts) e não cabe num arquivo. Ordenar pelo código dá um diff
 * estável quando o dump for atualizado — um país novo entra numa linha só.
 *
 * Devolve `{ paises, extintos, semNome }` em vez de só a lista, porque descartar
 * em silêncio é o defeito que se quer evitar: quem chama tem de poder avisar.
 */
export function montarListaDePaises(linhas) {
  const paises = [];
  const extintos = [];
  const semNome = [];
  const vistos = new Set();

  for (const linha of linhas) {
    const lido = lerLinhaDePais(linha);
    if (!lido) {
      // Linha que TEM código mas não tem nome é defeito da fonte, não
      // comentário: sem nome não há como oferecer nem como creditar.
      const colunas = String(linha).split("\t");
      const codigo = (colunas[COLUNA_ISO] || "").trim();
      if (/^[A-Z]{2}$/.test(codigo)) semNome.push(codigo);
      continue;
    }
    if (CODIGOS_EXTINTOS.includes(lido.codigo)) {
      extintos.push(lido.codigo);
      continue;
    }
    // Código repetido viraria duas opções idênticas no seletor.
    if (vistos.has(lido.codigo)) continue;
    vistos.add(lido.codigo);
    paises.push(lido);
  }

  paises.sort((a, b) =>
    a.codigo < b.codigo ? -1 : a.codigo > b.codigo ? 1 : 0
  );
  return { paises, extintos, semNome };
}

/**
 * Escreve o texto do módulo shared/paises-gerados.ts.
 *
 * Está aqui, e não dentro do gerador, porque é PURO: recebe a lista e devolve o
 * texto. É o que permite a server/paises-gerados.test.ts montar o módulo de novo
 * a partir do countryInfo.txt e comparar com o arquivo versionado, provando de
 * uma vez que ele não foi editado à mão e que rodar o gerador outra vez dá
 * exatamente o mesmo arquivo.
 *
 * O texto sai JÁ no formato do prettier do repositório (aspas duplas, dois
 * espaços, ponto e vírgula, vírgula final, 80 colunas): assim `pnpm format` não
 * reescreve o arquivo gerado e a comparação do teste continua valendo.
 */
export function montarModuloDePaises(paises) {
  const linhas = paises.map(
    pais => `  [${JSON.stringify(pais.codigo)}, ${JSON.stringify(pais.nome)}],`
  );
  return `// Lista de países ISO 3166-1 alfa-2 — ARQUIVO GERADO, não edite à mão.
//
// Refaça com:
//   node scripts/gerar-paises.mjs --entrada <pasta com o dump do GeoNames>
//
// O SEGUNDO CAMPO É NOME DE RESERVA, não o rótulo da tela. O rótulo de cada país
// sai traduzido pelo próprio navegador, no idioma em que a tela está
// (\`Intl.DisplayNames\`), e é por isso que não existe arquivo de tradução de país
// nos 10 idiomas do site. A reserva é o nome em inglês publicado pelo GeoNames, e
// só aparece se o navegador não conhecer o código — navegador antigo, ICU
// reduzido, ou código novo demais. Ver \`nomeDoPais\` em shared/paises.ts.

/**
 * O crédito que a CC BY 4.0 exige, gravado pelo gerador e mostrado em tela
 * embaixo do seletor de país. É dado exportado, e não comentário, pelo mesmo
 * motivo dos arquivos de cidade: o que aparece para a usuária é o que o script
 * carimbou, então trocar de fonte credita a nova sozinho, sem ninguém lembrar
 * de mexer na tela.
 */
export const FONTE_DOS_PAISES = ${JSON.stringify(FONTE)};
export const FONTE_DOS_PAISES_URL = ${JSON.stringify(FONTE_URL)};

/** Um país: o código ISO 3166-1 alfa-2 e o nome de reserva. */
export type PaisGerado = readonly [codigo: string, nomeDeReserva: string];

export const PAISES_GERADOS: readonly PaisGerado[] = [
${linhas.join("\n")}
];
`;
}
