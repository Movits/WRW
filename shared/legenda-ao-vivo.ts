/**
 * A legenda ao vivo do gravador (G15b; HN-19 do HiNoter): o texto do que está
 * sendo dito, com segundos de atraso, pelo reconhecimento de voz do PRÓPRIO
 * navegador (a Web Speech API). Não custa IA, não separa quem fala, não fica
 * guardada e não substitui a transcrição da reunião, que segue sendo a da IA,
 * por partes (a G15a mostra o texto delas durante a gravação).
 *
 * Decisão do Roberto de 16/11/2026: no Chrome, o reconhecimento costuma mandar
 * o áudio a um servidor do Google, e a tela diz isso antes de ligar, com o
 * texto para a Cris revisar (docs/termos/aviso-de-gravacao-rascunho.md, seção
 * da legenda). A dona confirma que as pessoas da reunião concordam, e a
 * confirmação, com o texto que ela viu, vai para a auditoria antes de a legenda
 * ligar (server/legenda-ao-vivo.ts). O texto da legenda nunca vai ao servidor.
 */

/**
 * As versões do aviso da legenda (as chaves `meetings.caption.notice*`, nos 10
 * idiomas). Mudou o que o aviso diz sobre o áudio (quem recebe, onde fica),
 * versão NOVA no fim da lista e troque a VIGENTE: as anteriores seguem aceitas,
 * para a aba aberta antes do deploy, e a prova guarda a que veio, com o texto.
 */
export const VERSOES_DO_AVISO_DA_LEGENDA = ["legenda-2026-11-22", "legenda-2026-11-23"] as const;

export type VersaoDoAvisoDaLegenda = (typeof VERSOES_DO_AVISO_DA_LEGENDA)[number];

export const VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA: VersaoDoAvisoDaLegenda = "legenda-2026-11-23";

/** O teto do texto do aviso que a tela manda para a prova (o aviso inteiro, com a caixa, em qualquer dos 10 idiomas). */
export const TEXTO_DO_AVISO_DA_LEGENDA_MAX = 3000;

/**
 * Cada ligar grava uma linha de auditoria: teto por dona, em memória como os
 * outros do router (a tela só pede uma vez por gravação; recarregar a página
 * pede de novo). Só conta o ligar aceito.
 */
export const LEGENDAS_POR_JANELA = 30;
export const JANELA_DA_LEGENDA_MS = 60 * 60_000;

/**
 * As recusas do ligar, como CÓDIGO (a tela traduz):
 * - FORA_DA_GRAVACAO: a reunião não está gravando (já encerrou, ou nem começou);
 * - DEMAIS: o teto de ligar por dona.
 * A reunião de outra conta, a excluída e a que não existe são NOT_FOUND, com a
 * frase de sempre.
 */
export const RECUSAS_DA_LEGENDA = {
  foraDaGravacao: "LEGENDA_FORA_DA_GRAVACAO",
  demais: "LEGENDAS_DEMAIS",
} as const;

export type CodigoDaRecusaDaLegenda = (typeof RECUSAS_DA_LEGENDA)[keyof typeof RECUSAS_DA_LEGENDA];
