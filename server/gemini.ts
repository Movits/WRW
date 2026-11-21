import { ENV } from "./_core/env";
import { IDIOMA_DA_REUNIAO_PADRAO, idiomaDaReuniao, nomeDoIdioma } from "@shared/idioma-da-reuniao";
import { modeloDeAudio, modeloDeAudioReserva } from "./_core/modelos-de-ia";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_MODEL = "gemini-embedding-001";
// Os modelos da transcrição, o principal (LLM_AUDIO_MODEL) e a reserva
// (LLM_AUDIO_MODEL_RESERVA), vêm de _core/modelos-de-ia.ts, já passados pela
// guarda do modelo concreto. Os padrões e o porquê de cada um estão lá.

// "High demand" (503), rate limit (429) e soluço interno (500) são passageiros
// por definição — o Google manda literalmente "try again later". Desistir na
// primeira resposta dessas era o que estourava o erro cru na cara da usuária.
const STATUS_PASSAGEIROS = new Set([429, 500, 503]);
const ESPERAS_MS = [2000, 5000];
// O submit da reunião é uma requisição síncrona atrás do proxy do Render
// (~100s): cada chamada tem teto próprio e as retentativas têm um orçamento
// total — retentar além disso só trocaria um erro claro por um timeout mudo,
// com o servidor ainda trabalhando e a usuária sem resposta.
const TIMEOUT_POR_CHAMADA_MS = 40_000;
const ORCAMENTO_RETENTATIVAS_MS = 50_000;
const espera = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class GeminiIndisponivelError extends Error {
  constructor(readonly status: number, mensagem?: string) {
    super(mensagem ?? `O serviço de IA está com alta demanda neste momento (${status}). Aguarde alguns instantes e tente de novo.`);
  }
}

// 429 de COTA ("exceeded your current quota... free_tier_requests, limit: 20")
// não é pico: é o limite gratuito diário do modelo, e retentar só queima tempo.
// O caminho certo é pular direto para o modelo reserva — cota separada — e,
// se as duas se esgotarem, dizer a verdade: renova em algumas horas.
export class GeminiCotaEsgotadaError extends GeminiIndisponivelError {
  constructor() {
    super(429, "O limite de uso gratuito do serviço de IA foi atingido. Ele renova sozinho (em minutos, se for o limite por minuto; em algumas horas, se for o diário). Para uso contínuo, ative o faturamento da chave do Google.");
  }
}

// Recusa que não é sobrecarga (400 payload errado, 401/403 chave inválida,
// 404 modelo inexistente): não melhora repetindo nem trocando de modelo. A
// mensagem é para a dona da reunião — ela vai parar em `processing_error` e
// na caixa vermelha da tela; o JSON do Google (que cita "API key", o nome do
// modelo, o endpoint) fica só no log, para quem for diagnosticar. O começo dele
// fica também em `detalhe`, que nunca vai à tela nem ao banco: quem chama o lê
// para escolher o código do erro (o vídeo do YouTube privado é um 400 como o
// pedido malformado; server/youtube.ts separa um do outro por ele).
export class GeminiRecusouChamadaError extends GeminiIndisponivelError {
  constructor(status: number, readonly detalhe = "") {
    super(status, `O serviço de IA recusou a chamada (HTTP ${status}). Avise o suporte.`);
  }
}

const pareceCotaEsgotada = (detalhe: string) =>
  /exceeded your current quota|free_tier_requests|RESOURCE_EXHAUSTED/i.test(detalhe);

/**
 * O Gemini desistiu dentro do prazo dele: HTTP 504, DEADLINE_EXCEEDED ("Deadline
 * expired before operation could complete."), que a documentação de erros da
 * Google dá para a entrada grande demais para o tempo da chamada. Como não é
 * 429, 500 nem 503, o geminiPost o devolve como GeminiRecusouChamadaError, mas
 * ele não é recusa do pedido nem do conteúdo: quem escolhe o código do erro
 * para a tela o trata como IA indisponível, ANTES do ramo da recusa (sem isso,
 * o vídeo público de 1 h virava "vídeo privado", e o PDF longo, "a IA recusou").
 */
export function prazoEsgotadoNoGemini(erro: unknown): boolean {
  return erro instanceof GeminiRecusouChamadaError && (erro.status === 504 || /DEADLINE_EXCEEDED|Deadline expired/i.test(erro.detalhe));
}

function getGeminiKey() {
  // Mesma cadeia de fallback do resto do app (LLM_API_KEY > chaves legadas >
  // GOOGLE_API_KEY). Ler só GOOGLE_API_KEY quebrava embeddings e transcrição em
  // produção, onde a chave é configurada como LLM_API_KEY.
  const key = ENV.llmApiKey;
  if (!key) throw new Error("Chave do LLM não configurada. Defina LLM_API_KEY (ou GOOGLE_API_KEY) no ambiente.");
  return key;
}

type OpcoesDaChamada = { timeoutMs?: number; orcamentoMs?: number };

// Exportada para o vídeo do YouTube (server/youtube.ts), que manda a URL do
// vídeo (file_data) em vez dos bytes e tem prazos próprios.
export async function geminiPost<T>(path: string, body: unknown, tentativas = ESPERAS_MS.length + 1, opcoes: OpcoesDaChamada = {}): Promise<T> {
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_POR_CHAMADA_MS;
  const orcamentoMs = opcoes.orcamentoMs ?? ORCAMENTO_RETENTATIVAS_MS;
  // Falta de chave é erro de configuração, não de rede: sai antes do laço —
  // retentar não faria a chave aparecer.
  const chave = getGeminiKey();
  const inicio = Date.now();
  let ultimoStatus = 503;
  for (let tentativa = 0; tentativa < tentativas; tentativa++) {
    if (tentativa > 0) {
      if (Date.now() - inicio > orcamentoMs) break;
      await espera(ESPERAS_MS[Math.min(tentativa - 1, ESPERAS_MS.length - 1)]);
    }
    let response: Response;
    try {
      response = await fetch(`${GEMINI_BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (erro) {
      // Chamada que estourou o teto ou caiu na rede conta como passageira —
      // mas dentro do mesmo orçamento, para o request não morrer no proxy.
      ultimoStatus = 504;
      console.warn(`[Gemini] chamada a ${path} falhou (tentativa ${tentativa + 1}/${tentativas}):`, erro instanceof Error ? erro.message : erro);
      continue;
    }
    if (response.ok) return response.json() as Promise<T>;
    const details = await response.text();
    // Erro que não é de sobrecarga (chave inválida, payload errado...) não
    // melhora repetindo: sai na hora. O detalhe vai ao LOG, não à mensagem —
    // ela acaba gravada em processing_error e mostrada na tela da dona.
    if (!STATUS_PASSAGEIROS.has(response.status)) {
      console.error(`[Gemini] ${response.status} em ${path} (não passageiro): ${details.slice(0, 400)}`);
      throw new GeminiRecusouChamadaError(response.status, details.slice(0, 400));
    }
    // Cota esgotada não é pico: repetir no mesmo modelo só queima tempo. Sai
    // já — na transcrição, é o que aciona o modelo reserva de imediato.
    if (response.status === 429 && pareceCotaEsgotada(details)) {
      console.warn(`[Gemini] cota esgotada em ${path}: ${details.slice(0, 200)}`);
      throw new GeminiCotaEsgotadaError();
    }
    ultimoStatus = response.status;
    console.warn(`[Gemini] ${response.status} em ${path} (tentativa ${tentativa + 1}/${tentativas}): ${details.slice(0, 200)}`);
  }
  throw new GeminiIndisponivelError(ultimoStatus);
}

export async function embedWithGemini(text: string, taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY" = "RETRIEVAL_DOCUMENT") {
  const payload = await geminiPost<{ embedding?: { values?: number[] } }>(`/models/${EMBEDDING_MODEL}:embedContent`, {
    model: `models/${EMBEDDING_MODEL}`,
    taskType,
    outputDimensionality: 768,
    content: { parts: [{ text: text.slice(0, 20_000) }] },
  });
  const vector = payload.embedding?.values;
  if (!Array.isArray(vector) || vector.length !== 768) throw new Error("Gemini não retornou um embedding de 768 dimensões.");
  return vector;
}

// O limite do plano do Gemini conta REQUISIÇÕES por minuto, não textos: um
// lote inteiro numa chamada de batchEmbedContents custa 1 requisição, enquanto
// indexar documento a documento custava N — era isso que estourava o ritmo na
// primeira indexação de uma base grande. O teto de textos por lote fica com
// quem chama (a indexação da memória usa lotes pequenos, com pausa entre eles).
export async function embedManyWithGemini(texts: string[], taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY" = "RETRIEVAL_DOCUMENT"): Promise<number[][]> {
  if (!texts.length) return [];
  const payload = await geminiPost<{ embeddings?: Array<{ values?: number[] }> }>(`/models/${EMBEDDING_MODEL}:batchEmbedContents`, {
    requests: texts.map(text => ({
      model: `models/${EMBEDDING_MODEL}`,
      taskType,
      outputDimensionality: 768,
      content: { parts: [{ text: text.slice(0, 20_000) }] },
    })),
  });
  const vectors = payload.embeddings?.map(item => item.values);
  if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(vector => !Array.isArray(vector) || vector.length !== 768)) {
    throw new Error("Gemini não retornou um embedding de 768 dimensões para cada texto do lote.");
  }
  return vectors as number[][];
}

type RespostaGeracao = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };

/**
 * `language` é o código que veio da tela ou do banco ('pt', 'pt-BR', 'en-US'...).
 * O prompt leva o NOME do idioma (nomeDoIdioma), e a resposta devolve o código
 * normalizado, que é o que se grava. Sem idioma, ou com um fora da lista, o
 * prompt não pede idioma e o código devolvido é o padrão (pt-BR).
 */
export async function transcribeWithGemini(input: { audio: Buffer; mimeType: string; language?: string }) {
  const idioma = idiomaDaReuniao(input.language);
  const languageInstruction = idioma ? ` O idioma predominante esperado é ${nomeDoIdioma(idioma)}.` : "";
  const geminiMimeType = input.mimeType === "audio/mpeg" ? "audio/mp3" : input.mimeType === "audio/m4a" ? "audio/mp4" : input.mimeType;
  const corpo = {
    contents: [{ parts: [
      { text: `Transcreva integralmente a fala deste áudio de reunião. Preserve nomes próprios, empresas, números, telefones e e-mails. Retorne somente a transcrição em texto, sem resumo e sem comentários.${languageInstruction}` },
      { inline_data: { mime_type: geminiMimeType, data: input.audio.toString("base64") } },
    ] }],
    generationConfig: { temperature: 0 },
  };

  const modelo = modeloDeAudio();
  let payload: RespostaGeracao;
  try {
    payload = await geminiPost<RespostaGeracao>(`/models/${modelo}:generateContent`, corpo);
  } catch (erro) {
    // O modelo de áudio seguiu lotado depois das retentativas: uma última
    // cartada no modelo reserva antes de devolver o erro para a usuária.
    // Recusa (4xx) não é lotação: a reserva receberia a mesma chave inválida
    // ou o mesmo payload recusado — sai na hora, sem o upload inútil.
    if (!(erro instanceof GeminiIndisponivelError) || erro instanceof GeminiRecusouChamadaError) throw erro;
    const reserva = modeloDeAudioReserva();
    // Reserva igual ao principal seria um 4º upload idêntico no mesmo modelo
    // lotado — sem valor nenhum.
    if (reserva === modelo) throw erro;
    console.warn(`[Gemini] ${modelo} sobrecarregado; tentando a reserva ${reserva}`);
    try {
      payload = await geminiPost<RespostaGeracao>(`/models/${reserva}:generateContent`, corpo, 1);
    } catch (erroDaReserva) {
      console.warn(`[Gemini] a reserva ${reserva} também falhou:`, erroDaReserva instanceof Error ? erroDaReserva.message : erroDaReserva);
      throw erro;
    }
  }

  const text = payload.candidates?.flatMap(candidate => candidate.content?.parts ?? []).map(part => part.text ?? "").join("\n").trim();
  if (!text) throw new Error("O Gemini não retornou uma transcrição válida.");
  return { text, language: idioma ?? IDIOMA_DA_REUNIAO_PADRAO, segments: [] as Array<unknown> };
}

/**
 * A resposta do modelo parou antes do fim (MAX_TOKENS, SAFETY, RECITATION...).
 * Na transcrição, texto cortado gravado como se fosse inteiro seria perda
 * silenciosa: quem chama trata como falha e tenta de novo. O motivo vai no log;
 * a mensagem é para a tela da dona.
 */
export class GeminiRespostaCortadaError extends Error {
  constructor(readonly motivo: string) {
    super("A transcrição de uma parte do áudio saiu incompleta. Tente de novo em instantes.");
  }
}

type RespostaComFim = {
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
};

// O raciocínio conta DENTRO do teto de saída: num áudio de 38 min o
// gemini-3.5-flash gastou 62,9 mil tokens pensando, só 2,6 mil escrevendo, e
// parou em MAX_TOKENS (14/11/2026). Transcrever não pede raciocínio: o
// orçamento é fixo e baixo. A família 3 usa o nível; a 2.x, o orçamento em
// tokens (que a 3 ainda aceita, mas o nível é o caminho documentado).
export function raciocinioBaixo(modelo: string): Record<string, string | number> {
  return /^gemini-[3-9]/.test(modelo) ? { thinkingLevel: "low" } : { thinkingBudget: 512 };
}

// Uma parte de ~10 min sai em segundo plano (a fila da reunião em partes), sem
// o proxy de 100 s do Render na frente: cada chamada tem até 5 min, e as
// retentativas até 8.
const TIMEOUT_DA_PARTE_MS = 5 * 60_000;
const ORCAMENTO_DA_PARTE_MS = 8 * 60_000;
const SAIDA_MAXIMA_DA_PARTE = 32_768;

/**
 * O teto de um arquivo inline numa chamada ao Gemini: 50 MB por arquivo, inline
 * ou pela File API (documentação de documentos da Google, lida em 18/11/2026).
 * Quem chama gerarComArquivoNoGemini passa o próprio teto, que nunca passa
 * deste.
 */
export const TETO_INLINE_DO_GEMINI_BYTES = 50 * 1000 * 1000;

/**
 * O teto do áudio inline: o tamanho máximo de uma parte da gravação em partes
 * (TAMANHO_MAXIMO_DA_PARTE, em server/fatias-de-reuniao.ts, que a rota das
 * partes já confere). Fica escrito aqui para gemini.ts não importar o módulo
 * das partes, que traz banco e bucket; um teste confere que os dois batem.
 */
export const TETO_INLINE_DO_AUDIO_BYTES = 16 * 1024 * 1024;

/**
 * O arquivo passou do teto inline de quem chamou (ou está vazio): recusado
 * ANTES de sair do servidor, sem gastar a chamada nem o envio de megabytes que
 * a Google recusaria. A mensagem é para o log.
 */
export class ArquivoForaDoTetoDoGeminiError extends Error {
  constructor(readonly bytes: number, readonly teto: number) {
    super(`O arquivo de ${bytes} bytes está fora do teto de ${teto} bytes da chamada ao Gemini.`);
    this.name = "ArquivoForaDoTetoDoGeminiError";
  }
}

/**
 * A resposta terminou (STOP) sem texto nenhum fora do raciocínio. A frase é a
 * de sempre da transcrição; o documento (server/documento-da-reuniao.ts)
 * reconhece a classe e grava o código dele.
 */
export class GeminiSemTextoError extends Error {
  constructor() {
    super("O Gemini não retornou uma transcrição válida.");
    this.name = "GeminiSemTextoError";
  }
}

/**
 * Uma chamada com um arquivo inline (áudio, PDF) e resposta, opcionalmente, em
 * JSON, no modelo multimodal (o do áudio, LLM_AUDIO_MODEL) e, se ele estiver
 * lotado, no reserva — a mesma cartada do transcribeWithGemini. Devolve o texto
 * das partes que não são raciocínio e o modelo que respondeu.
 *
 * - O arquivo vazio ou acima de `tetoInlineBytes` (nunca acima de
 *   TETO_INLINE_DO_GEMINI_BYTES) é recusado antes de qualquer chamada
 *   (ArquivoForaDoTetoDoGeminiError).
 * - Resposta que não terminou em STOP lança GeminiRespostaCortadaError, com o
 *   motivo (MAX_TOKENS, SAFETY, RECITATION...): texto cortado nunca passa por
 *   inteiro.
 * - STOP sem texto lança GeminiSemTextoError.
 * - O raciocínio vai sempre no nível baixo (raciocinioBaixo), dentro do teto de
 *   saída; os prazos e o teto de saída vêm de quem chama, e o padrão é o da
 *   parte do áudio.
 * - `reservaSoAteMs`: a reserva só é tentada se o modelo principal desistiu
 *   antes desse tempo, contado do começo da chamada. Sem ele, a reserva vem
 *   sempre que o principal está lotado. Quem trabalha contra a varredura de
 *   interrompidas (o documento, em server/documento-da-reuniao.ts) o passa,
 *   como o vídeo do YouTube faz com RESERVA_SO_ATE_MS: a reserva que começa
 *   tarde passaria do prazo.
 */
export async function gerarComArquivoNoGemini(input: {
  bytes: Buffer;
  mimeType: string;
  prompt: string;
  esquemaJson?: unknown;
  tetoInlineBytes: number;
  saidaMaxima?: number;
  timeoutMs?: number;
  orcamentoMs?: number;
  reservaSoAteMs?: number;
}): Promise<{ texto: string; modelo: string }> {
  const teto = Math.min(input.tetoInlineBytes, TETO_INLINE_DO_GEMINI_BYTES);
  if (!input.bytes.length || input.bytes.length > teto) throw new ArquivoForaDoTetoDoGeminiError(input.bytes.length, teto);
  const dados = input.bytes.toString("base64");
  const corpo = (modelo: string) => ({
    contents: [{ parts: [
      { text: input.prompt },
      { inline_data: { mime_type: input.mimeType, data: dados } },
    ] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: input.saidaMaxima ?? SAIDA_MAXIMA_DA_PARTE,
      thinkingConfig: raciocinioBaixo(modelo),
      ...(input.esquemaJson ? { responseMimeType: "application/json", responseSchema: input.esquemaJson } : {}),
    },
  });
  const opcoes = { timeoutMs: input.timeoutMs ?? TIMEOUT_DA_PARTE_MS, orcamentoMs: input.orcamentoMs ?? ORCAMENTO_DA_PARTE_MS };
  const inicio = Date.now();
  let modelo = modeloDeAudio();
  let payload: RespostaComFim;
  try {
    payload = await geminiPost<RespostaComFim>(`/models/${modelo}:generateContent`, corpo(modelo), undefined, opcoes);
  } catch (erro) {
    if (!(erro instanceof GeminiIndisponivelError) || erro instanceof GeminiRecusouChamadaError) throw erro;
    const reserva = modeloDeAudioReserva();
    if (reserva === modelo) throw erro;
    if (input.reservaSoAteMs !== undefined && Date.now() - inicio >= input.reservaSoAteMs) {
      console.warn(`[Gemini] ${modelo} indisponível depois de ${Math.round((Date.now() - inicio) / 1000)} s; tarde demais para a reserva ${reserva}`);
      throw erro;
    }
    console.warn(`[Gemini] ${modelo} sobrecarregado; tentando a reserva ${reserva}`);
    try {
      payload = await geminiPost<RespostaComFim>(`/models/${reserva}:generateContent`, corpo(reserva), 1, opcoes);
      modelo = reserva;
    } catch (erroDaReserva) {
      console.warn(`[Gemini] a reserva ${reserva} também falhou:`, erroDaReserva instanceof Error ? erroDaReserva.message : erroDaReserva);
      throw erro;
    }
  }
  const candidato = payload.candidates?.[0];
  const motivo = candidato?.finishReason ?? "SEM_MOTIVO";
  const uso = payload.usageMetadata ?? {};
  if (motivo !== "STOP") {
    console.error(`[Gemini] ${modelo} parou em ${motivo} (saída ${uso.candidatesTokenCount ?? "?"}, raciocínio ${uso.thoughtsTokenCount ?? 0})`);
    throw new GeminiRespostaCortadaError(motivo);
  }
  const texto = (candidato?.content?.parts ?? []).filter(parte => !parte.thought).map(parte => parte.text ?? "").join("").trim();
  if (!texto) throw new GeminiSemTextoError();
  return { texto, modelo };
}

/**
 * A transcrição de uma parte da gravação em partes (server/transcricao-de-fatia.ts):
 * o áudio inline, com o teto da parte, pela chamada genérica.
 */
export async function gerarComAudioNoGemini(input: { audio: Buffer; mimeType: string; prompt: string; esquemaJson?: unknown }): Promise<{ texto: string; modelo: string }> {
  const geminiMimeType = input.mimeType === "audio/mpeg" ? "audio/mp3" : input.mimeType === "audio/m4a" ? "audio/mp4" : input.mimeType;
  return gerarComArquivoNoGemini({
    bytes: input.audio, mimeType: geminiMimeType, prompt: input.prompt, esquemaJson: input.esquemaJson,
    tetoInlineBytes: TETO_INLINE_DO_AUDIO_BYTES,
  });
}
