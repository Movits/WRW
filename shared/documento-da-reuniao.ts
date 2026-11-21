/**
 * A reunião que nasce de um documento (H12 e H12b do desenho do gravador): um
 * PDF, ou fotos de um texto tiradas pela câmera, que o aparelho junta num PDF,
 * uma página por foto. O servidor guarda o PDF pelo mesmo prazo do áudio (30
 * dias), a IA lê o texto integral de cada página, e esse texto vira a
 * "transcrição" da reunião: dali em diante o caminho é o de sempre (extração,
 * resumo guardado, mapa mental, perguntas, tradução, link aberto).
 *
 * Mora em shared/ porque os dois lados usam: o servidor recusa fora dos tetos e
 * grava os códigos; a tela confere os mesmos tetos antes de enviar e traduz os
 * códigos no idioma de quem lê.
 */

/**
 * O teto do arquivo: 15 MB (decimais, como a tela mostra). Em base64 o PDF
 * cresce um terço e chega a 20 MB no pedido ao Gemini, que aceita até 50 MB por
 * arquivo, inline ou pela File API (documentação de documentos da Google, lida
 * em 18/11/2026).
 */
export const DOCUMENTO_BYTES_MAX = 15 * 1000 * 1000;

/** Quantos documentos a dona pode mandar ler por hora (cada um é uma leitura paga da IA). */
export const DOCUMENTOS_POR_HORA = 10;

/**
 * Quantas fotos cabem num documento. Cada foto vira uma página de ~0,3 a 1 MB
 * (o aparelho a reduz antes, ver client/src/lib/pdf-de-fotos.ts), e 20 cabem com
 * folga nos 15 MB.
 */
export const FOTOS_POR_DOCUMENTO_MAX = 20;

/**
 * O endereço do documento da reunião (server/_core/rota-do-documento.ts): o
 * POST recebe o PDF, e o GET o devolve à dona, para a tela mostrar as páginas.
 */
export function rotaDoDocumento(meetingId: string) {
  return `/api/reunioes/${encodeURIComponent(meetingId)}/documento`;
}

/** As origens de reunião que são documento (a coluna meetings.origem). */
export const ORIGENS_DE_DOCUMENTO = ["pdf", "foto"] as const;
export type OrigemDeDocumento = (typeof ORIGENS_DE_DOCUMENTO)[number];

export function ehReuniaoDeDocumento(origem: string | null | undefined): origem is OrigemDeDocumento {
  return origem === "pdf" || origem === "foto";
}

/**
 * Os códigos da recusa do ENVIO do documento (a rota binária,
 * server/_core/rota-do-documento.ts, responde só o código, em JSON). A tela os
 * traduz (client/src/lib/mensagem-de-erro.ts), e o Record de lá é por este tipo:
 * código novo aqui não compila lá sem o aviso dele. Toda recusa é definitiva:
 * reenviar o mesmo arquivo à mesma reunião não muda a resposta, e a tela exclui
 * a reunião que nasceu para ele (os desfechos passageiros, como o teto, o
 * bucket ou o banco fora, não são recusa: a tela reenvia à mesma reunião).
 */
export const CODIGOS_DA_RECUSA_DO_DOCUMENTO = ["SEM_REUNIAO", "FORA_DO_ESTADO", "CONTEUDO_DIFERENTE", "GRANDE_DEMAIS", "VAZIO", "FORMATO"] as const;
export type CodigoDaRecusaDoDocumento = (typeof CODIGOS_DA_RECUSA_DO_DOCUMENTO)[number];

export function ehRecusaDoDocumento(valor: unknown): valor is CodigoDaRecusaDoDocumento {
  return typeof valor === "string" && (CODIGOS_DA_RECUSA_DO_DOCUMENTO as readonly string[]).includes(valor);
}

/**
 * Os códigos que a leitura do documento grava em `meetings.processing_error`
 * quando falha em segundo plano. Código, nunca frase: o servidor não sabe o
 * idioma da dona, e a tela traduz (como o ERRO_INTERROMPIDO, shared/const.ts).
 */
export const CODIGOS_DA_FALHA_DO_DOCUMENTO = [
  // A IA não achou texto em página nenhuma (foto borrada, página em branco).
  "DOCUMENTO_SEM_TEXTO",
  // O texto não coube numa resposta da IA (a resposta parou em MAX_TOKENS).
  "DOCUMENTO_LONGO_DEMAIS",
  // A IA recusou ler (recusa 4xx, ou a resposta parou por segurança ou recitação).
  "DOCUMENTO_RECUSADO",
  // A IA ficou sobrecarregada ou sem cota, mesmo com o modelo reserva.
  "IA_INDISPONIVEL",
  // No reprocesso, o arquivo guardado não estava mais no bucket.
  "DOCUMENTO_AUSENTE",
  // Qualquer outra falha (resposta fora do formato, a extração que falhou).
  "DOCUMENTO_FALHOU",
] as const;
export type CodigoDaFalhaDoDocumento = (typeof CODIGOS_DA_FALHA_DO_DOCUMENTO)[number];

export function ehCodigoDaFalhaDoDocumento(valor: unknown): valor is CodigoDaFalhaDoDocumento {
  return typeof valor === "string" && (CODIGOS_DA_FALHA_DO_DOCUMENTO as readonly string[]).includes(valor);
}

/**
 * As falhas que se repetem com o mesmo arquivo: a leitura vai ao mesmo modelo,
 * com temperatura 0 e o mesmo teto de saída, e para de novo no mesmo ponto
 * (MAX_TOKENS). Reprocessar pagaria outra leitura para falhar igual: a tela não
 * mostra o botão, e o servidor recusa o reprocesso. A frase da causa já diz o
 * que fazer (dividir o arquivo e enviar cada parte).
 */
export const FALHAS_DO_DOCUMENTO_QUE_SE_REPETEM: readonly CodigoDaFalhaDoDocumento[] = ["DOCUMENTO_LONGO_DEMAIS"];

export function falhaDoDocumentoSeRepete(codigo: string | null | undefined): codigo is CodigoDaFalhaDoDocumento {
  return ehCodigoDaFalhaDoDocumento(codigo) && FALHAS_DO_DOCUMENTO_QUE_SE_REPETEM.includes(codigo);
}

/**
 * O texto de uma página do documento, como a leitura guarda em
 * `meeting_transcripts.segments` (o lugar das falas na reunião de áudio). A
 * página sem texto fica, vazia, para a numeração bater com a do PDF. O formato
 * não tem início, fim nem falante: todo leitor de falas (segmentosDoContrato no
 * servidor, segmentosValidos na tela) o descarta, e o texto corrido da
 * transcrição é o que vale para o resumo, as perguntas e a tradução.
 */
export type PaginaDoDocumento = { pagina: number; texto: string };

/** As páginas guardadas, só as válidas, na ordem e sem repetir o número. */
export function paginasDoDocumento(bruto: unknown): PaginaDoDocumento[] {
  if (!Array.isArray(bruto)) return [];
  const vistas = new Set<number>();
  const paginas: PaginaDoDocumento[] = [];
  for (const item of bruto) {
    if (!item || typeof item !== "object") continue;
    const { pagina, texto } = item as Record<string, unknown>;
    if (typeof pagina !== "number" || !Number.isInteger(pagina) || pagina < 1 || typeof texto !== "string" || vistas.has(pagina)) continue;
    vistas.add(pagina);
    paginas.push({ pagina, texto });
  }
  return paginas.sort((a, b) => a.pagina - b.pagina);
}
