/**
 * Juntar reuniões (H17 da auditoria de 16/11; HN-06 no app de referência da
 * cliente: juntar gravações separadas numa nota só). Duas ou mais reuniões
 * gravadas viram uma: a primeira fica (título, data, link da tela), o áudio das
 * outras entra depois do dela, na ordem escolhida, a transcrição é emendada e o
 * resumo é refeito pela IA (server/juntar-reunioes.ts).
 *
 * O caso que motivou: até a G13b a gravação parava em 10 minutos, e quem gravou
 * uma reunião longa tem vários pedaços dela.
 */

/** Quantas reuniões se juntam de uma vez. */
export const REUNIOES_POR_JUNCAO_MAX = 10;
/** O teto de junções por dona (cada uma refaz a extração e o resumo pela IA): 3 a cada 10 minutos. */
export const JUNCOES_POR_JANELA = 3;
export const JANELA_DA_JUNCAO_MS = 10 * 60_000;

/**
 * As recusas da junção, como CÓDIGO (a tela traduz):
 * - FORA_DO_ESTADO: alguma reunião não está pronta (gravando, processando, com
 *   falha) ou está sem o consentimento da gravação;
 * - SO_AUDIO: documento (PDF ou fotos) e vídeo do YouTube não se juntam;
 * - SEM_AUDIO: o áudio de alguma reunião não está mais guardado (passou dos 30
 *   dias) ou vence antes de a junção terminar;
 * - LONGA_DEMAIS: a reunião juntada passaria do teto da gravação (12 h, ou 200
 *   partes) ou de 99 vozes;
 * - DEMAIS: o teto de junções por dona.
 */
export const RECUSAS_DA_JUNCAO = {
  foraDoEstado: "JUNCAO_FORA_DO_ESTADO",
  soAudio: "JUNCAO_SO_AUDIO",
  semAudio: "JUNCAO_SEM_AUDIO",
  longaDemais: "JUNCAO_LONGA_DEMAIS",
  demais: "JUNCOES_DEMAIS",
} as const;
export type CodigoDaRecusaDaJuncao = (typeof RECUSAS_DA_JUNCAO)[keyof typeof RECUSAS_DA_JUNCAO];

/** A reunião pode entrar numa junção, pelo que a lista sabe dela? (o servidor confere de novo, com o áudio) */
export function podeJuntar(reuniao: { status: string; origem?: string | null }): boolean {
  if (reuniao.status !== "ready") return false;
  return reuniao.origem !== "pdf" && reuniao.origem !== "foto" && reuniao.origem !== "youtube";
}

/**
 * A ordem em que as reuniões escolhidas se juntam, por padrão: da mais antiga
 * para a mais nova (a ordem em que os pedaços foram gravados). A dona pode
 * mudar a ordem antes de confirmar.
 */
export function ordemCronologica<T extends { id: string; createdAt: number }>(reunioes: readonly T[]): T[] {
  return [...reunioes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
