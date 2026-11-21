import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

/**
 * Os prazos da leitura do documento (H12) com a chamada real ao Gemini
 * (geminiPost e gerarComArquivoNoGemini) e o relógio falso: a leitura tem de
 * desistir antes de a varredura de interrompidas dar a reunião como falha
 * (LIMITE_PROCESSAMENTO_MS, 15 min contados da ficha), com folga para o PDF que
 * o reprocesso lê do bucket. Passado disso, o texto lido e pago seria jogado
 * fora. Este arquivo NÃO fala com a internet: o fetch é trocado, o prazo de
 * cada chamada (AbortSignal.timeout) corre no relógio falso, e a chave é de
 * mentira.
 */
vi.mock("./_core/env", async original => {
  const real = await original<typeof import("./_core/env")>();
  return { ...real, ENV: { ...real.ENV, llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } };
});

const { FalhaDoDocumento, lerDocumentoComAIA, PIOR_CASO_DA_LEITURA_MS } = await import("./documento-da-reuniao");
const { LIMITE_PROCESSAMENTO_MS } = await import("@shared/const");

const MIN = 60_000;
const PDF = Buffer.from("%PDF-1.4\n% prazo\n%%EOF\n");
/** A folga que a leitura deixa antes da varredura: o PDF que o reprocesso lê do bucket, as gravações no banco. */
const FOLGA_MS = 2 * MIN;

type Passo = (sinal: AbortSignal) => Promise<Response>;
let roteiro: Passo[] = [];
let chamadas: Array<{ modelo: string; aos: number }> = [];
let inicio = 0;
let fetchOriginal: typeof globalThis.fetch;

/** O Gemini que nunca responde: a chamada só termina quando o prazo dela aborta. */
const nuncaResponde: Passo = sinal => new Promise((_responder, desistir) => {
  sinal.addEventListener("abort", () => desistir(sinal.reason), { once: true });
});
/** O Gemini que responde depois de `ms`, com o status dado (503: lotado). */
const respondeDepoisDe = (ms: number, status: number, corpo: unknown = { error: { code: status, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } }): Passo =>
  () => new Promise(responder => {
    setTimeout(() => responder(new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } })), ms);
  });
const LEITURA_CERTA = { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ paginas: [{ pagina: 1, texto: "Proposta." }] }) }] } }] };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  inicio = Date.now();
  roteiro = [];
  chamadas = [];
  fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    chamadas.push({ modelo: /\/models\/([^:]+):/.exec(String(entrada))?.[1] ?? "?", aos: Date.now() - inicio });
    const passo = roteiro[chamadas.length - 1];
    if (!passo) throw new Error("o teste não combinou esta chamada");
    return passo(init!.signal!);
  }) as typeof globalThis.fetch;
  // O prazo de cada chamada corre no relógio falso, como o resto.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controle = new AbortController();
    setTimeout(() => controle.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms);
    return controle.signal;
  });
  vi.stubEnv("LLM_AUDIO_MODEL", "gemini-3.5-flash");
  vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", "gemini-3.5-flash-lite");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Lê o PDF com o relógio andando 30 min: o que a leitura devolveu (ou a falha) e quando terminou. */
async function lerComORelogio() {
  let terminouAos = -1;
  const leitura = lerDocumentoComAIA(PDF, "pt-BR").then(
    paginas => { terminouAos = Date.now() - inicio; return paginas; },
    falha => { terminouAos = Date.now() - inicio; return falha as unknown; },
  );
  await vi.advanceTimersByTimeAsync(30 * MIN);
  return { resultado: await leitura, terminouAos };
}

const codigoDe = (resultado: unknown) => (resultado instanceof FalhaDoDocumento ? resultado.codigo : `não falhou: ${JSON.stringify(resultado)}`);

describe("a leitura do documento desiste antes da varredura de interrompidas", () => {
  it("o pior caso de conta cabe com folga nos 15 min da varredura", () => {
    expect(PIOR_CASO_DA_LEITURA_MS).toBeLessThanOrEqual(LIMITE_PROCESSAMENTO_MS - FOLGA_MS);
  });

  it("o Gemini que nunca responde: uma chamada só, abortada no prazo dela, sem nova tentativa nem reserva", async () => {
    roteiro = [nuncaResponde, nuncaResponde, nuncaResponde];
    const { resultado, terminouAos } = await lerComORelogio();
    expect(codigoDe(resultado)).toBe("IA_INDISPONIVEL");
    expect(chamadas).toEqual([{ modelo: "gemini-3.5-flash", aos: 0 }]);
    expect(terminouAos).toBe(10 * MIN);
    expect(terminouAos).toBeLessThanOrEqual(LIMITE_PROCESSAMENTO_MS - FOLGA_MS);
  });

  it("o pior caso: a falha passageira logo antes do fim do orçamento, e a chamada seguinte estourando o prazo", async () => {
    roteiro = [respondeDepoisDe(2 * MIN - 1000, 503), nuncaResponde, nuncaResponde];
    const { resultado, terminouAos } = await lerComORelogio();
    expect(codigoDe(resultado)).toBe("IA_INDISPONIVEL");
    // A nova tentativa no mesmo modelo, depois da espera de 2 s; a reserva já não entra.
    expect(chamadas).toEqual([{ modelo: "gemini-3.5-flash", aos: 0 }, { modelo: "gemini-3.5-flash", aos: 2 * MIN + 1000 }]);
    expect(terminouAos).toBe(12 * MIN + 1000);
    expect(terminouAos).toBeLessThanOrEqual(PIOR_CASO_DA_LEITURA_MS);
    expect(terminouAos).toBeLessThanOrEqual(LIMITE_PROCESSAMENTO_MS - FOLGA_MS);
  });

  it("o principal lotado logo no começo: a reserva entra, e a leitura dá certo", async () => {
    roteiro = [respondeDepoisDe(0, 503), respondeDepoisDe(0, 503), respondeDepoisDe(0, 503), respondeDepoisDe(0, 200, LEITURA_CERTA)];
    const { resultado } = await lerComORelogio();
    expect(resultado).toEqual([{ pagina: 1, texto: "Proposta." }]);
    expect(chamadas.map(chamada => chamada.modelo)).toEqual(["gemini-3.5-flash", "gemini-3.5-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"]);
    // As esperas de 2 e 5 s entre as tentativas; a reserva começa logo, bem antes dos 2 min.
    expect(chamadas[3].aos).toBeLessThan(10_000);
  });

  it("o principal lotado só depois de 2 min: a reserva, que começaria tarde, não entra", async () => {
    roteiro = [respondeDepoisDe(50_000, 503), respondeDepoisDe(58_000, 503), respondeDepoisDe(15_000, 503), respondeDepoisDe(0, 200, LEITURA_CERTA)];
    const { resultado, terminouAos } = await lerComORelogio();
    expect(codigoDe(resultado)).toBe("IA_INDISPONIVEL");
    expect(chamadas).toEqual([
      { modelo: "gemini-3.5-flash", aos: 0 },
      { modelo: "gemini-3.5-flash", aos: 52_000 },
      { modelo: "gemini-3.5-flash", aos: 115_000 },
    ]);
    expect(terminouAos).toBe(130_000);
  });
});
