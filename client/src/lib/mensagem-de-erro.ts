import {
  MENSAGEM_BANCO_INDISPONIVEL,
  MENSAGEM_DO_LIMITE,
  MENSAGEM_ERRO_DE_CONSULTA,
  MENSAGEM_FALHA_DA_MONTAGEM,
  MENSAGEM_GRAVACAO_SEM_AUDIO_ENVIADO,
  MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO,
  MENSAGEM_ITEM_NAO_ENCONTRADO,
  MENSAGEM_PARTES_SEM_TRANSCRICAO,
  MENSAGEM_PERFIL_MUDOU_NO_MEIO,
  MENSAGEM_RESUMO_CHEIO,
  MENSAGEM_REUNIAO_NAO_ENCONTRADA,
  MENSAGEM_RESUMO_SENDO_GERADO,
  MENSAGEM_SO_ACAO_TEM_CAIXA,
  NOT_ADMIN_ERR_MSG,
  UNAUTHED_ERR_MSG,
  type CodigoDaRecusaDaParte,
} from "@shared/const";
import { MENSAGEM_ACAO_NAO_ENCONTRADA, MENSAGEM_CONTATO_FORA_DA_REDE } from "@shared/proximas-acoes";
import { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO, MENSAGEM_EMAIL_SEM_RESUMO_PRONTO } from "@shared/email-de-retorno";
import { MENSAGEM_EXPORTACOES_DEMAIS, MENSAGEM_EXPORTAR_SO_PRONTA } from "@shared/exportar-reuniao";
import type { CodigoDaRecusaDoAudio } from "@shared/baixar-audio";
import { RECUSAS_DOS_DETALHES } from "@shared/detalhes-da-reuniao";
import { MENSAGEM_BUSCAS_DEMAIS } from "@shared/busca-de-reunioes";
import { RECUSAS_DA_JUNCAO } from "@shared/juntar-reunioes";
import { RECUSAS_DA_EDICAO } from "@shared/editar-transcricao";
import {
  MENSAGEM_RESUMO_POR_EMAIL_DEMAIS,
  MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO,
  MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO,
  MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO,
} from "@shared/resumo-por-email";
import { MENSAGEM_SENHA_DO_LINK_PEDIDA } from "@shared/senha-do-link";
import {
  DOCUMENTO_BYTES_MAX, DOCUMENTOS_POR_HORA, ehCodigoDaFalhaDoDocumento,
  type CodigoDaFalhaDoDocumento, type CodigoDaRecusaDoDocumento,
} from "@shared/documento-da-reuniao";

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
  // As recusas do resumo por e-mail (H22, server/resumo-por-email.ts).
  [MENSAGEM_RESUMO_POR_EMAIL_SEM_RESUMO]: "resumoPorEmail.erros.semResumo",
  [MENSAGEM_RESUMO_POR_EMAIL_SEM_DESTINATARIA]: "resumoPorEmail.erros.semDestinataria",
  [MENSAGEM_RESUMO_POR_EMAIL_DEMAIS]: "resumoPorEmail.erros.demais",
  [MENSAGEM_RESUMO_POR_EMAIL_FORA_DA_AGENDA]: "resumoPorEmail.erros.foraDaAgenda",
  [MENSAGEM_RESUMO_POR_EMAIL_EMAIL_INVALIDO]: "resumoPorEmail.erros.emailInvalido",
  [MENSAGEM_RESUMO_POR_EMAIL_SEM_EMAIL_DA_DONA]: "resumoPorEmail.erros.semEmailDaDona",
  [MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO]: "resumoPorEmail.erros.linkDesligado",
  [MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_REUNIAO]: "resumoPorEmail.erros.tetoDaReuniao",
  [MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA]: "resumoPorEmail.erros.tetoDaDona",
  [MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU]: "resumoPorEmail.erros.naoSaiu",
  [MENSAGEM_RESUMO_POR_EMAIL_NADA_A_REENVIAR]: "resumoPorEmail.erros.nadaAReenviar",
  // O link com senha, sem a entrada de quem a acertou (H23, server/link-aberto-da-reuniao.ts).
  [MENSAGEM_SENHA_DO_LINK_PEDIDA]: "meetings.openLink.password.required",
  // As falhas que a fila da gravação em partes grava em processing_error
  // (server/fila-de-transcricao.ts), que a caixa vermelha do detalhe mostra.
  [MENSAGEM_GRAVACAO_SEM_AUDIO_ENVIADO]: "meetings.processingFailedNoAudioSent",
  [MENSAGEM_FALHA_DA_MONTAGEM]: "meetings.processingFailedRetryLater",
  [MENSAGEM_PARTES_SEM_TRANSCRICAO]: "meetings.processingFailedNoTranscript",
  // O salvar do Meu Perfil que acharia as listas mudadas no meio (server/listas-do-perfil.ts).
  [MENSAGEM_PERFIL_MUDOU_NO_MEIO]: "profile.changedElsewhere",
  // A reunião que saiu (outra aba a excluiu ou a mandou para a lixeira, H7d):
  // a guarda da lixeira devolve esta frase a uns 50 procedimentos.
  [MENSAGEM_REUNIAO_NAO_ENCONTRADA]: "meetings.meetingNotFound",
  // O interesse da conta que caiu para Bronze com o cartão aberto (U3, server/routers/connections.ts).
  [MENSAGEM_INTERESSE_ESPERA_O_CADASTRO_COMPLETO]: "dashboard.interestNeedsSilver",
  // Os detalhes da reunião (H7c): o contato ou o contexto que não é da dona, em
  // qualquer caminho que grave o ponteiro (server/detalhes-da-reuniao.ts).
  [RECUSAS_DOS_DETALHES.contato]: "meetings.details.contactNotFound",
  [RECUSAS_DOS_DETALHES.contexto]: "meetings.details.contextNotFound",
  // O teto da busca entre as reuniões (H7b, routers/meetings.ts).
  [MENSAGEM_BUSCAS_DEMAIS]: "meetings.search.tooMany",
  // As recusas da junção de reuniões (H17, server/juntar-reunioes.ts).
  [RECUSAS_DA_JUNCAO.foraDoEstado]: "meetings.join.errorState",
  [RECUSAS_DA_JUNCAO.soAudio]: "meetings.join.errorOnlyAudio",
  [RECUSAS_DA_JUNCAO.semAudio]: "meetings.join.errorNoAudio",
  [RECUSAS_DA_JUNCAO.longaDemais]: "meetings.join.errorTooLong",
  [RECUSAS_DA_JUNCAO.demais]: "meetings.join.errorTooMany",
  // As recusas da edição da transcrição (H18, server/editar-transcricao.ts).
  [RECUSAS_DA_EDICAO.foraDoEstado]: "meetings.editTranscript.errorState",
  [RECUSAS_DA_EDICAO.documento]: "meetings.editTranscript.errorDocument",
  [RECUSAS_DA_EDICAO.mudou]: "meetings.editTranscript.errorChanged",
  [RECUSAS_DA_EDICAO.trecho]: "meetings.editTranscript.errorSegment",
  [RECUSAS_DA_EDICAO.vazio]: "meetings.editTranscript.errorEmpty",
  [RECUSAS_DA_EDICAO.demais]: "meetings.editTranscript.errorTooMany",
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

/**
 * As recusas de baixar o áudio da reunião (H8c: server/baixar-audio-da-reuniao.ts
 * e o teto em routers/meetings.ts). O servidor manda o CÓDIGO como mensagem
 * (shared/baixar-audio.ts, RECUSAS_DO_AUDIO), nunca frase, e aqui ele vira o
 * aviso no idioma da tela. O Record é pelo tipo do servidor: código novo lá
 * não compila aqui sem o aviso dele; cada valor chama t() com a chave literal,
 * para server/i18n-chaves-usadas.test.ts conferir que todas existem.
 */
const AVISO_POR_RECUSA_DO_AUDIO: Record<CodigoDaRecusaDoAudio, (t: (chave: string) => string) => string> = {
  AUDIO_VENCIDO: t => t("meetings.audioDownload.expired"),
  AUDIO_AUSENTE: t => t("meetings.audioDownload.noAudio"),
  AUDIO_AINDA_GRAVANDO: t => t("meetings.audioDownload.stillRecording"),
  AUDIOS_DEMAIS: t => t("meetings.audioDownload.tooMany"),
  AUDIO_OCUPADO: t => t("meetings.audioDownload.busy"),
  AUDIO_INDISPONIVEL: t => t("meetings.audioDownload.unavailable"),
};

/**
 * O que a tela diz quando preparar o áudio falha: a reunião que não é da dona
 * (ou excluída) pelo código NOT_FOUND; as recusas do áudio pelo código delas;
 * as mensagens comuns do servidor (banco fora do ar, sessão, limite da API)
 * pela tabela acima; e o resto, inclusive a rede fora, no aviso genérico do
 * áudio, nunca o texto cru.
 */
export function mensagemDaRecusaDoAudio(erro: unknown, t: (chave: string) => string): string {
  if (erro && typeof erro === "object") {
    const { message, data } = erro as { message?: unknown; data?: unknown };
    const codigo = data && typeof data === "object" ? (data as { code?: unknown }).code : undefined;
    if (typeof codigo === "string") {
      if (codigo === "NOT_FOUND") return t("meetings.meetingNotFound");
      if (typeof message === "string") {
        if (Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA_DO_AUDIO, message)) {
          return AVISO_POR_RECUSA_DO_AUDIO[message as CodigoDaRecusaDoAudio](t);
        }
        if (Object.prototype.hasOwnProperty.call(CHAVE_POR_MENSAGEM_DO_SERVIDOR, message)) return t(CHAVE_POR_MENSAGEM_DO_SERVIDOR[message]);
      }
    }
  }
  return t("meetings.audioDownload.error");
}

/**
 * Os códigos da rota do documento da reunião (H12 e H12b,
 * server/_core/rota-do-documento.ts): os da recusa do envio (o tipo de
 * shared/documento-da-reuniao.ts), os da porta da rota (sessão, teto, banco) e
 * o REDE da tela, quando o pedido nem chegou. Como nas partes, o servidor
 * manda só o código, e a frase sai no idioma da tela; código novo do tipo
 * compartilhado não compila aqui sem o aviso dele.
 */
type CodigoDoEnvioDoDocumento = CodigoDaRecusaDoDocumento
  | "SEM_SESSAO" | "CADASTRO_INCOMPLETO" | "MUITOS_PEDIDOS" | "TENTE_DE_NOVO" | "BANCO_INDISPONIVEL" | "ERRO" | "REDE";

type Traduzir = (chave: string, opcoes?: Record<string, unknown>) => string;

const AVISO_POR_RECUSA_DO_DOCUMENTO: Record<CodigoDoEnvioDoDocumento, (t: Traduzir) => string> = {
  SEM_SESSAO: t => t("meetings.document.errorSession"),
  CADASTRO_INCOMPLETO: t => t("meetings.document.errorSession"),
  // A reunião foi excluída no meio, ou já recebeu outro documento.
  SEM_REUNIAO: t => t("meetings.document.errorMeetingGone"),
  FORA_DO_ESTADO: t => t("meetings.document.errorMeetingGone"),
  CONTEUDO_DIFERENTE: t => t("meetings.document.errorMeetingGone"),
  GRANDE_DEMAIS: t => t("meetings.document.errorTooLarge", { mb: DOCUMENTO_BYTES_MAX / 1_000_000 }),
  VAZIO: t => t("meetings.document.errorEmpty"),
  FORMATO: t => t("meetings.document.errorNotPdf"),
  MUITOS_PEDIDOS: t => t("meetings.document.errorTooMany", { quantidade: DOCUMENTOS_POR_HORA }),
  BANCO_INDISPONIVEL: t => t("errors.databaseUnavailable"),
  TENTE_DE_NOVO: t => t("meetings.document.errorTryAgain"),
  ERRO: t => t("meetings.document.errorTryAgain"),
  REDE: t => t("meetings.document.errorTryAgain"),
};

export function mensagemDaRecusaDoDocumento(codigo: string | undefined, t: Traduzir): string {
  const aviso = codigo && Object.prototype.hasOwnProperty.call(AVISO_POR_RECUSA_DO_DOCUMENTO, codigo)
    ? AVISO_POR_RECUSA_DO_DOCUMENTO[codigo as CodigoDoEnvioDoDocumento]
    : null;
  return aviso ? aviso(t) : t("meetings.document.errorTryAgain");
}

/**
 * A causa gravada em `processing_error` quando a leitura do documento falha em
 * segundo plano (CODIGOS_DA_FALHA_DO_DOCUMENTO): o servidor grava o código, e
 * a tela diz o que fazer no idioma de quem lê. null para o que não é código
 * do documento (a tela segue com as outras causas conhecidas).
 */
const CAUSA_POR_FALHA_DO_DOCUMENTO: Record<CodigoDaFalhaDoDocumento, (t: Traduzir) => string> = {
  DOCUMENTO_SEM_TEXTO: t => t("meetings.document.failedNoText"),
  DOCUMENTO_LONGO_DEMAIS: t => t("meetings.document.failedTooLong"),
  DOCUMENTO_RECUSADO: t => t("meetings.document.failedRefused"),
  DOCUMENTO_ILEGIVEL: t => t("meetings.document.failedCorrupted"),
  IA_INDISPONIVEL: t => t("meetings.document.failedAiUnavailable"),
  DOCUMENTO_AUSENTE: t => t("meetings.document.failedMissing"),
  DOCUMENTO_FALHOU: t => t("meetings.document.failedGeneric"),
};

export function causaDaFalhaDoDocumento(codigo: string | null | undefined, t: Traduzir): string | null {
  return ehCodigoDaFalhaDoDocumento(codigo) ? CAUSA_POR_FALHA_DO_DOCUMENTO[codigo](t) : null;
}
