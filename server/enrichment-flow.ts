export const ENRICHMENT_STEPS = [
  { fieldType: "phone", question: "Qual é o telefone dele/dela?" },
  { fieldType: "company", question: "Em qual empresa trabalha?" },
  { fieldType: "assets", question: "O que essa pessoa pode oferecer? (ex.: mina, fábrica, patente, acesso)" },
  { fieldType: "needs", question: "O que ela está procurando? (ex.: investidores, parceiros, compradores)" },
  { fieldType: "how_met", question: "Como vocês se conheceram?" },
  { fieldType: "relationship_type", question: "O relacionamento é pessoal, profissional ou ambos?" },
] as const;

export type EnrichmentField = (typeof ENRICHMENT_STEPS)[number]["fieldType"];

export function getEnrichmentStep(index: number) {
  return ENRICHMENT_STEPS[index] ?? null;
}

export function isSkipResponse(value: string) {
  return /^(n[aã]o sei|não tenho|nao tenho|desconheço|desconheco|não informado|nao informado)$/i.test(value.trim());
}

// "Não sei", "não tenho", "não lembro", "desconheço" (e o mesmo em inglês e espanhol) em qualquer ponto da resposta,
// como palavra inteira: "Não sei o telefone.", "o telefone eu não sei", "não tenho o número dela", "I don't know".
const DIZ_QUE_NAO_SABE = new RegExp(
  "(?<!\\p{L})(?:"
  + "n[aã]o\\s+(?:sei|sabemos|lembro|me\\s+lembro|tenho|temos|tem|conhe[cç]o|fa[cç]o\\s+ideia)|desconhe[cç]o|sei\\s+l[aá]"
  + "|(?:do\\s+not|don['’]?t)\\s+(?:know|have|remember)|no\\s+idea"
  + "|no\\s+(?:lo\\s+)?s[eé]|no\\s+tengo|no\\s+recuerdo|ni\\s+idea"
  + ")(?!\\p{L})",
  "iu",
);

/**
 * A resposta diz que quem responde não sabe (ou não tem) o dado: "Não sei o telefone. O que ela tem para oferecer:
 * Exportação de café." Vale só quando a IA não tirou nada da pergunta da vez — "não sei o celular, o fixo é
 * 3333-4444" tem o fixo, e o fixo vira cartão. Antes só o "não sei" sozinho pulava a pergunta (`isSkipResponse`), e a
 * frase com qualquer coisa a mais repetia a mesma pergunta para sempre (conferência de tela do pacote do match,
 * 20/11/2026).
 */
export function dizQueNaoSabe(value: string) {
  return DIZ_QUE_NAO_SABE.test(value);
}

// O valor inteiro é um "não há dado": "Não informado", "Desconhecido", "N/A", "não sabe", "sem telefone", "—".
const VALOR_QUE_NAO_INFORMA =
  /^(?:n[aã]o\s+(?:informad[oa]|sabe|sei|consta|tem|possui|dispon[ií]vel)|desconhecid[oa]|ignorad[oa]|sem\s+(?:telefone|n[uú]mero|empresa|informa[cç][aã]o|dados?|contato)|nenhum[a]?|n\/?a|unknown|not\s+(?:provided|informed|available)|desconocid[oa]|-+|—|\?+)$/i;

/**
 * O valor que a IA extraiu é, ele mesmo, a falta do dado. Na tela (21/11), "o telefone eu não sei, mas ela oferece..."
 * voltou com o telefone "Não informado", confiança 1: virava um cartão que, confirmado, gravava "Não informado" no
 * telefone do contato. Valor assim não vira cartão; com a resposta dizendo que não sabe, a pergunta é pulada.
 */
export function valorQueNaoInforma(value: string) {
  return isSkipResponse(value) || VALOR_QUE_NAO_INFORMA.test(value.trim().replace(/[.!…]+$/, "").trim());
}

/** O índice, no roteiro, da pergunta que o campo responde (os apelidos de `isExpectedField` valem), ou -1. */
export function indiceDaEtapaDoCampo(fieldType: string) {
  return ENRICHMENT_STEPS.findIndex(step => isExpectedField(fieldType, step.fieldType));
}

/**
 * Teto do valor confirmado, por campo, igual ao da coluna de destino em
 * drizzle/schema.ts (ver aplicarRespostaAoContato em server/db.ts). Sem isto,
 * um telefone editado com 51 caracteres passava pelo zod e morria no UPDATE de
 * private_contacts.phone varchar(50): a usuária via "Erro ao salvar" e nada
 * dizia o motivo.
 */
export const LIMITE_VALOR_POR_CAMPO: Record<string, number> = {
  phone: 50, whatsapp: 50, email: 254,
  company: 200, job_title: 200, city: 100, country: 100,
  linkedin_url: 512, instagram_handle: 100,
  // contact_assets/contact_needs.tag_label varchar(200); o slug é cortado em 160 pelo slugify.
  assets: 200, asset_tag: 200, needs: 200, need_tag: 200,
};

// how_met, relationship_type (e os apelidos context/notes) vão para colunas
// TEXT; o teto é o mesmo da mensagem digitada (sendMessage: content max 2000).
export const LIMITE_VALOR_PADRAO = 2000;

export function limiteDoValor(fieldType: string) {
  return LIMITE_VALOR_POR_CAMPO[fieldType] ?? LIMITE_VALOR_PADRAO;
}

export function isExpectedField(fieldType: string, expected: EnrichmentField) {
  const aliases: Record<EnrichmentField, string[]> = {
    phone: ["phone", "whatsapp"],
    company: ["company"],
    assets: ["assets", "asset_tag"],
    needs: ["needs", "need_tag"],
    how_met: ["how_met", "context", "notes"],
    relationship_type: ["relationship_type"],
  };
  return aliases[expected].includes(fieldType);
}
