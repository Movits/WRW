/**
 * As vozes das participantes (H3c): os códigos das recusas de ligar uma voz a
 * uma conta e de juntar e separar vozes, que a tela traduz
 * (client/src/lib/mensagem-de-erro.ts). Os parsers das colunas moram em
 * shared/const.ts, ao lado de nomesDosFalantes.
 */
export const RECUSAS_DAS_VOZES = {
  /** A reunião não existe, não é da dona, foi excluída ou está na lixeira. */
  reuniaoNaoEncontrada: "VOZES_REUNIAO_NAO_ENCONTRADA",
  /** Só a reunião pronta tem as vozes finais. */
  soReuniaoPronta: "VOZES_SO_REUNIAO_PRONTA",
  /** A voz não existe nas falas, ou não tem o formato F1 a F99. */
  vozInvalida: "VOZES_VOZ_INVALIDA",
  /** A conta escolhida não é a dona nem uma participante ativa desta reunião. */
  contaInvalida: "VOZES_CONTA_INVALIDA",
  /** A voz juntada a ela mesma. */
  juntarASiMesma: "VOZES_JUNTAR_A_SI_MESMA",
  /** A principal escolhida já está juntada a outra voz (sem cadeia). */
  principalJuntada: "VOZES_PRINCIPAL_JUNTADA",
} as const;
export type CodigoDaRecusaDasVozes = (typeof RECUSAS_DAS_VOZES)[keyof typeof RECUSAS_DAS_VOZES];
