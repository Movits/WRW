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
export const VERSOES_DO_AVISO_DO_DOCUMENTO = ["documento-2026-11-19", "documento-2026-11-26"] as const;

export type VersaoDoAvisoDoDocumento = (typeof VERSOES_DO_AVISO_DO_DOCUMENTO)[number];

/**
 * A documento-2026-11-26 muda a retenção: o arquivo deixa de sair aos 30 dias e
 * fica, com o texto lido, até a dona excluir a reunião ou encerrar a conta
 * (decisão do Roberto de 26/11/2026, com a Política revisada pela Cris).
 */
export const VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO: VersaoDoAvisoDoDocumento = "documento-2026-11-26";
