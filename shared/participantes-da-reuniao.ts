/**
 * As participantes da reunião (R1b do desenho de 16/11/2026; decisão do
 * Roberto de 22/11: o convite é por link de uso único ou pelas conexões). A
 * parte que o servidor e a tela dividem: os tetos, o formato do convite, a
 * credencial da leitura e os códigos das recusas, que a tela traduz.
 */

/** O convite pendente vale 7 dias (decisão vetável do desenho de 16/11). */
export const CONVITE_DA_REUNIAO_VALE_MS = 7 * 24 * 60 * 60 * 1000;
/** Até 50 participantes por reunião, contando os convites pendentes. */
export const PARTICIPANTES_POR_REUNIAO_MAX = 50;
/** Até 30 convites a cada 10 minutos por dona (em memória, como os outros tetos). */
export const CONVITES_POR_JANELA = 30;
export const JANELA_DOS_CONVITES_MS = 10 * 60_000;

/**
 * O token do convite por link: 24 bytes aleatórios (192 bits) em base64url,
 * 32 caracteres. Só o hash (sha256) fica no banco.
 */
export const FORMATO_DO_CONVITE = /^[A-Za-z0-9_-]{32}$/;

/**
 * A credencial com que a participante lê a reunião pelas mesmas consultas do
 * link aberto (server/link-aberto-da-reuniao.ts): "participante:<id da
 * reunião>". Não abre nada sozinha: vale só com a sessão de uma conta que
 * participa da reunião, conferida no servidor a cada leitura. Não tem a forma
 * do token do link (32 caracteres sem ":"), e o link não a confunde.
 */
const PREFIXO_DA_CREDENCIAL = "participante:";
const FORMATO_DA_CREDENCIAL = /^participante:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function credencialDaParticipante(meetingId: string): string {
  return `${PREFIXO_DA_CREDENCIAL}${meetingId}`;
}

/** O id da reunião da credencial da participante, ou null quando é outra coisa (o token do link). */
export function reuniaoDaCredencial(credencial: string): string | null {
  return FORMATO_DA_CREDENCIAL.exec(credencial)?.[1]?.toLowerCase() ?? null;
}

/** As recusas das participantes, como CÓDIGO (a tela traduz, client/src/lib/mensagem-de-erro.ts). */
export const RECUSAS_DOS_PARTICIPANTES = {
  /** A reunião não existe, não é da dona, foi excluída ou está na lixeira. */
  reuniaoNaoEncontrada: "PARTICIPANTES_REUNIAO_NAO_ENCONTRADA",
  /** Só a reunião pronta recebe participantes. */
  soReuniaoPronta: "PARTICIPANTES_SO_REUNIAO_PRONTA",
  /** A reunião já tem 50 participantes, contando os convites pendentes. */
  reuniaoCheia: "PARTICIPANTES_REUNIAO_CHEIA",
  /** O convite não existe, venceu ou já foi usado (a mesma frase para os três). */
  conviteInvalido: "PARTICIPANTES_CONVITE_INVALIDO",
  /** A dona abriu o próprio convite. */
  conviteDaPropriaDona: "PARTICIPANTES_CONVITE_DA_PROPRIA_DONA",
  /** A conexão não é uma conexão aceita da dona. */
  conexaoInvalida: "PARTICIPANTES_CONEXAO_INVALIDA",
  /** A conexão já participa da reunião, ou já tem convite pendente. */
  jaParticipa: "PARTICIPANTES_JA_PARTICIPA",
  /** Convidar pede, uma vez por reunião, a confirmação de que as pessoas que falaram autorizaram. */
  autorizacaoPedida: "PARTICIPANTES_AUTORIZACAO_PEDIDA",
  /** O teto de convites da dona. */
  muitosConvites: "PARTICIPANTES_MUITOS_CONVITES",
  /** A participação não existe (já saiu, foi removida, ou é de outra reunião). */
  participanteNaoEncontrada: "PARTICIPANTES_PARTICIPANTE_NAO_ENCONTRADA",
} as const;
export type CodigoDaRecusaDosParticipantes = (typeof RECUSAS_DOS_PARTICIPANTES)[keyof typeof RECUSAS_DOS_PARTICIPANTES];
