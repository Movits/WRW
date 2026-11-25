/**
 * Os espaços de equipe (R2 do plano do gravador; HN-62 no app de referência
 * da cliente). A parte que o servidor e a tela dividem: os papéis, os tetos e
 * os códigos das recusas, que a tela traduz (client/src/lib/mensagem-de-erro.ts).
 *
 * A equipe é uma pasta das reuniões (H7d) com membras. A dona da pasta é a
 * dona da equipe; as membras entram como na R1b (convite por link de uso único
 * ou a uma conexão aceita, nunca por e-mail digitado) e têm um de dois papéis:
 * - "member" (membro): lê as reuniões da pasta e escreve as tarefas da equipe;
 * - "reader" (leitora): só lê as reuniões, as tarefas e a agenda.
 */

export const PAPEIS_DA_EQUIPE = ["member", "reader"] as const;
export type PapelDaEquipe = (typeof PAPEIS_DA_EQUIPE)[number];
/** O papel de quem vê a equipe: a dona ou um dos dois. */
export type PapelNaEquipe = "owner" | PapelDaEquipe;

/** Quem escreve as tarefas da equipe: a dona e as de papel "member". */
export function escreveTarefas(papel: PapelNaEquipe): boolean {
  return papel === "owner" || papel === "member";
}

/** O convite pendente vale 7 dias, como o da reunião (R1b). */
export const CONVITE_DA_EQUIPE_VALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Até 50 membras por equipe, contando os convites pendentes. */
export const MEMBRAS_POR_EQUIPE_MAX = 50;
/** Até 30 convites a cada 10 minutos por dona (em memória, como os outros tetos). */
export const CONVITES_DA_EQUIPE_POR_JANELA = 30;
export const JANELA_DOS_CONVITES_DA_EQUIPE_MS = 10 * 60_000;
/** Até 500 tarefas por equipe, feitas ou não. */
export const TAREFAS_POR_EQUIPE_MAX = 500;
export const TEXTO_DA_TAREFA_MAX = 500;
export const RESPONSAVEL_DA_TAREFA_MAX = 120;
/** As reuniões da equipe na tela: as 200 mais novas. */
export const REUNIOES_DA_EQUIPE_MAX = 200;
/** A agenda da equipe: as que ainda vêm (e a que está acontecendo), até 100. */
export const AGENDA_DA_EQUIPE_MAX = 100;

/**
 * O token do convite da equipe: 24 bytes aleatórios (192 bits) em base64url,
 * 32 caracteres, como o da reunião. Só o hash (sha256) fica no banco.
 */
export const FORMATO_DO_CONVITE_DA_EQUIPE = /^[A-Za-z0-9_-]{32}$/;

/** As recusas da equipe, como CÓDIGO (a tela traduz). */
export const RECUSAS_DA_EQUIPE = {
  /** A pasta não existe, não é da dona, ou a conta não é da equipe (a mesma frase). */
  equipeNaoEncontrada: "EQUIPE_NAO_ENCONTRADA",
  /** A equipe já tem 50 membras, contando os convites pendentes. */
  equipeCheia: "EQUIPE_CHEIA",
  /** O convite não existe, venceu ou já foi usado (a mesma frase para os três). */
  conviteInvalido: "EQUIPE_CONVITE_INVALIDO",
  /** A dona abriu o próprio convite. */
  conviteDaPropriaDona: "EQUIPE_CONVITE_DA_PROPRIA_DONA",
  /** A conexão não é uma conexão aceita da dona. */
  conexaoInvalida: "EQUIPE_CONEXAO_INVALIDA",
  /** A conexão já está na equipe, ou já tem convite pendente. */
  jaEstaNaEquipe: "EQUIPE_JA_ESTA",
  /** O primeiro convite da equipe pede a confirmação de que as pessoas que falaram autorizaram. */
  autorizacaoPedida: "EQUIPE_AUTORIZACAO_PEDIDA",
  /** O teto de convites da dona. */
  muitosConvites: "EQUIPE_MUITOS_CONVITES",
  /** A membra não existe (já saiu, foi removida, ou é de outra equipe). */
  membraNaoEncontrada: "EQUIPE_MEMBRA_NAO_ENCONTRADA",
  /** A leitora tentou escrever uma tarefa. */
  soLeitura: "EQUIPE_SO_LEITURA",
  /** A tarefa não existe ou é de outra equipe. */
  tarefaNaoEncontrada: "EQUIPE_TAREFA_NAO_ENCONTRADA",
  /** A equipe chegou a 500 tarefas. */
  tarefasDemais: "EQUIPE_TAREFAS_DEMAIS",
  /** O prazo da tarefa não é uma data. */
  prazoInvalido: "EQUIPE_PRAZO_INVALIDO",
  /** A reunião da agenda não existe ou é de outra conta. */
  agendaNaoEncontrada: "EQUIPE_AGENDA_NAO_ENCONTRADA",
} as const;
export type CodigoDaRecusaDaEquipe = (typeof RECUSAS_DA_EQUIPE)[keyof typeof RECUSAS_DA_EQUIPE];
