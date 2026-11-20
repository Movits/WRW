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
 * (a retenção não apaga o áudio da reunião em processamento, e o reprocesso o
 * seguraria além dos 30 dias; ver margemDoReprocesso, logo abaixo), e a tela
 * para nem oferecer o botão nesse caso.
 */
export const LIMITE_PROCESSAMENTO_MS = 15 * 60 * 1000;

/**
 * O tempo que o reprocesso da gravação em partes conta por parte. A fila
 * transcreve as partes que falharam uma depois da outra (cada uma espera a
 * anterior), e a montagem extrai da transcrição inteira, em janelas; enquanto
 * isso a reunião fica em 'uploading' ou 'processing', e o áudio vencido não sai
 * (STATUS_QUE_SEGURAM_AS_PARTES, em server/meeting-service.ts). É estimativa,
 * não garantia (a chamada da IA de uma parte pode levar até 5 min e se repetir,
 * em server/gemini.ts): o reprocesso que passar da conta segura o áudio além
 * dos 30 dias pelo tempo que passar, e ele sai na primeira varredura depois de
 * a reunião deixar esses estados.
 */
export const TEMPO_POR_PARTE_DO_REPROCESSO_MS = 2 * 60 * 1000;

/**
 * Quanto o áudio guardado ainda tem de durar para a reunião ser reprocessada: o
 * processamento inteiro (LIMITE_PROCESSAMENTO_MS) e mais
 * TEMPO_POR_PARTE_DO_REPROCESSO_MS por parte da gravação. Antes eram 15 min
 * para qualquer tamanho, e o reprocesso de uma gravação de 12 h (72 partes)
 * aceito a 20 min do prazo passava dele no meio.
 *
 * `partes` é o número de partes da gravação, a coluna expected_slices da
 * reunião, que a tela recebe; no envio único ela é nula e conta zero. O
 * servidor recusa (iniciarReprocessamento) e a tela esconde o botão com a
 * mesma conta, para os dois não divergirem. Conta todas as partes, e não só as
 * que falharam, porque a montagem relê a transcrição inteira.
 */
export function margemDoReprocesso(partes: number | null | undefined): number {
  return LIMITE_PROCESSAMENTO_MS + Math.max(0, partes ?? 0) * TEMPO_POR_PARTE_DO_REPROCESSO_MS;
}

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
 * Os tetos do envio único (meetings.submitRecording: o áudio inteiro, em
 * base64, num pedido só): 10 minutos e 10 MB. Moram aqui porque a tela confere
 * os mesmos antes de enviar, para a dona ver o aviso no idioma dela. Valem até
 * a G14 tirar o envio único (docs/arquitetura/gravador-de-reunioes.md); a
 * gravação em partes tem o teto dela, logo abaixo.
 */
export const ENVIO_UNICO_SEGUNDOS_MAX = 10 * 60;
export const ENVIO_UNICO_BYTES_MAX = 10 * 1024 * 1024;

/**
 * A gravação em partes não tem teto de tempo para quem grava (decisão do
 * Roberto de 15/11/2026): no lugar dele fica o aviso de hora, abaixo. As 12 h
 * são um teto técnico, contra gasto (uma gravação esquecida ligada). A tela
 * para nas 12 h pelo relógio dela; o servidor aceita a soma das partes com uma
 * folga própria (server/fatias-de-reuniao.ts), porque a duração medida nos
 * bytes e o relógio da tela não batem ao segundo.
 */
export const GRAVACAO_EM_PARTES_SEGUNDOS_MAX = 12 * 60 * 60;

/**
 * O teto de partes de uma reunião em partes: a rota das partes recusa a
 * posição 200 em diante, e o encerrar, mais de 200 (server/fatias-de-reuniao.ts).
 * Mora aqui porque a importação em partes confere o mesmo antes de a reunião
 * nascer (H9b): o WAV e o FLAC de horas, em partes de 14 MB, passariam dele.
 */
export const PARTES_POR_REUNIAO_MAX = 200;

/**
 * O aviso de hora da gravação em partes: a cada hora cheia de gravação (sem as
 * pausas) ele pede um OK. Sem o OK em 10 minutos, contados no relógio de
 * parede, a gravação para sozinha e entrega o que gravou, como no Encerrar.
 */
export const AVISO_DE_HORA_SEGUNDOS = 60 * 60;
export const PRAZO_DO_AVISO_DE_HORA_MS = 10 * 60 * 1000;

/**
 * Os códigos da recusa DEFINITIVA de uma parte da gravação em partes
 * (RecusaDaParte, em server/fatias-de-reuniao.ts): a rota das partes devolve
 * só o código, em JSON, e não frase. Moram aqui porque a tela os traduz
 * (client/src/lib/mensagem-de-erro.ts) para avisar a dona no idioma dela: o
 * servidor não sabe o idioma de quem grava. Código novo no servidor obriga a
 * tela a ter o aviso dele (o Record da tela é por este tipo).
 */
export type CodigoDaRecusaDaParte = "SEM_REUNIAO" | "FORA_DO_ESTADO" | "CONTEUDO_DIFERENTE" | "GRANDE_DEMAIS" | "FORMATO" | "SEM_DURACAO" | "LONGA_DEMAIS" | "POSICAO";

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
/** O item que a dona acrescenta passaria do teto (ITENS_DO_RESUMO_MAX, shared/item-do-resumo.ts). */
export const MENSAGEM_RESUMO_CHEIO = "Este resumo já chegou ao máximo de itens.";

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
