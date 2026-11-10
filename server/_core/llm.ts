import { ENV } from "./env";
import { modeloDeTexto } from "./modelos-de-ia";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  model?: string;
  thinking?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  /**
   * Temperatura da amostragem. Sem ela, o provedor usa o padrão dele e a mesma
   * pergunta volta com respostas diferentes — foi o que fez o mesmo anúncio
   * receber notas de confiança 88, 75 e 75 no reteste v4. Quem precisa de
   * resposta estável (classificação, nota, extração) manda 0. Quem não informa
   * continua sem o campo no corpo: o comportamento não muda.
   */
  temperature?: number;
  /**
   * Semente da amostragem, para os provedores compatíveis que a aceitam. Só
   * sobe quando informada, pelo mesmo motivo: um campo desconhecido a mais no
   * corpo é 400 em algumas implementações da API compatível com a OpenAI.
   */
  seed?: number;
  /** Teto de cada tentativa HTTP (padrão 60 s). */
  timeoutMs?: number;
  /** Orçamento total, tentativas e esperas incluídas (padrão 120 s). */
  orcamentoMs?: number;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const resolveApiUrl = () => {
  if (ENV.llmApiUrl && ENV.llmApiUrl.trim().length > 0) {
    const base = ENV.llmApiUrl.replace(/\/$/, "");
    // Bases OpenAI-compatíveis (ex.: Gemini .../v1beta/openai) já incluem o
    // prefixo de versão; só falta o caminho do recurso.
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  // O fallback antigo era o forge.manus.im — que morreu com o Manus. Chamar um
  // host morto vira um erro de rede obscuro minutos depois; falhar aqui, com
  // nome de variável, é diagnosticável em segundos. Todo chamador de invokeLLM
  // já trata exceção (é o mesmo caminho de "sem chave configurada").
  throw new Error(
    "LLM_API_URL não definida. Aponte para um endpoint compatível com a API da " +
      "OpenAI — ex.: https://generativelanguage.googleapis.com/v1beta/openai",
  );
};

const assertApiKey = () => {
  if (!ENV.llmApiKey) {
    throw new Error(
      "Nenhuma chave de LLM configurada. Defina LLM_API_KEY (ou GOOGLE_API_KEY) no .env"
    );
  }
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

const RETRY_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;

// Sem teto, um upstream que aceita a conexão e nunca responde só é derrubado
// pelo headersTimeout do Node (300 s) — vezes 5 tentativas com backoff, a
// mutation ficava presa por ~25 min com a tela em "pensando". Cada tentativa
// tem um teto e o conjunto (esperas incluídas) tem um orçamento; quem chama
// pode apertar os dois (o chat usa 15 s / 35 s).
const TIMEOUT_PADRAO_MS = 60_000;
const ORCAMENTO_PADRAO_MS = 120_000;

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type Limites = { timeoutMs: number; orcamentoMs: number };

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

// O teto de cada chamada. É um AbortController com setTimeout, e não
// AbortSignal.timeout(), de propósito: o relógio interno do AbortSignal não
// obedece aos timers falsos do Vitest, e o comportamento precisa ser testável
// sem esperar segundos de verdade. O sinal avisa o fetch para soltar a
// conexão; a corrida garante a rejeição mesmo que ele demore a obedecer. O
// timer é limpo ao terminar, para não segurar o processo.
//
// O CORPO é lido aqui dentro, e não por quem chama: `fetch` resolve assim que
// os cabeçalhos chegam, e um upstream que responde 200 e nunca fecha o corpo
// deixava o `response.json()` de fora do teto, preso até o bodyTimeout do
// undici (300 s), sem retentativa. Com o corpo consumido antes de o timer ser
// limpo, o teto vale até o último byte, e o abort cancela a leitura. O que
// sai é uma Response nova com o corpo já em memória: `fetchWithBackoff` e
// `invokeLLM` continuam lendo `.ok`, `.status`, `.headers`, `.text()` e
// `.json()` como antes.
const fetchComTeto = async (url: string, init: FetchInit, timeoutMs: number): Promise<Response> => {
  const controlador = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => {
      const motivo = new Error(`LLM sem resposta em ${Math.round(timeoutMs / 1000)}s`);
      controlador.abort(motivo);
      rejeitar(motivo);
    }, timeoutMs);
  });
  const cabecalhosECorpo = async () => {
    const response = await fetch(url, { ...init, signal: controlador.signal });
    const corpo = await response.text();
    // Status sem corpo (204, 304...) recusa até a string vazia no construtor.
    return new Response(corpo.length ? corpo : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  };
  try {
    return await Promise.race([cabecalhosECorpo(), teto]);
  } finally {
    clearTimeout(timer);
  }
};

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

// Equal-jitter exponential backoff. The cap/2 floor guarantees a minimum
// delay so a misbehaving caller loop slows down instead of hammering the
// upstream while it keeps returning errors.
const computeBackoffDelay = (
  attempt: number,
  retryAfterMs?: number
): number => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
};

// Retries non-2xx responses and network errors (timeouts included) with
// exponential backoff, then returns the final Response so callers keep their
// existing error handling. Stops early when the next attempt would not fit in
// the total budget.
const fetchWithBackoff = async (
  url: string,
  init: FetchInit,
  limites: Limites = { timeoutMs: TIMEOUT_PADRAO_MS, orcamentoMs: ORCAMENTO_PADRAO_MS }
): Promise<Response> => {
  const inicio = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_MAX_RETRIES; attempt++) {
    let response: Response | null = null;
    let retryAfterMs: number | undefined;
    try {
      response = await fetchComTeto(url, init, limites.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_MAX_RETRIES) throw error;
    }
    if (response) {
      if (response.ok || attempt === RETRY_MAX_RETRIES) return response;
      retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    }

    // Antes de dormir: se a espera mais uma tentativa inteira não cabem no
    // orçamento, retentar só trocaria um erro claro agora por um silêncio
    // mais longo — devolve o que tem (a resposta com erro, ou a falha).
    const atraso = computeBackoffDelay(attempt, retryAfterMs);
    if (Date.now() - inicio + atraso + limites.timeoutMs > limites.orcamentoMs) {
      if (response) return response;
      throw lastError;
    }

    if (response) {
      try {
        await response.body?.cancel();
      } catch {
        // Body already settled; nothing to clean up.
      }
      console.warn(
        `LLM request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after status ${response.status}`
      );
    } else {
      console.warn(
        `LLM request retry ${attempt + 1}/${RETRY_MAX_RETRIES} after network error`
      );
    }
    await sleep(atraso);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("LLM request failed after exhausting retries");
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  assertApiKey();

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    thinking,
    reasoning,
    temperature,
    seed,
    maxTokens,
    max_tokens,
    timeoutMs = TIMEOUT_PADRAO_MS,
    orcamentoMs = ORCAMENTO_PADRAO_MS,
  } = params;

  const payload: Record<string, unknown> = {
    messages: messages.map(normalizeMessage),
  };

  // LLM_MODEL redireciona todos os modelos herdados do proxy Manus (gpt-*, etc.)
  // para o provedor configurado no .env. O default garante que o payload sempre
  // leve um modelo: a API OpenAI-compatível do Gemini rejeita requisições sem o
  // campo `model` com 400 — foi o que derrubou FAQ, matches e compliance em
  // produção quando LLM_MODEL não estava definida. Modelo concreto, não o alias
  // gemini-flash-latest: o alias resolve para um modelo com cota gratuita de 20
  // requisições por dia, que esgota em minutos de uso real. Por isso o nome
  // passa pela guarda de modelos-de-ia.ts, que recusa alias e usa o padrão.
  const resolvedModel = modeloDeTexto(model);
  payload.model = resolvedModel;

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }

  if (thinking) {
    payload.thinking = thinking;
  }
  if (reasoning) {
    payload.reasoning = reasoning;
  }

  // `typeof === "number"` e não um truthy: temperature 0 e seed 0 são os
  // valores mais úteis dos dois, e um `if (temperature)` os descartaria.
  if (typeof temperature === "number") {
    payload.temperature = temperature;
  }
  if (typeof seed === "number") {
    payload.seed = seed;
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const response = await fetchWithBackoff(resolveApiUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.llmApiKey}`,
    },
    body: JSON.stringify(payload),
  }, { timeoutMs, orcamentoMs });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `LLM invoke failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as InvokeResult;
}

export type ModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ModelsResponse = {
  object: string;
  data: ModelInfo[];
};

export async function listLLMModels(): Promise<ModelsResponse> {
  assertApiKey();

  if (!ENV.llmApiUrl || ENV.llmApiUrl.trim().length === 0) {
    // Mesmo motivo do resolveApiUrl acima: o fallback era o forge morto.
    throw new Error("LLM_API_URL não definida.");
  }
  const url = `${ENV.llmApiUrl.replace(/\/$/, "")}/v1/models`;

  const response = await fetchWithBackoff(url, {
    headers: { authorization: `Bearer ${ENV.llmApiKey}` },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `List LLM models failed: ${response.status} ${response.statusText} – ${errorText}`
    );
  }

  return (await response.json()) as ModelsResponse;
}
