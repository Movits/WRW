import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { meetingDocuments, meetings } from "../drizzle/schema";
import { LIMITE_PROCESSAMENTO_MS } from "@shared/const";
import { escolhaDoIdioma, IDIOMA_AUTOMATICO, IDIOMA_DA_REUNIAO_PADRAO, idiomaFalado, nomeDoIdioma, type IdiomaFalado } from "@shared/idioma-da-reuniao";
import {
  DOCUMENTO_BYTES_MAX, DOCUMENTOS_POR_HORA, ehReuniaoDeDocumento, falhaDoDocumentoSeRepete,
  type CodigoDaFalhaDoDocumento, type CodigoDaRecusaDoDocumento, type OrigemDeDocumento, type PaginaDoDocumento,
} from "@shared/documento-da-reuniao";
import { criarTeto } from "./assistente-de-texto";
import { descreverErroDeBanco, ehErroDoDriverDeBanco, MENSAGEM_ERRO_DE_CONSULTA } from "./banco-indisponivel";
import { exigirDb } from "./db";
import { foraDaLixeira, reuniaoForaDeVista } from "./reuniao-visivel";
import {
  ArquivoForaDoTetoDoGeminiError, GeminiIndisponivelError, GeminiRecusouChamadaError, GeminiRespostaCortadaError,
  GeminiSemTextoError, gerarComArquivoNoGemini, prazoEsgotadoNoGemini,
} from "./gemini";
import {
  extrairDadosDaReuniao, gravarResultadoDaReuniao, MEETING_AUDIO_TTL_MS, MENSAGEM_REPROCESSO_EM_CONFLITO,
  MENSAGEM_REUNIAO_NAO_ENCONTRADA, ReprocessamentoRecusado, ReuniaoExcluidaDuranteProcessamento, ReuniaoTomadaPorOutraExecucao,
} from "./meeting-service";
import { chaveDoStorageDaDona, ObjetoAusenteNoStorageError, storageApagarTodasAsVersoes, storageGetBytes, storagePut } from "./storage";

/**
 * A reunião que nasce de um documento (H12 e H12b do desenho do gravador): um
 * PDF, ou as fotos de um texto, que o aparelho junta num PDF, uma página por
 * foto (client/src/lib/pdf-de-fotos.ts). O caminho:
 *
 * 1. `meetings.iniciarDocumento` cria a reunião em 'uploading', com o
 *    consentimento e a versão do aviso do documento (shared/aviso-do-documento.ts);
 * 2. o PDF chega pela rota binária `POST /api/reunioes/{id}/documento`
 *    (server/_core/rota-do-documento.ts), que autentica antes de ler o corpo;
 * 3. receberDocumento confere o arquivo (até 15 MB, começa por "%PDF-"), sobe o
 *    objeto, grava a linha de meeting_documents e toma a reunião para
 *    'processing', tudo antes de responder;
 * 4. em segundo plano, a IA devolve o texto integral de cada página, que vira a
 *    transcrição da reunião, e o caminho é o de sempre (gravarResultadoDaReuniao:
 *    extração, sugestões pendentes, pedido do resumo guardado, que a fila do
 *    resumo gera, com o mapa mental logo depois).
 *
 * O arquivo segue a regra do áudio: 30 dias contados do envio
 * (MEETING_AUDIO_TTL_MS), a varredura e a leitura vencida o tiram do bucket com
 * todas as versões, e a exclusão da reunião e a da conta também. A falha grava
 * um CÓDIGO em processing_error (shared/documento-da-reuniao.ts), que a tela
 * traduz; e a reunião que falhou se reprocessa pelo arquivo guardado.
 *
 * Custo de IA (preços do Gemini 3.6 Flash lidos em 16/11/2026: US$ 0,75 por
 * milhão de tokens de entrada e US$ 3,75 de saída até 31/12/2026, o dobro a
 * partir de 01/01/2027): cada página entra com ~560 tokens (o nível médio, o
 * padrão da família 3) e uma página de texto sai com ~750, então a leitura
 * custa ~US$ 0,005 por página, ou por foto. O PDF de 10 páginas, com a
 * extração e o resumo, fica em ~US$ 0,11. O teto de saída (65 mil tokens, ~80
 * páginas de texto corrido) limita o pior caso de uma leitura a ~US$ 0,30, e o
 * teto de 10 documentos por hora (DOCUMENTOS_POR_HORA) limita a conta por dona.
 */

/**
 * O teto de DOCUMENTOS_POR_HORA por dona, em memória, como os outros: basta à
 * instância única do Render e zera a cada deploy. A rota do arquivo
 * (server/_core/rota-do-documento.ts) reserva a vaga, que só fica gasta com o
 * documento aceito; meetings.iniciarDocumento só confere, sem gastar, para a
 * reunião não nascer quando o teto já está cheio.
 */
export const tetoDosDocumentos = criarTeto(DOCUMENTOS_POR_HORA, 60 * 60_000, "Muitos documentos enviados em pouco tempo.");

/** Recusa definitiva do envio: reenviar o mesmo arquivo não muda a resposta. */
export class RecusaDoDocumento extends Error {
  constructor(readonly codigo: CodigoDaRecusaDoDocumento, mensagem: string) {
    super(mensagem);
    this.name = "RecusaDoDocumento";
  }
}

/** Falha passageira (bucket fora): o mesmo arquivo pode ser reenviado depois. */
export class FalhaPassageiraDoDocumento extends Error {}

/** A leitura falhou com um código que a tela traduz. */
export class FalhaDoDocumento extends Error {
  constructor(readonly codigo: CodigoDaFalhaDoDocumento, mensagem: string, opcoes?: { cause?: unknown }) {
    super(mensagem, opcoes);
    this.name = "FalhaDoDocumento";
  }
}

/** O mesmo arquivo chegou de novo (a resposta do primeiro envio se perdeu): não duplica. */
class DocumentoRepetido extends Error {}

export const MENSAGEM_SEM_DOCUMENTO_PARA_REPROCESSAR = "Não há documento guardado desta reunião para reprocessar.";

/** O teto de saída do Flash: ~250 mil caracteres, umas 80 páginas de texto corrido. */
export const SAIDA_MAXIMA_DA_LEITURA = 65_536;

/**
 * Os prazos da leitura, no desenho do vídeo do YouTube (server/youtube.ts). A
 * leitura roda em segundo plano, sem o proxy do Render na frente, e tem de
 * terminar antes de a varredura de interrompidas dar a reunião como falha
 * (LIMITE_PROCESSAMENTO_MS, 15 min contados da ficha): passado disso, o texto
 * lido e pago seria descartado.
 *
 * - Cada chamada tem até 10 min: escrever os 65 mil tokens de SAIDA_MAXIMA_DA_LEITURA
 *   pede ~110 tokens por segundo, sustentados (com 6 min, pedia ~180, e o
 *   documento mais longo que o teto aceita estourava o prazo em toda tentativa).
 * - A nova tentativa no mesmo modelo só sai se a falha veio cedo (orçamento de
 *   2 min), e a reserva só se o principal desistiu em menos de 2 min.
 *
 * O pior caso é uma falha passageira aos 2 min, as esperas de 2 e 5 s e a
 * chamada seguinte estourando o prazo: ~12 min (PIOR_CASO_DA_LEITURA_MS), com
 * margem para o arquivo que o reprocesso lê do bucket. Lido o documento, a
 * ficha se renova (renovarFicha), e a extração e a gravação ganham outros 15 min.
 */
const TIMEOUT_DA_LEITURA_MS = 10 * 60_000;
const ORCAMENTO_DA_LEITURA_MS = 2 * 60_000;
const RESERVA_DA_LEITURA_SO_ATE_MS = 2 * 60_000;
export const PIOR_CASO_DA_LEITURA_MS = ORCAMENTO_DA_LEITURA_MS + 7_000 + TIMEOUT_DA_LEITURA_MS;

// O responseSchema do Gemini, com os tipos em maiúsculas e a ordem do contrato
// (como em server/transcricao-de-fatia.ts).
export const ESQUEMA_DA_LEITURA = {
  type: "OBJECT",
  properties: {
    paginas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          pagina: { type: "INTEGER", description: "O número da página no arquivo, a partir de 1." },
          texto: { type: "STRING" },
        },
        required: ["pagina", "texto"],
        propertyOrdering: ["pagina", "texto"],
      },
    },
  },
  required: ["paginas"],
} as const;

// "Detectar sozinho" (G16): a leitura devolve também o código do idioma em que
// está a maior parte do documento, DEPOIS das páginas (o texto antes do nome
// do idioma, como na fatia).
const ESQUEMA_DA_LEITURA_COM_IDIOMA = {
  type: "OBJECT",
  properties: {
    paginas: ESQUEMA_DA_LEITURA.properties.paginas,
    idioma: { type: "STRING", description: 'O código do idioma em que está escrita a maior parte do documento, como "pt", "en", "es", "it" ou "zh".' },
  },
  required: ["paginas", "idioma"],
  propertyOrdering: ["paginas", "idioma"],
} as const;

/** O esquema da leitura para a escolha do idioma: com o `idioma` só em "Detectar sozinho" (G16). */
export function esquemaDaLeitura(idioma: string | null | undefined) {
  return escolhaDoIdioma(idioma) === IDIOMA_AUTOMATICO ? ESQUEMA_DA_LEITURA_COM_IDIOMA : ESQUEMA_DA_LEITURA;
}

/**
 * O pedido da leitura. O idioma é o que a dona escolheu (G16: um dos que a IA
 * transcreve), ou "Detectar sozinho", que pede o código do idioma do
 * documento; a IA não traduz.
 */
export function promptDaLeitura(idioma: string | null | undefined): string {
  const escolha = escolhaDoIdioma(idioma);
  const instrucaoDoIdioma = escolha === IDIOMA_AUTOMATICO
    ? ' O idioma não foi informado: reconheça-o pelo texto e mantenha cada trecho no idioma em que está escrito. Em "idioma", devolva o código do idioma em que está escrita a maior parte do documento ("pt", "en", "es"...).'
    : escolha ? ` O idioma predominante esperado é ${nomeDoIdioma(escolha)}; mantenha cada trecho no idioma em que está escrito.` : "";
  return "Este arquivo é um documento em PDF: pode ser digital, escaneado ou fotos de páginas de um texto, uma foto por página. "
    + "Transcreva integralmente o texto de cada página, na ordem em que aparece, sem resumir, sem traduzir e sem comentar. "
    + "Preserve nomes próprios, empresas, números, datas, telefones, e-mails e endereços exatamente como estão escritos, e mantenha as quebras de parágrafo. "
    + "Em tabelas, escreva uma linha do texto por linha da tabela, com as células separadas por \" | \". "
    + "Texto manuscrito legível também entra; o que não der para ler fica de fora, sem inventar nem completar. "
    + "Devolva uma entrada por página do arquivo, com o número da página (a primeira é 1) e o texto dela; a página sem texto legível fica com o texto vazio."
    + instrucaoDoIdioma;
}

/** Começa por "%PDF-" (nos primeiros 1024 bytes, como os leitores de PDF aceitam). */
export function pareceUmPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).indexOf("%PDF-") !== -1;
}

/** O número da página: inteiro, a partir de 0, também escrito como texto ("3"); null fora disso. */
function numeroDaPagina(valor: unknown): number | null {
  const numero = typeof valor === "string" && /^\s*\d{1,6}\s*$/.test(valor) ? Number(valor) : valor;
  return typeof numero === "number" && Number.isInteger(numero) && numero >= 0 ? numero : null;
}

/**
 * As páginas que a IA devolveu, na ordem e com o texto aparado. O que o modelo
 * erra sem perder texto é consertado, e nada sai em silêncio:
 * - a numeração que começa em 0 (o modelo contou do zero) sobe 1 em todas;
 * - o número repetido (a mesma página em duas entradas, a foto tirada duas
 *   vezes, a numeração impressa no papel, "Página 1 de 1" em cada folha)
 *   junta os textos, na ordem em que vieram;
 * - o número escrito como texto ("3") vale como número;
 * - o item fora do formato (sem número de página ou sem texto) fica de fora,
 *   com um aviso no log que diz quantos (nunca o texto).
 * JSON inválido, resposta sem a lista e lista em que nenhuma página se salva
 * são falha (DOCUMENTO_FALHOU): o documento podia ter texto, a resposta é que
 * veio errada. A lista vazia é o documento sem texto (lerDocumentoComAIA).
 */
export function paginasDaResposta(texto: string): PaginaDoDocumento[] {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch (erro) {
    throw new FalhaDoDocumento("DOCUMENTO_FALHOU", "A leitura do documento veio num formato inválido.", { cause: erro });
  }
  const lista = (bruto as { paginas?: unknown } | null)?.paginas;
  if (!Array.isArray(lista)) throw new FalhaDoDocumento("DOCUMENTO_FALHOU", "A leitura do documento veio sem as páginas.");
  const lidas: PaginaDoDocumento[] = [];
  for (const item of lista) {
    const { pagina, texto: textoDaPagina } = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const numero = numeroDaPagina(pagina);
    if (numero !== null && typeof textoDaPagina === "string") lidas.push({ pagina: numero, texto: textoDaPagina.trim() });
  }
  if (lista.length && !lidas.length) throw new FalhaDoDocumento("DOCUMENTO_FALHOU", "Nenhuma página da leitura veio no formato.");
  const foraDoFormato = lista.length - lidas.length;
  if (foraDoFormato) console.warn(`[Documento] ${foraDoFormato} de ${lista.length} páginas da leitura vieram fora do formato (sem número de página ou sem texto) e ficaram de fora`);
  const contouDoZero = lidas.some(lida => lida.pagina === 0);
  if (contouDoZero) console.warn("[Documento] a leitura numerou as páginas a partir de 0; todas subiram 1");
  const textosPorPagina = new Map<number, string[]>();
  for (const lida of lidas) {
    const numero = contouDoZero ? lida.pagina + 1 : lida.pagina;
    textosPorPagina.set(numero, [...(textosPorPagina.get(numero) ?? []), lida.texto]);
  }
  const repetidas = lidas.length - textosPorPagina.size;
  if (repetidas) console.warn(`[Documento] ${repetidas} páginas da leitura repetiram o número de outra; os textos foram juntados, na ordem`);
  return Array.from(textosPorPagina, ([pagina, textos]) => ({ pagina, texto: textos.filter(Boolean).join("\n\n") }))
    .sort((a, b) => a.pagina - b.pagina);
}

/** O texto corrido da "transcrição": as páginas com texto, separadas por uma linha em branco. */
export function textoDasPaginas(paginas: readonly PaginaDoDocumento[]): string {
  return paginas.map(pagina => pagina.texto).filter(Boolean).join("\n\n");
}

/** A leitura do PDF pela IA: as páginas, ou a falha com o código dela. */
export async function lerDocumentoComAIA(bytes: Buffer, idioma: string | null | undefined): Promise<PaginaDoDocumento[]> {
  return (await lerDocumentoEOIdioma(bytes, idioma)).paginas;
}

/**
 * O código do idioma que a leitura de "Detectar sozinho" (G16) devolveu, ou
 * null (não veio, ou não é um idioma que a IA transcreve). A resposta já passou
 * por paginasDaResposta: o JSON é válido.
 */
export function idiomaDaLeitura(texto: string): IdiomaFalado | null {
  try {
    const idioma = (JSON.parse(texto) as { idioma?: unknown } | null)?.idioma;
    return idiomaFalado(typeof idioma === "string" ? idioma : null);
  } catch {
    return null;
  }
}

/**
 * A leitura e, com "Detectar sozinho" (G16), o idioma que a IA reconheceu no
 * documento (`idiomaDetectado`; null com o idioma escolhido ou quando ele não
 * veio). Os erros são os de lerDocumentoComAIA.
 */
export async function lerDocumentoEOIdioma(bytes: Buffer, idioma: string | null | undefined): Promise<{ paginas: PaginaDoDocumento[]; idiomaDetectado: IdiomaFalado | null }> {
  let texto: string;
  try {
    ({ texto } = await gerarComArquivoNoGemini({
      bytes,
      mimeType: "application/pdf",
      prompt: promptDaLeitura(idioma),
      esquemaJson: esquemaDaLeitura(idioma),
      tetoInlineBytes: DOCUMENTO_BYTES_MAX,
      saidaMaxima: SAIDA_MAXIMA_DA_LEITURA,
      timeoutMs: TIMEOUT_DA_LEITURA_MS,
      orcamentoMs: ORCAMENTO_DA_LEITURA_MS,
      reservaSoAteMs: RESERVA_DA_LEITURA_SO_ATE_MS,
    }));
  } catch (erro) {
    throw new FalhaDoDocumento(codigoDaFalhaDaIA(erro), "A IA não leu o documento.", { cause: erro });
  }
  const paginas = paginasDaResposta(texto);
  if (!textoDasPaginas(paginas)) throw new FalhaDoDocumento("DOCUMENTO_SEM_TEXTO", "A IA não achou texto no documento.");
  return { paginas, idiomaDetectado: escolhaDoIdioma(idioma) === IDIOMA_AUTOMATICO ? idiomaDaLeitura(texto) : null };
}

/**
 * O arquivo que o Gemini não consegue abrir: começa por "%PDF-" (passa pela tela
 * e pela rota), mas está corrompido. O Gemini responde 400 com "Unable to process
 * input: the file or media data is empty, corrupted, or malformed." (visto na
 * conferência de tela de 20/11/2026), ou "The document has no pages." para o PDF
 * sem página que se abra. O mesmo arquivo falha igual em toda leitura.
 */
const ARQUIVO_QUE_A_IA_NAO_ABRE = /corrupted|malformed|has no pages/i;

export function arquivoQueAIANaoAbre(erro: unknown): boolean {
  return erro instanceof GeminiRecusouChamadaError && erro.status === 400 && ARQUIVO_QUE_A_IA_NAO_ABRE.test(erro.detalhe);
}

/**
 * O código da falha de uma chamada à IA. A ordem decide: GeminiRecusouChamadaError
 * e GeminiCotaEsgotadaError são subclasses de GeminiIndisponivelError, o prazo
 * esgotado do Gemini (504) chega como recusa sem ser uma, e o arquivo corrompido
 * também chega como recusa (400), mas é do arquivo, e não da IA.
 */
function codigoDaFalhaDaIA(erro: unknown): CodigoDaFalhaDoDocumento {
  if (erro instanceof GeminiRespostaCortadaError) return erro.motivo === "MAX_TOKENS" ? "DOCUMENTO_LONGO_DEMAIS" : "DOCUMENTO_RECUSADO";
  if (erro instanceof GeminiSemTextoError) return "DOCUMENTO_SEM_TEXTO";
  if (prazoEsgotadoNoGemini(erro)) return "IA_INDISPONIVEL";
  if (arquivoQueAIANaoAbre(erro)) return "DOCUMENTO_ILEGIVEL";
  if (erro instanceof GeminiRecusouChamadaError) return "DOCUMENTO_RECUSADO";
  if (erro instanceof GeminiIndisponivelError) return "IA_INDISPONIVEL";
  if (erro instanceof ArquivoForaDoTetoDoGeminiError) return "DOCUMENTO_RECUSADO";
  return "DOCUMENTO_FALHOU";
}

/**
 * O que vai para processing_error quando a leitura falha: o código, nunca a
 * frase. Erro do driver do banco vira a frase do erro de consulta, que a tela
 * já traduz (a mensagem do driver traz o SQL com os parâmetros, e não pode ir
 * à tela); o detalhe vai ao log, como em mensagemDaFalha (meeting-service.ts).
 */
export function codigoDaFalha(erro: unknown): string {
  if (erro instanceof FalhaDoDocumento) return erro.codigo;
  if (ehErroDoDriverDeBanco(erro)) {
    console.error("[Documento] falha de banco na leitura:", descreverErroDeBanco(erro));
    return MENSAGEM_ERRO_DE_CONSULTA;
  }
  return "DOCUMENTO_FALHOU";
}

type Banco = Awaited<ReturnType<typeof exigirDb>>;

/** A ficha da execução, como em meeting-service.ts: estritamente maior que o updated_at lido. */
function fichaDaExecucao(updatedAtLido: unknown): number {
  const anterior = Number(updatedAtLido);
  return Math.max(Date.now(), Number.isFinite(anterior) ? anterior + 1 : 0);
}

function linhasAlcancadas(resultado: unknown): number {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  const n = (cabecalho as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/**
 * A reunião nasce no início do envio, como a gravação em partes, com o
 * consentimento e a versão do aviso do documento que a tela mostrou.
 */
export async function iniciarDocumento(ownerId: string, entrada: {
  title: string; language: string; consentNoticeVersion: string; origem: OrigemDeDocumento;
  contactId?: number | null; contextId?: string | null;
}) {
  const db = await exigirDb();
  const agora = Date.now();
  const id = crypto.randomUUID();
  await db.insert(meetings).values({
    id, ownerId, title: entrada.title, contactId: entrada.contactId ?? null, contextId: entrada.contextId ?? null,
    status: "uploading", consentGranted: true, consentAt: agora, consentNoticeVersion: entrada.consentNoticeVersion,
    language: entrada.language, audioPipeline: "single", origem: entrada.origem, createdAt: agora, updatedAt: agora,
  });
  return { id };
}

/** A reunião aceita este documento agora? Recusa, ou "repetido" quando o mesmo arquivo já chegou. */
async function conferirAReuniao(db: Pick<Banco, "select">, ownerId: string, meetingId: string, sha256: string, travar: boolean) {
  const consulta = db.select({
    status: meetings.status, origem: meetings.origem, consentimento: meetings.consentGranted, language: meetings.language, updatedAt: meetings.updatedAt,
    trashedAt: meetings.trashedAt,
  }).from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  const [reuniao] = travar ? await consulta.for("update") : await consulta;
  // Reunião de outra dona, reunião que não existe e a da lixeira (H7d) respondem igual.
  if (!reuniao || reuniaoForaDeVista(reuniao)) throw new RecusaDoDocumento("SEM_REUNIAO", "Reunião não encontrada.");
  const [existente] = await db.select({ sha256: meetingDocuments.sha256 }).from(meetingDocuments)
    .where(and(eq(meetingDocuments.meetingId, meetingId), eq(meetingDocuments.ownerId, ownerId))).limit(1);
  if (existente) {
    if (existente.sha256 === sha256) throw new DocumentoRepetido();
    throw new RecusaDoDocumento("CONTEUDO_DIFERENTE", "Esta reunião já recebeu outro documento.");
  }
  if (!ehReuniaoDeDocumento(reuniao.origem) || !reuniao.consentimento || reuniao.status !== "uploading") {
    throw new RecusaDoDocumento("FORA_DO_ESTADO", "Esta reunião não está recebendo documento.");
  }
  return reuniao;
}

/**
 * O objeto que subiu sem linha (o banco recusou, a reunião sumiu, o arquivo era
 * repetido) sai do bucket com todas as versões. Se o bucket também recusar, o
 * log de erro é o único lugar que diz qual objeto precisa sair à mão (a chave
 * leva só o openId aleatório e o id da reunião, sem dado de ninguém).
 */
async function tirarObjetoSemPonteiro(chave: string) {
  try {
    await storageApagarTodasAsVersoes(chave);
  } catch (erro) {
    console.error(`[Documento] o PDF ficou no bucket SEM ponteiro no banco; remoção manual: ${chave}`, erro instanceof Error ? erro.message : erro);
  }
}

/**
 * O documento que chegou pela rota: conferido, guardado e entregue à leitura em
 * segundo plano. Devolve `repetido` quando o mesmo arquivo já tinha chegado, e
 * o `trabalho` da leitura, que NUNCA rejeita (fora da requisição, uma rejeição
 * solta derrubaria o processo).
 *
 * A ordem é a do envio único (processMeetingRecording): o objeto sobe antes da
 * linha, com a chave exata; a linha e a tomada da reunião ('uploading' →
 * 'processing', com a ficha) vão numa transação com a reunião travada; se a
 * transação não grava, o objeto sai. Assim nenhum PDF fica no bucket sem a
 * linha que diz onde ele está.
 */
export async function receberDocumento(entrada: { ownerId: string; meetingId: string; bytes: Buffer }): Promise<{ repetido: boolean; trabalho: Promise<void> | null }> {
  const { ownerId, meetingId, bytes } = entrada;
  if (!bytes.length) throw new RecusaDoDocumento("VAZIO", "Documento vazio.");
  if (bytes.length > DOCUMENTO_BYTES_MAX) throw new RecusaDoDocumento("GRANDE_DEMAIS", "Documento grande demais.");
  if (!pareceUmPdf(bytes)) throw new RecusaDoDocumento("FORMATO", "O arquivo não é um PDF.");

  const db = await exigirDb();
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    await conferirAReuniao(db, ownerId, meetingId, sha256, false);
  } catch (erro) {
    if (erro instanceof DocumentoRepetido) return { repetido: true, trabalho: null };
    throw erro;
  }

  const id = crypto.randomUUID();
  const chave = `meetings/${ownerId}/${meetingId}/documento-${id.slice(0, 8)}.pdf`;
  try {
    await storagePut(chave, bytes, "application/pdf", { chaveExata: true });
  } catch (erro) {
    console.error("[Documento] o bucket recusou o PDF:", erro instanceof Error ? erro.message : erro);
    throw new FalhaPassageiraDoDocumento("Não foi possível guardar o documento agora.", { cause: erro });
  }

  let tomada: { ficha: number; language: string };
  try {
    tomada = await db.transaction(async tx => {
      const reuniao = await conferirAReuniao(tx, ownerId, meetingId, sha256, true);
      const agora = Date.now();
      await tx.insert(meetingDocuments).values({
        id, meetingId, ownerId, storageKey: chave, storageUrl: `/manus-storage/${chave}`, mimeType: "application/pdf",
        sizeBytes: bytes.length, sha256, expiresAt: agora + MEETING_AUDIO_TTL_MS, createdAt: agora,
      });
      const ficha = fichaDaExecucao(reuniao.updatedAt);
      await tx.update(meetings).set({ status: "processing", processingError: null, updatedAt: ficha })
        .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "uploading")));
      return { ficha, language: reuniao.language };
    });
  } catch (erro) {
    await tirarObjetoSemPonteiro(chave);
    if (erro instanceof DocumentoRepetido) return { repetido: true, trabalho: null };
    throw erro;
  }

  const trabalho = processarDocumento(db, { ownerId, meetingId, ficha: tomada.ficha, bytes, idioma: tomada.language, limparAntes: false })
    .catch(erro => console.error("[Documento] a leitura em segundo plano terminou com erro não tratado:", erro instanceof Error ? erro.message : erro));
  return { repetido: false, trabalho };
}

/**
 * Renova a ficha depois da leitura, que pode levar até PIOR_CASO_DA_LEITURA_MS:
 * a extração e a gravação ganham os 15 min inteiros antes da varredura de
 * interrompidas, como renovarFicha em server/youtube.ts. Zero linhas: a reunião
 * foi excluída, ou outra execução a tomou (a varredura, um reprocesso depois
 * dela). Nada desta execução foi gravado ainda, então não há o que limpar.
 */
async function renovarFicha(db: Banco, meetingId: string, ownerId: string, ficha: number): Promise<number> {
  const nova = Math.max(Date.now(), ficha + 1);
  const renovada = await db.update(meetings).set({ updatedAt: nova }).where(and(
    eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha),
  ));
  if (linhasAlcancadas(renovada)) return nova;
  const [agora] = await db.select({ status: meetings.status }).from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
  if (!agora || agora.status === "deleted") throw new ReuniaoExcluidaDuranteProcessamento();
  throw new ReuniaoTomadaPorOutraExecucao();
}

/**
 * A cadeia de causas de uma falha, para o log: o nome de cada elo, com o código,
 * o status HTTP e o motivo do fim quando há. Nunca as mensagens: a do JSON.parse
 * traz um trecho do texto lido, e a do driver, os parâmetros do SQL.
 */
export function nomesDaCadeia(erro: unknown): string {
  const nomes: string[] = [];
  const vistos = new Set<unknown>();
  let atual: unknown = erro;
  while (atual && typeof atual === "object" && !vistos.has(atual) && nomes.length < 8) {
    vistos.add(atual);
    const elo = atual as { name?: unknown; codigo?: unknown; status?: unknown; motivo?: unknown; code?: unknown; cause?: unknown };
    const classe = (atual as object).constructor?.name;
    const nome = classe && classe !== "Object" ? classe : typeof elo.name === "string" ? elo.name : "Error";
    const extras = [elo.codigo, elo.status, elo.motivo, elo.code].filter(valor => typeof valor === "string" || typeof valor === "number");
    nomes.push(extras.length ? `${nome}(${extras.join(", ")})` : nome);
    atual = elo.cause;
  }
  return nomes.length ? nomes.join(" <- ") : typeof erro;
}

/**
 * A leitura e o resto do caminho, em segundo plano: a IA lê as páginas, o texto
 * corrido vira a transcrição (as páginas vão em `segments`, para a tela navegar
 * por elas), e gravarResultadoDaReuniao faz a extração, as sugestões pendentes
 * e o pedido do resumo guardado, tudo arbitrado pela ficha, que se renova
 * depois da leitura. Documento não conta minutos de reunião. Falha marca a
 * reunião com o código, só se ela ainda for desta execução, e vai ao log com a
 * cadeia de causas; excluída ou tomada por outra, sai sem escrever.
 */
export async function processarDocumento(db: Banco, execucao: {
  ownerId: string; meetingId: string; ficha: number; bytes: Buffer; idioma: string; limparAntes: boolean;
}): Promise<void> {
  const { ownerId, meetingId } = execucao;
  let ficha = execucao.ficha;
  try {
    const { paginas, idiomaDetectado } = await lerDocumentoEOIdioma(execucao.bytes, execucao.idioma);
    ficha = await renovarFicha(db, meetingId, ownerId, ficha);
    const texto = textoDasPaginas(paginas);
    let extraction: Awaited<ReturnType<typeof extrairDadosDaReuniao>>;
    try {
      extraction = await extrairDadosDaReuniao(texto);
    } catch (erro) {
      throw new FalhaDoDocumento("DOCUMENTO_FALHOU", "A extração do documento falhou.", { cause: erro });
    }
    await gravarResultadoDaReuniao(db, {
      meetingId, ownerId, ficha,
      limparAntes: execucao.limparAntes,
      durationSeconds: 0,
      contarMinutos: false,
      // O idioma escolhido (G16: um dos que a IA transcreve) ou, com "Detectar
      // sozinho", o que a leitura reconheceu; sem nenhum, o padrão.
      transcription: { text: texto, segments: paginas, language: idiomaDetectado ?? idiomaFalado(execucao.idioma) ?? IDIOMA_DA_REUNIAO_PADRAO },
      extraction,
    });
  } catch (erro) {
    if (erro instanceof ReuniaoExcluidaDuranteProcessamento) return;
    if (erro instanceof ReuniaoTomadaPorOutraExecucao) {
      console.warn("[Documento] outra execução tomou a reunião no meio da leitura (a varredura de interrompidas ou um reprocesso); o resultado desta foi descartado");
      return;
    }
    const codigo = codigoDaFalha(erro);
    console.error(`[Documento] a leitura falhou (${codigo}):`, nomesDaCadeia(erro));
    try {
      await db.update(meetings).set({ status: "failed", processingError: codigo, updatedAt: Date.now() })
        .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha)));
    } catch (erroAoMarcar) {
      // Banco fora justo agora: a reunião fica 'processing', e a varredura de
      // interrompidas a dá como falha (ERRO_INTERROMPIDO) em até 20 minutos.
      console.error("[Documento] não foi possível marcar a falha da leitura:", erroAoMarcar instanceof Error ? erroAoMarcar.message : erroAoMarcar);
    }
  }
}

/**
 * Os bytes do PDF guardado, para a tela da dona mostrar as páginas (a rota
 * `GET /api/reunioes/{id}/documento`, server/_core/rota-do-documento.ts). O
 * leitor de PDF da tela lê o arquivo por fetch, e o proxy do storage responde
 * 307 para o bucket, que não manda CORS: por isso os bytes saem por aqui, na
 * mesma origem. A regra é a de documentoParaVer (meeting-service.ts): só a
 * dona, só reunião que não está sendo excluída e só antes do prazo dos 30 dias.
 * O link aberto nunca chega aqui (a rota exige a sessão da dona). null quando
 * não há o que mostrar: sem linha, vencido, chave fora do espaço da reunião ou
 * objeto que já saiu do bucket. Outra falha do bucket lança.
 */
export async function lerDocumentoGuardado(ownerId: string, meetingId: string): Promise<Buffer | null> {
  const db = await exigirDb();
  const [linha] = await db.select({
    storageKey: meetingDocuments.storageKey, sizeBytes: meetingDocuments.sizeBytes, expiresAt: meetingDocuments.expiresAt, status: meetings.status, trashedAt: meetings.trashedAt,
  })
    .from(meetingDocuments)
    .innerJoin(meetings, and(eq(meetings.id, meetingDocuments.meetingId), eq(meetings.ownerId, meetingDocuments.ownerId)))
    .where(and(eq(meetingDocuments.meetingId, meetingId), eq(meetingDocuments.ownerId, ownerId)))
    .limit(1);
  // A da lixeira (H7d) não mostra o PDF, como a excluída.
  if (!linha || reuniaoForaDeVista(linha) || linha.expiresAt <= Date.now()) return null;
  if (!(linha.sizeBytes > 0 && linha.sizeBytes <= DOCUMENTO_BYTES_MAX)) return null;
  const chave = chaveDoStorageDaDona("meetings", ownerId, linha.storageKey);
  if (!chave || !chave.startsWith(`meetings/${ownerId}/${meetingId}/`)) return null;
  try {
    return await storageGetBytes(chave, DOCUMENTO_BYTES_MAX);
  } catch (erro) {
    if (erro instanceof ObjetoAusenteNoStorageError) return null;
    throw erro;
  }
}

/**
 * A chave do documento que dá para reprocessar, ou null: a linha tem de existir,
 * durar mais que o processamento inteiro (como o áudio, em chaveReprocessavel),
 * caber no teto e estar no espaço DESTA reunião DESTA dona no bucket.
 */
function chaveReprocessavel(documento: { storageKey: string; sizeBytes: number; expiresAt: number } | undefined, ownerId: string, meetingId: string): string | null {
  if (!documento) return null;
  if (documento.expiresAt <= Date.now() + LIMITE_PROCESSAMENTO_MS) return null;
  if (!(documento.sizeBytes > 0 && documento.sizeBytes <= DOCUMENTO_BYTES_MAX)) return null;
  const chave = chaveDoStorageDaDona("meetings", ownerId, documento.storageKey);
  return chave && chave.startsWith(`meetings/${ownerId}/${meetingId}/`) ? chave : null;
}

/**
 * O reprocesso da reunião de documento com falha (meetings.reprocess passa por
 * iniciarReprocessamento, em meeting-service.ts, que chama este): lê o PDF
 * guardado e refaz a leitura, sem gravar arquivo nem renovar os 30 dias. Toma a
 * reunião ('failed' → 'processing', com a ficha) e devolve logo; o trabalho
 * nunca rejeita. A falha que se repete com o mesmo arquivo
 * (falhaDoDocumentoSeRepete: o texto que não cabe numa resposta) é recusada
 * antes de tudo, com o código dela: reprocessar pagaria outra leitura para
 * falhar igual.
 */
export async function iniciarReprocessamentoDoDocumento(db: Banco, reuniao: {
  id: string; ownerId: string; updatedAt: number; language: string; processingError: string | null;
}): Promise<{ trabalho: Promise<void> }> {
  const { id: meetingId, ownerId } = reuniao;
  if (falhaDoDocumentoSeRepete(reuniao.processingError)) throw new ReprocessamentoRecusado("PRECONDITION_FAILED", reuniao.processingError);
  const [documento] = await db.select({ storageKey: meetingDocuments.storageKey, sizeBytes: meetingDocuments.sizeBytes, expiresAt: meetingDocuments.expiresAt })
    .from(meetingDocuments).where(and(eq(meetingDocuments.meetingId, meetingId), eq(meetingDocuments.ownerId, ownerId))).limit(1);
  const chave = chaveReprocessavel(documento, ownerId, meetingId);
  if (!chave) throw new ReprocessamentoRecusado("PRECONDITION_FAILED", MENSAGEM_SEM_DOCUMENTO_PARA_REPROCESSAR);

  const ficha = fichaDaExecucao(reuniao.updatedAt);
  // A reunião que foi para a lixeira (H7d) entre a leitura de quem chama e aqui
  // não é tomada: a tomada repete a regra, como a do áudio (meeting-service.ts).
  const tomada = await db.update(meetings).set({ status: "processing", processingError: null, updatedAt: ficha })
    .where(and(
      eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "failed"), eq(meetings.consentGranted, true), foraDaLixeira(),
    ));
  if (!linhasAlcancadas(tomada)) {
    const [agora] = await db.select({ status: meetings.status, trashedAt: meetings.trashedAt }).from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId))).limit(1);
    if (!agora || reuniaoForaDeVista(agora)) throw new ReprocessamentoRecusado("NOT_FOUND", MENSAGEM_REUNIAO_NAO_ENCONTRADA);
    throw new ReprocessamentoRecusado("CONFLICT", MENSAGEM_REPROCESSO_EM_CONFLITO);
  }

  const trabalho = (async () => {
    let bytes: Buffer;
    try {
      bytes = await storageGetBytes(chave, DOCUMENTO_BYTES_MAX);
    } catch (erro) {
      console.error("[Documento] não foi possível ler o PDF guardado:", erro instanceof Error ? erro.message : erro);
      const codigo: CodigoDaFalhaDoDocumento = erro instanceof ObjetoAusenteNoStorageError ? "DOCUMENTO_AUSENTE" : "DOCUMENTO_FALHOU";
      await db.update(meetings).set({ status: "failed", processingError: codigo, updatedAt: Date.now() })
        .where(and(eq(meetings.id, meetingId), eq(meetings.ownerId, ownerId), eq(meetings.status, "processing"), eq(meetings.updatedAt, ficha)));
      return;
    }
    await processarDocumento(db, { ownerId, meetingId, ficha, bytes, idioma: reuniao.language, limparAntes: true });
  })().catch(erro => console.error("[Documento] o reprocesso em segundo plano terminou com erro não tratado:", erro instanceof Error ? erro.message : erro));
  return { trabalho };
}
