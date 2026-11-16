import crypto from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { contactAssets, contactNeeds, meetingContactSuggestions, networkSugestoes, privateContacts } from "../drizzle/schema";
import { tokensDoTermo } from "@shared/direcao-do-termo";
import { PALAVRAS_VAZIAS_DA_CITACAO } from "@shared/tipo-da-oferta";
import { exigirDb } from "./db";
import { invokeLLM } from "./_core/llm";
import { slugifyMatchTag } from "./match-service";

/**
 * QUEM SOU, O QUE TENHO e O QUE PRECISO a partir de uma conversa — Meu
 * Network Inteligente, spec da Glenda de 14/09, itens 5 a 10.
 *
 * Três regras da spec viram código aqui:
 *
 * 1. QUEM SOU é SÓ identificação: nome ou razão social, telefone, e-mail e,
 *    se der, pessoa física ou jurídica. Profissão, cargo, setor, produtos,
 *    serviços, necessidades nunca entram nele (item 6). O schema da resposta
 *    nem tem onde pôr isso.
 *
 * 2. A IA não inventa (itens 6, 9 e 10). Prompt é pedido, não garantia —
 *    mesmo raciocínio do portão da demanda expressa. Por isso cada item
 *    proposto carrega o TRECHO literal da fonte, e o código confere: trecho
 *    que não está na transcrição (ou no texto), que não diz nada (uma palavra
 *    solta) ou que a fonte nega derruba o item; o TEXTO do item precisa ser
 *    sustentado pelo trecho (palavra e número que o trecho não diz derrubam,
 *    e a negação que restringe o item — "embalagem que não seja de plástico"
 *    — fica, sem trocar de lado); telefone que não é um número inteiro da
 *    fonte vira nada; e-mail que não aparece inteiro, idem; nome cujas
 *    palavras não aparecem, idem; cargo e empresa que a fonte não diz como
 *    estão escritos, idem.
 *
 * 4. O QUE TENHO e O QUE PRECISO podem circular sem identificação na rede
 *    global (itens 12 e 13): item que carrega o nome, a empresa, o telefone ou
 *    o e-mail do contato não passa, nem na proposta nem na confirmação.
 *
 * 3. Nada entra sozinho (CLAUDE.md): o que passa pelo portão vira PENDÊNCIA
 *    em network_sugestoes, com origem e confiança, e só vira dado do contato
 *    quando a dona confirma — podendo corrigir o valor antes.
 */

/**
 * Os campos que uma pendência propõe. `cargo` e `empresa` (achado 6 da
 * bancada de 16/11) são o apoio da pessoa da reunião, jobTitle e company do
 * contato: criar ou vincular a pessoa não os grava, eles esperam a dona aqui.
 */
export const CAMPOS_DA_SUGESTAO = ["nome", "telefone", "email", "tipo_pessoa", "tenho", "preciso", "cargo", "empresa"] as const;
export type CampoDaSugestao = (typeof CAMPOS_DA_SUGESTAO)[number];
export type OrigemDaSugestao = "reuniao" | "voz" | "texto";

/** Os tetos das colunas de destino (private_contacts, contact_assets, contact_needs). */
export const LIMITES_DO_CAMPO: Record<CampoDaSugestao, number> = {
  nome: 200, telefone: 50, email: 254, tipo_pessoa: 10, tenho: 200, preciso: 200, cargo: 200, empresa: 200,
};

export type ItemProposto = { texto: string; categoria: string | null; trecho: string; confianca: number };

export type PerfilProposto = {
  quemSou: { tipoPessoa: "fisica" | "juridica" | "nao_informado"; nome: string | null; telefone: string | null; email: string | null };
  oQueTenho: ItemProposto[];
  oQuePreciso: ItemProposto[];
};

// ─── O portão: o que não está na fonte não passa ─────────────────────────────

/**
 * Escrita sem espaço entre palavras (chinês, japonês, tailandês...): ali a
 * "palavra" do analisador é a frase inteira, e a comparação desce ao
 * caractere. RegExp por string, como a SEPARADOR_DE_PALAVRA (tsc em ES5).
 */
const CLASSE_SEM_ESPACO = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]";
const QUEBRA_SEM_ESPACO = new RegExp(`(${CLASSE_SEM_ESPACO})`, "u");
const EH_SEM_ESPACO = new RegExp(`^${CLASSE_SEM_ESPACO}$`, "u");

/**
 * As unidades de comparação: minúsculas, sem acento e sem pontuação, na
 * tokenização do analisador de termos (shared/direcao-do-termo.ts), que
 * entende qualquer escrita; em escrita sem espaço, cada caractere.
 */
function unidades(texto: string): string[] {
  return tokensDoTermo(texto).flatMap(palavra => palavra.split(QUEBRA_SEM_ESPACO)).filter(Boolean);
}

/** As unidades separadas por um espaço: a comparação não tropeça em "Distribuição," × "distribuicao". */
function comparavel(texto: string): string {
  return unidades(texto).join(" ");
}

/** As unidades de um texto com a oração de cada uma: ponto, vírgula, dois-pontos e quebra de linha separam orações. */
function unidadesPorOracao(texto: string): { lista: string[]; oracao: number[] } {
  const lista: string[] = [];
  const oracao: number[] = [];
  texto.split(/[.,;:!?…\n]+/).forEach((parte, indice) => {
    for (const unidade of unidades(parte)) {
      lista.push(unidade);
      oracao.push(indice);
    }
  });
  return { lista, oracao };
}

const temDigito = (unidade: string) => /\d/.test(unidade);

/** Palavra que prova alguma coisa: não é número (conferido à parte), ligação, artigo nem sigla de duas letras. */
const ehConteudo = (unidade: string) =>
  !temDigito(unidade) && (EH_SEM_ESPACO.test(unidade) || (unidade.length >= 3 && !PALAVRAS_VAZIAS_DA_CITACAO.has(unidade)));

/**
 * Negação que desmente o trecho: "A gente ainda NÃO tem distribuidor no
 * Chile" não sustenta "Distribuidor no Chile". Dentro do trecho vale a lista
 * curta; logo antes dele, também "sem" ("estamos sem distribuidor") — dentro,
 * "sem" costuma ser qualidade ("produtos sem glúten"). "Não só" e "não
 * apenas" não negam.
 */
const NEGACOES_NO_TRECHO = new Set(["nao", "nunca", "jamais", "nem", "nenhum", "nenhuma", "not", "never"]);
const NEGACOES_ANTES_DO_TRECHO = new Set(["nao", "nunca", "jamais", "nem", "nenhum", "nenhuma", "not", "never", "sem", "without"]);
const RESSALVAS_DA_NEGACAO = new Set(["so", "apenas", "somente", "only", "just"]);
const negaEm = (lista: readonly string[], k: number, negacoes: ReadonlySet<string>) =>
  negacoes.has(lista[k]) && !RESSALVAS_DA_NEGACAO.has(lista[k + 1]);
/** Quantas unidades antes do trecho, na mesma oração, a negação alcança ("não tem um distribuidor"). */
const ALCANCE_DA_NEGACAO = 3;
/** Quantas unidades em volta do trecho ainda o sustentam ("distribuição de medicamentos | em todo o Brasil"). */
const JANELA_DO_TRECHO = 5;

/**
 * Artigo ou determinante: o que vem logo antes de um nome ("UMA embalagem",
 * "UM tecido", "THE supplier"). "Outro", "esse" e "cada" ficam de fora porque
 * também são pronome ("o outro acha que não").
 */
const DETERMINANTES = new Set(["um", "uma", "uns", "umas", "o", "a", "os", "as", "algum", "alguma", "alguns", "algumas", "an", "the"]);

/**
 * A negação que RESTRINGE um nome não desmente a declaração (achado 5 da
 * bancada de 16/11): "uma embalagem QUE NÃO seja de plástico" pede uma
 * embalagem, e a restrição é parte do item. O "não" derrubava o item nas 6
 * rodadas, e com ele o resto da frase ("um distribuidor em São Paulo").
 *
 * Restringe o "não" que vem logo depois de "que" (ou com uma palavra no
 * meio: "que ainda não"), com um NOME antes do "que", tudo na mesma oração.
 * Nome é a palavra que vem logo depois de um artigo ("UMA embalagem que não
 * seja", "UM tecido que não tenha"). Sem essa exigência, "acho que não", "a
 * gente acha que não", "eu sinto que não" e "I think that not" passavam o
 * verbo por nome, e a necessidade negada virava item (revisão da IA3). O
 * artigo e o nome podem vir logo antes do trecho: a leitura é feita na fonte.
 *
 * Não restringe — desmente — "o que não temos", "a gente que não tem", "uma
 * vez que não", "tenho a impressão que não" (antes do "que" não há nome) nem
 * "um distribuidor que não temos" (o verbo depois do "não" é a própria
 * declaração de quem fala). Sem artigo na fonte ("procuro embalagem que não
 * seja de plástico"), o "não" desmente e o item cai, do lado conservador.
 */
const RELATIVOS = new Set(["que", "that", "which", "who"]);
const NAO_SAO_NOME = new Set([
  "isso", "isto", "aquilo", "tudo", "algo", "nada", "coisa", "coisas", "gente",
  // locuções e opinião: "uma vez que não", "é uma pena que não", "tenho a impressão (a sensação, a certeza) que não"
  "vez", "pena", "medida", "impressao", "sensacao", "certeza", "ideia", "opiniao", "sentimento",
  // o assunto da conversa, não um item: "investidor é um assunto (um tema) que não está na pauta"
  "assunto", "tema", "questao", "prioridade", "momento", "verdade", "realidade", "situacao",
  "what", "all", "something", "anything", "nothing", "everything", "thing", "things",
  "feeling", "impression", "sense", "idea", "opinion", "issue", "topic", "priority", "matter", "truth",
]);
const VERBOS_DA_DECLARACAO = new Set([
  "tenho", "temos", "possuo", "possuimos", "preciso", "precisamos", "procuro", "procuramos", "busco", "buscamos",
  "quero", "queremos", "ofereco", "oferecemos", "vendo", "vendemos", "faco", "fazemos", "conheco", "conhecemos",
  "have", "need", "want", "offer", "sell", "own",
]);
function negacaoRestringeUmNome(lista: readonly string[], oracao: readonly number[], k: number): boolean {
  if (!negaEm(lista, k, NEGACOES_NO_TRECHO) || lista[k] === "nem" || VERBOS_DA_DECLARACAO.has(lista[k + 1])) return false;
  return [k - 1, k - 2].some(j => j >= 2 && RELATIVOS.has(lista[j]) && oracao[j - 2] === oracao[k]
    && DETERMINANTES.has(lista[j - 2]) && ehConteudo(lista[j - 1]) && !NAO_SAO_NOME.has(lista[j - 1]));
}

/**
 * Como o trecho se lê no lugar em que aparece na fonte (das unidades `inicio`
 * a `fim`). A negação dentro dele desmente a declaração ("não precisamos de
 * investidores"), salvo a que restringe um nome e o "nem" que continua uma
 * restrição na mesma oração ("sem plástico nem isopor", "que não seja de
 * plástico nem de isopor"). "restringe": o trecho só vale por causa de uma
 * restrição com "que não".
 */
function leituraDoTrecho(lista: readonly string[], oracao: readonly number[], inicio: number, fim: number): "desmente" | "restringe" | "afirma" {
  let restricao: number | null = null;
  let restringe = false;
  for (let k = inicio; k < fim; k += 1) {
    if (restricao !== null && restricao !== oracao[k]) restricao = null;
    if (lista[k] === "sem" || lista[k] === "without") restricao = oracao[k];
    else if (lista[k] === "nem" && restricao !== null) continue;
    else if (negacaoRestringeUmNome(lista, oracao, k)) {
      restricao = oracao[k];
      restringe = true;
    } else if (negaEm(lista, k, NEGACOES_NO_TRECHO)) return "desmente";
  }
  return restringe ? "restringe" : "afirma";
}

/** "E" e "ou" seguidos de artigo abrem outro item: "uma embalagem sem plástico | e um distribuidor em São Paulo". */
const COORDENACOES = new Set(["e", "ou", "and", "or"]);
/** A preposição que abre outro complemento fecha o "sem": "produtos sem glúten | para hotéis". "De" não fecha: "sem adição de açúcar". */
const FECHAM_O_SEM = new Set(["para", "em", "no", "na", "nos", "nas", "com", "for", "in", "with"]);

type AlcanceDaNegacao = { negada: boolean[]; marca: boolean[]; complemento: boolean[]; abertaPor: number[] };

/**
 * Até onde vai cada negação de um texto, da unidade `de` até antes da `ate`
 * (o texto inteiro, se a faixa não for dada). A marca ("não", "sem",
 * "nem"..., fora "não só") alcança da palavra seguinte ao fim da oração.
 * O "sem" e a restrição com "que não" (com o "nem" que os continua) param
 * antes em dois lugares (revisão da IA3):
 * - no "e" ou "ou" seguido de artigo, que abre outro item ("uma embalagem
 *   sem plástico | e um distribuidor em São Paulo");
 * - só o "sem", na preposição que abre outro complemento ("produtos sem
 *   glúten | para hotéis").
 * O "não" que nega a frase vai até o fim da oração, como antes: depois da
 * normalização, "é" e "e" são a mesma unidade, e "o que não temos É UM
 * distribuidor" não pode virar "e um", outro item afirmado.
 * O que vem depois da preposição que fecha o "sem" é `complemento`: a fonte o
 * afirma, mas sozinho ele não faz um item ("estamos sem distribuidor | no
 * Chile" não sustenta o item "Chile"). `abertaPor` é a posição da marca cujo
 * alcance chega à palavra, ou -1. As listas devolvidas começam na unidade `de`.
 */
function alcanceDaNegacao(
  lista: readonly string[],
  oracao: readonly number[],
  faixa: { de: number; ate: number } = { de: 0, ate: lista.length },
  ehMarca: (k: number) => boolean = k => negaEm(lista, k, NEGACOES_ANTES_DO_TRECHO),
): AlcanceDaNegacao {
  const alcance: AlcanceDaNegacao = { negada: [], marca: [], complemento: [], abertaPor: [] };
  // A asserção evita que o tsc estreite `aberta` para null no laço.
  let aberta = null as { em: number; tipo: "sem" | "restricao" | "frase" } | null;
  let complemento: number | null = null;
  for (let k = faixa.de; k < faixa.ate; k += 1) {
    const outroItem = COORDENACOES.has(lista[k]) && DETERMINANTES.has(lista[k + 1]);
    if (aberta !== null && (oracao[aberta.em] !== oracao[k] || (outroItem && aberta.tipo !== "frase"))) aberta = null;
    if (complemento !== null && (complemento !== oracao[k] || outroItem)) complemento = null;
    if (aberta?.tipo === "sem" && FECHAM_O_SEM.has(lista[k])) {
      aberta = null;
      complemento = oracao[k];
    }
    const marca = ehMarca(k);
    alcance.negada.push(aberta !== null);
    alcance.abertaPor.push(aberta ? aberta.em : -1);
    alcance.complemento.push(complemento !== null);
    alcance.marca.push(marca);
    if (marca) {
      const tipo = lista[k] === "sem" || lista[k] === "without" ? "sem"
        : lista[k] === "nem" && aberta ? aberta.tipo
          : negacaoRestringeUmNome(lista, oracao, k) ? "restricao" : "frase";
      aberta = { em: k, tipo };
      complemento = null;
    }
  }
  return alcance;
}

/**
 * A fonte em unidades, com a oração de cada uma e o alcance das negações
 * dela. A mesma transcrição é conferida item a item, pessoa a pessoa: a
 * última leitura fica guardada.
 */
let ultimaFonteLida: ({ fonte: string; daFonte: string[]; oracao: number[] } & AlcanceDaNegacao) | null = null;
function fonteLida(fonte: string) {
  if (ultimaFonteLida?.fonte === fonte) return ultimaFonteLida;
  const { lista: daFonte, oracao } = unidadesPorOracao(fonte);
  ultimaFonteLida = { fonte, daFonte, oracao, ...alcanceDaNegacao(daFonte, oracao) };
  return ultimaFonteLida;
}

/**
 * Uma palavra da fonte em volta do trecho. `negada`: está no alcance de uma
 * negação que o PRÓPRIO trecho traz ("embalagem que não seja de PLÁSTICO");
 * `marca`: é essa negação. Negação de fora do trecho não entra aqui: a que
 * vem logo antes já derruba a ocorrência inteira. `complemento`: vem depois
 * do "sem X" e de uma preposição ("sem glúten para HOTÉIS"), seja o "sem" do
 * trecho ou de antes dele.
 */
type PalavraDoApoio = { unidade: string; negada: boolean; marca: boolean; complemento: boolean };

/**
 * O que a fonte diz em volta do trecho citado, ou null se o trecho não a
 * sustenta. Aspas e reticências do modelo saem; com reticência no meio
 * ("distribui ... na África"), cada pedaço precisa estar, como sequência de
 * palavras inteiras. Pedaço com menos de 4 letras não prova nada e é
 * ignorado; o trecho inteiro precisa de pelo menos DUAS palavras de conteúdo
 * (uma palavra solta — "para", "pessoas" — é palavra-chave, não declaração,
 * como em citacaoConfere). Ocorrência negada não conta, nem a que se
 * desmente.
 */
function apoioDoTrecho(trecho: unknown, fonte: string): PalavraDoApoio[] | null {
  if (typeof trecho !== "string") return null;
  const lida = fonteLida(fonte);
  const { daFonte, oracao } = lida;
  const pedacos = trecho.split(/\.{3}|…/).map(parte => unidadesPorOracao(parte).lista).filter(pedaco => pedaco.join("").length >= 4);
  if (!pedacos.length || pedacos.reduce((soma, pedaco) => soma + pedaco.filter(ehConteudo).length, 0) < 2) return null;
  const apoio: PalavraDoApoio[] = [];
  for (const pedaco of pedacos) {
    let achou = false;
    for (let inicio = 0; inicio + pedaco.length <= daFonte.length; inicio += 1) {
      if (!pedaco.every((unidade, k) => daFonte[inicio + k] === unidade)) continue;
      const fim = inicio + pedaco.length;
      const leitura = leituraDoTrecho(daFonte, oracao, inicio, fim);
      if (leitura === "desmente") continue;
      // A negação logo antes do trecho, se o alcance dela ainda chega a ele
      // ("não tem um | distribuidor"). Se o trecho só vale pela restrição,
      // também a de qualquer ponto antes, na mesma oração: em "Não precisamos
      // de um investidor que não entenda do setor", o primeiro "não" desmente
      // a declaração, e o segundo só restringiria o nome.
      const abertaPor = lida.abertaPor[inicio];
      if ((abertaPor >= 0 && inicio - abertaPor <= ALCANCE_DA_NEGACAO) || (leitura === "restringe" && lida.negada[inicio])) continue;
      achou = true;
      const de = Math.max(0, inicio - JANELA_DO_TRECHO);
      const ate = Math.min(daFonte.length, fim + JANELA_DO_TRECHO);
      const doTrecho = alcanceDaNegacao(daFonte, oracao, { de, ate }, k => k >= inicio && k < fim && negaEm(daFonte, k, NEGACOES_ANTES_DO_TRECHO));
      for (let k = de; k < ate; k += 1) {
        apoio.push({
          unidade: daFonte[k],
          negada: doTrecho.negada[k - de],
          marca: doTrecho.marca[k - de],
          complemento: doTrecho.complemento[k - de] || lida.complemento[k],
        });
      }
    }
    if (!achou) return null;
  }
  return apoio;
}

/** O trecho citado está na fonte, diz alguma coisa e não é negado por ela? */
export function trechoEstaNaFonte(trecho: string | null | undefined, fonte: string): boolean {
  return apoioDoTrecho(trecho, fonte) !== null;
}

/**
 * Duas grafias da mesma palavra: "distribuição" × "distribuímos",
 * "fornecedores" × "fornecedor", "venda" × "vendemos". Prefixo comum de 4+
 * letras que cobre a menor delas, a menos das 4 últimas; "investidores" ×
 * "investimento" não passa. Escrita sem espaço compara o caractere.
 */
function mesmaRaiz(a: string, b: string): boolean {
  if (a === b) return true;
  if (EH_SEM_ESPACO.test(a) || EH_SEM_ESPACO.test(b)) return false;
  const menor = Math.min(a.length, b.length);
  let comum = 0;
  while (comum < menor && a[comum] === b[comum]) comum += 1;
  return comum >= 4 && comum >= menor - 4;
}

/**
 * O TEXTO do item é sustentado pelo trecho? O modelo pode encurtar ("atua na
 * distribuição de medicamentos em todo o Brasil" → "Distribuição de
 * medicamentos no Brasil"), nunca acrescentar: toda palavra de conteúdo do
 * texto aparece, na mesma raiz, no trecho ou em volta dele, e todo número
 * aparece igual. Sem isso, um trecho verdadeiro servia de passe para um texto
 * inventado ("Fundo de investimento com R$ 50 milhões"). É o mesmo que o
 * prompt pede (REGRAS_DAS_TRES_DIMENSOES): palavra que o trecho não tem
 * ("Serviços de", "Especialista em") continua caindo.
 *
 * A negação que o trecho traz é parte do item e não pode trocar de lado
 * (achado 5 da bancada de 16/11). De "uma embalagem que não seja de
 * plástico" passam "Embalagem que não seja de plástico", "Embalagem sem
 * plástico" (o "sem" faz as vezes do "que não seja") e "Embalagem"; não passa
 * "Embalagem de plástico". A palavra que fica sob a negação no item precisa
 * estar sob a negação no trecho, a que fica fora, fora; e o item afirma
 * alguma coisa ("Sem distribuidor no Chile" não é item), que não seja só o
 * complemento do "sem" ("Chile", de "estamos sem distribuidor no Chile").
 */
export function textoSustentadoPeloTrecho(texto: unknown, trecho: unknown, fonte: string): boolean {
  if (typeof texto !== "string") return false;
  const apoio = apoioDoTrecho(trecho, fonte);
  if (!apoio) return false;
  const { lista: doTexto, oracao } = unidadesPorOracao(texto);
  if (!doTexto.some(ehConteudo)) return false;
  const { negada: sobNegacao, marca } = alcanceDaNegacao(doTexto, oracao);
  const casa = (unidade: string, daFonte: PalavraDoApoio) => (temDigito(unidade) ? daFonte.unidade === unidade : mesmaRaiz(unidade, daFonte.unidade));
  let afirma = false;
  for (let k = 0; k < doTexto.length; k += 1) {
    const unidade = doTexto[k];
    if (marca[k]) {
      // A negação do item: o trecho também nega, e alguma palavra do item fica sob ela.
      const alcanca = doTexto.some((outra, j) => j > k && oracao[j] === oracao[k] && !marca[j] && (ehConteudo(outra) || temDigito(outra)));
      if (!alcanca || !apoio.some(daFonte => daFonte.marca)) return false;
      continue;
    }
    if (!temDigito(unidade) && !ehConteudo(unidade)) continue;
    if (sobNegacao[k]) {
      if (!apoio.some(daFonte => daFonte.negada && !daFonte.marca && casa(unidade, daFonte))) return false;
    } else {
      const afirmadas = apoio.filter(daFonte => !daFonte.negada && !daFonte.marca && casa(unidade, daFonte));
      if (!afirmadas.length) return false;
      if (ehConteudo(unidade) && afirmadas.some(daFonte => !daFonte.complemento)) afirma = true;
    }
  }
  return afirma;
}

/** Letra de qualquer escrita (RegExp por string, como a SEPARADOR_DE_PALAVRA: tsc em ES5). */
const TEM_LETRA = new RegExp("\\p{L}", "u");

/**
 * Cargo e empresa que a IA deu a uma pessoa da reunião (achado 6 da bancada
 * de 16/11) ficam só se a fonte os diz como estão escritos: as mesmas
 * palavras, na mesma ordem, e não no alcance de uma negação da mesma oração
 * ("não sou mais a diretora"). "Consultor" não se sustenta em "Ponte Sul
 * Consultoria", nem "fundadora" numa reunião em que ninguém disse a palavra.
 * Acento, caixa e pontuação não contam.
 */
export function expressaoEstaNaFonte(expressao: string | null | undefined, fonte: string): boolean {
  const procurada = unidades(expressao ?? "");
  if (!procurada.some(unidade => TEM_LETRA.test(unidade))) return false;
  const { daFonte, negada } = fonteLida(fonte);
  for (let inicio = 0; inicio + procurada.length <= daFonte.length; inicio += 1) {
    if (procurada.every((unidade, k) => daFonte[inicio + k] === unidade) && !negada[inicio]) return true;
  }
  return false;
}

/**
 * O telefone é um número da fonte? A fonte é lida em "corridas" de dígitos
 * (espaço, ponto, hífen e parêntese não quebram a corrida; barra só entre
 * dígitos, como no CNPJ — " / " separa dois números). Vale a corrida inteira
 * igual ao telefone, ou a diferença de um código de país que a PRÓPRIA fonte
 * traz ("+1 415..." citado sem o +1) ou o +55 (a fala costuma omiti-lo), com
 * DDD. Prefixo que a fonte não diz (um DDD inventado) ou pedaço de outro
 * número (CNPJ, o meio de um celular) não passa. Número dito por extenso
 * ("nove nove...") também não: sem prova, o campo fica para a dona completar.
 */
export function telefoneEstaNaFonte(telefone: string | null | undefined, fonte: string): boolean {
  const digitos = (telefone ?? "").replace(/\D/g, "");
  if (digitos.length < 8) return false;
  return (fonte.match(/\+?\d(?:[\d\s().-]|\/(?=\d))*\d/g) ?? []).some(bruta => {
    const corrida = bruta.replace(/\D/g, "");
    if (corrida === digitos) return true;
    if (digitos.length >= 10 && corrida === `55${digitos}`) return true;
    if (corrida.length >= 10 && digitos === `55${corrida}`) return true;
    const codigoDoPais = corrida.length - digitos.length;
    return bruta.startsWith("+") && digitos.length >= 10 && codigoDoPais >= 1 && codigoDoPais <= 3 && corrida.endsWith(digitos);
  });
}

/** Os endereços de e-mail inteiros de um texto; o ponto final da frase não faz parte do endereço. */
function emailsDoTexto(texto: string): string[] {
  return (texto.match(/[^\s@<>()[\]{},;:"'`]+@[^\s@<>()[\]{},;:"'`]+/g) ?? []).map(endereco => endereco.replace(/^\.+|\.+$/g, ""));
}

/**
 * O e-mail aparece INTEIRO na fonte, escrito ou ditado ("maria arroba
 * empresa ponto com")? Pedaço de endereço não vale: "maria@farmabras.com"
 * não é "maria@farmabras.com.br".
 */
export function emailEstaNaFonte(email: string | null | undefined, fonte: string): boolean {
  const alvo = (email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alvo)) return false;
  const escrita = fonte.toLowerCase();
  const ditada = escrita.replace(/\s*\barroba\b\s*/g, "@").replace(/\s+\bponto\b\s+/g, ".").replace(/\s*@\s*/g, "@");
  return [...emailsDoTexto(escrita), ...emailsDoTexto(ditada)].includes(alvo);
}

/** Quem o contato é, para nada disso vazar em O QUE TENHO / O QUE PRECISO. */
export type Identificacao = { nomes?: unknown[]; telefones?: unknown[] };

const PADRAO_DE_EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Telefone com DDD, em qualquer das grafias comuns. Valor ("R$ 1.000.000") e ano ("2024-2025") não casam. */
const PADRAO_DE_TELEFONE = new RegExp("(?<!\\d)(?:\\+\\s?\\d{1,3}[\\s.-]?)?\\(?\\d{2,3}\\)?[\\s.-]?\\d{4,5}[\\s.-]?\\d{4}(?!\\d)");

function contemSequencia(lista: readonly string[], sequencia: readonly string[]): boolean {
  if (!sequencia.length) return false;
  for (let inicio = 0; inicio + sequencia.length <= lista.length; inicio += 1) {
    if (sequencia.every((unidade, k) => lista[inicio + k] === unidade)) return true;
  }
  return false;
}

/**
 * O item carrega a identificação do contato? E-mail ou telefone escritos, o
 * telefone conhecido (pelos 8 últimos dígitos) ou o nome/empresa conhecidos
 * como SEQUÊNCIA de palavras — "Maria Silva", "Maria da Silva", "Farmabras".
 * Palavra solta do nome não conta: a empresa "Medicamentos Brasil" não pode
 * barrar "Distribuição de medicamentos no Brasil".
 */
export function itemIdentificaOContato(texto: string, quem: Identificacao): boolean {
  if (PADRAO_DE_EMAIL.test(texto) || PADRAO_DE_TELEFONE.test(texto)) return true;
  const corridas = (texto.match(/\d[\d\s().-]*\d/g) ?? []).map(corrida => corrida.replace(/\D/g, ""));
  const telefoneConhecido = (quem.telefones ?? []).some(telefone => {
    const digitos = typeof telefone === "string" ? telefone.replace(/\D/g, "") : "";
    return digitos.length >= 8 && corridas.some(corrida => corrida.includes(digitos.slice(-8)));
  });
  if (telefoneConhecido) return true;
  const doTexto = unidades(texto);
  return (quem.nomes ?? []).some(nome => {
    if (typeof nome !== "string") return false;
    const todas = unidades(nome);
    const conteudo = todas.filter(ehConteudo);
    return conteudo.length > 0 && (contemSequencia(doTexto, conteudo) || contemSequencia(doTexto, todas));
  });
}

/** Toda palavra de 3+ letras do nome aparece, como palavra, na fonte. */
export function nomeEstaNaFonte(nome: string | null | undefined, fonte: string): boolean {
  const palavras = tokensDoTermo(nome ?? "").filter(p => p.length >= 3);
  if (!palavras.length) return false;
  const daFonte = new Set(tokensDoTermo(fonte));
  return palavras.every(p => daFonte.has(p));
}

const confiancaValida = (valor: unknown) => {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(0, Math.min(1, numero)) : 0;
};

/**
 * Aplica o portão à proposta do modelo. O que sobra é o que a fonte sustenta,
 * sem a identificação do contato em O QUE TENHO / O QUE PRECISO — a de quem a
 * chamada conhece (`identificacao`) e a que o próprio modelo propôs em QUEM SOU.
 */
export function filtrarPelaFonte(proposta: PerfilProposto, fonte: string, identificacao: Identificacao = {}): PerfilProposto {
  const quemSou = proposta.quemSou ?? { tipoPessoa: "nao_informado", nome: null, telefone: null, email: null };
  const quem: Identificacao = {
    nomes: [...(identificacao.nomes ?? []), quemSou.nome],
    telefones: [...(identificacao.telefones ?? []), quemSou.telefone],
  };
  const itens = (lista: unknown): ItemProposto[] => (Array.isArray(lista) ? lista : [])
    .filter((item): item is ItemProposto => Boolean(item) && typeof item.texto === "string" && item.texto.trim().length >= 2)
    .filter(item => textoSustentadoPeloTrecho(item.texto, item.trecho, fonte))
    .filter(item => !itemIdentificaOContato(item.texto, quem))
    .map(item => ({
      texto: item.texto.trim().slice(0, LIMITES_DO_CAMPO.tenho),
      // Categoria do modelo não passa: nenhum portão a confere, a dona não a vê e ela daria match por categoria.
      categoria: null,
      trecho: item.trecho.trim().slice(0, 1000),
      confianca: confiancaValida(item.confianca),
    }))
    .slice(0, 10);
  const nome = typeof quemSou.nome === "string" && nomeEstaNaFonte(quemSou.nome, fonte) ? quemSou.nome.trim().slice(0, LIMITES_DO_CAMPO.nome) : null;
  const telefone = typeof quemSou.telefone === "string" && quemSou.telefone.trim().length <= LIMITES_DO_CAMPO.telefone && telefoneEstaNaFonte(quemSou.telefone, fonte)
    ? quemSou.telefone.trim() : null;
  const email = typeof quemSou.email === "string" && quemSou.email.trim().length <= LIMITES_DO_CAMPO.email && emailEstaNaFonte(quemSou.email, fonte)
    ? quemSou.email.trim().toLowerCase() : null;
  const tipoPessoa = quemSou.tipoPessoa === "fisica" || quemSou.tipoPessoa === "juridica" ? quemSou.tipoPessoa : "nao_informado";
  return { quemSou: { tipoPessoa, nome, telefone, email }, oQueTenho: itens(proposta.oQueTenho), oQuePreciso: itens(proposta.oQuePreciso) };
}

// ─── A IA: interpretar texto ou fala sobre UM contato ─────────────────────────

export const REGRAS_DAS_TRES_DIMENSOES = `Organize o que for dito sobre a pessoa ou empresa em três dimensões, EXATAMENTE assim:
1. QUEM SOU — SOMENTE identificação: nome ou razão social, telefone e e-mail; e, se estiver claro, se é pessoa física ou jurídica. NUNCA ponha em QUEM SOU profissão, cargo, setor, expertise, ativos, produtos, serviços, necessidades, mercados ou capacidades.
2. O QUE TENHO — o que a pessoa ou empresa faz, oferece, controla, representa, comercializa, possui, conhece, disponibiliza ou consegue acessar: atividade empresarial, produtos, serviços, distribuição, canais comerciais, mercados, tecnologia, expertise, ativos, estrutura, licenças, representação, acesso, capacidade operacional. Escreva cada item de forma comercialmente útil e curta (ex.: "Distribuição de medicamentos no Brasil").
3. O QUE PRECISO — demandas, necessidades, objetivos e oportunidades que a pessoa ou empresa DECLAROU buscar: investidores, compradores, fornecedores, distribuidores, representantes, parceiros, tecnologia, licenças, capital, clientes, acesso a um país, internacionalização, serviços especializados.
REGRAS OBRIGATÓRIAS:
- NÃO INVENTE. Só preencha o que está dito na fonte. Nome, telefone e e-mail só se aparecerem escritos ou falados; senão, null.
- Não deduza necessidade a partir de setor, porte, cargo ou "poderia precisar". Só entra em O QUE PRECISO o que foi declarado.
- Um item por coisa: "um distribuidor no Chile e um fornecedor de vidro" são dois itens, cada um com o seu trecho.
- Cada item de O QUE TENHO e O QUE PRECISO leva "trecho": as palavras LITERAIS da fonte que dizem aquele item (a parte da frase sobre ele), copiadas sem alterar nada.
- O texto do item é feito com as palavras do trecho: pode cortar palavras e mudar a forma de uma palavra (plural, verbo em substantivo: "distribuímos" vira "distribuição"). Não troque palavra por sinônimo nem acrescente palavra que o trecho não tem ("Serviços de", "Especialista em", "Produção de"), produto, lugar, número ou valor.
- Restrição dita com "não" faz parte do item: "um tecido que não tenha poliéster" vira "Tecido que não tenha poliéster" ou "Tecido sem poliéster". O que a fonte NEGA ("não temos", "não precisamos") não vira item.
- O QUE TENHO e O QUE PRECISO NUNCA levam nome de pessoa, razão social, nome da empresa, telefone ou e-mail: esses itens podem circular sem identificação na rede. Escreva "Distribuição de medicamentos no Brasil", nunca "Farmabras: distribuição de medicamentos".
- Faltou informação? Deixe vazio. É melhor faltar do que inventar.`;

const ESQUEMA_DO_ITEM = {
  type: "object",
  properties: {
    texto: { type: "string", maxLength: 200 },
    trecho: { type: "string", maxLength: 1000 },
    confianca: { type: "number" },
  },
  required: ["texto", "trecho", "confianca"],
  additionalProperties: false,
} as const;

export const ESQUEMA_DO_PERFIL = {
  type: "object",
  properties: {
    quemSou: {
      type: "object",
      properties: {
        tipoPessoa: { type: "string", enum: ["fisica", "juridica", "nao_informado"] },
        nome: { type: ["string", "null"], maxLength: 200 },
        telefone: { type: ["string", "null"], maxLength: 50 },
        email: { type: ["string", "null"], maxLength: 254 },
      },
      required: ["tipoPessoa", "nome", "telefone", "email"],
      additionalProperties: false,
    },
    oQueTenho: { type: "array", items: ESQUEMA_DO_ITEM },
    oQuePreciso: { type: "array", items: ESQUEMA_DO_ITEM },
  },
  required: ["quemSou", "oQueTenho", "oQuePreciso"],
  additionalProperties: false,
} as const;

/**
 * Interpreta um texto (digitado, ou a transcrição de um áudio curto) sobre UM
 * contato e devolve o que a fonte sustenta. A resposta do modelo passa pelo
 * portão aqui dentro: quem chama nunca recebe item sem prova.
 */
export async function interpretarComplemento(
  fonte: string,
  contexto: { nomeDoContato: string; identificacao?: Identificacao },
): Promise<PerfilProposto> {
  const resposta = await invokeLLM({
    timeoutMs: 45_000,
    orcamentoMs: 60_000,
    messages: [
      { role: "system", content: `Você organiza anotações de networking sobre um contato. ${REGRAS_DAS_TRES_DIMENSOES}\nRetorne somente JSON estruturado.` },
      { role: "user", content: `Contato em questão: ${contexto.nomeDoContato.slice(0, 200)}\n\nFonte:\n${fonte.slice(0, 8000)}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "perfil_do_contato", strict: true, schema: ESQUEMA_DO_PERFIL as never } },
  });
  const conteudo = resposta.choices?.[0]?.message?.content;
  if (typeof conteudo !== "string") throw new Error("A IA não retornou uma interpretação válida.");
  let bruto: PerfilProposto;
  try {
    bruto = JSON.parse(conteudo) as PerfilProposto;
  } catch {
    throw new Error("A IA não retornou uma interpretação válida.");
  }
  return filtrarPelaFonte(bruto, fonte.slice(0, 8000), {
    nomes: [contexto.nomeDoContato, ...(contexto.identificacao?.nomes ?? [])],
    telefones: contexto.identificacao?.telefones,
  });
}

// ─── Pendências ───────────────────────────────────────────────────────────────

type Banco = Awaited<ReturnType<typeof exigirDb>>;

export type PendenciaNova = {
  campo: CampoDaSugestao;
  valor: string;
  categoria: string | null;
  trecho: string | null;
  confianca: number;
};

/** A proposta filtrada, em linhas de pendência. `nao_informado` não vira pendência. */
export function pendenciasDaProposta(proposta: PerfilProposto, confiancaDoQuemSou = 0.8): PendenciaNova[] {
  const linhas: PendenciaNova[] = [];
  const { quemSou } = proposta;
  if (quemSou.nome) linhas.push({ campo: "nome", valor: quemSou.nome, categoria: null, trecho: null, confianca: confiancaDoQuemSou });
  if (quemSou.telefone) linhas.push({ campo: "telefone", valor: quemSou.telefone, categoria: null, trecho: null, confianca: confiancaDoQuemSou });
  if (quemSou.email) linhas.push({ campo: "email", valor: quemSou.email, categoria: null, trecho: null, confianca: confiancaDoQuemSou });
  if (quemSou.tipoPessoa !== "nao_informado") linhas.push({ campo: "tipo_pessoa", valor: quemSou.tipoPessoa, categoria: null, trecho: null, confianca: confiancaDoQuemSou });
  for (const item of proposta.oQueTenho) linhas.push({ campo: "tenho", valor: item.texto, categoria: item.categoria, trecho: item.trecho, confianca: item.confianca });
  for (const item of proposta.oQuePreciso) linhas.push({ campo: "preciso", valor: item.texto, categoria: item.categoria, trecho: item.trecho, confianca: item.confianca });
  return linhas;
}

/**
 * O que não precisa virar pendência porque o contato já tem: o mesmo telefone,
 * o mesmo e-mail, o mesmo nome, o mesmo tipo, ou um "tenho"/"preciso" com o
 * mesmo slug. Valor DIFERENTE do que está gravado vira pendência — a dona
 * decide se troca; nada é sobrescrito sem ela.
 */
/** A mesma pendência escrita de outro jeito tem a mesma chave: slug em Tenho/Preciso, dígitos no telefone. */
function chaveDaPendencia(campo: CampoDaSugestao, valor: string): string {
  if (campo === "tenho" || campo === "preciso") return `${campo}:${slugifyMatchTag(valor)}`;
  if (campo === "telefone") return `${campo}:${valor.replace(/\D/g, "")}`;
  return `${campo}:${comparavel(valor)}`;
}

export function semRepeticao(
  linhas: PendenciaNova[],
  atual: {
    fullName?: string | null; phone?: string | null; whatsapp?: string | null; email?: string | null; tipoPessoa?: string | null;
    jobTitle?: string | null; company?: string | null; tenho: string[]; preciso: string[];
  },
): PendenciaNova[] {
  const digitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");
  const slugs = (lista: string[]) => new Set(lista.map(slugifyMatchTag));
  const tenho = slugs(atual.tenho);
  const preciso = slugs(atual.preciso);
  const vistos = new Set<string>();
  return linhas.filter(linha => {
    const chave = chaveDaPendencia(linha.campo, linha.valor);
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    switch (linha.campo) {
      case "nome": return comparavel(linha.valor) !== comparavel(atual.fullName ?? "");
      case "telefone": {
        const novo = digitos(linha.valor);
        return ![digitos(atual.phone), digitos(atual.whatsapp)].some(d => d && (d.endsWith(novo) || novo.endsWith(d)));
      }
      case "email": return linha.valor.toLowerCase() !== (atual.email ?? "").toLowerCase();
      case "tipo_pessoa": return linha.valor !== atual.tipoPessoa;
      case "tenho": return !tenho.has(slugifyMatchTag(linha.valor));
      case "preciso": return !preciso.has(slugifyMatchTag(linha.valor));
      case "cargo": return comparavel(linha.valor) !== comparavel(atual.jobTitle ?? "");
      case "empresa": return comparavel(linha.valor) !== comparavel(atual.company ?? "");
    }
  });
}

export async function gravarPendencias(db: Banco, entrada: {
  ownerId: string;
  origem: OrigemDaSugestao;
  contactId?: number | null;
  meetingId?: string | null;
  meetingSuggestionId?: string | null;
  linhas: PendenciaNova[];
}): Promise<number> {
  // A mesma pendência não abre duas vezes: nem repetida na mesma leva, nem
  // igual a uma que o contato já tem aberta (a dona completou por texto duas
  // vezes com a mesma frase, ou a pessoa da reunião foi vinculada a ele).
  const abertas = new Set<string>();
  if (entrada.linhas.length && entrada.contactId != null) {
    const linhasAbertas = await db.select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor }).from(networkSugestoes)
      .where(and(
        eq(networkSugestoes.ownerId, entrada.ownerId), eq(networkSugestoes.contactId, entrada.contactId),
        eq(networkSugestoes.status, "pendente"),
      ));
    for (const aberta of linhasAbertas) abertas.add(chaveDaPendencia(aberta.campo, aberta.valor));
  }
  const linhas = entrada.linhas.filter(linha => {
    const chave = chaveDaPendencia(linha.campo, linha.valor.slice(0, LIMITES_DO_CAMPO[linha.campo]));
    if (abertas.has(chave)) return false;
    abertas.add(chave);
    return true;
  });
  if (!linhas.length) return 0;
  const agora = Date.now();
  await db.insert(networkSugestoes).values(linhas.map(linha => ({
    id: crypto.randomUUID(),
    ownerId: entrada.ownerId,
    contactId: entrada.contactId ?? null,
    meetingId: entrada.meetingId ?? null,
    meetingSuggestionId: entrada.meetingSuggestionId ?? null,
    origem: entrada.origem,
    campo: linha.campo,
    valor: linha.valor.slice(0, LIMITES_DO_CAMPO[linha.campo]),
    categoria: linha.categoria,
    trecho: linha.trecho,
    confianca: confiancaValida(linha.confianca).toFixed(3),
    status: "pendente" as const,
    createdAt: agora,
    updatedAt: agora,
  })));
  return linhas.length;
}

/** O retrato atual do contato que a deduplicação precisa. Posse no WHERE. */
export async function retratoDoContato(db: Banco, ownerId: string, contactId: number) {
  const [contato] = await db.select({
    id: privateContacts.id, fullName: privateContacts.fullName, phone: privateContacts.phone,
    whatsapp: privateContacts.whatsapp, email: privateContacts.email, tipoPessoa: privateContacts.tipoPessoa,
    jobTitle: privateContacts.jobTitle, company: privateContacts.company,
  }).from(privateContacts).where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId))).limit(1);
  if (!contato) return null;
  const [tenho, preciso] = await Promise.all([
    db.select({ label: contactAssets.tagLabel }).from(contactAssets)
      .where(and(eq(contactAssets.ownerId, ownerId), eq(contactAssets.contactId, contactId))),
    db.select({ label: contactNeeds.tagLabel }).from(contactNeeds)
      .where(and(eq(contactNeeds.ownerId, ownerId), eq(contactNeeds.contactId, contactId))),
  ]);
  return { ...contato, tenho: tenho.map(t => t.label), preciso: preciso.map(p => p.label) };
}

/**
 * Quem o contato é, para O QUE TENHO e O QUE PRECISO não levarem a
 * identificação dele: o nome, a empresa e os telefones gravados no contato e,
 * além deles, o que a reunião disse dele e ainda não foi gravado (revisão da
 * IA3). O contato criado pela reunião nasce sem empresa, que espera a dona
 * como pendência; sem isto, "Chocolate da Cacau Tupinã" passava na
 * confirmação e no completar por texto ou voz. Entram o nome, a empresa e o
 * telefone das pessoas da reunião ligadas ao contato e as pendências de nome,
 * empresa e telefone dele em qualquer status: ignorar a pendência não deixa a
 * empresa anônima. Posse no WHERE.
 */
export async function identificacaoDoContato(db: Banco, ownerId: string, contato: {
  id: number; fullName: string | null; company: string | null; phone: string | null; whatsapp: string | null;
}): Promise<Identificacao> {
  const [daReuniao, pendencias] = await Promise.all([
    db.select({ fullName: meetingContactSuggestions.fullName, company: meetingContactSuggestions.company, phone: meetingContactSuggestions.phone })
      .from(meetingContactSuggestions)
      .where(and(eq(meetingContactSuggestions.ownerId, ownerId), eq(meetingContactSuggestions.existingContactId, contato.id))),
    db.select({ campo: networkSugestoes.campo, valor: networkSugestoes.valor }).from(networkSugestoes)
      .where(and(
        eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.contactId, contato.id),
        inArray(networkSugestoes.campo, ["nome", "empresa", "telefone"]),
      )),
  ]);
  return {
    nomes: [
      contato.fullName, contato.company,
      ...daReuniao.flatMap(pessoa => [pessoa.fullName, pessoa.company]),
      ...pendencias.filter(pendencia => pendencia.campo !== "telefone").map(pendencia => pendencia.valor),
    ],
    telefones: [
      contato.phone, contato.whatsapp,
      ...daReuniao.map(pessoa => pessoa.phone),
      ...pendencias.filter(pendencia => pendencia.campo === "telefone").map(pendencia => pendencia.valor),
    ],
  };
}

/** Pendências abertas de um contato (ou de uma reunião), mais recentes primeiro. */
export async function listarPendencias(ownerId: string, filtro: { contactId?: number; meetingId?: string }) {
  const db = await exigirDb();
  const condicoes = [eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.status, "pendente")];
  if (filtro.contactId !== undefined) condicoes.push(eq(networkSugestoes.contactId, filtro.contactId));
  if (filtro.meetingId !== undefined) condicoes.push(eq(networkSugestoes.meetingId, filtro.meetingId));
  const linhas = await db.select().from(networkSugestoes).where(and(...condicoes)).orderBy(desc(networkSugestoes.createdAt)).limit(100);
  return linhas.map(linha => ({
    id: linha.id,
    contactId: linha.contactId === null ? null : Number(linha.contactId),
    meetingId: linha.meetingId,
    meetingSuggestionId: linha.meetingSuggestionId,
    origem: linha.origem,
    campo: linha.campo,
    valor: linha.valor,
    categoria: linha.categoria,
    trecho: linha.trecho,
    confianca: Number(linha.confianca),
    criadaEm: linha.createdAt,
  }));
}

export class PendenciaNaoEncontrada extends Error {
  constructor() { super("Sugestão não encontrada ou já decidida."); this.name = "PendenciaNaoEncontrada"; }
}
export class ValorInvalido extends Error {
  constructor(mensagem: string) { super(mensagem); this.name = "ValorInvalido"; }
}

/** Normaliza e valida o valor que vai ser gravado (o da IA ou o corrigido pela dona). */
export function valorParaGravar(campo: CampoDaSugestao, valor: string): string {
  const limpo = valor.trim();
  if (!limpo) throw new ValorInvalido("O valor não pode ficar vazio.");
  if (limpo.length > LIMITES_DO_CAMPO[campo]) throw new ValorInvalido("O valor é longo demais para este campo.");
  if (campo === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpo)) throw new ValorInvalido("E-mail inválido.");
  if (campo === "telefone" && limpo.replace(/\D/g, "").length < 8) throw new ValorInvalido("Telefone inválido.");
  if (campo === "tipo_pessoa" && limpo !== "fisica" && limpo !== "juridica") throw new ValorInvalido("Tipo de pessoa inválido.");
  // Só pontuação ("...") gravaria tag_slug "" — um item que o motor não enxerga e nenhuma conferência reconhece.
  if ((campo === "tenho" || campo === "preciso") && !slugifyMatchTag(limpo)) throw new ValorInvalido("O item precisa ter ao menos uma palavra.");
  return campo === "email" ? limpo.toLowerCase() : limpo;
}

export const MENSAGEM_ITEM_COM_IDENTIFICACAO =
  "O que tem e o que precisa não levam nome, empresa, telefone ou e-mail do contato: esses itens podem circular sem identificação na rede global. Corrija o texto antes de confirmar.";

/**
 * A dona confirma: a pendência vira dado do contato. Tomada e aplicação vão
 * na MESMA transação, com a tomada condicional (status 'pendente' no WHERE)
 * como primeira instrução: dois cliques ou duas abas aplicam uma vez só, e se
 * a escrita no contato falhar — inclusive com o banco caindo no meio — o
 * rollback devolve a pendência a 'pendente'; ela nunca fica "confirmada" sem
 * ter sido aplicada.
 *
 * Tenho/Preciso que o contato já tem (mesmo slug OU mesmo rótulo, como na
 * confirmação do enriquecimento em db.ts) não é inserido de novo: a pendência
 * só é confirmada. E item que carrega nome, empresa, telefone ou e-mail do
 * contato — também os que a reunião deu e ainda não foram gravados nele
 * (identificacaoDoContato) — é recusado antes de qualquer escrita.
 */
export async function confirmarPendencia(ownerId: string, id: string, valorCorrigido?: string) {
  const db = await exigirDb();
  const [pendencia] = await db.select().from(networkSugestoes)
    .where(and(eq(networkSugestoes.id, id), eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.status, "pendente"))).limit(1);
  if (!pendencia || pendencia.contactId === null) throw new PendenciaNaoEncontrada();
  const contactId = Number(pendencia.contactId);
  const campo = pendencia.campo;
  const valor = valorParaGravar(campo, valorCorrigido ?? pendencia.valor);

  const [contato] = await db.select({
    id: privateContacts.id, fullName: privateContacts.fullName, company: privateContacts.company,
    phone: privateContacts.phone, whatsapp: privateContacts.whatsapp,
  }).from(privateContacts)
    .where(and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId))).limit(1);
  if (!contato) throw new PendenciaNaoEncontrada();
  const ehTenhoOuPreciso = campo === "tenho" || campo === "preciso";
  if (ehTenhoOuPreciso && itemIdentificaOContato(valor, await identificacaoDoContato(db, ownerId, { ...contato, id: contactId }))) {
    throw new ValorInvalido(MENSAGEM_ITEM_COM_IDENTIFICACAO);
  }

  const agora = Date.now();
  const doContato = and(eq(privateContacts.id, contactId), eq(privateContacts.ownerId, ownerId));
  const inseriu = await db.transaction(async tx => {
    const [tomada] = await tx.update(networkSugestoes)
      .set({ status: "confirmada", valor, decididaEm: agora, updatedAt: agora })
      .where(and(eq(networkSugestoes.id, id), eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.status, "pendente")));
    if (!((tomada as { affectedRows?: number } | undefined)?.affectedRows)) throw new PendenciaNaoEncontrada();

    switch (campo) {
      case "nome": await tx.update(privateContacts).set({ fullName: valor, updatedAt: agora }).where(doContato); return false;
      case "telefone": await tx.update(privateContacts).set({ phone: valor, updatedAt: agora }).where(doContato); return false;
      case "email": await tx.update(privateContacts).set({ email: valor, updatedAt: agora }).where(doContato); return false;
      case "tipo_pessoa": await tx.update(privateContacts).set({ tipoPessoa: valor as "fisica" | "juridica", updatedAt: agora }).where(doContato); return false;
      case "cargo": await tx.update(privateContacts).set({ jobTitle: valor, updatedAt: agora }).where(doContato); return false;
      case "empresa": await tx.update(privateContacts).set({ company: valor, updatedAt: agora }).where(doContato); return false;
      case "tenho":
      case "preciso": {
        const tabela = campo === "tenho" ? contactAssets : contactNeeds;
        const slug = slugifyMatchTag(valor);
        const [existente] = await tx.select({ id: tabela.id }).from(tabela)
          .where(and(eq(tabela.ownerId, ownerId), eq(tabela.contactId, contactId), or(eq(tabela.tagSlug, slug), eq(tabela.tagLabel, valor))))
          .limit(1);
        if (existente) return false;
        // A dona confirma só o texto; categoria que ela não viu não vira dado (e daria match por categoria).
        await tx.insert(tabela).values({ ownerId, contactId, tagSlug: slug, tagLabel: valor, category: null, description: null, createdAt: agora, updatedAt: agora });
        return true;
      }
    }
  });
  return { campo, contactId, mudouTenhoOuPreciso: inseriu };
}

export async function ignorarPendencia(ownerId: string, id: string) {
  const db = await exigirDb();
  const agora = Date.now();
  const [resultado] = await db.update(networkSugestoes)
    .set({ status: "ignorada", decididaEm: agora, updatedAt: agora })
    .where(and(eq(networkSugestoes.id, id), eq(networkSugestoes.ownerId, ownerId), eq(networkSugestoes.status, "pendente")));
  if (!((resultado as { affectedRows?: number } | undefined)?.affectedRows)) throw new PendenciaNaoEncontrada();
  return { ok: true as const };
}

/**
 * Decisão sobre a pessoa sugerida pela reunião (meetings.decideContactSuggestion):
 * - criar: as pendências de O QUE TENHO / O QUE PRECISO / tipo de pessoa passam
 *   a apontar para o contato novo, ainda pendentes — criar o contato confirma
 *   o QUEM SOU que a tela mostrou, não o resto. Cargo e empresa que a IA deu
 *   à pessoa não entram no contato (achado 6 da bancada de 16/11): viram
 *   pendências dele;
 * - vincular a um contato que já existe: idem, e o QUEM SOU, o cargo e a
 *   empresa da sugestão que diferem do contato viram pendência (nada
 *   sobrescreve o que a dona gravou);
 * - ignorar: tudo que veio daquela pessoa é ignorado.
 */
export async function decidirPendenciasDaPessoaSugerida(db: Banco, entrada: {
  ownerId: string;
  meetingSuggestionId: string;
  meetingId: string;
  acao: "create" | "link" | "ignore";
  contactId: number | null;
  quemSouDaSugestao?: { fullName: string; phone: string | null; email: string | null; jobTitle?: string | null; company?: string | null };
}) {
  const agora = Date.now();
  const daPessoa = and(
    eq(networkSugestoes.ownerId, entrada.ownerId),
    eq(networkSugestoes.meetingSuggestionId, entrada.meetingSuggestionId),
    eq(networkSugestoes.status, "pendente"),
  );
  if (entrada.acao === "ignore" || entrada.contactId === null) {
    await db.update(networkSugestoes).set({ status: "ignorada", decididaEm: agora, updatedAt: agora }).where(daPessoa);
    return;
  }
  await db.update(networkSugestoes).set({ contactId: entrada.contactId, updatedAt: agora }).where(daPessoa);
  const sugestao = entrada.quemSouDaSugestao;
  if (!sugestao) return;
  const linha = (campo: CampoDaSugestao, valor: string | null | undefined): PendenciaNova[] =>
    valor?.trim() ? [{ campo, valor: valor.trim(), categoria: null, trecho: null, confianca: 0.8 }] : [];
  const apoio = [...linha("cargo", sugestao.jobTitle), ...linha("empresa", sugestao.company)];
  const gravar = (linhas: PendenciaNova[]) => gravarPendencias(db, {
    ownerId: entrada.ownerId, origem: "reuniao", contactId: entrada.contactId,
    meetingId: entrada.meetingId, meetingSuggestionId: entrada.meetingSuggestionId, linhas,
  });
  if (entrada.acao === "create") {
    await gravar(apoio);
    return;
  }
  const atual = await retratoDoContato(db, entrada.ownerId, entrada.contactId);
  if (!atual) return;
  await gravar(semRepeticao([
    ...linha("nome", sugestao.fullName), ...linha("telefone", sugestao.phone), ...linha("email", sugestao.email), ...apoio,
  ], atual));
}

/**
 * As propostas por pessoa que a extração da reunião devolve, já filtradas
 * pelo portão contra a transcrição — e sem o nome, a empresa ou o telefone
 * que a própria extração deu à pessoa. Serve a processarAudioGuardado.
 */
export function pendenciasDaPessoaNaReuniao(pessoa: {
  tipoPessoa?: unknown; oQueTenho?: unknown; oQuePreciso?: unknown;
  fullName?: unknown; company?: unknown; phone?: unknown;
}, transcricao: string): PendenciaNova[] {
  const filtrada = filtrarPelaFonte({
    quemSou: { tipoPessoa: pessoa.tipoPessoa === "fisica" || pessoa.tipoPessoa === "juridica" ? pessoa.tipoPessoa : "nao_informado", nome: null, telefone: null, email: null },
    oQueTenho: pessoa.oQueTenho as ItemProposto[],
    oQuePreciso: pessoa.oQuePreciso as ItemProposto[],
  }, transcricao, { nomes: [pessoa.fullName, pessoa.company], telefones: [pessoa.phone] });
  return pendenciasDaProposta(filtrada);
}

/** As pendências tiradas de uma reunião saem com os derivados dela (exclusão e reprocessamento). */
export async function apagarPendenciasDaReuniao(db: Banco, ownerId: string, meetingId: string) {
  await db.delete(networkSugestoes).where(and(eq(networkSugestoes.meetingId, meetingId), eq(networkSugestoes.ownerId, ownerId)));
}
