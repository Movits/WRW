/**
 * O Pergunte a várias reuniões (H6c do plano do gravador; HN-44 no app de
 * referência da cliente: perguntar a várias notas, escolhendo-as, com o número
 * de fontes). A dona escolhe as reuniões por etiqueta ou uma a uma, e a IA lê
 * as transcrições delas, até o teto de uma pergunta (o mesmo da pergunta a uma
 * reunião, cerca de 7 h de fala). Acima dele, lê primeiro as mais ligadas à
 * pergunta, pelo índice da Memória, e diz quais ficaram de fora. O servidor
 * está em server/perguntar-a-varias-reunioes.ts; a tela, em
 * client/src/components/PergunteAVariasReunioes.tsx.
 */

/** Quantas reuniões uma pergunta pode escolher (uma a uma, ou as mais novas das etiquetas). */
export const REUNIOES_POR_PERGUNTA_MAX = 30;
/**
 * Quantas etiquetas uma pergunta pode juntar (T52): as reuniões com QUALQUER
 * uma delas entram (a união), até REUNIOES_POR_PERGUNTA_MAX.
 */
export const ETIQUETAS_POR_PERGUNTA_MAX = 20;
/** O que a IA lê de uma vez: o teto da pergunta a uma reunião (LIMITE_DA_ENTRADA_DA_PERGUNTA), cerca de 7 h de fala. */
export const LIMITE_DA_LEITURA_DA_IA = 400_000;
/** Os caracteres de uma hora de fala, para a tela estimar as horas (o teto dá cerca de 7 h). */
export const CARACTERES_POR_HORA_DE_FALA = Math.round(LIMITE_DA_LEITURA_DA_IA / 7);
/**
 * O teto de perguntas a várias reuniões por dona, em 24 h, contado no banco (as
 * linhas de perguntas_entre_reunioes): cada uma pode ler até ~7 h de fala, e um
 * teto de um dia que zerasse a cada deploy não seguraria nada.
 */
export const PERGUNTAS_ENTRE_REUNIOES_EM_24H = 20;
export const JANELA_DAS_PERGUNTAS_ENTRE_REUNIOES_MS = 24 * 60 * 60_000;
/** Quantas citações a resposta traz, no máximo (de reuniões diferentes, quando a resposta usa várias). */
export const CITACOES_ENTRE_REUNIOES_MAX = 5;

/** A avaliação que a dona dá à resposta ("ajudou" ou "não ajudou"). */
export const AVALIACOES_DA_RESPOSTA = ["boa", "ruim"] as const;
export type AvaliacaoDaResposta = (typeof AVALIACOES_DA_RESPOSTA)[number];

/** As recusas, como CÓDIGO (a tela traduz). */
export const RECUSAS_ENTRE_REUNIOES = {
  /** Uma das reuniões escolhidas não é da dona, não existe ou está sendo excluída. */
  naoEncontrada: "VARIAS_REUNIAO_NAO_ENCONTRADA",
  /** Nenhuma reunião pronta da dona tem as etiquetas escolhidas. */
  semReuniao: "VARIAS_SEM_REUNIAO",
  /** Nenhuma das escolhidas tem transcrição pronta. */
  semTranscricao: "VARIAS_SEM_TRANSCRICAO",
  /** Cada uma das escolhidas passa sozinha do que a IA lê de uma vez. */
  longasDemais: "VARIAS_LONGAS_DEMAIS",
  /** O teto de 24 h. */
  tetoDiario: "VARIAS_TETO_DIARIO",
  /** A avaliação de uma pergunta que não é da dona (ou que não existe). */
  perguntaNaoEncontrada: "VARIAS_PERGUNTA_NAO_ENCONTRADA",
} as const;
export type CodigoDaRecusaEntreReunioes = (typeof RECUSAS_ENTRE_REUNIOES)[keyof typeof RECUSAS_ENTRE_REUNIOES];

/** Por que uma reunião escolhida não foi lida. */
export const MOTIVOS_DE_FORA = ["limite", "longa_demais", "sem_transcricao"] as const;
export type MotivoDeFora = (typeof MOTIVOS_DE_FORA)[number];

/**
 * Em que ordem a IA leu: "todas" (couberam todas), "relevancia" (passavam do
 * teto, e o índice da Memória escolheu as mais ligadas à pergunta) ou
 * "recentes" (passavam do teto, e sem o índice ficaram as mais novas).
 */
export const ORDENS_DA_LEITURA = ["todas", "relevancia", "recentes"] as const;
export type OrdemDaLeitura = (typeof ORDENS_DA_LEITURA)[number];

/** As horas de fala, arredondadas para meia hora (no mínimo meia), pelos caracteres da transcrição. */
export function horasDeFala(caracteres: number): number {
  return Math.max(0.5, Math.round((caracteres / CARACTERES_POR_HORA_DE_FALA) * 2) / 2);
}

/**
 * O rótulo de uma voz entre reuniões, como a resposta o traz: a reunião (o
 * número dela na lista de fontes) e a voz dentro dela, "{R2:F1}". O {F1} da
 * reunião 1 e o da reunião 2 podem ser pessoas diferentes.
 */
const ROTULO_ENTRE_REUNIOES = /\{R([1-9]\d?):F([1-9]\d?)\}/g;

/**
 * A troca dos rótulos entre reuniões pelo que a tela mostra: o nome que a dona
 * deu à voz naquela reunião ou, sem nome, o rótulo traduzido que quem chama
 * monta ("Falante 1 (reunião 2)"). Por função, e não por texto: um nome com
 * "$&" sairia trocado pelo próprio rótulo. Como em vozesNoTexto
 * (shared/vozes-no-texto.ts), o servidor nunca resolve o nome.
 */
export function vozesEntreReunioesNoTexto(
  texto: string,
  nomesDaReuniao: (numero: number) => Readonly<Record<string, string>> | undefined,
  rotuloDaVoz: (numeroDaVoz: number, numeroDaReuniao: number) => string,
): string {
  return texto.replace(ROTULO_ENTRE_REUNIOES, (_rotulo, reuniao: string, voz: string) => {
    const nome = nomesDaReuniao(Number(reuniao))?.[`F${voz}`]?.trim();
    return nome || rotuloDaVoz(Number(voz), Number(reuniao));
  });
}
