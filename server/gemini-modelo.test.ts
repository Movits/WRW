import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as listarModelosMod from "../scripts/listar-modelos-gemini.mjs";

/**
 * Modelo de IA concreto, nunca alias (regra do CLAUDE.md da raiz).
 *
 * O modelo da transcrição (LLM_AUDIO_MODEL), o da reserva
 * (LLM_AUDIO_MODEL_RESERVA) e o das chamadas de texto (LLM_MODEL) passam pela
 * guarda de server/_core/modelos-de-ia.ts. Ausente ou vazio ("", como no
 * .env.example) usa o padrão em silêncio; só espaços, qualquer id com "latest"
 * e id sem número de versão são recusados, com aviso no log uma vez por origem
 * e valor, e o padrão assume. O áudio, que vai sempre à API do Gemini com o id
 * na URL, também recusa todo id fora do formato gemini-<versão>; o texto aceita
 * id de outro provedor compatível com a OpenAI. O boot imprime os modelos que
 * valem, sem a chave, e scripts/listar-modelos-gemini.mjs lista o que a chave
 * enxerga.
 *
 * O fetch é dublado em tudo: nada aqui sai para a internet.
 */

// Dublês de chave sem o formato de uma chave do Google: com ele, a varredura
// de segredos do /abrir-pr e a proteção de push do GitHub os tomariam por
// chave de verdade.
const CHAVE_FALSA = "chave-falsa-que-nunca-pode-aparecer";
const VARIAVEIS_DE_MODELO = ["LLM_AUDIO_MODEL", "LLM_AUDIO_MODEL_RESERVA", "LLM_MODEL"];

let fetchFalso: ReturnType<typeof vi.fn>;
let avisos: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Módulos novos a cada teste: o aviso de recusa sai uma vez por valor e por
  // processo, e o ENV de _core/env.ts é lido na importação.
  vi.resetModules();
  // O .env de quem roda a suíte não decide o teste: cada caso diz o que vale.
  for (const nome of VARIAVEIS_DE_MODELO) vi.stubEnv(nome, undefined);
  vi.stubEnv("LLM_API_KEY", CHAVE_FALSA);
  vi.stubEnv("GOOGLE_API_KEY", undefined);
  vi.stubEnv("LLM_API_URL", "https://ia.teste.local/v1beta/openai");
  fetchFalso = vi.fn();
  vi.stubGlobal("fetch", fetchFalso);
  avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const modelosDeIa = () => import("./_core/modelos-de-ia");
const textoDosAvisos = () => avisos.mock.calls.map(argumentos => argumentos.map(String).join(" ")).join("\n");
const urlDaChamada = (n: number) => String(fetchFalso.mock.calls[n][0]);

const audio = { audio: Buffer.from("bytes-de-teste"), mimeType: "audio/wav" };
const respostaTranscricao = (texto: string) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: texto }] } }] }),
});
// O 429 de cota do plano gratuito: pula as retentativas e vai direto à reserva.
const resposta429Cota = () => ({
  ok: false, status: 429,
  text: async () => '{"error":{"code":429,"message":"You exceeded your current quota... generate_content_free_tier_requests, limit: 20"}}',
});

describe("a guarda do áudio: só id do Gemini, no formato gemini-<versão>", () => {
  it.each(["gemini-3.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-2.0-flash-001", "gemini-3-pro-preview"])(
    "%s passa",
    async id => {
      const { ehModeloDeAudioConcreto } = await modelosDeIa();
      expect(ehModeloDeAudioConcreto(id)).toBe(true);
    }
  );

  it.each([
    ["gemini-flash-latest", "alias -latest"],
    ["gemini-2.5-flash-latest", "tem versão, mas é -latest"],
    ["gemini-latest", "só latest"],
    ["gemini-pro", "nome de família, sem versão"],
    ["gemini-flash", "nome de família, sem versão"],
    ["gemini-flash-lite", "nome de família, sem versão"],
    ["", "vazio"],
    ["models/gemini-3.5-flash", "com o prefixo models/"],
    ["Gemini-3.5-Flash", "maiúsculas"],
    ["gemini-3.5-flash/../../files", "outro caminho na URL da API"],
    ["gemini-3.5-flash:streamGenerateContent", "outro método na URL da API"],
    ["gpt-4o", "outro provedor"],
    ["gpt-4o-2024-08-06", "outro provedor, com versão: o áudio vai sempre ao Gemini"],
  ])("%s é recusado (%s)", async id => {
    const { ehModeloDeAudioConcreto } = await modelosDeIa();
    expect(ehModeloDeAudioConcreto(id)).toBe(false);
  });
});

describe("a guarda do texto: aceita outro provedor, recusa alias", () => {
  // O texto vai ao LLM_API_URL, qualquer endpoint compatível com a OpenAI, com
  // o id no corpo JSON: a guarda não prende o formato ao Gemini.
  it.each(["gemini-3.5-flash", "gemini-2.0-flash-001", "gpt-4o-2024-08-06", "gpt-4.1-mini", "google/gemini-2.5-flash", "gemma-3-27b-it", "llama3.1:8b"])(
    "%s passa",
    async id => {
      const { ehModeloDeTextoConcreto } = await modelosDeIa();
      expect(ehModeloDeTextoConcreto(id)).toBe(true);
    }
  );

  it.each([
    ["gemini-flash-latest", "alias -latest"],
    ["gemini-2.5-flash-latest", "tem versão, mas é -latest"],
    ["chatgpt-4o-latest", "alias de outro provedor"],
    ["GPT-4O-LATEST", "latest em maiúsculas"],
    ["gemini-pro", "nome de família, sem versão"],
    ["gemini-flash-lite", "nome de família, sem versão"],
    ["", "vazio"],
  ])("%s é recusado (%s)", async id => {
    const { ehModeloDeTextoConcreto } = await modelosDeIa();
    expect(ehModeloDeTextoConcreto(id)).toBe(false);
  });
});

describe("a recusa: o padrão assume, o log avisa e a chave fica fora dele", () => {
  it("os padrões passam nas duas guardas, e a reserva é diferente do principal", async () => {
    const m = await modelosDeIa();
    for (const padrao of [m.MODELO_DE_AUDIO_PADRAO, m.MODELO_DE_AUDIO_RESERVA_PADRAO, m.MODELO_DE_TEXTO_PADRAO]) {
      expect(m.ehModeloDeAudioConcreto(padrao), padrao).toBe(true);
      expect(m.ehModeloDeTextoConcreto(padrao), padrao).toBe(true);
    }
    expect(m.MODELO_DE_AUDIO_RESERVA_PADRAO).not.toBe(m.MODELO_DE_AUDIO_PADRAO);
  });

  it("ausente ou vazio usa o padrão em silêncio; espaço em volta de um id bom é aparado", async () => {
    const { exigirModeloDeAudio, exigirModeloDeTexto } = await modelosDeIa();
    expect(exigirModeloDeAudio(undefined, "gemini-3.5-flash", "LLM_AUDIO_MODEL")).toBe("gemini-3.5-flash");
    expect(exigirModeloDeAudio("", "gemini-3.5-flash", "LLM_AUDIO_MODEL")).toBe("gemini-3.5-flash");
    expect(exigirModeloDeAudio("  gemini-2.5-flash \n", "gemini-3.5-flash", "LLM_AUDIO_MODEL")).toBe("gemini-2.5-flash");
    expect(exigirModeloDeTexto("", "gemini-3.5-flash", "LLM_MODEL")).toBe("gemini-3.5-flash");
    expect(exigirModeloDeTexto(" gpt-4o-2024-08-06 ", "gemini-3.5-flash", "LLM_MODEL")).toBe("gpt-4o-2024-08-06");
    expect(avisos).not.toHaveBeenCalled();
  });

  it("recusado: avisa no log uma vez por valor e usa o padrão", async () => {
    const { exigirModeloDeTexto } = await modelosDeIa();
    expect(exigirModeloDeTexto("gemini-flash-latest", "gemini-3.5-flash", "LLM_MODEL")).toBe("gemini-3.5-flash");
    expect(exigirModeloDeTexto("gemini-flash-latest", "gemini-3.5-flash", "LLM_MODEL")).toBe("gemini-3.5-flash");
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(textoDosAvisos()).toMatch(/LLM_MODEL recusado \("gemini-flash-latest"\).*padrão gemini-3\.5-flash/);
  });

  it("cada origem e cada valor recusado tem o seu aviso; só o repetido não avisa de novo", async () => {
    // Recusas diferentes no mesmo módulo: um aviso só por processo, ou um por
    // valor sem a origem, calaria a recusa do LLM_MODEL no boot.
    const { exigirModeloDeAudio, exigirModeloDeTexto } = await modelosDeIa();
    exigirModeloDeAudio("gemini-flash-latest", "gemini-3.5-flash", "LLM_AUDIO_MODEL");
    exigirModeloDeTexto("gemini-flash-latest", "gemini-3.5-flash", "LLM_MODEL");
    exigirModeloDeTexto("gemini-pro", "gemini-3.5-flash", "LLM_MODEL");
    exigirModeloDeTexto("gemini-pro", "gemini-3.5-flash", "LLM_MODEL");
    expect(avisos).toHaveBeenCalledTimes(3);
    const texto = textoDosAvisos();
    expect(texto).toContain('LLM_AUDIO_MODEL recusado ("gemini-flash-latest")');
    expect(texto).toContain('LLM_MODEL recusado ("gemini-flash-latest")');
    expect(texto).toContain('LLM_MODEL recusado ("gemini-pro")');
  });

  it("o aviso diz a regra de cada guarda: formato do Gemini no áudio, versão sem latest no texto", async () => {
    const { exigirModeloDeAudio, exigirModeloDeTexto } = await modelosDeIa();
    exigirModeloDeAudio("gemini-pro", "gemini-3.5-flash", "LLM_AUDIO_MODEL");
    exigirModeloDeTexto("gemini-pro", "gemini-3.5-flash", "LLM_MODEL");
    expect(avisos).toHaveBeenCalledTimes(2);
    const [doAudio, doTexto] = textoDosAvisos().split("\n");
    expect(doAudio).toContain("formato gemini-<versão>");
    expect(doTexto).toContain('com número de versão e sem "latest"');
    expect(doTexto).not.toContain("formato gemini-<versão>");
  });

  it("só espaço é vazio recusado, com aviso", async () => {
    const { exigirModeloDeAudio, exigirModeloDeTexto } = await modelosDeIa();
    expect(exigirModeloDeAudio("   ", "gemini-3.5-flash", "LLM_AUDIO_MODEL")).toBe("gemini-3.5-flash");
    expect(exigirModeloDeTexto("   ", "gemini-3.5-flash", "LLM_MODEL")).toBe("gemini-3.5-flash");
    expect(textoDosAvisos()).toContain("LLM_AUDIO_MODEL recusado (vazio)");
    expect(textoDosAvisos()).toContain("LLM_MODEL recusado (vazio)");
  });

  it("valor que não parece id do Gemini fica fora do log: pode ser a chave colada no campo errado", async () => {
    const { exigirModeloDeAudio } = await modelosDeIa();
    expect(exigirModeloDeAudio(CHAVE_FALSA, "gemini-3.5-flash", "LLM_AUDIO_MODEL")).toBe("gemini-3.5-flash");
    expect(avisos).toHaveBeenCalledTimes(1);
    expect(textoDosAvisos()).toContain("LLM_AUDIO_MODEL recusado (valor fora do log");
    expect(textoDosAvisos()).not.toContain(CHAVE_FALSA);
  });
});

describe("transcrição: o modelo de áudio vem do ambiente, pela guarda", () => {
  it("sem variável, chama /models/gemini-3.5-flash:generateContent", async () => {
    const { transcribeWithGemini } = await import("./gemini");
    fetchFalso.mockResolvedValueOnce(respostaTranscricao("olá"));

    expect((await transcribeWithGemini(audio)).text).toBe("olá");
    expect(urlDaChamada(0)).toContain("/models/gemini-3.5-flash:generateContent");
    expect(avisos).not.toHaveBeenCalled();
  });

  it("com LLM_AUDIO_MODEL, o caminho troca", async () => {
    vi.stubEnv("LLM_AUDIO_MODEL", "gemini-2.5-flash");
    const { transcribeWithGemini } = await import("./gemini");
    fetchFalso.mockResolvedValueOnce(respostaTranscricao("olá"));

    await transcribeWithGemini(audio);
    expect(urlDaChamada(0)).toContain("/models/gemini-2.5-flash:generateContent");
  });

  it.each(["gemini-flash-latest", "gemini-2.5-flash-latest", "gemini-pro"])(
    "LLM_AUDIO_MODEL=%s é recusado, loga e cai no padrão",
    async valor => {
      vi.stubEnv("LLM_AUDIO_MODEL", valor);
      const { transcribeWithGemini } = await import("./gemini");
      fetchFalso.mockResolvedValueOnce(respostaTranscricao("olá"));

      await transcribeWithGemini(audio);
      expect(urlDaChamada(0)).toContain("/models/gemini-3.5-flash:generateContent");
      expect(textoDosAvisos()).toContain(`LLM_AUDIO_MODEL recusado ("${valor}")`);
    }
  );

  it("LLM_AUDIO_MODEL de outro provedor é recusado, fora do log: a transcrição vai sempre ao Gemini", async () => {
    vi.stubEnv("LLM_AUDIO_MODEL", "gpt-4o-2024-08-06");
    const { transcribeWithGemini } = await import("./gemini");
    fetchFalso.mockResolvedValueOnce(respostaTranscricao("olá"));

    await transcribeWithGemini(audio);
    expect(urlDaChamada(0)).toContain("/models/gemini-3.5-flash:generateContent");
    expect(textoDosAvisos()).toContain("LLM_AUDIO_MODEL recusado (valor fora do log");
  });

  it("LLM_MODEL não decide o áudio: o principal fica no padrão e a reserva dispara", async () => {
    // O texto apontado para o padrão da reserva. Se o áudio caísse no
    // LLM_MODEL (o erro que a reserva já teve), principal e reserva virariam o
    // mesmo modelo e a reserva nunca dispararia.
    vi.stubEnv("LLM_MODEL", "gemini-3.5-flash-lite");
    const { transcribeWithGemini } = await import("./gemini");
    fetchFalso.mockResolvedValueOnce(resposta429Cota()).mockResolvedValueOnce(respostaTranscricao("pela reserva"));

    const texto = await transcribeWithGemini(audio).then(
      resultado => resultado.text,
      (erro: Error) => `rejeitou: ${erro.message}`
    );
    expect(urlDaChamada(0)).toContain("/models/gemini-3.5-flash:generateContent");
    expect(fetchFalso).toHaveBeenCalledTimes(2);
    expect(urlDaChamada(1)).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(texto).toBe("pela reserva");
  });

  it("reserva igual ao principal não faz a 2ª chamada", async () => {
    // O principal apontado para o padrão da reserva: os dois viram o mesmo modelo.
    vi.stubEnv("LLM_AUDIO_MODEL", "gemini-3.5-flash-lite");
    const { transcribeWithGemini } = await import("./gemini");
    fetchFalso.mockResolvedValue(resposta429Cota());

    await expect(transcribeWithGemini(audio)).rejects.toThrow(/limite de uso gratuito/i);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(urlDaChamada(0)).toContain("/models/gemini-3.5-flash-lite:generateContent");
  });

  it("reserva recusada pela guarda cai no padrão da reserva, que assume", async () => {
    vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", "gemini-flash-lite-latest");
    const { transcribeWithGemini } = await import("./gemini");
    fetchFalso.mockResolvedValueOnce(resposta429Cota()).mockResolvedValueOnce(respostaTranscricao("pela reserva"));

    expect((await transcribeWithGemini(audio)).text).toBe("pela reserva");
    expect(urlDaChamada(1)).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(textoDosAvisos()).toContain('LLM_AUDIO_MODEL_RESERVA recusado ("gemini-flash-lite-latest")');
  });
});

describe("texto: LLM_MODEL passa pela guarda do texto em invokeLLM", () => {
  const respostaDoLLM = () =>
    new Response(JSON.stringify({ id: "r", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const modeloPedido = (n: number) => JSON.parse(String(fetchFalso.mock.calls[n][1].body)).model;
  const mensagens = [{ role: "user" as const, content: "oi" }];

  it("sem LLM_MODEL, vai o padrão gemini-3.5-flash", async () => {
    const { invokeLLM } = await import("./_core/llm");
    fetchFalso.mockImplementation(async () => respostaDoLLM());

    await invokeLLM({ messages: mensagens });
    expect(modeloPedido(0)).toBe("gemini-3.5-flash");
    expect(avisos).not.toHaveBeenCalled();
  });

  it("LLM_MODEL concreto vai como está", async () => {
    vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
    const { invokeLLM } = await import("./_core/llm");
    fetchFalso.mockImplementation(async () => respostaDoLLM());

    await invokeLLM({ messages: mensagens });
    expect(modeloPedido(0)).toBe("gemini-2.5-flash");
  });

  it("LLM_MODEL de outro provedor compatível com a OpenAI vai como está, sem aviso", async () => {
    vi.stubEnv("LLM_MODEL", "gpt-4o-2024-08-06");
    const { invokeLLM } = await import("./_core/llm");
    fetchFalso.mockImplementation(async () => respostaDoLLM());

    await invokeLLM({ messages: mensagens });
    expect(modeloPedido(0)).toBe("gpt-4o-2024-08-06");
    expect(avisos).not.toHaveBeenCalled();
  });

  it("LLM_MODEL vence o model de quem chama; sem a variável, o do chamador vai como está", async () => {
    vi.stubEnv("LLM_MODEL", "gemini-2.5-flash");
    const { invokeLLM } = await import("./_core/llm");
    fetchFalso.mockImplementation(async () => respostaDoLLM());

    await invokeLLM({ messages: mensagens, model: "gemini-2.0-flash-001" });
    expect(modeloPedido(0)).toBe("gemini-2.5-flash");

    vi.stubEnv("LLM_MODEL", undefined);
    await invokeLLM({ messages: mensagens, model: "gemini-2.0-flash-001" });
    expect(modeloPedido(1)).toBe("gemini-2.0-flash-001");
    expect(avisos).not.toHaveBeenCalled();
  });

  it.each(["gemini-flash-latest", "gemini-2.5-flash-latest", "gemini-pro"])(
    "LLM_MODEL=%s é recusado, loga uma vez e cai no padrão em todas as chamadas",
    async valor => {
      vi.stubEnv("LLM_MODEL", valor);
      const { invokeLLM } = await import("./_core/llm");
      fetchFalso.mockImplementation(async () => respostaDoLLM());

      await invokeLLM({ messages: mensagens });
      await invokeLLM({ messages: mensagens });
      expect(modeloPedido(0)).toBe("gemini-3.5-flash");
      expect(modeloPedido(1)).toBe("gemini-3.5-flash");
      const recusas = textoDosAvisos().split("\n").filter(aviso => aviso.includes("LLM_MODEL recusado"));
      expect(recusas).toHaveLength(1);
      expect(recusas[0]).toContain(`("${valor}")`);
    }
  );

  it("o model de quem chama, herança do proxy Manus, também passa pela guarda", async () => {
    const { invokeLLM } = await import("./_core/llm");
    fetchFalso.mockImplementation(async () => respostaDoLLM());

    await invokeLLM({ messages: mensagens, model: "gemini-flash-latest" });
    expect(modeloPedido(0)).toBe("gemini-3.5-flash");
    expect(textoDosAvisos()).toContain('invokeLLM({ model }) recusado ("gemini-flash-latest")');
  });
});

describe("a linha [IA] do boot", () => {
  it("mostra áudio, reserva e texto em uso, sem a chave", async () => {
    vi.stubEnv("GOOGLE_API_KEY", "chave-falsa-do-google-que-nao-aparece");
    const { linhaDosModelosDeIa } = await modelosDeIa();

    const linha = linhaDosModelosDeIa();
    expect(linha).not.toContain(CHAVE_FALSA);
    expect(linha).not.toContain("chave-falsa-do-google-que-nao-aparece");
    expect(linha).toBe("[IA] áudio gemini-3.5-flash · reserva gemini-3.5-flash-lite · texto gemini-3.5-flash");
  });

  it("reflete o ambiente depois da guarda e diz quando a reserva não dispara", async () => {
    vi.stubEnv("LLM_AUDIO_MODEL", "gemini-2.5-flash");
    vi.stubEnv("LLM_AUDIO_MODEL_RESERVA", "gemini-2.5-flash");
    vi.stubEnv("LLM_MODEL", "gemini-flash-latest");
    const { linhaDosModelosDeIa } = await modelosDeIa();

    expect(linhaDosModelosDeIa()).toBe(
      "[IA] áudio gemini-2.5-flash · reserva gemini-2.5-flash (igual ao áudio: não dispara) · texto gemini-3.5-flash"
    );
    expect(textoDosAvisos()).toContain('LLM_MODEL recusado ("gemini-flash-latest")');
  });

  it("LLM_MODEL sozinho muda só o texto", async () => {
    vi.stubEnv("LLM_MODEL", "gemini-3.5-flash-lite");
    const { linhaDosModelosDeIa } = await modelosDeIa();

    expect(linhaDosModelosDeIa()).toBe("[IA] áudio gemini-3.5-flash · reserva gemini-3.5-flash-lite · texto gemini-3.5-flash-lite");
  });

  it("id de outro provedor no texto fica fora da linha: a guarda do texto não o distingue de uma chave", async () => {
    // Com dígito e sem "latest", uma chave colada no LLM_MODEL passa na guarda
    // do texto; a linha do boot não pode levá-la ao log do Render.
    const chaveComDigitos = "chave-falsa-com-digitos-0123456789";
    for (const valor of ["gpt-4o-2024-08-06", chaveComDigitos]) {
      vi.stubEnv("LLM_MODEL", valor);
      const { linhaDosModelosDeIa, modeloDeTexto } = await modelosDeIa();
      expect(modeloDeTexto()).toBe(valor);
      const linha = linhaDosModelosDeIa();
      expect(linha).toBe("[IA] áudio gemini-3.5-flash · reserva gemini-3.5-flash-lite · texto (id de outro provedor, fora do log)");
      expect(linha).not.toContain(valor);
    }
    expect(avisos).not.toHaveBeenCalled();
  });

  it("sai no começo do boot, e o index.ts não lê a chave do LLM", () => {
    const boot = readFileSync(join(__dirname, "_core", "index.ts"), "utf8");
    const comeco = boot.indexOf("async function startServer");
    const fim = boot.indexOf("const app = express();");
    // As duas âncoras precisam existir, nesta ordem: sem a do fim, o slice
    // pegaria quase o arquivo inteiro e um log movido para depois do listen
    // passaria.
    expect(comeco).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(comeco);
    expect(boot.slice(comeco, fim)).toContain("console.log(linhaDosModelosDeIa());");
    expect(boot).not.toMatch(/llmApiKey|LLM_API_KEY|GOOGLE_API_KEY/);
  });
});

describe("scripts/listar-modelos-gemini.mjs (fetch dublado)", () => {
  // O script é .mjs, sem tipos.
  const script = listarModelosMod as any;
  const modeloDaApi = (id: string, metodos = ["generateContent", "countTokens"], entrada = 1_048_576, saida = 65_536) => ({
    name: `models/${id}`,
    supportedGenerationMethods: metodos,
    inputTokenLimit: entrada,
    outputTokenLimit: saida,
  });
  const pagina = (models: unknown[], nextPageToken?: string) =>
    new Response(JSON.stringify({ models, ...(nextPageToken ? { nextPageToken } : {}) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  async function rodar(argumentos: string[], ambiente: Record<string, string> = { LLM_API_KEY: CHAVE_FALSA }) {
    const saida: string[] = [];
    const erros: string[] = [];
    const codigo = await script.principal({
      argumentos,
      ambiente,
      buscar: fetchFalso,
      escrever: (texto: string) => saida.push(texto),
      escreverErro: (texto: string) => erros.push(texto),
    });
    return { codigo, saida: saida.join("\n"), erros: erros.join("\n") };
  }

  it("pagina a lista com a chave no cabeçalho x-goog-api-key, nunca na URL nem na tela", async () => {
    fetchFalso
      .mockResolvedValueOnce(pagina([modeloDaApi("gemini-3.5-flash")], "pagina-2"))
      .mockResolvedValueOnce(pagina([modeloDaApi("gemini-3.5-flash-lite"), modeloDaApi("gemini-embedding-001", ["embedContent"], 2048, 1)]));

    const { codigo, saida, erros } = await rodar([]);
    expect(codigo).toBe(0);
    expect(fetchFalso).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchFalso.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?/);
      expect(String(url)).not.toContain(CHAVE_FALSA);
      expect(init.headers["x-goog-api-key"]).toBe(CHAVE_FALSA);
    }
    expect(new URL(urlDaChamada(0)).searchParams.get("pageToken")).toBeNull();
    expect(new URL(urlDaChamada(1)).searchParams.get("pageToken")).toBe("pagina-2");
    // a tabela: nome, generateContent sim/não e os limites de entrada e saída
    expect(saida).toMatch(/gemini-3\.5-flash\s+sim\s+1048576\s+65536/);
    expect(saida).toMatch(/gemini-embedding-001\s+não\s+2048\s+1/);
    expect(saida).toContain("3 modelo(s)");
    expect(saida).toContain("não prova que o id é concreto");
    expect(`${saida}\n${erros}`).not.toContain(CHAVE_FALSA);
  });

  it("--conferir diz se cada id existe e sai com 1 se faltar algum", async () => {
    fetchFalso.mockImplementation(async () => pagina([modeloDaApi("gemini-3.5-flash"), modeloDaApi("gemini-3.5-flash-lite")]));

    const todos = await rodar(["--conferir", "gemini-3.5-flash,models/gemini-3.5-flash-lite"]);
    expect(todos.codigo).toBe(0);
    expect(todos.saida).toContain("gemini-3.5-flash: existe (generateContent: sim)");
    expect(todos.saida).toContain("gemini-3.5-flash-lite: existe (generateContent: sim)");

    const falta = await rodar(["--conferir=gemini-3.5-flash,gemini-3.8-flash"]);
    expect(falta.codigo).toBe(1);
    expect(falta.saida).toContain("gemini-3.8-flash: NÃO existe para esta chave");
    expect(falta.saida).toContain("não prova que o id é concreto");
  });

  it("--conferir sai com 1 se o id existe sem generateContent, e diz que o servidor não consegue usá-lo", async () => {
    // Como os modelos só da Live API: passam na guarda e existem, mas toda
    // transcrição com eles voltaria 404.
    const soAoVivo = "gemini-2.5-flash-native-audio-preview-09-2025";
    fetchFalso.mockImplementation(async () => pagina([modeloDaApi("gemini-3.5-flash"), modeloDaApi(soAoVivo, ["countTokens", "bidiGenerateContent"])]));

    const { codigo, saida } = await rodar(["--conferir", `gemini-3.5-flash,${soAoVivo}`]);
    expect(codigo).toBe(1);
    expect(saida).toContain(`${soAoVivo}: existe, mas SEM generateContent: o servidor não consegue usá-lo`);
    expect(saida).toContain("gemini-3.5-flash: existe (generateContent: sim)");
  });

  it("a ajuda diz que existir não prova que o id é concreto, sem ir à rede", async () => {
    const { codigo, saida } = await rodar(["--ajuda"], {});
    expect(codigo).toBe(0);
    expect(saida).toContain("Existir NÃO prova que o id é concreto");
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("sem chave no ambiente, sai com 2 sem chamar a API", async () => {
    const { codigo, erros } = await rodar([], {});
    expect(codigo).toBe(2);
    expect(erros).toMatch(/LLM_API_KEY.*GOOGLE_API_KEY/);
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("sem LLM_API_KEY, usa GOOGLE_API_KEY; com as duas, vale a LLM_API_KEY (a mesma ordem do servidor)", async () => {
    fetchFalso.mockImplementation(async () => pagina([modeloDaApi("gemini-3.5-flash")]));
    await rodar([], { GOOGLE_API_KEY: "chave-falsa-do-google-1234" });
    expect(fetchFalso.mock.calls[0][1].headers["x-goog-api-key"]).toBe("chave-falsa-do-google-1234");

    await rodar([], { LLM_API_KEY: "chave-do-wrw-falsa", GOOGLE_API_KEY: "outra-chave-falsa" });
    expect(fetchFalso.mock.calls[1][1].headers["x-goog-api-key"]).toBe("chave-do-wrw-falsa");
  });

  it("erro da API sai com 2, e a chave não aparece nem se a resposta a repetir", async () => {
    fetchFalso.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 400, message: `API key not valid: ${CHAVE_FALSA}` } }), { status: 400 }));

    const { codigo, saida, erros } = await rodar(["--conferir", "gemini-3.5-flash"]);
    expect(codigo).toBe(2);
    expect(erros).toContain("HTTP 400");
    expect(erros).toContain("[chave omitida]");
    expect(`${saida}\n${erros}`).not.toContain(CHAVE_FALSA);
  });

  // Os dois casos põem a chave atravessando o corte, com quase toda ela antes
  // (falta só o último caractere) ou só o começo; as posições seguem o
  // tamanho do dublê.
  it.each([300 - CHAVE_FALSA.length + 1, 285])("a chave sai do erro da API antes do corte: começando no caractere %i, nem um pedaço dela aparece", async posicao => {
    // O trecho mostrado tem 300 caracteres: cortado antes de apagar a chave,
    // o começo dela ficava e não casava mais com a chave inteira. A premissa do
    // caso: a chave cruza o corte, com ao menos 8 caracteres dela antes.
    expect(posicao + CHAVE_FALSA.length).toBeGreaterThan(300);
    expect(posicao).toBeLessThanOrEqual(300 - 8);
    fetchFalso.mockResolvedValueOnce(new Response(".".repeat(posicao) + CHAVE_FALSA, { status: 400 }));

    const { codigo, saida, erros } = await rodar([]);
    expect(codigo).toBe(2);
    expect(`${saida}\n${erros}`).not.toContain(CHAVE_FALSA.slice(0, 8));
    expect(erros).toContain("[chave omitida]");
  });

  it("falha de rede sai com 2 e mostra a causa", async () => {
    fetchFalso.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND") }));
    const { codigo, erros } = await rodar([]);
    expect(codigo).toBe(2);
    expect(erros).toContain("fetch failed (getaddrinfo ENOTFOUND)");
  });

  it("a API repetindo a página seguinte não faz o script girar sem fim", async () => {
    fetchFalso.mockImplementation(async () => pagina([modeloDaApi("gemini-3.5-flash")], "sempre-a-mesma"));
    const { codigo, erros } = await rodar([]);
    expect(codigo).toBe(2);
    expect(fetchFalso).toHaveBeenCalledTimes(2);
    expect(erros).toContain("girar sem fim");
  });

  it("argumento solto ou valor de opção desconhecida não vai para a tela: pode ser a chave", async () => {
    for (const argumentos of [[CHAVE_FALSA], [`--chave=${CHAVE_FALSA}`]]) {
      const { codigo, saida, erros } = await rodar(argumentos, {});
      expect(codigo).toBe(2);
      expect(`${saida}\n${erros}`).not.toContain(CHAVE_FALSA);
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("não toca banco nem lê o .env: só importa node:url e só lê o ambiente quando roda direto", () => {
    // Sem o CR: num checkout do Windows com core.autocrlf=true (o padrão do
    // Git), o arquivo chega com CRLF e cada linha terminaria em \r.
    const fonte = readFileSync(join(__dirname, "..", "scripts", "listar-modelos-gemini.mjs"), "utf8").replace(/\r\n/g, "\n");
    const imports = fonte.split("\n").filter(linha => linha.startsWith("import"));
    expect(imports).toEqual(['import { pathToFileURL } from "node:url";']);
    const codigo = fonte
      .split("\n")
      .filter(linha => !linha.trim().startsWith("//"))
      .join("\n");
    expect(codigo).not.toMatch(/dotenv|mysql|readFile|\bimport\s*\(|\brequire\s*\(/);
    expect(codigo.match(/process\.env/g)).toHaveLength(1);
  });

  it("a receita do cabeçalho passa a chave só ao comando, sem exportá-la no terminal", () => {
    // Exportada, a chave ficaria no terminal, e o pnpm dev e o pnpm test dali a
    // usariam no lugar da do .env (o dotenv não sobrescreve o ambiente).
    const fonte = readFileSync(join(__dirname, "..", "scripts", "listar-modelos-gemini.mjs"), "utf8");
    expect(fonte).not.toMatch(/\bexport\s+(?:LLM_API_KEY|GOOGLE_API_KEY)\b/);
    expect(fonte).toContain('LLM_API_KEY="$CHAVE" node scripts/listar-modelos-gemini.mjs');
  });
});
