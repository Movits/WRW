import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O perfil de voz da dona (H3d): as partes que não falam com o banco. A
 * amostra conferida (tipo, tamanho, duração e conteúdo), o consentimento que
 * serve, o pedido de transcrição com a amostra antes do trecho, os rótulos da
 * voz da dona na junção e na montagem, e o proxy /manus-storage negando a
 * amostra a todo mundo. O que fala com o banco está em
 * server/perfil-de-voz.integracao.test.ts e server/fila-de-transcricao.integracao.test.ts.
 */
const ambiente = vi.hoisted(() => ({ ENV: { llmApiKey: "chave-de-teste-que-nunca-sai-daqui" } }));
vi.mock("./_core/env", () => ambiente);

const { conteudoConfereComOTipo, consentimentoValido, decodificarAmostra, chaveDaAmostra, contarGravacaoDaAmostra, zerarTetoDaAmostraParaTestes } = await import("./perfil-de-voz");
const { transcreverFatia, promptDaFatia, deslocarRotulosDasFalas, contasComAVozDaDona, parteUsouAVozDaDona, TEXTO_DA_AMOSTRA_DA_VOZ, TEXTO_DO_TRECHO_COM_AMOSTRA } = await import("./transcricao-de-fatia");
const { podeBaixarChave } = await import("./_core/storageProxy");
const { deslocarResultado } = await import("./juntar-reunioes");
const {
  DURACAO_MAXIMA_DA_AMOSTRA_MS, DURACAO_MINIMA_DA_AMOSTRA_MS, GRAVACOES_DA_AMOSTRA_POR_JANELA, HASHES_DO_TEXTO_DO_PERFIL_DE_VOZ, RECUSAS_DO_PERFIL_DE_VOZ,
  TAMANHO_MAXIMO_DA_AMOSTRA, VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ,
} = await import("@shared/perfil-de-voz");

/** O texto do consentimento como a tela o manda (client/src/components/PerfilDeVoz.tsx), num idioma. */
const PASTA_DOS_LOCALES = path.resolve(import.meta.dirname, "../client/src/i18n/locales");
function textoDoConsentimento(idioma: string): string {
  const { perfilDeVoz } = JSON.parse(fs.readFileSync(path.join(PASTA_DOS_LOCALES, `${idioma}.json`), "utf8"));
  return `${perfilDeVoz.consent}\n${perfilDeVoz.consentSupport}`;
}

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(60, 2)]);
const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 3)]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(60, 4)]);

async function recusa(acao: () => unknown) {
  try {
    await acao();
  } catch (erro) {
    return erro as { code?: string; message: string };
  }
  throw new Error("era para recusar");
}

describe("a amostra: tipo, conteúdo, tamanho e duração", () => {
  it("cada formato do gravador é reconhecido pelos primeiros bytes, e o tipo trocado não passa", () => {
    expect(conteudoConfereComOTipo(WEBM, "audio/webm")).toBe(true);
    expect(conteudoConfereComOTipo(MP4, "audio/mp4")).toBe(true);
    expect(conteudoConfereComOTipo(OGG, "audio/ogg")).toBe(true);
    expect(conteudoConfereComOTipo(WAV, "audio/wav")).toBe(true);
    expect(conteudoConfereComOTipo(MP4, "audio/webm")).toBe(false);
    expect(conteudoConfereComOTipo(Buffer.from("%PDF-1.4 qualquer coisa"), "audio/mp4")).toBe(false);
  });

  it("aceita o base64 com o cabeçalho do FileReader e devolve os bytes", () => {
    const r = decodificarAmostra({ audioBase64: `data:audio/webm;codecs=opus;base64,${WEBM.toString("base64")}`, mimeType: "audio/webm", duracaoMs: 30_000 });
    expect(r.bytes.equals(WEBM)).toBe(true);
    expect(r).toMatchObject({ tipo: "audio/webm", duracaoMs: 30_000 });
  });

  it.each([
    ["tipo que não é de áudio do gravador", { mimeType: "application/pdf" }],
    ["conteúdo que não é o do tipo", { audioBase64: Buffer.from("isto não é áudio nenhum, só texto").toString("base64") }],
    ["curta demais", { duracaoMs: DURACAO_MINIMA_DA_AMOSTRA_MS - 1 }],
    ["longa demais", { duracaoMs: DURACAO_MAXIMA_DA_AMOSTRA_MS + 5_000 }],
    ["maior que o teto", { audioBase64: Buffer.concat([WEBM, Buffer.alloc(TAMANHO_MAXIMO_DA_AMOSTRA)]).toString("base64") }],
    ["base64 com lixo", { audioBase64: "<script>" }],
  ])("recusa a amostra %s com o código", async (_nome, troca) => {
    const erro = await recusa(() => decodificarAmostra({ audioBase64: WEBM.toString("base64"), mimeType: "audio/webm", duracaoMs: 30_000, ...troca }));
    expect(erro).toMatchObject({ code: "BAD_REQUEST", message: RECUSAS_DO_PERFIL_DE_VOZ.amostraInvalida });
  });

  it("a chave da amostra fica sob perfis-de-voz/<openId>/ e nunca se repete", () => {
    const a = chaveDaAmostra("open-1", "audio/mp4");
    expect(a).toMatch(/^perfis-de-voz\/open-1\/[0-9a-f-]{36}\.m4a$/);
    expect(chaveDaAmostra("open-1", "audio/mp4")).not.toBe(a);
  });

  it("o teto de gravações por hora é por dona", async () => {
    zerarTetoDaAmostraParaTestes();
    for (let i = 0; i < GRAVACOES_DA_AMOSTRA_POR_JANELA; i++) contarGravacaoDaAmostra("dona-teto");
    expect(await recusa(() => contarGravacaoDaAmostra("dona-teto"))).toMatchObject({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_PERFIL_DE_VOZ.demais });
    expect(() => contarGravacaoDaAmostra("outra-dona")).not.toThrow();
    zerarTetoDaAmostraParaTestes();
  });
});

describe("o consentimento que serve", () => {
  const bom = { versaoDoTexto: VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ, idioma: "pt-BR", textoExibido: textoDoConsentimento("pt-BR") };
  it("a versão que o servidor conhece, com o texto dela no idioma da tela", () => {
    expect(consentimentoValido(bom)).toBe(true);
    expect(consentimentoValido({ ...bom, idioma: "ja", textoExibido: textoDoConsentimento("ja") })).toBe(true);
  });
  it("a versão vigente aceita exatamente o texto dos 10 locales: mudou o texto, versão nova com os hashes novos", () => {
    const idiomas = fs.readdirSync(PASTA_DOS_LOCALES).filter(nome => nome.endsWith(".json")).map(nome => nome.replace(/\.json$/, "")).sort();
    expect(idiomas).toHaveLength(10);
    const daVersao = HASHES_DO_TEXTO_DO_PERFIL_DE_VOZ[VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ];
    expect(Object.keys(daVersao).sort()).toEqual(idiomas);
    for (const idioma of idiomas) {
      expect(crypto.createHash("sha256").update(textoDoConsentimento(idioma)).digest("hex"), idioma).toBe(daVersao[idioma]);
    }
  });
  it.each([
    ["sem consentimento", undefined],
    ["versão desconhecida", { ...bom, versaoDoTexto: "perfil-de-voz-1999-01-01" }],
    ["texto vazio", { ...bom, textoExibido: "  " }],
    ["sem idioma", { ...bom, idioma: "" }],
    ["texto que não é o da versão", { ...bom, textoExibido: "Autorizo qualquer coisa." }],
    ["o texto de outro idioma", { ...bom, textoExibido: textoDoConsentimento("en") }],
    ["idioma que a tela não tem", { ...bom, idioma: "xx" }],
    ["idioma herdado do Object", { ...bom, idioma: "constructor" }],
  ])("não serve: %s", (_nome, consentimento) => {
    expect(consentimentoValido(consentimento)).toBe(false);
  });
});

describe("o proxy /manus-storage nega a amostra", () => {
  it("nem a própria dona baixa a amostra pela chave (só pelo perfilDeVoz.ouvir)", async () => {
    const semSala = async () => null;
    expect(await podeBaixarChave({ id: 1, openId: "dona-1", role: "silver" }, "perfis-de-voz/dona-1/amostra.webm", semSala)).toBe(false);
    expect(await podeBaixarChave({ id: 2, openId: "adm", role: "admin" }, "perfis-de-voz/dona-1/amostra.webm", semSala)).toBe(false);
  });
});

// ─── A transcrição com a amostra ────────────────────────────────────────────
let fetchOriginal: typeof globalThis.fetch;
let pedidos: Array<Record<string, any>> = [];
function responder(corpo: unknown) {
  globalThis.fetch = (async (_entrada: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(corpo) }] } }] }), { status: 200 });
  }) as typeof globalThis.fetch;
}

describe("a transcrição da parte com a amostra da voz da dona", () => {
  beforeEach(() => {
    fetchOriginal = globalThis.fetch;
    pedidos = [];
    vi.stubEnv("LLM_AUDIO_MODEL", "gemini-3.5-flash");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a amostra vai ANTES do trecho, cada áudio com o texto que o apresenta, e o prompt pede o rótulo fixo da dona", async () => {
    responder({ segmentos: [{ inicio: "00:01", fim: "00:03", falante: "F1", texto: "Bom dia" }, { inicio: "00:04", fim: "00:06", falante: "F2", texto: "Oi" }] });
    const amostra = Buffer.from("amostra-da-dona");
    const r = await transcreverFatia({
      audio: Buffer.from("trecho"), mimeType: "audio/mp4", idioma: "pt-BR", inicioSegundos: 0, duracaoSegundos: 600, ultimaTentativa: false,
      amostraDaVoz: { audio: amostra, mimeType: "audio/webm" },
    });
    expect(r.segmentos.map(s => s.falante)).toEqual(["F1", "F2"]);
    const partes = pedidos[0].contents[0].parts;
    expect(partes).toHaveLength(5);
    expect(partes[0].text).toContain('levam sempre o rótulo "F1"');
    expect(partes[0].text).toContain('as outras vozes começam em "F2"');
    expect(partes[1]).toEqual({ text: TEXTO_DA_AMOSTRA_DA_VOZ });
    expect(partes[2]).toEqual({ inline_data: { mime_type: "audio/webm", data: amostra.toString("base64") } });
    expect(partes[3]).toEqual({ text: TEXTO_DO_TRECHO_COM_AMOSTRA });
    expect(partes[4]).toEqual({ inline_data: { mime_type: "audio/mp4", data: Buffer.from("trecho").toString("base64") } });
  });

  it("sem a amostra, o pedido é o de sempre: o prompt e o trecho, sem a regra da dona", async () => {
    responder({ segmentos: [] });
    await transcreverFatia({ audio: Buffer.from("trecho"), mimeType: "audio/mp4", idioma: "pt-BR", inicioSegundos: 0, duracaoSegundos: 600, ultimaTentativa: false });
    const partes = pedidos[0].contents[0].parts;
    expect(partes).toHaveLength(2);
    expect(partes[0].text).not.toContain("AMOSTRA");
  });

  it("na parte seguinte, as vozes já identificadas são só rótulos, e uma frase à parte diz qual é a dona", () => {
    const prompt = promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 600, vozDaDona: true, anterior: { falantes: ["F1", "F2"], ultimasFalas: [] } });
    expect(prompt).toContain('Vozes já identificadas: F1, F2. O rótulo "F1" é a dona.');
    expect(prompt).not.toContain("F1 (a dona)");
    const semAmostra = promptDaFatia({ idioma: "pt-BR", duracaoSegundos: 600, anterior: { falantes: ["F1", "F2"], ultimasFalas: [] } });
    expect(semAmostra).toContain("Vozes já identificadas: F1, F2. Reconheça");
    expect(semAmostra).not.toContain("é a dona");
  });

  it("com a amostra, a fala sem rótulo válido no começo da parte não cai no rótulo da dona", async () => {
    const corpo = { segmentos: [{ inicio: "00:01", fim: "00:03", falante: "F1 (a dona)", texto: "Bom dia" }, { inicio: "00:04", fim: "00:06", falante: "F3", texto: "Oi" }] };
    responder(corpo);
    const comAmostra = await transcreverFatia({
      audio: Buffer.from("trecho"), mimeType: "audio/mp4", idioma: "pt-BR", inicioSegundos: 0, duracaoSegundos: 600, ultimaTentativa: false,
      amostraDaVoz: { audio: Buffer.from("amostra"), mimeType: "audio/webm" },
    });
    expect(comAmostra.segmentos.map(s => s.falante)).toEqual(["F2", "F3"]);
    // Sem a amostra, como antes: o primeiro rótulo.
    responder(corpo);
    const semAmostra = await transcreverFatia({ audio: Buffer.from("trecho"), mimeType: "audio/mp4", idioma: "pt-BR", inicioSegundos: 0, duracaoSegundos: 600, ultimaTentativa: false });
    expect(semAmostra.segmentos.map(s => s.falante)).toEqual(["F1", "F3"]);
  });
});

describe("os rótulos da voz da dona", () => {
  const fala = (falante: string, texto = "x") => ({ inicio: 0, fim: 1, falante, texto });

  it("na reunião juntada, a dona fica no rótulo fixo e as outras vozes vão para depois dos usados", () => {
    expect(deslocarRotulosDasFalas([fala("F1"), fala("F2"), fala("F3")], 2, ["F1"]).map(s => s.falante)).toEqual(["F1", "F4", "F5"]);
    // Sem o fixo, como antes: tudo desloca.
    expect(deslocarRotulosDasFalas([fala("F1"), fala("F2")], 2).map(s => s.falante)).toEqual(["F3", "F4"]);
  });

  it("a montagem liga o rótulo da dona à conta dela só com a amostra usada e a voz dela nas falas", () => {
    const comAmostra = [{ status: "transcribed", result: { vozDaDona: true } }];
    expect(parteUsouAVozDaDona({ vozDaDona: true })).toBe(true);
    expect(contasComAVozDaDona(comAmostra, [fala("F1"), fala("F2")], {})).toEqual({ F1: "owner" });
    // A ligação que já havia fica.
    expect(contasComAVozDaDona(comAmostra, [fala("F1"), fala("F2")], { F2: "abc" })).toEqual({ F1: "owner", F2: "abc" });
    // Sem a amostra, sem a voz da dona nas falas, ou com o rótulo já ligado: nada muda.
    expect(contasComAVozDaDona([{ status: "transcribed", result: {} }], [fala("F1")], {})).toBeNull();
    expect(contasComAVozDaDona([{ status: "failed", result: { vozDaDona: true } }], [fala("F1")], {})).toBeNull();
    expect(contasComAVozDaDona(comAmostra, [fala("F2")], {})).toBeNull();
    expect(contasComAVozDaDona(comAmostra, [fala("F1")], { F1: "outra-participacao" })).toBeNull();
  });

  it("não liga o F1 quando a dona deu nome livre a ele (ela soltou a conta ao nomear)", () => {
    const comAmostra = [{ status: "transcribed", result: { vozDaDona: true, segmentos: [fala("F1")] } }];
    expect(contasComAVozDaDona(comAmostra, [fala("F1")], {}, { F1: "Ana" })).toBeNull();
    // O nome de OUTRA voz não muda nada; nome em branco não conta.
    expect(contasComAVozDaDona(comAmostra, [fala("F1")], {}, { F2: "Bia" })).toEqual({ F1: "owner" });
    expect(contasComAVozDaDona(comAmostra, [fala("F1")], {}, { F1: "  " })).toEqual({ F1: "owner" });
  });

  it("não liga o F1 se alguma parte transcrita SEM a amostra também usa o F1 (outra pessoa, numa reunião juntada)", () => {
    const marcada = { status: "transcribed", result: { vozDaDona: true, segmentos: [fala("F1"), fala("F2")] } };
    const semMarcaComF1 = { status: "transcribed", result: { segmentos: [fala("F1")] } };
    const semMarcaSemF1 = { status: "transcribed", result: { segmentos: [fala("F3")] } };
    expect(contasComAVozDaDona([semMarcaComF1, marcada], [fala("F1"), fala("F1"), fala("F2")], {})).toBeNull();
    // A parte sem a amostra que não usa o F1 (vozes deslocadas) não atrapalha.
    expect(contasComAVozDaDona([semMarcaSemF1, marcada], [fala("F3"), fala("F1"), fala("F2")], {})).toEqual({ F1: "owner" });
    // A parte que falhou não conta.
    expect(contasComAVozDaDona([{ status: "failed", result: { segmentos: [fala("F1")] } }, marcada], [fala("F1")], {})).toEqual({ F1: "owner" });
  });

  it("na junção, a parte com os rótulos deslocados perde a marca da voz da dona; sem deslocar, a marca fica", () => {
    const result = { vozDaDona: true, segmentos: [fala("F1"), fala("F2")], contexto: { falantes: ["F1", "F2"], ultimasFalas: [] } };
    const deslocada = deslocarResultado(result, 2, 600) as Record<string, unknown>;
    expect(parteUsouAVozDaDona(deslocada)).toBe(false);
    expect((deslocada.segmentos as Array<{ falante: string }>).map(s => s.falante)).toEqual(["F3", "F4"]);
    expect(parteUsouAVozDaDona(deslocarResultado(result, 0, 600))).toBe(true);
    // O original não muda.
    expect(result.vozDaDona).toBe(true);
  });
});
