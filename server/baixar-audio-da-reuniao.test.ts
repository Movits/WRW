import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { auditLogs, meetingAudioSlices, meetingRecordings, meetings } from "../drizzle/schema";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * Baixar o áudio da reunião (H8c) sem o banco: uma transação dublada mostra que
 * a leitura das partes e o insert da auditoria estão DENTRO dela, que a falha
 * da auditoria desfaz tudo e nenhuma parte sai, e o que a auditoria leva. As
 * condições do WHERE (a dona, a reunião excluída) só o banco de verdade prova:
 * estão em baixar-audio-da-reuniao.integracao.test.ts, contra o MariaDB. Aqui
 * também ficam o balcão das fichas e a conferência do ffmpeg.
 */

const banco = vi.hoisted(() => ({ atual: null as unknown }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    if (banco.atual) return banco.atual;
    throw new Error("banco dublado: o teste não montou a transação");
  },
}));

const { prepararAudioDaReuniao, partesParaBaixar, criarBalcaoDoAudio, criarConferenciaDoFfmpeg, esperarVagaDeConversao, FORMATO_DA_FICHA } = await import("./baixar-audio-da-reuniao");
const { ACAO_AUDIO_BAIXADO, RECUSAS_DO_AUDIO, nomeDoArquivoDoAudio, tamanhoEstimadoDoAudio } = await import("@shared/baixar-audio");
const { MEETING_AUDIO_TTL_MS } = await import("./meeting-service");

const AGORA = 1_763_400_000_000;
const DIA = 24 * 60 * 60 * 1000;
const PEDIDO = { formato: "mp3" as const, userId: 7, ipAddress: "203.0.113.7", userAgent: "vitest" };

type Linhas = {
  reuniao?: Record<string, unknown>;
  partes?: Array<Record<string, unknown>>;
  gravacao?: Record<string, unknown>;
};

const REUNIAO_EM_PARTES = { status: "ready", audioPipeline: "slices", createdAt: AGORA - 2 * DIA };
const REUNIAO_DE_ENVIO_UNICO = { status: "ready", audioPipeline: "single", createdAt: AGORA - 2 * DIA };
const linha = (seq: number, extra: Record<string, unknown> = {}) => ({
  seq, status: "transcribed", storageKey: `meetings/dona-1/reuniao-1/partes/${String(seq).padStart(4, "0")}-abcd1234.webm`,
  mimeType: "audio/webm", durationMs: 600_000, offsetMs: seq * 600_000, expiresAt: AGORA + 28 * DIA, ...extra,
});

/** A transação dublada: cada consulta responde pela tabela, e os passos ficam registrados. */
function transacaoDublada(linhas: Linhas, insert: () => Promise<unknown> = async () => undefined) {
  const passos: string[] = [];
  const inserido: { tabela?: unknown; valores?: Record<string, unknown> } = {};
  const resposta = (tabela: unknown) => {
    if (tabela === meetings) { passos.push("select meetings"); return linhas.reuniao ? [linhas.reuniao] : []; }
    if (tabela === meetingAudioSlices) { passos.push("select meeting_audio_slices"); return linhas.partes ?? []; }
    if (tabela === meetingRecordings) { passos.push("select meeting_recordings"); return linhas.gravacao ? [linhas.gravacao] : []; }
    throw new Error("tabela que a preparação do áudio não lê");
  };
  const tx = {
    select: () => ({
      from: (tabela: unknown) => ({
        where: () => ({
          limit: async () => resposta(tabela),
          // A ordenação pode terminar a consulta (as partes) ou seguir para o limit (a gravação mais recente).
          orderBy: () => {
            let lidas: unknown[] | null = null;
            const ler = () => (lidas ??= resposta(tabela));
            return { then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve().then(ler).then(ok, falha), limit: async () => ler() };
          },
        }),
      }),
    }),
    insert: (tabela: unknown) => ({
      values: async (valores: Record<string, unknown>) => {
        passos.push("insert");
        inserido.tabela = tabela;
        inserido.valores = valores;
        return insert();
      },
    }),
  };
  const db = {
    // Fora da transação, nada: ler ou gravar pelo banco solto falha o teste.
    select: () => { throw new Error("leitura fora da transação"); },
    insert: () => { throw new Error("gravação fora da transação"); },
    transaction: async (trabalho: (t: typeof tx) => Promise<unknown>) => {
      passos.push("begin");
      try {
        const resultado = await trabalho(tx);
        passos.push("commit");
        return resultado;
      } catch (erro) {
        passos.push("rollback");
        throw erro;
      }
    },
  };
  return { db, passos, inserido };
}

async function prepararCom(linhas: Linhas, insert?: () => Promise<unknown>, pedido = PEDIDO) {
  const dublada = transacaoDublada(linhas, insert);
  banco.atual = dublada.db;
  try {
    const resultado = await prepararAudioDaReuniao("dona-1", "reuniao-1", pedido, AGORA).then(dados => ({ dados }), erro => ({ erro }));
    return { ...dublada, ...resultado };
  } finally {
    banco.atual = null;
  }
}
const erroDe = (r: object) => (r as { erro: { code?: string; message?: string } }).erro;

describe("preparar: a leitura das partes e a auditoria na mesma transação", () => {
  it("a auditoria não entra: a transação volta atrás e nenhuma parte sai", async () => {
    const r = await prepararCom({ reuniao: REUNIAO_EM_PARTES, partes: [linha(0), linha(1)] }, async () => { throw new Error("audit_logs recusou"); });
    expect(r).not.toHaveProperty("dados");
    expect(erroDe(r).message).toBe("audit_logs recusou");
    expect(r.passos).toEqual(["begin", "select meetings", "select meeting_audio_slices", "insert", "rollback"]);
  });

  it("a auditoria entra depois de tudo lido, em audit_logs, e só então as partes saem", async () => {
    const r = await prepararCom({ reuniao: REUNIAO_EM_PARTES, partes: [linha(0), linha(1)] });
    expect(r.passos).toEqual(["begin", "select meetings", "select meeting_audio_slices", "insert", "commit"]);
    expect(r.inserido.tabela).toBe(auditLogs);
    expect(r).toHaveProperty("dados");
  });

  it("a linha leva o formato, as contagens, a duração e os formatos de origem, com IP e navegador cortados; nunca a chave do bucket", async () => {
    const partes = [linha(0), linha(1, { mimeType: "audio/mp4", storageKey: "meetings/dona-1/reuniao-1/partes/0001-ffff0000.m4a" }), linha(2, { mimeType: "audio/mpeg", durationMs: 120_000 })];
    const r = await prepararCom({ reuniao: REUNIAO_EM_PARTES, partes }, undefined,
      { ...PEDIDO, formato: "m4a", ipAddress: `198.51.100.23, 10.0.0.1${"9".repeat(60)}`, userAgent: "u".repeat(800) });
    expect(r.inserido.valores).toEqual({
      userId: 7,
      action: ACAO_AUDIO_BAIXADO,
      resource: "meetings",
      resourceId: "reuniao-1",
      details: { formato: "m4a", partes: 3, duracaoSegundos: 1320, emPartes: true, formatosDeOrigem: ["audio/mp4", "audio/mpeg", "audio/webm"] },
      ipAddress: "198.51.100.23",
      userAgent: "u".repeat(500),
      status: "success",
      riskLevel: "medium",
    });
    expect(ACAO_AUDIO_BAIXADO).toBe("MEETING_AUDIO_DOWNLOADED");
    expect(JSON.stringify(r.inserido.valores)).not.toMatch(/meetings\/dona-1|partes\/|\.webm|\.m4a/);
  });

  it("o envio único sai como uma parte só, da gravação mais recente", async () => {
    const r = await prepararCom({
      reuniao: REUNIAO_DE_ENVIO_UNICO,
      gravacao: { storageKey: "meetings/dona-1/recording_x.m4a", mimeType: "audio/m4a", durationSeconds: 95, expiresAt: AGORA + DIA },
    });
    expect(r.passos).toEqual(["begin", "select meetings", "select meeting_recordings", "insert", "commit"]);
    expect((r as { dados: unknown }).dados).toEqual({
      partes: [{ seq: 0, storageKey: "meetings/dona-1/recording_x.m4a", mimeType: "audio/m4a", inicioMs: 0, duracaoMs: 95_000 }],
      duracaoSegundos: 95,
    });
    expect((r.inserido.valores?.details as { emPartes: boolean }).emPartes).toBe(false);
  });

  it.each(["processing", "ready", "failed"])("reunião '%s' baixa: o áudio já está inteiro no bucket", async status => {
    const r = await prepararCom({ reuniao: { ...REUNIAO_EM_PARTES, status }, partes: [linha(0)] });
    expect(r).toHaveProperty("dados");
  });
});

describe("preparar: as recusas não gravam nada", () => {
  it("reunião que não é da dona (ou excluída, ou que não existe): NOT_FOUND, sem ler o resto e sem auditoria", async () => {
    const r = await prepararCom({});
    expect(erroDe(r)).toMatchObject({ code: "NOT_FOUND", message: "Reunião não encontrada." });
    expect(r.passos).toEqual(["begin", "select meetings", "rollback"]);
    expect(r.inserido.valores).toBeUndefined();
  });

  it.each(["recording", "uploading"])("reunião '%s' (a gravação ainda chega): AUDIO_AINDA_GRAVANDO, sem auditoria", async status => {
    const r = await prepararCom({ reuniao: { ...REUNIAO_EM_PARTES, status }, partes: [linha(0)] });
    expect(erroDe(r)).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_AUDIO.aindaGravando });
    expect(r.passos).toEqual(["begin", "select meetings", "rollback"]);
  });

  it("partes vencidas (passaram dos 30 dias): AUDIO_VENCIDO, o código que a tela traduz, sem auditoria", async () => {
    const r = await prepararCom({ reuniao: REUNIAO_EM_PARTES, partes: [linha(0, { expiresAt: AGORA - 1 }), linha(1, { expiresAt: AGORA })] });
    expect(erroDe(r)).toMatchObject({ code: "PRECONDITION_FAILED", message: "AUDIO_VENCIDO" });
    expect(r.passos).toEqual(["begin", "select meetings", "select meeting_audio_slices", "rollback"]);
  });

  it("sem linha nenhuma: a reunião mais velha que o prazo venceu; a recente não tem áudio", async () => {
    const velha = await prepararCom({ reuniao: { ...REUNIAO_EM_PARTES, createdAt: AGORA - MEETING_AUDIO_TTL_MS }, partes: [] });
    expect(erroDe(velha)).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_AUDIO.vencido });
    const recente = await prepararCom({ reuniao: REUNIAO_EM_PARTES, partes: [] });
    expect(erroDe(recente)).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_AUDIO.ausente });
  });

  it("partes que nunca chegaram ou cujo áudio sumiu do bucket, no prazo: AUDIO_AUSENTE", async () => {
    const r = await prepararCom({ reuniao: REUNIAO_EM_PARTES, partes: [
      linha(0, { status: "uploading" }), linha(1, { status: "failed", lastError: "NAO_RECEBIDA" }), linha(2, { status: "failed", lastError: "AUDIO_AUSENTE" }),
    ] });
    expect(erroDe(r)).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_AUDIO.ausente });
    expect(r.inserido.valores).toBeUndefined();
  });

  it("a reunião em que todas as partes falharam na IA tem o áudio guardado: baixa, e não é 'sem áudio'", async () => {
    const r = await prepararCom({ reuniao: { ...REUNIAO_EM_PARTES, status: "failed" }, partes: [
      linha(0, { status: "failed", lastError: "TENTATIVAS_ESGOTADAS", offsetMs: null }),
      linha(1, { status: "failed", lastError: "IA_RECUSOU", offsetMs: null }),
    ] });
    expect((r as { dados: { partes: Array<{ seq: number; inicioMs: number }> } }).dados.partes.map(p => [p.seq, p.inicioMs])).toEqual([[0, 0], [1, 600_000]]);
    expect(r.passos).toEqual(["begin", "select meetings", "select meeting_audio_slices", "insert", "commit"]);
  });

  it("envio único vencido: AUDIO_VENCIDO; sem gravação, pela data da reunião", async () => {
    const vencida = await prepararCom({
      reuniao: REUNIAO_DE_ENVIO_UNICO,
      gravacao: { storageKey: "k", mimeType: "audio/webm", durationSeconds: 60, expiresAt: AGORA },
    });
    expect(erroDe(vencida)).toMatchObject({ message: RECUSAS_DO_AUDIO.vencido });
    expect(vencida.inserido.valores).toBeUndefined();
    const semGravacao = await prepararCom({ reuniao: REUNIAO_DE_ENVIO_UNICO });
    expect(erroDe(semGravacao)).toMatchObject({ message: RECUSAS_DO_AUDIO.ausente });
  });
});

describe("partesParaBaixar: as partes na ordem e no tempo do player", () => {
  it("ordena pelo seq, usa o início gravado pela fila e, sem ele, a soma das anteriores (contando as que não saem)", () => {
    const partes = partesParaBaixar([
      linha(3, { offsetMs: null, durationMs: 100_000 }),
      linha(0, { offsetMs: 0, durationMs: 600_000 }),
      // A parte 1 nunca subiu: não sai, mas o tempo dela conta para as seguintes.
      linha(1, { status: "failed", lastError: "NAO_RECEBIDA", offsetMs: null, durationMs: 590_000 }),
      linha(2, { status: "received", offsetMs: null, durationMs: 610_000 }),
    ], AGORA);
    expect(partes.map(p => [p.seq, p.inicioMs, p.duracaoMs])).toEqual([[0, 0, 600_000], [2, 1_190_000, 610_000], [3, 1_800_000, 100_000]]);
  });

  it("parte vencida ou ainda subindo não sai", () => {
    const partes = partesParaBaixar([linha(0), linha(1, { status: "uploading" }), linha(2, { expiresAt: AGORA })], AGORA);
    expect(partes.map(p => p.seq)).toEqual([0]);
  });

  // O áudio da parte que falhou na IA continua no bucket (o reprocesso o relê):
  // sem ele, o arquivo trazia silêncio justo no trecho sem transcrição.
  it("a parte que falhou na IA, no banco ou nas tentativas sai; a que nunca subiu ou cujo áudio sumiu do bucket, não", () => {
    const causas = ["IA_INDISPONIVEL", "IA_RECUSOU", "IA_CORTOU", "TEMPOS_FORA_DA_PARTE", "TENTATIVAS_ESGOTADAS", "BANCO_INDISPONIVEL", "ERRO", null];
    const linhas = [
      ...causas.map((lastError, seq) => linha(seq, { status: "failed", lastError })),
      linha(causas.length, { status: "failed", lastError: "NAO_RECEBIDA" }),
      linha(causas.length + 1, { status: "failed", lastError: "AUDIO_AUSENTE" }),
    ];
    expect(partesParaBaixar(linhas, AGORA).map(p => p.seq)).toEqual(causas.map((_c, seq) => seq));
  });

  it("a mesma regra do reprocesso: a parte com falha da IA no meio sai no tempo dela, entre as transcritas", () => {
    const partes = partesParaBaixar([linha(0), linha(1, { status: "failed", lastError: "IA_RECUSOU", offsetMs: null }), linha(2)], AGORA);
    expect(partes.map(p => [p.seq, p.inicioMs])).toEqual([[0, 0], [1, 600_000], [2, 1_200_000]]);
  });
});

describe("o balcão das fichas", () => {
  const FICHA = { ownerId: "dona-1", meetingId: "reuniao-1", formato: "mp3" as const, nomeDoArquivo: "Reunião.mp3", partes: [] };

  it("a ficha tem 192 bits aleatórios, serve uma vez só, e só para a dona dela", () => {
    const balcao = criarBalcaoDoAudio({ limite: 5 });
    const numero = balcao.reservar().emitir(FICHA);
    expect(numero).toMatch(FORMATO_DA_FICHA);
    expect(balcao.reservar().emitir(FICHA)).not.toBe(numero);
    // Outra conta não leva nem estraga: a ficha segue valendo para a dona.
    expect(balcao.tomar(numero, "outra-conta")).toBeNull();
    const tomada = balcao.tomar(numero, "dona-1");
    expect(tomada?.ficha).toEqual(FICHA);
    expect(balcao.tomar(numero, "dona-1")).toBeNull();
    expect(balcao.tomar("x".repeat(31), "dona-1")).toBeNull();
    expect(balcao.tomar("../../etc/passwd", "dona-1")).toBeNull();
  });

  it("a ficha vence depois da validade, e a vaga dela volta", () => {
    let agora = 1_000;
    const balcao = criarBalcaoDoAudio({ limite: 1, validadeMs: 120_000, relogio: () => agora });
    const numero = balcao.reservar().emitir(FICHA);
    expect(() => balcao.reservar()).toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS", message: RECUSAS_DO_AUDIO.ocupado }));
    agora += 120_000;
    expect(balcao.tomar(numero, "dona-1")).toBeNull();
    expect(balcao.ocupadas()).toBe(0);
    expect(() => balcao.reservar()).not.toThrow();
  });

  it("o limite conta as reservas, as fichas no prazo e os downloads em curso; soltar e terminar devolvem a vaga, uma vez só", () => {
    const balcao = criarBalcaoDoAudio({ limite: 2 });
    const reserva = balcao.reservar();
    const numero = balcao.reservar().emitir(FICHA);
    expect(() => balcao.reservar()).toThrow(expect.objectContaining({ message: "AUDIO_OCUPADO" }));
    reserva.soltar();
    reserva.soltar();
    expect(balcao.ocupadas()).toBe(1);
    const tomada = balcao.tomar(numero, "dona-1")!;
    // Em curso, o download segue ocupando a vaga.
    expect(balcao.ocupadas()).toBe(1);
    tomada.terminar();
    tomada.terminar();
    expect(balcao.ocupadas()).toBe(0);
    expect(() => reserva.emitir(FICHA)).toThrow();
  });

  // G14, parte 2: a conversão da parte do recuo do corte usa o mesmo ffmpeg, e a instância tem 1 CPU.
  it("a conversão da rota das partes divide as vagas com o download: com as duas tomadas, nem conversão nem download entram; soltar devolve uma vez só", () => {
    const balcao = criarBalcaoDoAudio({ limite: 2 });
    const primeira = balcao.tentarConverter()!;
    const segunda = balcao.tentarConverter()!;
    expect(balcao.ocupadas()).toBe(2);
    expect(balcao.tentarConverter()).toBeNull();
    expect(() => balcao.reservar()).toThrow(expect.objectContaining({ message: "AUDIO_OCUPADO" }));
    primeira();
    primeira();
    expect(balcao.ocupadas()).toBe(1);
    // O download que entra ocupa a vaga que sobrou: a conversão seguinte espera.
    const reserva = balcao.reservar();
    expect(balcao.tentarConverter()).toBeNull();
    reserva.soltar();
    segunda();
    expect(balcao.ocupadas()).toBe(0);
  });

  it("a fila curta da conversão: espera a vaga que solta no meio e, sem vaga no prazo, devolve null", async () => {
    const balcao = criarBalcaoDoAudio({ limite: 1 });
    const tomada = balcao.tentarConverter()!;
    let esperas = 0;
    const esperar = async () => { esperas++; if (esperas === 3) tomada(); };
    const soltar = await esperarVagaDeConversao(balcao, 10_000, esperar);
    expect(soltar).toBeTypeOf("function");
    expect(esperas).toBe(3);
    expect(balcao.ocupadas()).toBe(1);

    let semVaga = 0;
    expect(await esperarVagaDeConversao(balcao, 1_000, async () => { semVaga++; })).toBeNull();
    // 1 s em passos de 250 ms: quatro esperas e a última tentativa, sem espera depois dela.
    expect(semVaga).toBe(4);
    soltar!();
    expect(balcao.ocupadas()).toBe(0);
  });
});

describe("a conferência do ffmpeg", () => {
  it("sem o executável, não: e só confere de novo depois de um minuto", async () => {
    let agora = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const conferir = criarConferenciaDoFfmpeg("ffmpeg-que-nao-existe-wrw", () => agora);
    await expect(conferir()).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("baixar o áudio fica indisponível"));
    agora += 59_000;
    await expect(conferir()).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
    agora += 2_000;
    await expect(conferir()).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  const temFfmpeg = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0;
  it.skipIf(!temFfmpeg && process.env.CI !== "true")("com o ffmpeg da máquina (libmp3lame e aac), sim, e o sim fica guardado", async () => {
    const conferir = criarConferenciaDoFfmpeg();
    await expect(conferir()).resolves.toBe(true);
    await expect(conferir()).resolves.toBe(true);
  }, 20_000);

  // Com o servidor como root, a conversão só sobe o ffmpeg como nobody: a
  // conferência sobe com o mesmo usuário, e a troca recusada vira "não" ANTES de
  // a preparação auditar e emitir a ficha de um download que falharia.
  it.each(["EPERM", "EINVAL"])("como root, a troca para o nobody recusada (%s): não, com o motivo no log", async codigo => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const opcoesDoSpawn: unknown[] = [];
    const recusada = ((_executavel: string, _args: readonly string[], opcoes: unknown) => {
      opcoesDoSpawn.push(opcoes);
      throw Object.assign(new Error(`spawn ${codigo}`), { code: codigo });
    }) as unknown as typeof import("node:child_process").spawn;
    const conferir = criarConferenciaDoFfmpeg("ffmpeg", () => 0, { usuario: { uid: 65534, gid: 65534 }, spawn: recusada });
    await expect(conferir()).resolves.toBe(false);
    expect(opcoesDoSpawn).toHaveLength(1);
    expect(opcoesDoSpawn[0]).toMatchObject({ uid: 65534, gid: 65534 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("não deixou o ffmpeg rodar como o usuário nobody"));
    vi.restoreAllMocks();
  });

  it("a conferência sobe o ffmpeg com o mesmo usuário da conversão (usuarioDoFfmpeg), e sem ele fora do root", async () => {
    const { usuarioDoFfmpeg } = await import("./conversao-do-audio");
    const opcoesDoSpawn: Array<Record<string, unknown>> = [];
    const espia = ((_executavel: string, _args: readonly string[], opcoes: Record<string, unknown>) => {
      opcoesDoSpawn.push(opcoes);
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    }) as unknown as typeof import("node:child_process").spawn;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await criarConferenciaDoFfmpeg("ffmpeg", () => 0, { spawn: espia })();
    const esperado = usuarioDoFfmpeg();
    if (esperado) expect(opcoesDoSpawn[0]).toMatchObject(esperado);
    else expect(opcoesDoSpawn[0]).not.toHaveProperty("uid");
    // Sem a troca (fora do root), o "não" é o de sempre, do ffmpeg que não subiu.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("não subiu ou não tem libmp3lame e aac"));
    vi.restoreAllMocks();
  });
});

describe("nomeDoArquivoDoAudio: o nome que o navegador grava", () => {
  it("o título e a data, sem o que o sistema de arquivos recusa, com a extensão do formato", () => {
    expect(nomeDoArquivoDoAudio("Reunião: importadora / Santos - 2026-11-18", "mp3")).toBe("Reunião importadora Santos - 2026-11-18.mp3");
    expect(nomeDoArquivoDoAudio("اجتماع مع المستورد - 2026-11-18", "m4a")).toBe("اجتماع مع المستورد - 2026-11-18.m4a");
    expect(nomeDoArquivoDoAudio('<>:"|?*', "mp3")).toBe("audio.mp3");
    expect(nomeDoArquivoDoAudio(undefined, "m4a")).toBe("audio.m4a");
    expect(nomeDoArquivoDoAudio("  ..reunião..  ", "mp3")).toBe("reunião.mp3");
  });

  it("sem controles de direção do texto nem quebras de linha: 'abc<RLO>3pm.exe' não se disfarça de outra extensão", () => {
    const nome = nomeDoArquivoDoAudio("abc\u202e3pm.exe\u2066x\u200f\r\nfim", "mp3");
    expect(nome).toBe("abc 3pm.exe x fim.mp3");
    expect(nome).not.toMatch(/[\u0000-\u001f\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  });

  it("no máximo 120 caracteres antes da extensão, contados por caractere (não por unidade UTF-16)", () => {
    expect(nomeDoArquivoDoAudio("a".repeat(300), "mp3")).toBe(`${"a".repeat(120)}.mp3`);
    const emoji = nomeDoArquivoDoAudio("🎙️".repeat(100), "mp3");
    expect(Array.from(emoji.replace(/\.mp3$/, "")).length).toBeLessThanOrEqual(120);
    expect(emoji).not.toMatch(/\uFFFD/);
  });
});

describe("tamanhoEstimadoDoAudio: 64 kbps", () => {
  it("uma hora dá 28,8 MB; 12 h, ~346 MB; duração inválida, zero", () => {
    expect(tamanhoEstimadoDoAudio(3600)).toBe(28_800_000);
    expect(tamanhoEstimadoDoAudio(12 * 3600)).toBe(345_600_000);
    expect(tamanhoEstimadoDoAudio(0)).toBe(0);
    expect(tamanhoEstimadoDoAudio(Number.NaN)).toBe(0);
    expect(tamanhoEstimadoDoAudio(-5)).toBe(0);
  });
});
