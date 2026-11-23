/**
 * A lixeira das reuniões (H7d do plano do gravador; HN-67 no app de
 * referência da cliente: "Excluídas recentemente", com restaurar).
 *
 * É exclusão ADIADA: mandada para a lixeira, a reunião sai de toda consulta
 * (a lista, a busca, a Memória, o link aberto, as filas, os motores e cada
 * procedimento pelo id), salvo a lixeira da própria dona. Dentro do prazo, a
 * dona restaura; depois dele, ou no "Apagar de vez", a reunião é excluída pelo
 * caminho de sempre (server/lixeira-de-reunioes.ts).
 */

/** Quanto a reunião fica na lixeira antes de ser excluída de vez: 30 dias, contados da ida para a lixeira. */
export const PRAZO_DA_LIXEIRA_MS = 30 * 24 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * As recusas da lixeira, como CÓDIGO (a tela traduz):
 * - GRAVANDO: a gravação em partes ainda está no ar (o gravador manda partes);
 *   a dona encerra a gravação antes;
 * - VENCIDA: passou o prazo, e a reunião está sendo excluída de vez (ou já saiu).
 */
export const RECUSAS_DA_LIXEIRA = {
  gravando: "LIXEIRA_GRAVANDO",
  vencida: "LIXEIRA_VENCIDA",
} as const;
export type CodigoDaRecusaDaLixeira = (typeof RECUSAS_DA_LIXEIRA)[keyof typeof RECUSAS_DA_LIXEIRA];

/**
 * A reunião pode ir para a lixeira, pelo que a lista sabe dela? Só a gravação
 * em partes ainda no ar não pode: o gravador continua mandando partes, e o
 * áudio novo iria para uma reunião que a dona mandou apagar. A gravação
 * abandonada sai do ar sozinha (a fila a encerra depois de horas sem parte), e
 * aí pode. Depois do fim ('uploading'), as partes que ficaram no aparelho já
 * foram gravadas: a rota das partes as aceita na lixeira, e restaurar devolve
 * a reunião inteira. O servidor confere de novo, com a linha travada.
 */
export function podeIrParaALixeira(reuniao: { status: string; audioPipeline?: string | null }): boolean {
  if (reuniao.status === "deleted") return false;
  return !(reuniao.audioPipeline === "slices" && reuniao.status === "recording");
}

/**
 * Quantas reuniões o "Apagar de vez" e cada rodada do "Esvaziar a lixeira"
 * excluem por pedido: cada uma tira o áudio do bucket (até centenas de partes
 * numa reunião longa), e o pedido não pode passar do tempo do proxy. A tela
 * pede de novo enquanto restar alguma.
 */
export const REUNIOES_POR_EXCLUSAO_MAX = 10;

/** O instante em que a reunião sai de vez da lixeira. */
export function fimDoPrazoDaLixeira(naLixeiraDesde: number): number {
  return naLixeiraDesde + PRAZO_DA_LIXEIRA_MS;
}

/** Ainda dá para restaurar? (o servidor confere de novo) */
export function dentroDoPrazoDaLixeira(naLixeiraDesde: number, agora: number): boolean {
  return agora < fimDoPrazoDaLixeira(naLixeiraDesde);
}

/**
 * Os dias que faltam para a reunião sair de vez, arredondados para cima: a que
 * foi para a lixeira agora tem 30; a do último dia, 1; a vencida, 0.
 */
export function diasRestantesNaLixeira(naLixeiraDesde: number, agora: number): number {
  const falta = fimDoPrazoDaLixeira(naLixeiraDesde) - agora;
  if (falta <= 0) return 0;
  return Math.min(Math.ceil(PRAZO_DA_LIXEIRA_MS / DIA_MS), Math.ceil(falta / DIA_MS));
}
