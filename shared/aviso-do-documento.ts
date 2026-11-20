/**
 * A versão do aviso do documento (`meetings.document.notice` e a caixa
 * `meetings.document.consentLabel`, nos 10 idiomas) que a dona viu ao mandar um
 * PDF ou as fotos de um texto para a IA ler (H12 e H12b). Vai em cada reunião,
 * na mesma coluna do aviso de gravação (consent_notice_version), com o prefixo
 * "documento-" para as duas listas nunca se confundirem.
 *
 * A regra é a do aviso de gravação (shared/aviso-de-gravacao.ts): mudou o que o
 * aviso diz sobre o arquivo (quem acessa, retenção, IA, transferência)? Versão
 * NOVA no fim da lista e troca da VIGENTE; as anteriores seguem aceitas. O
 * rascunho jurídico de cada versão fica em docs/termos/aviso-do-documento-rascunho.md,
 * para a Cris.
 */
export const VERSOES_DO_AVISO_DO_DOCUMENTO = ["documento-2026-11-19"] as const;

export type VersaoDoAvisoDoDocumento = (typeof VERSOES_DO_AVISO_DO_DOCUMENTO)[number];

export const VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO: VersaoDoAvisoDoDocumento = "documento-2026-11-19";
