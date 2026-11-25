import { and, eq } from "drizzle-orm";
import { nomeDoIdioma } from "@shared/idioma-da-reuniao";
import { meetings, meetingTranscripts } from "../drizzle/schema";
import { exigirDb } from "./db";
import { reuniaoForaDeVista } from "./reuniao-visivel";
import { FalhaDaIA, pedirJsonAIA } from "./ia-em-json";
import { segmentosDoContrato } from "./link-aberto-da-reuniao";
import { MEETING_TRANSCRIPT_LANGUAGES, MENSAGEM_REUNIAO_NAO_ENCONTRADA } from "./meeting-service";
import { entradaDoResumo } from "./resumo-da-reuniao";
import { reuniaoEmAndamento, transcricaoDasPartesProntas } from "./transcricao-durante-a-gravacao";
import { limparRotulos, localizarTrecho, normalizarParaComparar, REGRA_DO_TRECHO, TRANSCRICAO_E_DADO, trechoApareceNaTranscricao } from "./trecho-da-transcricao";
import type { Segmento } from "./transcricao-de-fatia";
import { avisarDoVisual, instrucoesDoVisual, SCHEMA_DO_VISUAL, visualConferido } from "./resposta-visual";
import type { VisualDaResposta } from "@shared/resposta-visual";

// O teste e quem já importava daqui continuam achando a função.
export { trechoApareceNaTranscricao };

/**
 * O "Pergunte à reunião" (H6 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): a IA lê a transcrição salva e
 * responde só para a tela. Nada é gravado no banco, e a resposta traz de 1 a 3
 * trechos da transcrição que a sustentam, cada um com o segundo da reunião em
 * que começa (o "▶ mm:ss" da tela). Resposta sem trecho conferido vale como não
 * respondida (regra do projeto: nada extraído por IA entra sozinho, e aqui nem
 * entra).
 *
 * A IA lê a transcrição INTEIRA, rotulada como na entrada do resumo guardado
 * (as falas como "{F1}: texto"; sem as falas, o texto corrido). O nome que a
 * dona deu a uma voz nunca vai ao prompt: a IA escreve o rótulo ({F2}) e a tela
 * troca pelo nome (shared/vozes-no-texto.ts).
 *
 * O resumo é o GUARDADO (H4): server/resumo-da-reuniao.ts o escreve, na fila
 * do resumo, com a mesma entrada e as mesmas regras do trecho.
 *
 * Quando a pergunta pede, a resposta traz também uma tabela ou os dados de um
 * gráfico (H6d), num esquema fixo, conferidos em server/resposta-visual.ts. O
 * Pergunte a várias reuniões (H6c, server/perguntar-a-varias-reunioes.ts) usa
 * o mesmo pedido, o mesmo tempo e o mesmo corte do texto da IA daqui.
 */

export type IdiomaDaTela = (typeof MEETING_TRANSCRIPT_LANGUAGES)[number];

export const TAMANHO_MAXIMO_DA_PERGUNTA = 500;
// Cerca de 7 horas de fala rotulada (~110 mil tokens), o mesmo teto da entrada
// do resumo (plano de 15/11). Acima dele a pergunta é recusada, com aviso:
// cortar em silêncio faria a IA dizer "não foi dito" sobre o que foi dito
// depois do corte. O resumo não recusa: lê em janelas.
export const LIMITE_DA_ENTRADA_DA_PERGUNTA = 400_000;
// Acima disto (cerca de 1h45 de fala) a reunião é longa: o modelo leva mais
// tempo só para ler a entrada, e a chamada ganha mais folga. A pergunta longa
// também pesa mais no teto, o da dona e o do link aberto
// (segundaVagaDaPerguntaLonga, em routers/meetings.ts).
export const ENTRADA_LONGA_DA_PERGUNTA = 100_000;
// A dona espera na tela: cada tentativa tem o teto, e o orçamento (tentativas e
// esperas somadas) só deixa uma nova tentativa depois de uma falha rápida: até
// 15 s na reunião curta, até 5 s na longa. Na longa, o pior caso (uma falha de
// 5 s e uma tentativa inteira) fica em 85 s: com a leitura do banco, a
// requisição inteira fica abaixo dos 100 s em que um proxy na frente do
// servidor costuma cortá-la (o Cloudflare corta aí, com o erro 524). Cortada
// pelo proxy, a tela receberia um erro genérico, e não a frase traduzida de
// "a IA não respondeu".
const TEMPO_DA_REUNIAO_CURTA = { timeoutMs: 45_000, orcamentoMs: 60_000 };
const TEMPO_DA_REUNIAO_LONGA = { timeoutMs: 80_000, orcamentoMs: 85_000 };
export const CITACOES_NO_MAXIMO = 3;
/**
 * O tamanho da resposta, em letras. Era 1.000, com "no máximo 3 frases" para
 * toda pergunta: a sugestão "Ações e responsáveis" (H6b), que pede TODAS as
 * ações da reunião, saía cortada nas primeiras (defeito 3 do teste manual T50,
 * 23/11). A transcrição já ia inteira; o corte era o da resposta. 4.000 letras
 * cabem umas 30 ações de uma linha.
 */
export const RESPOSTA_DA_PERGUNTA_MAX = 4_000;
/** A regra da pergunta que pede uma lista: a reunião inteira, um item por linha (defeito 3 do T50). */
export const REGRA_DA_LISTA = "Quando a pergunta pede uma lista (todas as ações, com os responsáveis e os prazos; as decisões; os termos citados), leia a transcrição inteira, do começo ao fim, e liste cada item numa linha própria, começando por \"- \", sem parar nos primeiros e sem juntar dois itens numa linha: nesse caso, o limite de 3 frases não vale.";

export const MENSAGEM_SEM_TRANSCRICAO = "Esta reunião ainda não tem transcrição pronta para a IA ler.";
export const MENSAGEM_IA_INDISPONIVEL = "O serviço de IA não respondeu agora. Tente de novo em instantes.";
export const MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR = "Esta reunião é longa demais para perguntas à IA: o limite é de cerca de 7 horas de fala.";

type CodigoDaRecusa = "NOT_FOUND" | "PRECONDITION_FAILED" | "SERVICE_UNAVAILABLE" | "PAYLOAD_TOO_LARGE";

/**
 * Recusa com o código que o router repassa e a tela traduz. A reunião longa
 * demais para perguntar tem o código só dela (PAYLOAD_TOO_LARGE): a frase em
 * português nunca chega crua à tela.
 */
export class RecusaDaReuniaoComIA extends Error {
  readonly codigo: CodigoDaRecusa;
  constructor(codigo: CodigoDaRecusa, mensagem: string) {
    super(mensagem);
    this.name = "RecusaDaReuniaoComIA";
    this.codigo = codigo;
  }
}

/** Um trecho literal que sustenta a resposta e o segundo da reunião em que ele começa (null sem as falas). */
export type CitacaoDaResposta = { trecho: string; inicioSegundos: number | null };

export type RespostaDaReuniao =
  | {
      respondida: true;
      resposta: string;
      citacoes: CitacaoDaResposta[];
      /**
       * O campo de antes da H6 (um trecho só), igual ao da primeira citação.
       * Fica por UMA versão, para a aba aberta antes do deploy não quebrar, e
       * sai na seguinte: a tela nova lê só `citacoes`. A aba antiga mostra a
       * resposta como ela vem, e a IA agora escreve a voz como rótulo: lá,
       * "{F2} disse..." aparece cru até a página recarregar. Aceito: a aba
       * antiga é passageira, e o rótulo não expõe nome nenhum.
       */
      trecho: string;
      /**
       * A tabela ou o gráfico (H6d), só quando a pergunta pede e a conferência
       * passa (server/resposta-visual.ts). Sem visual, o campo nem vem.
       */
      visual?: VisualDaResposta;
    }
  | { respondida: false };

type TranscricaoDaReuniao = { texto: string; segmentos: Segmento[] };

/**
 * A transcrição de uma reunião PRONTA da dona, com as falas. O ownerId vai no
 * WHERE das duas leituras: reunião de outra dona é "não encontrada", nunca
 * lida. Os nomes das vozes (meetings.speaker_names) não são lidos: não vão à
 * IA. Banco fora do ar sobe como erro (o middleware do tRPC o traduz), nunca
 * vira "sem dados".
 */
async function transcricaoDaReuniaoPronta(ownerId: string, meetingId: string): Promise<TranscricaoDaReuniao> {
  const db = await exigirDb();
  const [reuniao] = await db.select({ status: meetings.status, trashedAt: meetings.trashedAt }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  // A da lixeira (H7d) é "não encontrada", como a excluída.
  if (!reuniao || reuniaoForaDeVista(reuniao)) throw new RecusaDaReuniaoComIA("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  // Em processamento a transcrição é da tentativa anterior e está para ser trocada.
  if (reuniao.status !== "ready") throw new RecusaDaReuniaoComIA("PRECONDITION_FAILED", MENSAGEM_SEM_TRANSCRICAO);
  const [transcricao] = await db.select({ transcript: meetingTranscripts.transcript, segments: meetingTranscripts.segments }).from(meetingTranscripts)
    .where(and(eq(meetingTranscripts.meetingId, meetingId), eq(meetingTranscripts.ownerId, ownerId))).limit(1);
  const texto = transcricao?.transcript?.trim();
  if (!texto) throw new RecusaDaReuniaoComIA("PRECONDITION_FAILED", MENSAGEM_SEM_TRANSCRICAO);
  return { texto, segmentos: segmentosDoContrato(transcricao?.segments) };
}

/**
 * Chama a IA pedindo JSON (server/ia-em-json.ts). Qualquer falha dela (rede,
 * cota, JSON inválido, resposta cortada) vira SERVICE_UNAVAILABLE, que a tela
 * mostra traduzido.
 */
export async function pedirJsonDaTela(
  sistema: string, usuario: string, nome: string, schema: Record<string, unknown>,
  tempo: { timeoutMs: number; orcamentoMs: number },
): Promise<{ dados: Record<string, unknown>; modelo: string | null }> {
  try {
    // Só o Pergunte usa este pedido (a uma reunião e a várias, H6c):
    // LLM_MODEL_PERGUNTA escolhe o modelo dele, e LLM_RACIOCINIO_PERGUNTA, o raciocínio.
    return await pedirJsonAIA({ sistema, usuario, nome, schema, ...tempo, funcao: "pergunta" });
  } catch (erro) {
    if (erro instanceof FalhaDaIA) throw new RecusaDaReuniaoComIA("SERVICE_UNAVAILABLE", MENSAGEM_IA_INDISPONIVEL);
    throw erro;
  }
}

/** O tempo da chamada à IA pelo tamanho da entrada: ver TEMPO_DA_REUNIAO_CURTA. */
export function tempoDaPergunta(caracteres: number): { timeoutMs: number; orcamentoMs: number } {
  return caracteres > ENTRADA_LONGA_DA_PERGUNTA ? TEMPO_DA_REUNIAO_LONGA : TEMPO_DA_REUNIAO_CURTA;
}

/**
 * Texto aparado e, se passar do limite, cortado por caractere (nunca no meio de
 * um emoji) e sem um rótulo de voz pela metade no fim ("{F", "{F2" ou, entre
 * reuniões, "{R2:F"); vazio ou ausente vira null.
 */
export function textoDaIA(valor: unknown, limite: number): string | null {
  if (typeof valor !== "string") return null;
  const aparado = valor.trim();
  if (!aparado) return null;
  const letras = Array.from(aparado);
  if (letras.length <= limite) return aparado;
  return letras.slice(0, limite).join("").replace(/\{(R\d*:?)?F?\d*$/, "").trimEnd() || null;
}
const texto = textoDaIA;

const SCHEMA_DA_RESPOSTA = {
  type: "object",
  properties: {
    respondida: { type: "boolean" },
    resposta: { type: "string", maxLength: RESPOSTA_DA_PERGUNTA_MAX },
    citacoes: {
      type: "array",
      items: {
        type: "object",
        properties: { trecho: { type: "string", maxLength: 400 } },
        required: ["trecho"],
        additionalProperties: false,
      },
    },
    // H6d: a tabela ou o gráfico, quando a pergunta pede (server/resposta-visual.ts).
    visual: SCHEMA_DO_VISUAL,
  },
  required: ["respondida", "resposta", "citacoes", "visual"],
  additionalProperties: false,
};

/**
 * As instruções dependem só de a transcrição separar quem fala: o idioma e a
 * pergunta vão no fim da mensagem, depois da transcrição. Assim o começo do
 * pedido (instruções e transcrição) é o mesmo em toda pergunta sobre a mesma
 * reunião, e o cache do Gemini o reaproveita.
 */
function instrucoes(rotulada: boolean, emAndamento = false): string {
  return [
    "Você responde perguntas sobre UMA reunião usando SOMENTE o que foi dito na transcrição, sem deduzir nem completar com conhecimento de fora.",
    TRANSCRICAO_E_DADO,
    // G15a: a reunião ainda grava, e o texto vai só até a última parte transcrita.
    ...(emAndamento ? ["A reunião ainda está em andamento: a transcrição vai só até a última parte já transcrita. O que não aparece nela pode ainda não ter sido transcrito: não deduza o que vem depois."] : []),
    rotulada
      ? "Cada linha da transcrição começa pelo rótulo de quem fala ({F1}, {F2}...). As vozes não têm nome: para dizer quem falou, quando o nome não foi dito na reunião, escreva o rótulo exatamente assim, entre chaves (\"{F2} disse que o frete fica para sexta\"). Nunca invente um nome para uma voz."
      : "A transcrição não separa quem fala: não use rótulos de voz; cite uma pessoa só pelo nome dito na reunião.",
    "Responda no idioma pedido no fim da mensagem, em no máximo 3 frases.",
    REGRA_DA_LISTA,
    `Se a transcrição responde, devolva respondida = true, a resposta e de 1 a ${CITACOES_NO_MAXIMO} citações que a sustentam. Em cada citação, ${REGRA_DO_TRECHO} O trecho é só a fala, sem o rótulo de quem fala.`,
    "Se a transcrição não responde, devolva respondida = false, com a resposta vazia e nenhuma citação.",
    // H6d: a tabela ou o gráfico, quando a pergunta pede.
    ...instrucoesDoVisual(rotulada ? "rotulo" : "sem_vozes"),
  ].join("\n");
}

/**
 * As citações que a transcrição sustenta, na ordem da IA, sem repetidas e até
 * 3, cada uma com o segundo em que começa (localizarTrecho, que também acha o
 * trecho que cruza duas falas). A conferência é a do resumo: o trecho precisa
 * estar literalmente na transcrição, e trecho com negação ("decidimos não
 * renovar") vale. Só o dobro do pedido é examinado: cada conferência percorre
 * a reunião inteira.
 */
function citacoesConferidas(bruto: unknown, transcricao: TranscricaoDaReuniao): CitacaoDaResposta[] {
  const lista = Array.isArray(bruto) ? bruto.slice(0, 2 * CITACOES_NO_MAXIMO) : [];
  const vistas = new Set<string>();
  const citacoes: CitacaoDaResposta[] = [];
  for (const item of lista) {
    if (citacoes.length >= CITACOES_NO_MAXIMO) break;
    const dito = item && typeof item === "object" ? (item as Record<string, unknown>).trecho : null;
    // A IA às vezes copia o rótulo da voz junto da fala ("{F2}: ..."): ele sai antes de conferir.
    const trecho = texto(typeof dito === "string" ? limparRotulos(dito) : null, 400);
    if (!trecho || !trechoApareceNaTranscricao(trecho, transcricao.texto)) continue;
    const chave = normalizarParaComparar(trecho);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    citacoes.push({ trecho, inicioSegundos: localizarTrecho(trecho, transcricao.segmentos) });
  }
  return citacoes;
}

const ROTULO_DE_VOZ = /\{(F[1-9]\d?)\}/g;

/**
 * Os rótulos que a resposta cita e que não são vozes da entrada que a IA leu:
 * "{F7}" numa reunião de duas vozes viraria um "Falante 7" que não existe na
 * tela. As vozes são as que entradaDoResumo rotulou (sem as falas, nenhuma),
 * e não um filtro refeito aqui: a voz que só tem fala vazia não foi ao prompt.
 */
export function vozesForaDaEntrada(resposta: string, vozes: ReadonlySet<string>): string[] {
  return Array.from(resposta.matchAll(ROTULO_DE_VOZ), rotulo => rotulo[1]).filter(voz => !vozes.has(voz));
}

/**
 * Por que a pergunta voltou como não respondida. A tela diz o mesmo nos quatro
 * casos ("a transcrição não responde"), e o log os separa: a IA que disse não
 * é uma coisa, a resposta que a conferência derrubou é outra, e só o log mede
 * quantas respostas caem na conferência. Vão ao log só o motivo, contagens e
 * rótulos de voz: a pergunta, a resposta e os trechos são a fala das pessoas.
 */
type MotivoDaNaoRespondida = "ia_disse_que_nao" | "resposta_vazia" | "sem_citacao_conferida" | "voz_inexistente";

function naoRespondida(motivo: MotivoDaNaoRespondida, detalhe?: string): { respondida: false } {
  const linha = `[Pergunte] não respondida (${motivo})${detalhe ? `: ${detalhe}` : ""}`;
  // A IA que diz não é o caminho normal; o resto é resposta que se perdeu.
  if (motivo === "ia_disse_que_nao") console.info(linha);
  else console.warn(linha);
  return { respondida: false };
}

/**
 * Pergunta à IA sobre uma reunião pronta da dona. `antesDeChamarAIA` roda com
 * o tamanho conhecido e antes da chamada (os routers da dona e do link tomam
 * ali a segunda vaga do teto, a da reunião longa: segundaVagaDaPerguntaLonga,
 * em routers/meetings.ts); não roda quando a pergunta é recusada antes da IA.
 */
export async function perguntarAReuniao(
  ownerId: string,
  meetingId: string,
  pergunta: string,
  idioma: IdiomaDaTela,
  antesDeChamarAIA?: (custo: { longa: boolean }) => void,
): Promise<RespostaDaReuniao> {
  return responderPelaTranscricao(await transcricaoDaReuniaoPronta(ownerId, meetingId), pergunta, idioma, antesDeChamarAIA, false);
}

/**
 * A pergunta durante a gravação (G15a; HN-20 do HiNoter): a IA lê o texto das
 * partes que a fila já transcreveu (server/transcricao-durante-a-gravacao.ts),
 * com as mesmas regras da pergunta de sempre (a conferência dos trechos, as
 * vozes como rótulo, os tetos). Só a reunião gravada em partes da dona, em
 * andamento (gravando, recebendo as últimas partes ou montando a
 * transcrição); a que ficou pronta no meio responde pela transcrição final.
 * Sem nenhuma parte transcrita ainda, recusa antes da IA (PRECONDITION_FAILED).
 */
export async function perguntarDuranteAGravacao(
  ownerId: string,
  meetingId: string,
  pergunta: string,
  idioma: IdiomaDaTela,
  antesDeChamarAIA?: (custo: { longa: boolean }) => void,
): Promise<RespostaDaReuniao> {
  const db = await exigirDb();
  const [reuniao] = await db.select({ status: meetings.status, audioPipeline: meetings.audioPipeline, trashedAt: meetings.trashedAt }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (!reuniao || reuniaoForaDeVista(reuniao)) throw new RecusaDaReuniaoComIA("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
  if (reuniao.status === "ready") return perguntarAReuniao(ownerId, meetingId, pergunta, idioma, antesDeChamarAIA);
  if (reuniao.audioPipeline !== "slices" || !reuniaoEmAndamento(reuniao.status)) throw new RecusaDaReuniaoComIA("PRECONDITION_FAILED", MENSAGEM_SEM_TRANSCRICAO);
  const { texto, segmentos } = await transcricaoDasPartesProntas(db, ownerId, meetingId);
  if (!texto.trim()) throw new RecusaDaReuniaoComIA("PRECONDITION_FAILED", MENSAGEM_SEM_TRANSCRICAO);
  return responderPelaTranscricao({ texto, segmentos }, pergunta, idioma, antesDeChamarAIA, true);
}

/**
 * A pergunta à IA sobre uma transcrição já lida (a final ou, durante a
 * gravação, a das partes prontas): o tamanho, o teto da reunião longa, a
 * chamada e a conferência da resposta.
 */
async function responderPelaTranscricao(
  transcricao: TranscricaoDaReuniao,
  pergunta: string,
  idioma: IdiomaDaTela,
  antesDeChamarAIA: ((custo: { longa: boolean }) => void) | undefined,
  emAndamento: boolean,
): Promise<RespostaDaReuniao> {
  const entrada = entradaDoResumo(transcricao.texto, transcricao.segmentos);
  if (entrada.texto.length > LIMITE_DA_ENTRADA_DA_PERGUNTA) throw new RecusaDaReuniaoComIA("PAYLOAD_TOO_LARGE", MENSAGEM_REUNIAO_LONGA_PARA_PERGUNTAR);
  const longa = entrada.texto.length > ENTRADA_LONGA_DA_PERGUNTA;
  antesDeChamarAIA?.({ longa });
  const { dados } = await pedirJsonDaTela(
    instrucoes(entrada.rotulada, emAndamento),
    // A transcrição primeiro e a pergunta por último: ver instrucoes().
    `Transcrição:\n\n${entrada.texto}\n\nResponda em ${nomeDoIdioma(idioma)}.\nPergunta: ${pergunta.slice(0, TAMANHO_MAXIMO_DA_PERGUNTA)}`,
    "resposta_da_reuniao",
    SCHEMA_DA_RESPOSTA,
    tempoDaPergunta(entrada.texto.length),
  );
  if (dados.respondida !== true) return naoRespondida("ia_disse_que_nao");
  const resposta = texto(dados.resposta, RESPOSTA_DA_PERGUNTA_MAX);
  if (!resposta) return naoRespondida("resposta_vazia");
  // Resposta sem trecho que a transcrição sustente, ou que cita uma voz que a
  // reunião não tem, não vai para a tela: vale como não respondida. A voz
  // inventada derruba a resposta inteira, como derruba o item do resumo:
  // trocar o rótulo por um texto neutro deixaria na tela uma frase atribuída a
  // ninguém, e o rótulo inventado mostra que a IA leu mal a reunião.
  const citacoes = citacoesConferidas(dados.citacoes, transcricao);
  if (!citacoes.length) {
    const recebidas = Array.isArray(dados.citacoes) ? dados.citacoes.length : 0;
    return naoRespondida("sem_citacao_conferida", `nenhuma de ${recebidas} citações está na transcrição`);
  }
  const inventadas = vozesForaDaEntrada(resposta, entrada.vozes);
  if (inventadas.length) return naoRespondida("voz_inexistente", `${inventadas.join(", ")} fora das ${entrada.vozes.size} vozes da entrada`);
  // H6d: o visual só acompanha a resposta que passou; a voz que a entrada não tem derruba só ele.
  const conferido = visualConferido(dados.visual, textoDoVisual => (vozesForaDaEntrada(textoDoVisual, entrada.vozes).length ? null : textoDoVisual));
  avisarDoVisual("Pergunte", conferido);
  return { respondida: true, resposta, citacoes, trecho: citacoes[0].trecho, ...(conferido.visual ? { visual: conferido.visual } : {}) };
}
