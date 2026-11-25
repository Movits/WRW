export const ENRICHMENT_STEPS = [
  { fieldType: "phone", question: "Qual é o telefone dele/dela?" },
  { fieldType: "company", question: "Em qual empresa trabalha?" },
  { fieldType: "assets", question: "O que essa pessoa pode oferecer? (ex.: mina, fábrica, patente, acesso)" },
  { fieldType: "needs", question: "O que ela está procurando? (ex.: investidores, parceiros, compradores)" },
  { fieldType: "how_met", question: "Como vocês se conheceram?" },
  { fieldType: "relationship_type", question: "O relacionamento é pessoal, profissional ou ambos?" },
] as const;

export type EnrichmentField = (typeof ENRICHMENT_STEPS)[number]["fieldType"];

/** O que cada pergunta pede, dito para explicar à dona o que falta na resposta (T45, 24/11). */
const O_QUE_A_ETAPA_PEDE: Record<EnrichmentField, string> = {
  phone: "um número de telefone",
  company: "o nome da empresa",
  assets: "algo que essa pessoa pode oferecer",
  needs: "algo que essa pessoa está procurando",
  how_met: "como vocês se conheceram",
  relationship_type: "se o relacionamento é pessoal, profissional ou ambos",
};

/** O nome curto de cada pergunta, para dizer o que foi anotado ou pulado. */
const NOME_DA_ETAPA: Record<EnrichmentField, string> = {
  phone: "o telefone",
  company: "a empresa",
  assets: "o que essa pessoa oferece",
  needs: "o que essa pessoa procura",
  how_met: "como vocês se conheceram",
  relationship_type: "o tipo de relacionamento",
};

/** "a, b e c". */
function juntarNomes(nomes: string[]) {
  return nomes.length <= 1 ? nomes.join("") : `${nomes.slice(0, -1).join(", ")} e ${nomes[nomes.length - 1]}`;
}

export const DICA_DO_NAO_SEI = "Se não souber, responda \"não sei\" e eu passo para a próxima pergunta.";

/**
 * A resposta não trouxe o dado da pergunta da vez (T45, 24/11: o chat repetia a
 * mesma pergunta sem dizer por quê). Diz o que faltou, refaz a pergunta e
 * ensina a pular. Quando a resposta era de OUTRA pergunta (guardada para quando
 * o roteiro chegar lá, `anotadas`), diz que anotou, em vez de dar a entender
 * que ela se perdeu.
 */
export function explicarOQueFalta(fieldType: EnrichmentField, pergunta: string, anotadas: EnrichmentField[] = []) {
  const unicas = Array.from(new Set(anotadas)).filter(campo => campo !== fieldType);
  const inicio = unicas.length
    ? `Anotei o que você contou sobre ${juntarNomes(unicas.map(campo => NOME_DA_ETAPA[campo]))} para quando chegarmos lá. Para esta pergunta, ainda preciso de ${O_QUE_A_ETAPA_PEDE[fieldType]}.`
    : `Não encontrei ${O_QUE_A_ETAPA_PEDE[fieldType]} na sua resposta.`;
  return `${inicio} ${pergunta} ${DICA_DO_NAO_SEI}`;
}

/** A resposta trouxe algo da pergunta, mas sem a confiança de um cartão. */
export function pedirDeOutroJeito(fieldType: EnrichmentField) {
  return `Não tenho certeza se entendi. Preciso de ${O_QUE_A_ETAPA_PEDE[fieldType]}: pode dizer de outro jeito? ${DICA_DO_NAO_SEI}`;
}

/**
 * O aviso das perguntas puladas porque o contato já as tem respondidas (T45,
 * 24/11), antes da pergunta seguinte. O que já está na ficha se muda nela.
 */
export function avisoDasJaPreenchidas(puladas: EnrichmentField[]) {
  if (!puladas.length) return "";
  return `Este contato já tem ${juntarNomes(puladas.map(campo => NOME_DA_ETAPA[campo]))} na ficha, então pulei ${puladas.length === 1 ? "essa pergunta" : "essas perguntas"} (para mudar, edite a ficha do contato).`;
}

/**
 * A próxima pergunta a fazer a partir de `aPartirDe`: pula as que o contato já
 * tem respondidas (`preenchidas`), menos a que tem resposta dita antes da vez
 * (`comAntecipadas`), que precisa virar cartão lá. Devolve o índice (o tamanho
 * do roteiro quando não sobra pergunta) e as puladas.
 */
export function proximaEtapaAPerguntar(aPartirDe: number, preenchidas: ReadonlySet<string>, comAntecipadas: ReadonlySet<string> = new Set()) {
  const puladas: EnrichmentField[] = [];
  let indice = Math.max(0, aPartirDe);
  for (; indice < ENRICHMENT_STEPS.length; indice++) {
    const campo = ENRICHMENT_STEPS[indice].fieldType;
    if (!preenchidas.has(campo) || comAntecipadas.has(campo)) break;
    puladas.push(campo);
  }
  return { indice, puladas };
}

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
