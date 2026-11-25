/**
 * A consulta da administração a uma reunião gravada (R1a do desenho de
 * 16/11/2026; decisões do Roberto de 22/11 e frase da Cris no aviso de
 * gravação 2026-11-23).
 *
 * A administração (admin e presidente; nunca Ouro sem cargo) só abre uma
 * reunião de outra conta com o MOTIVO registrado antes da leitura, na mesma
 * transação da auditoria (server/consulta-da-administracao.ts). A dona vê a
 * data de cada consulta, não o motivo nem quem consultou. A reunião gravada
 * antes do aviso que anuncia a consulta fica fechada.
 */

/** Os motivos que justificam a consulta, nesta ordem na tela. */
export const MOTIVOS_DA_CONSULTA = [
  "apuracao_de_denuncia",
  "seguranca",
  "suporte_pedido_pela_usuaria",
  "obrigacao_legal",
  "ordem_judicial",
] as const;
export type MotivoDaConsulta = (typeof MOTIVOS_DA_CONSULTA)[number];

/** Os rótulos, em português fixo, como o resto do Painel Ouro. */
export const ROTULO_DO_MOTIVO: Record<MotivoDaConsulta, string> = {
  apuracao_de_denuncia: "Apuração de denúncia",
  seguranca: "Segurança",
  suporte_pedido_pela_usuaria: "Suporte pedido pela usuária",
  obrigacao_legal: "Obrigação legal",
  ordem_judicial: "Ordem judicial",
};

/**
 * O texto que complementa o motivo: obrigatório, de 10 a 500 caracteres
 * (decisão vetável: o caminho mais seguro é a administração escrever o porquê
 * daquela reunião, e não só escolher a categoria).
 */
export const COMPLEMENTO_DO_MOTIVO_MIN = 10;
export const COMPLEMENTO_DO_MOTIVO_MAX = 500;

/** Por quanto tempo a consulta aberta serve o áudio da reunião pelo proxy. */
export const MINUTOS_DO_PASSE_DO_AUDIO = 60;

/** Quantas reuniões a lista da administração traz por página. */
export const REUNIOES_POR_PAGINA_NA_CONSULTA = 30;
export const BUSCA_DA_CONSULTA_MAX = 120;

/** As ações da auditoria: a lista lida e a reunião aberta. As duas sobrevivem à exclusão da conta de quem consultou. */
export const ACAO_LISTA_DA_ADMINISTRACAO = "MEETINGS_ADMIN_LIST";
export const ACAO_CONSULTA_DA_ADMINISTRACAO = "MEETING_ADMIN_READ";

/** As recusas da consulta, como CÓDIGO (a tela traduz). */
export const RECUSAS_DA_CONSULTA = {
  // A reunião não existe, foi excluída ou está na lixeira: a mesma resposta.
  naoEncontrada: "CONSULTA_REUNIAO_NAO_ENCONTRADA",
  // Gravada antes do aviso que anuncia a consulta (ou juntada com uma assim).
  anteriorAoAviso: "CONSULTA_REUNIAO_ANTERIOR_AO_AVISO",
} as const;
