/**
 * O que o contato possui e procura, escrito pela dona na ficha do contato
 * (T45, 24/11: a ficha só deixava remover; acrescentar e corrigir eram só pelo
 * chat). O teto é o da coluna (contact_assets.tag_label e
 * contact_needs.tag_label, varchar(200)), e as recusas saem como código, que a
 * tela traduz.
 */
export const ROTULO_DO_ITEM_DA_FICHA_MAX = 200;

export const RECUSAS_DO_ITEM_DA_FICHA = {
  /** O contato já tem este item (o mesmo texto, ou o mesmo sem acento e maiúsculas). */
  repetido: "ITEM_DA_FICHA_REPETIDO",
  /** O texto não tem nenhuma letra ou número que sirva para o cruzamento. */
  semTexto: "ITEM_DA_FICHA_SEM_TEXTO",
} as const;

export type TipoDoItemDaFicha = "possui" | "procura";
