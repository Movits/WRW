/**
 * Exportar a reunião (H8 do desenho do gravador,
 * docs/arquitetura/gravador-de-reunioes.md): quem gravou baixa a reunião num
 * arquivo que sai da WRW. Pela decisão do Roberto de 16/11/2026, só em PDF
 * nesta entrega: sem Word, TXT, Markdown e SRT, e sem a biblioteca `docx`.
 *
 * O PDF sai da impressão do próprio aparelho (a tela de impressão monta o
 * documento com as fontes do sistema), e não de uma biblioteca: assim o árabe
 * (da direita para a esquerda), o hindi, o chinês e o japonês saem certos no
 * celular e no computador, sem embutir fontes de vários megabytes. O servidor
 * entrega o conteúdo, e a tela o imprime (client/src/components/ExportarReuniao.tsx).
 *
 * Regras que o servidor (server/exportar-reuniao.ts) e a tela leem daqui:
 * só a dona exporta (o link aberto não ganha o botão); só saem os itens do
 * resumo que ela CONFIRMOU; a leitura e a auditoria vão na mesma transação.
 */

/** Os formatos aceitos. A lista existe para a auditoria dizer qual saiu e para o formato novo entrar sem mudar a rota. */
export const FORMATOS_DA_EXPORTACAO = ["pdf"] as const;
export type FormatoDaExportacao = (typeof FORMATOS_DA_EXPORTACAO)[number];

/** A ação gravada em audit_logs a cada exportação. */
export const ACAO_REUNIAO_EXPORTADA = "MEETING_EXPORTED";

/** O teto por dona: 30 exportações a cada 10 minutos, só as que saíram. */
export const EXPORTACOES_POR_JANELA = 30;
export const JANELA_DA_EXPORTACAO_MS = 10 * 60_000;

/**
 * As recusas da exportação, nas palavras que chegam ao navegador. Como as do
 * e-mail de retorno (shared/email-de-retorno.ts): o servidor escreve sem saber
 * o idioma da dona, e a tela as traduz reconhecendo o texto exato
 * (client/src/lib/mensagem-de-erro.ts, chaves meetings.export.*).
 */
export const MENSAGEM_EXPORTAR_SO_PRONTA = "Só dá para baixar o PDF de uma reunião pronta.";
export const MENSAGEM_EXPORTACOES_DEMAIS = "Muitos PDFs baixados em sequência. Aguarde alguns minutos e tente de novo.";
