export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

/**
 * Banco fora do ar e erro de consulta, nas palavras que chegam ao navegador.
 *
 * Moram aqui, e não em server/banco-indisponivel.ts, pelo mesmo motivo de
 * CODIGO_ERRO_INTERROMPIDO logo abaixo: o servidor escreve sem saber o idioma
 * de quem vai ler — não há cabeçalho de idioma tratado em lugar nenhum, nem
 * coluna de idioma em `users` — e é a TELA que traduz, reconhecendo o texto
 * exato (client/src/lib/mensagem-de-erro.ts). As duas frases acima, em inglês,
 * são traduzidas pelo mesmo caminho: elas apareciam cruas, em inglês, para
 * quem lia a plataforma em qualquer um dos dez idiomas.
 *
 * O servidor continua importando estas constantes de server/banco-indisponivel.ts,
 * que as reexporta: nenhum import de lá precisou mudar.
 */
export const MENSAGEM_BANCO_INDISPONIVEL = "Banco de dados indisponível; tente de novo em instantes";

/** Erro do driver que NÃO é queda do banco (tabela ausente, chave duplicada, SQL inválido). */
export const MENSAGEM_ERRO_DE_CONSULTA = "Erro ao consultar o banco de dados";

/**
 * O 429 do limite geral da API (server/_core/limite-de-requisicoes.ts, que a
 * reexporta). Mora aqui pelo mesmo motivo das duas acima: chega à tela no
 * envelope do tRPC, em português, e a tela a traduz (`errors.tooManyRequests`).
 */
export const MENSAGEM_DO_LIMITE = "Muitas requisições em pouco tempo. Aguarde alguns segundos e tente de novo.";

/**
 * Código (não frase) que a varredura de reuniões presas grava em
 * `meetings.processing_error`. Mora em shared/ porque os dois lados o leem:
 * o servidor escreve sem saber o idioma da dona, e a tela de Reuniões traduz
 * (`meetings.processingInterrupted`) — um texto fixo em português apareceria
 * cru nas outras nove línguas. As demais mensagens de processing_error são
 * frases já pensadas para a tela e passam inteiras.
 */
export const CODIGO_ERRO_INTERROMPIDO = "ERRO_INTERROMPIDO";

/**
 * Quanto tempo uma reunião pode ficar em "processing" antes de a varredura
 * dá-la como interrompida. Mora em shared/ porque os dois lados o usam: o
 * servidor na varredura e para recusar reprocessar um áudio prestes a vencer
 * (a retenção o apagaria no meio), e a tela para nem oferecer o botão nesse caso.
 */
export const LIMITE_PROCESSAMENTO_MS = 15 * 60 * 1000;

/**
 * Frase (e não código) que o reprocessamento grava em `processing_error`
 * quando o áudio não está mais no bucket. Frase, porque o app Expo mostra
 * processing_error como veio; compartilhada, porque a tela do site a reconhece
 * para traduzi-la e para não oferecer de novo um reprocessamento sem áudio.
 */
export const MENSAGEM_AUDIO_GUARDADO_AUSENTE = "O áudio guardado desta reunião não foi encontrado.";

/**
 * O título da reunião, depois do trim: o servidor recusa fora disso
 * (server/routers/meetings.ts), e o gravador confere o mesmo antes de enviar,
 * para a dona ver o aviso no idioma dela, e não o BAD_REQUEST do zod.
 */
export const TITULO_DA_REUNIAO_MIN = 2;
export const TITULO_DA_REUNIAO_MAX = 200;

/**
 * As recusas do resumo guardado da reunião (H4), nas palavras que chegam ao
 * navegador. Moram aqui pelo mesmo motivo de MENSAGEM_BANCO_INDISPONIVEL: o
 * servidor (server/resumo-guardado.ts, que as reexporta) escreve sem saber o
 * idioma da dona, e a tela as traduz reconhecendo o texto exato
 * (client/src/lib/mensagem-de-erro.ts, chaves meetings.summary.*).
 */
export const MENSAGEM_RESUMO_SENDO_GERADO = "O resumo desta reunião está sendo refeito. Espere terminar para decidir.";
export const MENSAGEM_ITEM_NAO_ENCONTRADO = "Este item do resumo não existe mais. Atualize a tela.";
export const MENSAGEM_SO_ACAO_TEM_CAIXA = "Só as ações do resumo têm caixa de marcar.";

/** O nome que a dona dá a uma voz da transcrição (H3): até 60 caracteres. */
export const NOME_DO_FALANTE_MAX = 60;
/** O rótulo de voz que a transcrição por partes grava: F1, F2... (até F99). */
export const FORMATO_DO_FALANTE = /^F[1-9][0-9]?$/;

/**
 * A versão da confirmação que a dona marca ao ligar o link aberto da reunião
 * (H3b, decisão do Roberto de 16/11/2026). A 2 é a caixa que fala dos nomes que
 * ela der às vozes: só o link ligado com ela mostra esses nomes. A 1 é a caixa
 * de 12/11, que não falava deles, e vale também para a aba aberta antes do
 * deploy, que não manda versão nenhuma (server/link-aberto-da-reuniao.ts).
 */
export const VERSAO_DA_AUTORIZACAO_COM_NOMES = 2;

/** Os nomes guardados, só os pares válidos (a coluna é JSON livre). */
export function nomesDosFalantes(bruto: unknown): Record<string, string> {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return {};
  const saida: Record<string, string> = {};
  for (const [falante, nome] of Object.entries(bruto as Record<string, unknown>)) {
    if (FORMATO_DO_FALANTE.test(falante) && typeof nome === "string" && nome.trim()) saida[falante] = nome.trim().slice(0, NOME_DO_FALANTE_MAX);
  }
  return saida;
}
