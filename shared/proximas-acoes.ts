/**
 * As próximas ações da dona (H5a do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): as constantes e as funções puras
 * que o servidor (server/proximas-acoes.ts) e a tela (a página
 * /proximas-acoes e o cartão do Dashboard) dividem. Nada aqui lê banco, rede
 * ou process.env (shared/CLAUDE.md).
 */

/** O endereço da página. */
export const ROTA_DAS_PROXIMAS_ACOES = "/proximas-acoes";

/** As seções do resumo guardado que viram próxima ação quando a dona confirma. */
export const SECOES_QUE_VIRAM_ACAO = ["action", "task"] as const;

export function viraProximaAcao(secao: string): boolean {
  return (SECOES_QUE_VIRAM_ACAO as readonly string[]).includes(secao);
}

/**
 * O texto que a dona anota ou edita; o servidor recusa acima disso. A ação que
 * vem do resumo chega a 700 letras (o parágrafo da tarefa sem assunto,
 * server/resumo-da-reuniao.ts), e a edição a devolve com os nomes das vozes no
 * lugar dos rótulos (até 60 letras cada) e com o emoji contando dois: a folga
 * deixa a dona salvar a edição da ação que o próprio resumo criou.
 */
export const TEXTO_DA_ACAO_MAX = 1000;
export const DETALHE_DA_ACAO_MAX = 2000;
/** O tamanho da coluna proximas_acoes.responsavel (o mesmo do item do resumo). */
export const RESPONSAVEL_DA_ACAO_MAX = 120;

/**
 * As recusas das próximas ações, nas palavras que chegam ao navegador. Moram
 * aqui pelo motivo das recusas do resumo guardado (shared/const.ts): o servidor
 * escreve sem saber o idioma da dona, e a tela as traduz reconhecendo o texto
 * exato (client/src/lib/mensagem-de-erro.ts, chaves proximasAcoes.*).
 */
export const MENSAGEM_ACAO_NAO_ENCONTRADA = "Esta próxima ação não existe mais. Atualize a tela.";
export const MENSAGEM_CONTATO_FORA_DA_REDE = "Este contato não está na sua rede.";

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "AAAA-MM-DD" de um dia que existe no calendário, de 2000 a 2100. */
export function prazoValido(texto: string): boolean {
  const partes = DATA_ISO.exec(texto);
  if (!partes) return false;
  const ano = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  if (ano < 2000 || ano > 2100) return false;
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

/**
 * "2026-11-20" no idioma de quem lê; o ano só quando não é o corrente. Mora
 * aqui para a lista das ações e o lembrete no sino (H15) dizerem o prazo igual.
 */
export function prazoNaTela(prazo: string, idioma: string, agora: Date = new Date()): string {
  const [ano, mes, dia] = prazo.split("-").map(Number);
  const data = new Date(ano, mes - 1, dia);
  return data.toLocaleDateString(idioma, { day: "numeric", month: "short", ...(ano === agora.getFullYear() ? {} : { year: "numeric" }) });
}

/** O dia de hoje no relógio de quem lê, como "AAAA-MM-DD". */
export function hojeNoRelogio(agora: Date = new Date()): string {
  const doisDigitos = (n: number) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${doisDigitos(agora.getMonth() + 1)}-${doisDigitos(agora.getDate())}`;
}

/**
 * O destaque do prazo de uma ação aberta: atrasada (o dia passou) ou vence
 * hoje. A feita e a sem prazo não se destacam. Datas como "AAAA-MM-DD", que se
 * comparam como texto.
 */
export function situacaoDoPrazo(prazo: string | null, feita: boolean, hoje: string): "atrasada" | "hoje" | null {
  if (!prazo || feita) return null;
  if (prazo < hoje) return "atrasada";
  return prazo === hoje ? "hoje" : null;
}

// As palavras de ligação dos nomes ("Ana de Souza", "Maria da Silva"): não
// distinguem ninguém.
const PARTICULAS = ["de", "da", "do", "das", "dos", "e", "di", "du", "del", "della", "van", "von", "der", "den", "la", "le", "y"];

// Pelo construtor: o tsconfig não aceita a flag `u` em regex literal (o tsc
// checa em ES5), e o \p{...} só existe com ela. O acento só sai depois de letra
// latina, como em shared/direcao-do-termo.ts: no cirílico e no devanágari a
// marca faz parte da letra. Sem importar aquele módulo, que é grande, para o
// cartão do Dashboard não carregar o vocabulário do match.
const ACENTO_DE_LETRA_LATINA = new RegExp("(\\p{Script=Latin})\\p{M}+", "gu");
const FORA_DE_PALAVRA = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");

/** As palavras de um nome: sem acento, sem pontuação, em minúsculas e sem as partículas. */
export function palavrasDoNome(nome: string): string[] {
  return nome.normalize("NFD").replace(ACENTO_DE_LETRA_LATINA, "$1").normalize("NFC").toLowerCase()
    .split(FORA_DE_PALAVRA)
    .filter(palavra => palavra.length > 0 && !PARTICULAS.includes(palavra));
}

/**
 * O contato da rede da dona que um nome aponta (o responsável que a reunião
 * citou, ou o que a dona escreveu), sem IA. Compara as palavras sem acento e
 * sem as partículas, e só sugere quando a resposta é UMA:
 *
 * - um nome só ("Ana"): o único contato com esse primeiro nome;
 * - nome e sobrenome ("Ana Souza"): o único contato com o mesmo primeiro nome e
 *   as outras palavras no nome dele ("Ana Paula Souza"); havendo mais de um, o
 *   único com o nome inteiro igual.
 *
 * Nenhum candidato, dois ou mais, ou um nome de uma letra: nenhuma sugestão.
 * A sugestão é só uma pergunta na tela; quem liga o contato é a dona.
 */
export function sugerirContatoPeloNome<T extends { id: number; fullName: string }>(
  nome: string | null | undefined,
  contatos: readonly T[],
): T | null {
  return sugerirContatoNaRede(nome, indexarRedeParaSugerir(contatos));
}

/**
 * A rede pronta para a sugestão: as palavras de cada nome, calculadas uma vez,
 * agrupadas pela primeira. A lista pergunta por várias ações de uma vez; sem o
 * índice, cada pergunta normalizaria a rede inteira de novo.
 */
export type RedeParaSugerir<T> = ReadonlyMap<string, ReadonlyArray<{ contato: T; palavras: readonly string[] }>>;

export function indexarRedeParaSugerir<T extends { id: number; fullName: string }>(contatos: readonly T[]): RedeParaSugerir<T> {
  const porPrimeira = new Map<string, Array<{ contato: T; palavras: readonly string[] }>>();
  for (const contato of contatos) {
    const palavras = palavrasDoNome(contato.fullName);
    if (!palavras.length) continue;
    const grupo = porPrimeira.get(palavras[0]);
    if (grupo) grupo.push({ contato, palavras });
    else porPrimeira.set(palavras[0], [{ contato, palavras }]);
  }
  return porPrimeira;
}

/** sugerirContatoPeloNome sobre a rede já indexada (indexarRedeParaSugerir). */
export function sugerirContatoNaRede<T extends { id: number; fullName: string }>(
  nome: string | null | undefined,
  rede: RedeParaSugerir<T>,
): T | null {
  const procuradas = palavrasDoNome(nome ?? "");
  if (!procuradas.length || procuradas.join("").length < 2) return null;
  const [primeira, ...resto] = procuradas;
  const parecidos = (rede.get(primeira) ?? []).filter(candidato => resto.every(palavra => candidato.palavras.includes(palavra)));
  if (parecidos.length === 1) return parecidos[0].contato;
  // "Ana" com duas Anas na rede não diz qual das duas.
  if (!resto.length) return null;
  const chave = procuradas.join(" ");
  const iguais = parecidos.filter(candidato => candidato.palavras.join(" ") === chave);
  return iguais.length === 1 ? iguais[0].contato : null;
}
