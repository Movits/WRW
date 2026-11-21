import {
  MENSAGEM_BANCO_INDISPONIVEL,
  MENSAGEM_DO_LIMITE,
  MENSAGEM_ERRO_DE_CONSULTA,
  MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO,
  MENSAGEM_ITEM_NAO_ENCONTRADO,
  MENSAGEM_PERFIL_MUDOU_NO_MEIO,
  MENSAGEM_RESUMO_CHEIO,
  MENSAGEM_RESUMO_SENDO_GERADO,
  MENSAGEM_SO_ACAO_TEM_CAIXA,
  NOT_ADMIN_ERR_MSG,
  UNAUTHED_ERR_MSG,
  type CodigoDaRecusaDaParte,
} from "@shared/const";
import { MENSAGEM_ACAO_NAO_ENCONTRADA, MENSAGEM_CONTATO_FORA_DA_REDE } from "@shared/proximas-acoes";
import { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO, MENSAGEM_EMAIL_SEM_RESUMO_PRONTO } from "@shared/email-de-retorno";
import { MENSAGEM_EXPORTACOES_DEMAIS, MENSAGEM_EXPORTAR_SO_PRONTA } from "@shared/exportar-reuniao";

/**
 * O que a tela mostra quando uma consulta falha.
 *
 * Nem todo erro que chega ao React Query passou pelo servidor tRPC. O
 * `errorFormatter` (server/_core/trpc.ts) escreve mensagens em português e já
 * mascarou o SQL, mas ele só fala quando a resposta tem o envelope do tRPC.
 * Um 502/503 em HTML do Render (o res.json() falha e chega a mensagem do
 * SyntaxError do navegador, "Unexpected token '<' … is not valid JSON"), um
 * JSON fora do envelope ("Unable to transform response from server", como o
 * 403 do bloqueio de scanners) e a rede fora ("Failed to fetch") chegam como
 * TRPCClientError montado no cliente, com texto técnico em inglês. Isso não é
 * para a usuária ler. O 429 do limite da API (responderLimite,
 * server/_core/limite-de-requisicoes.ts) vem no envelope, com data.code
 * TOO_MANY_REQUESTS e sem path, e passa pela tabela abaixo, no idioma da tela;
 * 429 em texto puro só existe fora de /api/trpc.
 *
 * O sinal é `data.code`: só um erro devolvido pelo servidor tem o `data` do
 * shape (TRPCClientError.from monta `data` a partir de `result.error.data`,
 * que não existe fora do envelope). Com ele, a mensagem é a do servidor; sem
 * ele, o texto genérico — e não o do ErrorBoundary, que afirma "nossa equipe
 * foi notificada", coisa que aqui ninguém foi.
 */
/**
 * As mensagens que o SERVIDOR escreve e a tela precisa dizer no idioma de quem
 * lê. Mesmo princípio do CODIGO_ERRO_INTERROMPIDO (shared/const.ts): o servidor
 * não sabe o idioma da usuária, então quem traduz é a tela, reconhecendo o
 * texto exato que chegou.
 *
 * O pt-BR de cada chave é IGUAL, caractere a caractere, à constante do
 * servidor — em português a tela continua mostrando exatamente o que mostrava.
 * As duas de sessão e permissão são o caso mais gritante: o servidor as manda
 * em INGLÊS ("Please login (10001)"), e era isso que aparecia para quem lia a
 * plataforma em português, árabe, japonês ou qualquer um dos dez idiomas.
 *
 * O que não está na tabela passa inteiro, de propósito: são as mensagens de
 * regra de negócio, escritas uma a uma para a tela.
 */
const CHAVE_POR_MENSAGEM_DO_SERVIDOR: Record<string, string> = {
  [MENSAGEM_BANCO_INDISPONIVEL]: "errors.databaseUnavailable",
  [MENSAGEM_ERRO_DE_CONSULTA]: "errors.queryFailed",
  [UNAUTHED_ERR_MSG]: "errors.notAuthenticated",
  [NOT_ADMIN_ERR_MSG]: "errors.notAuthorized",
  [MENSAGEM_DO_LIMITE]: "errors.tooManyRequests",
  // As recusas das decisões do resumo guardado (server/resumo-guardado.ts).
  [MENSAGEM_RESUMO_SENDO_GERADO]: "meetings.summary.errorRegenerating",
  [MENSAGEM_ITEM_NAO_ENCONTRADO]: "meetings.summary.errorItemGone",
  [MENSAGEM_SO_ACAO_TEM_CAIXA]: "meetings.summary.errorOnlyActions",
  // As recusas das próximas ações (server/proximas-acoes.ts).
  [MENSAGEM_ACAO_NAO_ENCONTRADA]: "proximasAcoes.errorGone",
  [MENSAGEM_CONTATO_FORA_DA_REDE]: "proximasAcoes.errorContactOutside",
  // As recusas do rascunho de e-mail de retorno (server/email-de-retorno.ts).
  [MENSAGEM_EMAIL_SEM_RESUMO_PRONTO]: "meetings.followUp.summaryNotReady",
  [MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO]: "meetings.followUp.needsConfirmed",
  // O item que a dona acrescenta passaria do teto do resumo (H4f).
  [MENSAGEM_RESUMO_CHEIO]: "meetings.summary.errorFull",
  // As recusas do PDF da reunião (H8, server/exportar-reuniao.ts e o teto em routers/meetings.ts).
  [MENSAGEM_EXPORTAR_SO_PRONTA]: "meetings.export.onlyReady",
  [MENSAGEM_EXPORTACOES_DEMAIS]: "meetings.export.tooMany",
  // O salvar do Meu Perfil que acharia as listas mudadas no meio (server/listas-do-perfil.ts).
  [MENSAGEM_PERFIL_MUDOU_NO_MEIO]: "profile.changedElsewhere",
  // O interesse da conta que caiu para Bronze com o cartão aberto (U3, server/routers/connections.ts).
  [MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO]: "dashboard.interestNeedsSilver",
};

/**
 * Traduz uma mensagem vinda do servidor quando ela é uma das conhecidas.
 * Exportada porque as telas que mostram `err.message` direto (toasts de
 * Reuniões, Deal Room, Rede…) também precisam passar por aqui.
 */
export function traduzirMensagemDoServidor(mensagem: string, t: (chave: string) => string): string {
  const chave = CHAVE_POR_MENSAGEM_DO_SERVIDOR[mensagem];
  return chave ? t(chave) : mensagem;
}

export function mensagemDeErroParaTela(erro: unknown, t: (chave: string) => string): string {
  if (erro && typeof erro === "object") {
    const { message, data } = erro as { message?: unknown; data?: unknown };
    const codigo = data && typeof data === "object" ? (data as { code?: unknown }).code : undefined;
    if (typeof codigo === "string" && typeof message === "string" && message.trim()) {
      return traduzirMensagemDoServidor(message, t);
    }
  }
  return t("errorBoundary.serverUnavailable");
}

/**
 * O aviso de uma parte da gravação em partes que o servidor recusou de vez
 * (G13b). A rota das partes (server/_core/rota-das-partes.ts) responde só o
 * CÓDIGO da recusa, nunca frase, porque não sabe o idioma de quem grava; aqui
 * ele vira o aviso no idioma da tela. Para a dona a gravação é contínua: o
 * aviso fala de "um trecho", e diz que ele fica de fora da transcrição.
 *
 * O Record é pelo tipo do servidor (shared/const.ts): código novo lá não
 * compila aqui sem o aviso dele. Cada valor chama t() com a chave literal, para
 * o teste de chaves usadas (server/i18n-chaves-usadas.test.ts) conferir que
 * todas existem. Código desconhecido (uma recusa 4xx que não é da tabela) cai
 * no aviso genérico, nunca no código cru.
 */
const AVISO_POR_RECUSA_DA_PARTE: Record<CodigoDaRecusaDaParte, (t: (chave: string) => string) => string> = {
  // A reunião foi excluída (em outra aba, por exemplo) ou já não recebe áudio.
  SEM_REUNIAO: t => t("meetings.partRejectedMeetingGone"),
  FORA_DO_ESTADO: t => t("meetings.partRejectedMeetingGone"),
  GRANDE_DEMAIS: t => t("meetings.partRejectedTooLarge"),
  LONGA_DEMAIS: t => t("meetings.partRejectedTooLarge"),
  FORMATO: t => t("meetings.partRejectedUnreadable"),
  SEM_DURACAO: t => t("meetings.partRejectedUnreadable"),
  CONTEUDO_DIFERENTE: t => t("meetings.partRejected"),
  POSICAO: t => t("meetings.partRejected"),
};

export function mensagemDaRecusaDaParte(codigo: string | undefined, t: (chave: string) => string): string {
  const aviso = codigo && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA_DA_PARTE, codigo)
    ? AVISO_POR_RECUSA_DA_PARTE[codigo as CodigoDaRecusaDaParte]
    : null;
  return aviso ? aviso(t) : t("meetings.partRejected");
}
