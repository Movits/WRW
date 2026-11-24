/**
 * A versão do aviso de gravação (`meetings.consentNotice`, nos 10 idiomas) que
 * a dona viu ao gravar. Vai em cada reunião, na coluna consent_notice_version.
 *
 * Ao mudar o que o aviso diz sobre o áudio (quem acessa, retenção, IA,
 * transferência), crie uma versão NOVA no fim da lista e troque a VIGENTE: as
 * anteriores continuam aceitas, para não perder a gravação de quem estava com
 * a aba aberta quando o texto mudou, e o servidor grava a que veio. É o
 * contrário do aceite dos termos (server/routers/consent.ts), que recusa a
 * versão que não é a vigente. O rascunho jurídico completo de cada versão
 * fica em docs/termos/aviso-de-gravacao-rascunho.md, para a Cris.
 */
export const VERSOES_DO_AVISO_DE_GRAVACAO = ["2026-11-14", "2026-11-23"] as const;

export type VersaoDoAvisoDeGravacao = (typeof VERSOES_DO_AVISO_DE_GRAVACAO)[number];

export const VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO: VersaoDoAvisoDeGravacao = "2026-11-23";
