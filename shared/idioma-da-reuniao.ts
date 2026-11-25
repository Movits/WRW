/**
 * O idioma falado numa reunião, num ditado ou na voz sobre um contato.
 *
 * Contrato do desenho do gravador (docs/arquitetura/gravador-de-reunioes.md,
 * "Contratos entre as PRs"): uma função só decide o código, em que 'pt' vira
 * 'pt-BR'. O CÓDIGO fica gravado (meetings.language e
 * meeting_transcripts.language, varchar 12); o NOME só vai no prompt da IA.
 *
 * Há duas listas, para dois papéis:
 * - IDIOMAS_DA_REUNIAO são os 10 idiomas da tela (client/src/i18n): o destino
 *   da tradução, os rótulos do PDF e o idioma em que a IA responde a quem
 *   pergunta. `idiomaDaReuniao` só aceita estes.
 * - IDIOMAS_FALADOS (G16) são os que a IA transcreve, os 10 e mais 99: o idioma
 *   em que a reunião é falada, transcrita e resumida. `idiomaFalado` aceita
 *   estes. Quem lê o idioma ORIGINAL de uma transcrição ou de um resumo passa
 *   por ela; quem precisa de um idioma da tela, por `idiomaDaReuniao`.
 *
 * A reunião pode também nascer com IDIOMA_AUTOMATICO ("Detectar sozinho"): a
 * IA reconhece o idioma de cada fala, mesmo quando a conversa muda de idioma
 * no meio, e a transcrição fica com o idioma que mais aparece
 * (`idiomaPredominante`), que é o do resumo. O "auto" fica só em
 * meetings.language, para o reprocesso detectar de novo; a transcrição grava
 * sempre um código de verdade.
 *
 * Reuniões gravadas antes desta função guardam 'pt'; quem lê o idioma gravado
 * passa por uma das funções em vez de comparar a string crua.
 */
export const IDIOMAS_DA_REUNIAO = ["pt-BR", "en", "es", "fr", "de", "ar", "zh", "hi", "ja", "ru"] as const;

export type IdiomaDaReuniao = (typeof IDIOMAS_DA_REUNIAO)[number];

export const IDIOMA_DA_REUNIAO_PADRAO: IdiomaDaReuniao = "pt-BR";

/**
 * Os idiomas que a IA transcreve: a lista de idiomas dos modelos Gemini na
 * documentação da Google ("Language support", Vertex AI, lida em 21/11/2026:
 * 109 códigos), com os 10 da tela na frente. Três códigos mudam para o nosso
 * contrato: 'pt' é 'pt-BR' (o único português), o hebraico antigo 'iw' é 'he'
 * e o 'mni-Mtei' (manipuri, na escrita meitei) é 'mni'.
 */
export const IDIOMAS_FALADOS = [
  ...IDIOMAS_DA_REUNIAO,
  "af", "sq", "am", "hy", "as", "az", "eu", "be", "bn", "bs", "bg", "ca", "ceb", "co", "hr", "cs", "da", "dv", "nl", "eo",
  "et", "fil", "fi", "fy", "gl", "ka", "el", "gu", "ht", "ha", "haw", "he", "hmn", "hu", "is", "ig", "id", "ga", "it", "jv",
  "kn", "kk", "km", "ko", "kri", "ku", "ky", "lo", "la", "lv", "lt", "lb", "mk", "mg", "ms", "ml", "mt", "mi", "mr", "mni",
  "mn", "my", "ne", "no", "ny", "or", "ps", "fa", "pl", "pa", "ro", "sm", "gd", "sr", "st", "sn", "sd", "si", "sk", "sl",
  "so", "su", "sw", "sv", "tg", "ta", "te", "th", "tr", "uk", "ur", "ug", "uz", "vi", "cy", "xh", "yi", "yo", "zu",
] as const;

export type IdiomaFalado = (typeof IDIOMAS_FALADOS)[number];

/** "Detectar sozinho" (G16): o valor que vai em meetings.language. */
export const IDIOMA_AUTOMATICO = "auto";

/** O que a dona escolhe no "Idioma da reunião": um idioma falado ou "Detectar sozinho". */
export type EscolhaDoIdioma = IdiomaFalado | typeof IDIOMA_AUTOMATICO;

const NOMES: Record<IdiomaDaReuniao, string> = {
  "pt-BR": "português do Brasil",
  en: "inglês",
  es: "espanhol",
  fr: "francês",
  de: "alemão",
  ar: "árabe",
  zh: "chinês simplificado",
  hi: "hindi",
  ja: "japonês",
  ru: "russo",
};

const DA_TELA: ReadonlySet<string> = new Set(IDIOMAS_DA_REUNIAO);
const FALADOS: ReadonlySet<string> = new Set(IDIOMAS_FALADOS);

// Os códigos antigos ou vizinhos que a IA e os navegadores ainda escrevem. Num
// Map, e não num objeto: "constructor" e "toString" não podem virar idioma.
const APELIDOS: ReadonlyMap<string, IdiomaFalado> = new Map<string, IdiomaFalado>([
  ["pt", "pt-BR"], ["iw", "he"], ["tl", "fil"], ["nb", "no"], ["nn", "no"], ["in", "id"], ["ji", "yi"], ["jw", "jv"],
  ["mo", "ro"], ["cmn", "zh"], ["yue", "zh"],
]);

// As escritas da direita para a esquerda entre os idiomas falados.
const DA_DIREITA_PARA_A_ESQUERDA: ReadonlySet<string> = new Set(["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv"]);

// O nome que o CLDR não tem (o Intl.DisplayNames devolve o próprio código).
const NOMES_FORA_DO_CLDR: ReadonlyMap<string, string> = new Map([["kri", "krio"]]);

function baseDoCodigo(codigo: string): string {
  return codigo.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * O código da lista para o que veio da tela, do navegador ou do banco, ou
 * null quando não é um dos 10. Aceita o código regional que o navegador
 * informa ("en-US", "zh-CN") e todo português ("pt", "pt-PT", "pt-br") como
 * 'pt-BR', o único português da lista.
 */
export function idiomaDaReuniao(codigo: string | null | undefined): IdiomaDaReuniao | null {
  if (typeof codigo !== "string") return null;
  const base = baseDoCodigo(codigo);
  if (base === "pt") return "pt-BR";
  return DA_TELA.has(base) ? (base as IdiomaDaReuniao) : null;
}

/**
 * O idioma falado da lista (G16) para o que veio da tela, da IA ou do banco, ou
 * null quando a IA não o transcreve (ou não é idioma). Como `idiomaDaReuniao`:
 * o código regional cai na base ("it-IT" é "it", "zh-TW" é "zh"), todo
 * português é 'pt-BR', e os códigos antigos viram os de hoje ('iw' é 'he').
 * "auto" não é idioma: quem aceita a escolha usa `escolhaDoIdioma`.
 */
export function idiomaFalado(codigo: string | null | undefined): IdiomaFalado | null {
  if (typeof codigo !== "string") return null;
  const base = baseDoCodigo(codigo);
  if (!base) return null;
  const apelido = APELIDOS.get(base);
  if (apelido) return apelido;
  return FALADOS.has(base) ? (base as IdiomaFalado) : null;
}

/** A escolha do "Idioma da reunião": "auto" ou um idioma falado; null fora disso. */
export function escolhaDoIdioma(codigo: string | null | undefined): EscolhaDoIdioma | null {
  if (typeof codigo === "string" && codigo.trim().toLowerCase() === IDIOMA_AUTOMATICO) return IDIOMA_AUTOMATICO;
  return idiomaFalado(codigo);
}

// Um Intl.DisplayNames por idioma de quem lê, criado na primeira vez. null:
// o ambiente não tem o Intl.DisplayNames (navegador muito antigo).
const nomeadores = new Map<string, Intl.DisplayNames | null>();

/**
 * O nome do idioma `codigo` escrito no idioma `lingua` ("italiano" em pt-BR,
 * "Italian" em inglês), pelo Intl.DisplayNames, que traz os nomes do CLDR nos
 * 10 idiomas da tela. Sem nome (o CLDR não tem, ou o ambiente não tem o
 * Intl.DisplayNames), o nome de reserva ou o próprio código: nunca vazio.
 */
export function nomeDoIdiomaEm(codigo: string, lingua: string): string {
  let nomeador = nomeadores.get(lingua);
  if (nomeador === undefined) {
    try {
      nomeador = new Intl.DisplayNames([lingua], { type: "language" });
    } catch {
      nomeador = null;
    }
    nomeadores.set(lingua, nomeador);
  }
  // Só a base: o único português da lista é o pt-BR, e "português (Brasil)"
  // no meio de uma frase sobra.
  const base = baseDoCodigo(codigo);
  let nome: string | undefined;
  try {
    nome = nomeador?.of(base);
  } catch {
    nome = undefined;
  }
  if (nome && nome.toLowerCase() !== base) return nome;
  return NOMES_FORA_DO_CLDR.get(base) ?? codigo;
}

/**
 * O nome do idioma, em português, para o prompt da IA. Os 10 da tela têm o
 * nome de sempre (o prompt das reuniões nesses idiomas não muda); os outros,
 * o do CLDR em português ("italiano", "coreano").
 */
export function nomeDoIdioma(codigo: IdiomaFalado): string {
  return DA_TELA.has(codigo) ? NOMES[codigo as IdiomaDaReuniao] : nomeDoIdiomaEm(codigo, "pt-BR");
}

/** Se o idioma se escreve da direita para a esquerda (o árabe, o hebraico, o persa...). */
export function escritoDaDireitaParaAEsquerda(codigo: string | null | undefined): boolean {
  const idioma = idiomaFalado(codigo);
  return !!idioma && DA_DIREITA_PARA_A_ESQUERDA.has(idioma);
}

/** Uma fala da transcrição (ou uma página do documento), com o idioma que a IA reconheceu nela. */
export type FalaComIdioma = { inicio?: unknown; fim?: unknown; texto?: unknown; idioma?: unknown; lacuna?: unknown };

/** Um idioma da transcrição e a fração dela que ele ocupa (de 0 a 1). */
export type ParteDoIdioma = { idioma: IdiomaFalado; fracao: number };

/**
 * Os idiomas que a IA reconheceu nas falas (G16, "Detectar sozinho"), do que
 * mais aparece ao que menos aparece, com a fração de cada um. O peso de uma
 * fala é o tempo dela (fim − início), que não depende da escrita (o chinês usa
 * menos letras que o inglês para o mesmo tempo de fala). Sem tempo em nenhuma
 * (as páginas de um documento, os tempos que vieram estragados), o peso é o
 * tamanho do texto. O trecho não recebido (lacuna), a fala vazia e a fala sem
 * idioma reconhecido não contam. No empate, vale o idioma que apareceu
 * primeiro.
 */
export function idiomasDasFalas(falas: readonly FalaComIdioma[]): ParteDoIdioma[] {
  const contadas: Array<{ idioma: IdiomaFalado; tempo: number; letras: number }> = [];
  for (const fala of falas) {
    if (!fala || typeof fala !== "object" || fala.lacuna === true || typeof fala.texto !== "string" || !fala.texto.trim()) continue;
    const idioma = idiomaFalado(typeof fala.idioma === "string" ? fala.idioma : null);
    if (!idioma) continue;
    const tempo = Number(fala.fim) - Number(fala.inicio);
    contadas.push({ idioma, tempo: Number.isFinite(tempo) && tempo > 0 ? tempo : 0, letras: fala.texto.trim().length });
  }
  const peloTempo = contadas.some(fala => fala.tempo > 0);
  const pesos = new Map<IdiomaFalado, number>();
  for (const fala of contadas) pesos.set(fala.idioma, (pesos.get(fala.idioma) ?? 0) + (peloTempo ? fala.tempo : fala.letras));
  const total = Array.from(pesos.values()).reduce((soma, peso) => soma + peso, 0);
  if (total <= 0) return [];
  // O Map guarda a ordem em que cada idioma apareceu, e o sort é estável.
  return Array.from(pesos, ([idioma, peso]) => ({ idioma, peso }))
    .filter(({ peso }) => peso > 0)
    .sort((a, b) => b.peso - a.peso)
    .map(({ idioma, peso }) => ({ idioma, fracao: peso / total }));
}

/** O idioma que mais aparece nas falas, ou null quando a IA não reconheceu nenhum. */
export function idiomaPredominante(falas: readonly FalaComIdioma[]): IdiomaFalado | null {
  return idiomasDasFalas(falas)[0]?.idioma ?? null;
}

/**
 * O idioma que a transcrição grava: o que a reunião escolheu, como sempre; com
 * "Detectar sozinho", o que mais aparece nas falas, e o padrão quando a IA não
 * reconheceu nenhum (a transcrição sempre grava um código de verdade, e o "auto"
 * fica só na reunião).
 */
export function idiomaDaTranscricao(escolhido: string | null | undefined, falas: readonly FalaComIdioma[]): string {
  if (escolhaDoIdioma(escolhido) === IDIOMA_AUTOMATICO) return idiomaPredominante(falas) ?? IDIOMA_DA_REUNIAO_PADRAO;
  return escolhido ?? IDIOMA_DA_REUNIAO_PADRAO;
}
