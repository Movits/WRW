/**
 * Governança: quando um perfil deixa de ser Bronze e passa a Prata.
 *
 * Spec da Glenda de 14/09/2026 (Governança, itens 2 a 9) e decisão do Roberto
 * no mesmo dia: o cadastro nasce Bronze e a Prata vem pela QUALIDADE do perfil.
 * Bronze e Prata não são planos, não têm mensalidade e não medem status: medem
 * o quanto as três dimensões estratégicas do perfil (Quem sou, O que tenho, O
 * que preciso) estão completas e com conteúdo. Ouro é outra coisa (categoria
 * premium, concedida à mão) e não sai daqui.
 *
 * O critério, objetivo e verificável, sobre os campos que existem em
 * `user_profiles`:
 *
 *  QUEM SOU (as quatro)
 *   - nome de exibição com uma palavra que valha (régua de rótulo, abaixo);
 *   - cidade com uma palavra que valha;
 *   - atuação: especialidade principal, área de atuação ou setor, qualquer um
 *     deles com uma palavra que valha;
 *   - apresentação (bio) com pelo menos MINIMO_DE_PALAVRAS_NA_APRESENTACAO
 *     palavras de conteúdo DIFERENTES, e no máximo metade de repetição.
 *  O QUE TENHO: pelo menos um item com conteúdo (régua de rótulo).
 *  O QUE PRECISO: pelo menos um item com conteúdo (régua de rótulo), ou o
 *   texto de "Outra necessidade" com conteúdo e a opção marcada em "O que você
 *   busca?" — a mesma leitura de `necessidadesEscritasDoPerfil` nos motores,
 *   que tratam esse texto como necessidade declarada.
 *  Itens repetidos (mesmo texto, sem acento e caixa) contam uma vez.
 *
 * Por que UM item basta em O que tenho / O que preciso: exigir dois empurraria
 * a membra a marcar uma necessidade que ela não tem só para subir de nível, e
 * necessidade declarada é o que sustenta a conexão de serviço ("fazemos match
 * porque alguém declarou que precisa"). Quantidade forçada pioraria a precisão
 * que o nível quer premiar.
 *
 * O que NÃO entra, de propósito (item 2 da spec: nada de status social,
 * patrimônio, fama, cargo ou poder econômico): cargo, empresa, porte, CNPJ,
 * faixa de renda, capacidade de investimento, anos de experiência,
 * escolaridade, LinkedIn. E contagem de caracteres também não (item 9): o que
 * conta é palavra de conteúdo distinta, e o texto que é enchimento não conta.
 *
 * Palavra que vale (anti-enchimento, item 9):
 *  - pelo menos 2 letras nos rótulos ("TI", "RH", "Li") e 3 na apresentação
 *    (marcas combinantes contam, para o hindi não perder a vogal); números e
 *    símbolos não contam;
 *  - não é palavra funcional comum (de, para, com, the, and, und, pour...) nem
 *    marcador de vazio (teste, asdf, lorem, nada, tudo, ok...);
 *  - não é, inteira, um trecho de fileira do teclado (asdf, qwert, hjkl);
 *  - não tem a mesma letra três vezes seguidas (kkkk, aaaa);
 *  - em alfabeto latino, não tem 6 consoantes seguidas e tem vogal (sigla de
 *    até 4 letras sem vogal só passa como rótulo);
 *  - não passa de 40 caracteres.
 *  Nas escritas sem espaço entre palavras (chinês, japonês, tailandês), cada
 *  caractere é uma unidade e dois caracteres distintos valem uma palavra.
 *
 * Limite conhecido: sem dicionário nem IA, um texto inventado mas plausível
 * passa. Isso é aceito: a regra é determinística e explicável à membra. Até a
 * U3 a Prata não abria recurso nenhum; desde ela (19/11/2026) abre só a LISTA
 * das conexões sugeridas pelo motor de perfis e o interesse por elas
 * (`veAsConexoesSugeridas`, abaixo). A lista é anônima: o nome só aparece com o
 * interesse dos dois lados.
 * Quem passar pela régua com texto inventado vê cartões sem nome, o que toda
 * Bronze via antes da U3. Um admin continua podendo corrigir o nível à mão.
 *
 * Fica em `shared/` para o servidor (que promove e trava a lista) e as telas
 * (o Perfil e o Painel, que mostram o que falta) usarem a MESMA régua.
 */

import { CHAVE_OUTRA_NECESSIDADE } from "./o-que-busca";

/** Muda quando o critério mudar; vai para a auditoria da promoção. */
export const VERSAO_DO_CRITERIO_DE_QUALIFICACAO = "2026-09-14";

export const MINIMO_DE_PALAVRAS_NA_APRESENTACAO = 6;

export type PendenciaDoPerfil =
  | "nome"
  | "cidade"
  | "atuacao"
  | "apresentacao"
  | "oQueTenho"
  | "oQuePreciso";

/** A ordem em que as pendências aparecem para a membra: a das seções do Perfil. */
export const ORDEM_DAS_PENDENCIAS: readonly PendenciaDoPerfil[] = [
  "nome", "cidade", "atuacao", "apresentacao", "oQueTenho", "oQuePreciso",
];

/** Só os campos que o critério lê. Aceita a linha de `user_profiles` inteira. */
export type PerfilParaQualificar = {
  displayName?: string | null;
  city?: string | null;
  bio?: string | null;
  primarySpecialty?: string | null;
  activityArea?: string | null;
  sector?: string | null;
  whatIHave?: unknown;
  whatINeed?: unknown;
  /** "O que você busca?": só importa se "Outra necessidade" está marcada. */
  seekingTypes?: unknown;
  /** O texto de "Outra necessidade": necessidade declarada, vale como O que preciso. */
  seekingOtherNeed?: unknown;
};

export type QualificacaoDoPerfil = {
  /** true = o perfil atende ao critério de Prata. */
  qualificado: boolean;
  /** O que falta, na ordem das seções do Perfil. Vazio quando qualificado. */
  pendencias: PendenciaDoPerfil[];
  dimensoes: { quemSou: boolean; oQueTenho: boolean; oQuePreciso: boolean };
  /**
   * O que a régua contou, para a tela explicar a pendência em vez de só
   * repetir o mínimo (revisão da #135, item 8: "Consultora de marketing digital
   * para pequenas empresas" tem 7 palavras, 5 de conteúdo, e a tela dizia só
   * "pelo menos 6"). `contadas` são as palavras de conteúdo DISTINTAS;
   * `repetida` é a repetição dominante, que pode acontecer JUNTO com a falta
   * de palavras; `vazia` é o campo sem nada escrito — o único caso do texto
   * geral, porque com texto escrito ele esconde a contagem.
   */
  detalhes: { apresentacao: { contadas: number; minimo: number; repetida: boolean; vazia: boolean } };
};

// Palavras funcionais de 3+ letras dos idiomas de escrita latina da plataforma.
// Não carregam informação sobre quem a pessoa é; sem esta lista, "para com que
// uma dos das" seria uma apresentação de seis palavras.
const PALAVRAS_FUNCIONAIS = new Set([
  // português
  "que", "com", "para", "por", "uma", "uns", "umas", "dos", "das", "nos", "nas", "num", "numa",
  "sou", "sao", "esta", "este", "isso", "isto", "essa", "esse", "aqui", "mais", "muito", "muita",
  "tambem", "sem", "sobre", "entre", "ate", "pelo", "pela", "pelos", "pelas", "meu", "minha",
  "meus", "minhas", "seu", "sua", "seus", "suas", "ser", "ter", "tem", "sim", "nao", "mas",
  "como", "quando", "onde", "qual", "quais", "foi", "sido", "estou", "tenho", "fazer", "faco",
  // inglês
  "the", "and", "for", "with", "you", "your", "are", "was", "were", "this", "that", "from",
  "have", "has", "had", "not", "but", "all", "any", "our", "out", "who", "what", "which", "into",
  // espanhol
  "los", "las", "del", "una", "unos", "unas", "por", "con", "para", "como", "pero", "muy", "soy",
  // francês
  "les", "des", "une", "pour", "avec", "dans", "sur", "par", "est", "suis", "qui", "que", "pas",
  // alemão
  "der", "die", "das", "und", "ich", "bin", "mit", "fur", "von", "den", "dem", "ein", "eine", "ist", "nicht",
  // italiano
  "per", "con", "che", "gli", "della", "delle", "sono",
]);

// Marcadores de vazio e de preenchimento de teste.
const MARCADORES_DE_VAZIO = new Set([
  "teste", "testes", "testando", "test", "tests", "testing", "asd", "asdf", "qwe", "qwerty",
  "lorem", "ipsum", "xxx", "xxxx", "bla", "blabla", "blablabla", "haha", "hehe", "rsrs",
  "nada", "nenhum", "nenhuma", "none", "nothing", "null", "undefined", "tbd", "todo", "etc",
  "www", "http", "https", "coisa", "coisas", "algo", "tudo", "qualquer", "anything",
  "everything", "something", "ok",
]);

// Itens inteiros que dizem "não sei" em vez de declarar algo. Frase inteira, e
// não palavra solta, para "Sei" continuar valendo como nome.
const ITENS_SEM_DECLARACAO = new Set([
  "nao sei", "sei la", "a definir", "nao tenho", "nao preciso", "nada ainda", "ainda nao sei",
  "i don t know", "dont know", "not sure", "no se", "je ne sais pas",
]);

const LINHAS_DE_TECLADO = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "azertyuiop", "qsdfghjklm", "wxcvbn", "qwertzuiop", "yxcvbnm"];

// As expressões com \p{...} nascem por new RegExp(..., "u"), como em
// direcao-do-termo.ts: o tsconfig não fixa target, e o literal /.../u não
// passa no `pnpm check`. Pela mesma razão, texto vira lista com Array.from.
// Escritas sem espaço entre palavras: cada caractere é uma unidade.
const ESCRITA_SEM_ESPACO = new RegExp("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}]", "u");
const SO_LATINO = new RegExp("^\\p{Script=Latin}+$", "u");
const MARCA_COMBINANTE = new RegExp("\\p{M}", "gu");
const TOKEN = new RegExp("[\\p{L}\\p{M}]+", "gu");
const LETRA = new RegExp("\\p{L}", "gu");
const TRES_IGUAIS_SEGUIDAS = new RegExp("(.)\\1\\1", "u");
const SO_UMA_LETRA_REPETIDA = new RegExp("^(.)\\1+$", "u");

function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(MARCA_COMBINANTE, "");
}

function tokensDe(texto: unknown): string[] {
  if (typeof texto !== "string" || texto.trim() === "") return [];
  return texto.normalize("NFC").toLowerCase().match(TOKEN) ?? [];
}

/**
 * A palavra INTEIRA é um trecho de uma fileira do teclado ("asdf", "qwert",
 * "lkjh"). Só a palavra inteira: "property" contém "erty" e é palavra.
 */
function sequenciaDeTeclado(palavra: string): boolean {
  if (palavra.length < 4) return false;
  return LINHAS_DE_TECLADO.some(linha => linha.includes(palavra) || linha.split("").reverse().join("").includes(palavra));
}

/**
 * Uma palavra (de escrita com espaço, já em minúsculas) vale?
 * `minimoDeLetras` 2 é a régua dos rótulos (nome, cidade, atuação, itens):
 * aceita "TI", "RH", "Li". 3 é a da apresentação, que exige palavra com vogal.
 */
function palavraValida(palavra: string, minimoDeLetras: 2 | 3): boolean {
  const letras = palavra.match(LETRA)?.length ?? 0;
  const tamanho = Array.from(palavra).length;
  if (letras < 2 || tamanho < minimoDeLetras || tamanho > 40) return false;
  if (TRES_IGUAIS_SEGUIDAS.test(palavra) || SO_UMA_LETRA_REPETIDA.test(palavra)) return false;
  const base = semAcento(palavra);
  if (PALAVRAS_FUNCIONAIS.has(base) || MARCADORES_DE_VAZIO.has(base)) return false;
  if (SO_LATINO.test(base)) {
    // Sigla curta sem vogal ("CRM", "RH") passa como rótulo, não como palavra da apresentação.
    const exigeVogal = minimoDeLetras === 3 || base.length >= 5;
    if (exigeVogal && !/[aeiouy]/.test(base)) return false;
    if (/[^aeiouy]{6}/.test(base)) return false;
    if (sequenciaDeTeclado(base)) return false;
  }
  return true;
}

/** Nome, cidade, atuação ou item: basta UMA palavra que valha. */
export function rotuloComConteudo(texto: unknown): boolean {
  return tokensDe(texto).some(token =>
    ESCRITA_SEM_ESPACO.test(token) || palavraValida(token, 2));
}

type Leitura = { distintas: number; total: number };

/** Conta as palavras de conteúdo de um texto: quantas diferentes e quantas no total. */
function lerPalavras(texto: unknown): Leitura {
  const palavras = new Set<string>();
  const caracteres = new Set<string>();
  let total = 0;
  let totalDeCaracteres = 0;
  for (const token of tokensDe(texto)) {
    if (ESCRITA_SEM_ESPACO.test(token)) {
      for (const caractere of Array.from(token)) {
        if (ESCRITA_SEM_ESPACO.test(caractere)) {
          caracteres.add(caractere);
          totalDeCaracteres += 1;
        }
      }
      continue;
    }
    if (palavraValida(token, 3)) {
      palavras.add(semAcento(token));
      total += 1;
    }
  }
  return {
    distintas: palavras.size + Math.floor(caracteres.size / 2),
    total: total + Math.floor(totalDeCaracteres / 2),
  };
}

/** A leitura de um texto tem pelo menos `minimo` palavras de conteúdo diferentes, sem repetição dominante. */
function leituraComConteudo({ distintas, total }: Leitura, minimo: number): boolean {
  if (distintas < Math.max(1, minimo)) return false;
  // "empresa empresa vendas vendas marketing marketing...": mais repetição que
  // conteúdo não é apresentação.
  return distintas / total >= 0.5;
}

/** Texto com pelo menos `minimo` palavras de conteúdo diferentes, sem repetição dominante. */
export function textoComConteudo(texto: unknown, minimo: number): boolean {
  return leituraComConteudo(lerPalavras(texto), minimo);
}

/** Itens de O que tenho / O que preciso: distintos (sem acento e caixa) e com conteúdo. */
export function itensComConteudo(valor: unknown): string[] {
  const lista = Array.isArray(valor) ? valor : typeof valor === "string" ? [valor] : [];
  const vistos = new Set<string>();
  const validos: string[] = [];
  for (const item of lista) {
    if (typeof item !== "string") continue;
    // Os ids das opções fixas chegam como "acesso_governamental": o sublinhado separa palavras.
    const legivel = item.replace(/[_-]+/g, " ");
    if (!rotuloComConteudo(legivel)) continue;
    const chave = semAcento(legivel.toLowerCase()).replace(/\s+/g, " ").trim();
    if (ITENS_SEM_DECLARACAO.has(tokensDe(chave).join(" "))) continue;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    validos.push(item);
  }
  return validos;
}

/**
 * O texto de "Outra necessidade" conta como O que preciso só com a opção
 * marcada (desmarcá-la apaga o texto: `textoDaOutraNecessidade`), como em
 * `necessidadesEscritasDoPerfil`, e passa pela mesma régua anti-enchimento dos itens.
 */
function outraNecessidadeComConteudo(p: PerfilParaQualificar): boolean {
  const marcada = Array.isArray(p.seekingTypes) && p.seekingTypes.includes(CHAVE_OUTRA_NECESSIDADE);
  return marcada && itensComConteudo(p.seekingOtherNeed).length > 0;
}

/**
 * U3, "matches possíveis" (promessa à Dra. Glenda na reunião de 11/11/2026):
 * a lista das conexões sugeridas pelo motor de perfis se libera com o cadastro
 * completo, e o cadastro completo é esta régua — o nível Prata. A Bronze vê só
 * QUANTAS conexões são possíveis (`matches.conexoesPossiveis`), nunca quem.
 *
 * Lê o NÍVEL, e não o perfil: quem decide a Prata é a promoção ao gravar o
 * perfil (`server/nivel-do-perfil.ts`, no Perfil, no cadastro e na reunião
 * "Sou eu"). Ouro, presidente e admin não são degraus desta régua, mas veem a
 * lista como sempre viram ("Ouro = Presidente = administradora"). O
 * Distribuidor do Smart Match é um poder, não um nível: a Bronze com o poder
 * continua vendo só o número. Lista fechada de propósito: nível desconhecido
 * ou ausente não vê a lista.
 */
const NIVEIS_QUE_VEEM_AS_CONEXOES_SUGERIDAS: readonly string[] = ["silver", "gold", "president", "admin"];

export function veAsConexoesSugeridas(nivel: string | null | undefined): boolean {
  return typeof nivel === "string" && NIVEIS_QUE_VEEM_AS_CONEXOES_SUGERIDAS.includes(nivel);
}

/** Avalia o perfil pela régua de Prata. Perfil ausente = tudo pendente. */
export function avaliarQualificacaoDoPerfil(perfil: PerfilParaQualificar | null | undefined): QualificacaoDoPerfil {
  const p = perfil ?? {};
  const pendencias: PendenciaDoPerfil[] = [];

  if (!rotuloComConteudo(p.displayName)) pendencias.push("nome");
  if (!rotuloComConteudo(p.city)) pendencias.push("cidade");
  if (![p.primarySpecialty, p.activityArea, p.sector].some(rotuloComConteudo)) pendencias.push("atuacao");
  // A apresentação é lida uma vez: a mesma leitura decide a pendência e vai
  // para `detalhes`, para a tela explicar com a contagem que a régua fez.
  const apresentacao = lerPalavras(p.bio);
  if (!leituraComConteudo(apresentacao, MINIMO_DE_PALAVRAS_NA_APRESENTACAO)) pendencias.push("apresentacao");
  const quemSou = pendencias.length === 0;

  const oQueTenho = itensComConteudo(p.whatIHave).length > 0;
  if (!oQueTenho) pendencias.push("oQueTenho");
  const oQuePreciso = itensComConteudo(p.whatINeed).length > 0 || outraNecessidadeComConteudo(p);
  if (!oQuePreciso) pendencias.push("oQuePreciso");

  return {
    qualificado: pendencias.length === 0,
    pendencias,
    dimensoes: { quemSou, oQueTenho, oQuePreciso },
    detalhes: {
      apresentacao: {
        contadas: apresentacao.distintas,
        minimo: MINIMO_DE_PALAVRAS_NA_APRESENTACAO,
        /**
         * Nada legível no campo. É o único caso em que o texto geral ("uma
         * apresentação com pelo menos N palavras") é o que cabe: com texto
         * escrito, ele esconde a contagem que explica a recusa.
         */
        vazia: typeof p.bio !== "string" || p.bio.trim() === "",
        /**
         * Repetição dominante — a mesma razão de `leituraComConteudo`, mas SEM
         * exigir que a contagem já tenha chegado ao mínimo. Quem falha nas duas
         * portas precisa saber disso antes de completar as palavras que faltam,
         * senão chega a 6 e leva uma segunda recusa sem aviso (validação de
         * 16/09 na #135, item 8).
         */
        repetida: apresentacao.total > 0 && apresentacao.distintas / apresentacao.total < 0.5,
      },
    },
  };
}
