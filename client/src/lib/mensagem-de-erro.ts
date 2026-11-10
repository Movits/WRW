import {
  MENSAGEM_BANCO_INDISPONIVEL,
  MENSAGEM_ERRO_DE_CONSULTA,
  NOT_ADMIN_ERR_MSG,
  UNAUTHED_ERR_MSG,
} from "@shared/const";

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
 * TOO_MANY_REQUESTS e sem path, e passa com a frase do servidor; 429 em texto
 * puro só existe fora de /api/trpc.
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
