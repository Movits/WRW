/**
 * Os anexos do resumo da reunião (H4g e H4h do plano do gravador; HN-32 e
 * HN-33 no app de referência da cliente): fotos que a dona escolhe ou tira, e
 * desenhos ou escrita à mão feitos na tela de desenho (a caneta do iPad, o dedo
 * ou o mouse), guardados como imagem. O que vale para o servidor e para a tela
 * mora aqui; o serviço é server/anexos-do-resumo.ts.
 */

/** Os tipos de anexo: a foto (H4g) e o desenho à mão (H4h). */
export const TIPOS_DE_ANEXO = ["photo", "drawing"] as const;
export type TipoDeAnexo = (typeof TIPOS_DE_ANEXO)[number];

/** Os formatos aceitos: os que a redução da #149 produz e os que o aparelho entrega sem ela. */
export const FORMATOS_DE_ANEXO = ["image/jpeg", "image/png", "image/webp"] as const;
export type FormatoDeAnexo = (typeof FORMATOS_DE_ANEXO)[number];

/**
 * O teto do arquivo, o mesmo das fotos de contexto e de contato: é o teto de
 * abuso, não a régua de qualidade. A foto chega reduzida no aparelho a
 * LADO_MAXIMO_DO_ANEXO (algumas centenas de KB); o teto só pesa no recuo da
 * redução, em que o original sobe como veio.
 */
export const ANEXO_BYTES_MAX = 10 * 1024 * 1024;

/**
 * O lado maior da imagem depois da redução no aparelho. Como no cartão de
 * visita e na mídia de contexto (client/src/lib/reduzir-imagem.ts): a foto do
 * quadro branco, do slide ou da página tem texto para ler.
 */
export const LADO_MAXIMO_DO_ANEXO = 1600;

/** Quantos anexos uma reunião guarda (fotos e desenhos somados). */
export const ANEXOS_POR_REUNIAO_MAX = 20;

/** Quantos anexos uma dona envia por janela (todas as reuniões somadas). */
export const ANEXOS_POR_JANELA = 60;
export const JANELA_DOS_ANEXOS_MS = 60 * 60_000;

/**
 * As recusas, como CÓDIGO (a tela traduz):
 * - FORMATO: o arquivo não é JPEG, PNG nem WebP (pelo conteúdo, não pelo nome);
 * - GRANDE_DEMAIS: passa de ANEXO_BYTES_MAX, ou está vazio;
 * - DEMAIS: a reunião já tem ANEXOS_POR_REUNIAO_MAX anexos;
 * - NAO_ENCONTRADO: a reunião ou o anexo não existe, é de outra conta ou saiu;
 * - MUITOS_ENVIOS: o teto de ANEXOS_POR_JANELA por dona;
 * - BUCKET: o armazenamento não respondeu agora (dá para tentar de novo).
 */
export const RECUSAS_DOS_ANEXOS = {
  formato: "ANEXO_FORMATO",
  grandeDemais: "ANEXO_GRANDE_DEMAIS",
  demais: "ANEXOS_DEMAIS",
  naoEncontrado: "ANEXO_NAO_ENCONTRADO",
  muitosEnvios: "ANEXOS_MUITOS_ENVIOS",
  bucket: "ANEXO_BUCKET_INDISPONIVEL",
} as const;
export type CodigoDaRecusaDoAnexo = (typeof RECUSAS_DOS_ANEXOS)[keyof typeof RECUSAS_DOS_ANEXOS];

export function ehCodigoDaRecusaDoAnexo(valor: unknown): valor is CodigoDaRecusaDoAnexo {
  return (Object.values(RECUSAS_DOS_ANEXOS) as unknown[]).includes(valor);
}

/** O anexo como a tela da dona o recebe. */
export type AnexoDaDona = {
  id: string;
  tipo: TipoDeAnexo;
  url: string;
  mimeType: string;
  criadoEm: number;
  expiraEm: number;
};

/** O anexo como o link aberto o recebe: sem a hora de envio nem a chave, só o endereço pela rota do link. */
export type AnexoDoLink = { id: string; tipo: TipoDeAnexo; url: string };

/** A rota do link aberto que entrega a imagem: `${ROTA_DO_ANEXO_DO_LINK}/{token}/anexo/{id}`. */
export const ROTA_DO_ANEXO_DO_LINK = "/reuniao-aberta";

export function enderecoDoAnexoDoLink(token: string, anexoId: string): string {
  return `${ROTA_DO_ANEXO_DO_LINK}/${token}/anexo/${anexoId}`;
}
