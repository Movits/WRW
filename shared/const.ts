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
