import { ENV } from "./_core/env";
import { escolhaDoIdioma, IDIOMA_AUTOMATICO, IDIOMA_DA_REUNIAO_PADRAO, idiomaFalado, nomeDoIdioma } from "@shared/idioma-da-reuniao";
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

// `opcoes` serve a quem tem pressa: a ordem da Memória na pergunta a várias
// reuniões (server/perguntar-a-varias-reunioes.ts) faz uma tentativa curta e,
// sem resposta, segue sem a ordem. Sem `opcoes`, as retentativas de sempre.
export async function embedWithGemini(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY" = "RETRIEVAL_DOCUMENT",
  opcoes: { tentativas?: number; timeoutMs?: number } = {},
) {
  const payload = await geminiPost<{ embedding?: { values?: number[] } }>(`/models/${EMBEDDING_MODEL}:embedContent`, {
    model: `models/${EMBEDDING_MODEL}`,
    taskType,
    outputDimensionality: 768,
    content: { parts: [{ text: text.slice(0, 20_000) }] },
  }, opcoes.tentativas, opcoes.timeoutMs === undefined ? {} : { timeoutMs: opcoes.timeoutMs });
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

// "Detectar sozinho" (G16) no envio único: a resposta vem em JSON, com a
// transcrição e o código do idioma que mais aparece na fala.
const ESQUEMA_DA_TRANSCRICAO_COM_IDIOMA = {
  type: "OBJECT",
  properties: {
    transcricao: { type: "STRING" },
    idioma: { type: "STRING", description: 'O código do idioma em que a maior parte da fala foi dita, como "pt", "en", "es", "it" ou "zh".' },
  },
  required: ["transcricao", "idioma"],
  propertyOrdering: ["transcricao", "idioma"],
} as const;

const INSTRUCAO_DO_IDIOMA_AUTOMATICO = " O idioma não foi informado: reconheça-o pela fala. A conversa pode ter mais de um idioma e mudar de idioma no meio; transcreva cada fala no idioma em que foi dita, sem traduzir.";

/** A resposta de "Detectar sozinho" (o JSON do ESQUEMA_DA_TRANSCRICAO_COM_IDIOMA): o texto e o idioma (o padrão, se ele não veio ou não é da lista). */
export function transcricaoComIdioma(resposta: string): { text: string; language: string } {
  let lida: { transcricao?: unknown; idioma?: unknown } | null;
  try {
    lida = JSON.parse(resposta) as typeof lida;
  } catch (erro) {
    throw new Error("O Gemini não retornou uma transcrição válida.", { cause: erro });
  }
  const text = typeof lida?.transcricao === "string" ? lida.transcricao.trim() : "";
  if (!text) throw new Error("O Gemini não retornou uma transcrição válida.");
  return { text, language: idiomaFalado(typeof lida?.idioma === "string" ? lida.idioma : null) ?? IDIOMA_DA_REUNIAO_PADRAO };
}

/**
 * `language` é o código que veio da tela ou do banco ('pt', 'pt-BR', 'en-US'...).
 * O prompt leva o NOME do idioma (nomeDoIdioma), e a resposta devolve o código
 * normalizado, que é o que se grava. Sem idioma, ou com um que a IA não
 * transcreve, o prompt não pede idioma e o código devolvido é o padrão (pt-BR).
 * Os idiomas falados (G16) são os 10 da tela e os outros que a IA transcreve.
 *
 * Com "Detectar sozinho" (G16, 'auto'), o prompt não diz o idioma e pede cada
 * fala no idioma em que foi dita; a resposta vem em JSON, com o código do
 * idioma que mais aparece, que é o que se grava (transcricaoComIdioma).
 */
export async function transcribeWithGemini(input: { audio: Buffer; mimeType: string; language?: string }) {
  const automatico = escolhaDoIdioma(input.language) === IDIOMA_AUTOMATICO;
  const idioma = automatico ? null : idiomaFalado(input.language);
  const languageInstruction = automatico ? INSTRUCAO_DO_IDIOMA_AUTOMATICO : idioma ? ` O idioma predominante esperado é ${nomeDoIdioma(idioma)}.` : "";
  const pedido = automatico
    ? 'Transcreva integralmente a fala deste áudio de reunião. Preserve nomes próprios, empresas, números, telefones e e-mails. Em "transcricao", somente a transcrição em texto, sem resumo e sem comentários; em "idioma", o código do idioma que mais aparece na fala.'
    : "Transcreva integralmente a fala deste áudio de reunião. Preserve nomes próprios, empresas, números, telefones e e-mails. Retorne somente a transcrição em texto, sem resumo e sem comentários.";
  const geminiMimeType = input.mimeType === "audio/mpeg" ? "audio/mp3" : input.mimeType === "audio/m4a" ? "audio/mp4" : input.mimeType;
  const corpo = {
    contents: [{ parts: [
      { text: `${pedido}${languageInstruction}` },
      { inline_data: { mime_type: geminiMimeType, data: input.audio.toString("base64") } },
    ] }],
    generationConfig: automatico
      ? { temperature: 0, responseMimeType: "application/json", responseSchema: ESQUEMA_DA_TRANSCRICAO_COM_IDIOMA }
      : { temperature: 0 },
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
  if (automatico) return { ...transcricaoComIdioma(text), segments: [] as Array<unknown> };
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

/**
 * A voz do Gemini (H19b, server/resumo-em-audio.ts): o texto vira fala com um
 * modelo de voz (TTS). A resposta é áudio cru, PCM de 16 bits, mono, na taxa
 * que o tipo diz ("audio/L16;codec=pcm;rate=24000"); quem chama converte em
 * MP3. Uma chamada por pedaço do texto, com as retentativas de sempre.
 */
export type FalaDoGemini = { pcm: Buffer; amostrasPorSegundo: number };

type RespostaDaVoz = { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> };

export class GeminiSemAudioError extends Error {
  constructor() {
    super("O modelo de voz não devolveu áudio.");
  }
}

/** A taxa do PCM pelo tipo que o Gemini manda; sem ela, 24 kHz (o que a documentação dá para os modelos de voz). */
export function taxaDoPcm(tipo: string | undefined): number {
  const taxa = Number(/rate=(\d+)/i.exec(tipo ?? "")?.[1]);
  return Number.isInteger(taxa) && taxa >= 8_000 && taxa <= 48_000 ? taxa : 24_000;
}

export async function falarComGemini(texto: string, modelo: string, voz: string): Promise<FalaDoGemini> {
  const resposta = await geminiPost<RespostaDaVoz>(`/models/${modelo}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: texto }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voz } } },
    },
  }, undefined, { timeoutMs: 60_000, orcamentoMs: 70_000 });
  const partes = resposta.candidates?.[0]?.content?.parts ?? [];
  const audio = partes.map(parte => parte.inlineData).filter(dado => dado?.data);
  if (!audio.length) throw new GeminiSemAudioError();
  const amostrasPorSegundo = taxaDoPcm(audio[0]?.mimeType);
  const pcm = Buffer.concat(audio.map(dado => Buffer.from(dado!.data!, "base64")));
  // Amostra de 16 bits: um byte solto no fim seria ruído.
  return { pcm: pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm, amostrasPorSegundo };
}

/**
 * A busca na web com o Gemini (H4i, server/complemento-pela-busca.ts): a
 * ferramenta google_search ("Grounding with Google Search"). Devolve o texto e
 * o que a busca usou: as consultas e as páginas (o endereço é o de
 * redirecionamento da Google, que leva à página).
 */
export type RespostaDaBusca = { texto: string; consultas: string[]; fontes: Array<{ url: string; titulo: string | null }> };

type RespostaComBusca = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    groundingMetadata?: {
      webSearchQueries?: unknown;
      groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>;
      groundingSupports?: Array<{ groundingChunkIndices?: unknown }>;
    };
  }>;
};

export async function buscarComGemini(prompt: string, modelo: string): Promise<RespostaDaBusca> {
  const resposta = await geminiPost<RespostaComBusca>(`/models/${modelo}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2_048, thinkingConfig: raciocinioBaixo(modelo) },
  }, undefined, { timeoutMs: 45_000, orcamentoMs: 55_000 });
  const candidato = resposta.candidates?.[0];
  const texto = (candidato?.content?.parts ?? []).filter(parte => !parte.thought && typeof parte.text === "string").map(parte => parte.text).join("").trim();
  const meta = candidato?.groundingMetadata;
  const consultas = Array.isArray(meta?.webSearchQueries) ? meta.webSearchQueries.filter((q): q is string => typeof q === "string") : [];
  const pedacos = meta?.groundingChunks ?? [];
  // As páginas que sustentam o texto primeiro (groundingSupports), depois as outras.
  const usados = new Set<number>();
  for (const apoio of meta?.groundingSupports ?? []) {
    if (Array.isArray(apoio.groundingChunkIndices)) for (const i of apoio.groundingChunkIndices) if (typeof i === "number") usados.add(i);
  }
  const ordem = [...Array.from(usados), ...pedacos.map((_p, i) => i).filter(i => !usados.has(i))];
  const fontes: RespostaDaBusca["fontes"] = [];
  for (const i of ordem) {
    const web = pedacos[i]?.web;
    if (web && typeof web.uri === "string") fontes.push({ url: web.uri, titulo: typeof web.title === "string" ? web.title : null });
  }
  return { texto, consultas, fontes };
}
