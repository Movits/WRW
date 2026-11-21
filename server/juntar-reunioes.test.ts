import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });

const { deslocarResultado, maiorRotuloDaReuniao, planejarJuncao, RecusaDaJuncao, MAIOR_ROTULO } = await import("./juntar-reunioes");
type ReuniaoParaJuntar = import("./juntar-reunioes").ReuniaoParaJuntar;
type ParteParaJuntar = import("./juntar-reunioes").ParteParaJuntar;
const { RECUSAS_DA_JUNCAO } = await import("@shared/juntar-reunioes");
const { MARCA_DE_OUTRA_REUNIAO } = await import("./transcricao-de-fatia");
const { LIMITE_PROCESSAMENTO_MS, margemDoReprocesso, PARTES_POR_REUNIAO_MAX } = await import("@shared/const");

/**
 * O plano da junção de reuniões (H17), sem banco: a conta das posições, dos
 * tempos e dos rótulos das vozes, os nomes, os detalhes e as recusas. A
 * transação de verdade está em juntar-reunioes.integracao.test.ts.
 */
const DONA = "dona-da-juncao";
const AGORA = Date.UTC(2026, 10, 21, 12);
const PRAZO = AGORA + 20 * 24 * 60 * 60_000;

const fala = (inicio: number, falante: string, texto: string) => ({ inicio, fim: inicio + 5, falante, texto });
const parte = (seq: number, segmentos: ReturnType<typeof fala>[], extra: Partial<ParteParaJuntar> = {}): ParteParaJuntar => ({
  id: `parte-${seq}-${Math.random()}`, seq, status: "transcribed", durationMs: 600_000, offsetMs: seq * 600_000,
  result: { segmentos, contexto: { falantes: Array.from(new Set(segmentos.map(s => s.falante))), ultimasFalas: segmentos.slice(-1) } },
  lastError: null, expiresAt: PRAZO, ...extra,
});
const emPartes = (id: string, partes: ParteParaJuntar[], extra: Partial<ReuniaoParaJuntar> = {}): ReuniaoParaJuntar => ({
  id, status: "ready", audioPipeline: "slices", origem: "gravacao", consentGranted: true, expectedSlices: partes.length,
  speakerNames: null, etiquetas: null, ondeFoi: null, contactId: null, contextId: null, shareToken: null, partes, gravacao: null, ...extra,
});
const envioUnico = (id: string, extra: Partial<ReuniaoParaJuntar> = {}): ReuniaoParaJuntar => ({
  ...emPartes(id, []), audioPipeline: "single", origem: null, expectedSlices: null,
  gravacao: {
    id: `gravacao-${id}`, storageKey: `meetings/${DONA}/${id}/recording.webm`, storageUrl: `/manus-storage/meetings/${DONA}/${id}/recording.webm`,
    mimeType: "audio/webm", sizeBytes: 1000, durationSeconds: 300, expiresAt: PRAZO, createdAt: AGORA - 1000,
  },
  ...extra,
});

describe("deslocarResultado", () => {
  it("desloca os rótulos (F1 → F3) e os tempos das falas, do contexto e das últimas falas; o resto fica", () => {
    const original = { segmentos: [fala(10, "F1", "oi"), fala(20, "F2", "olá")], contexto: { falantes: ["F1", "F2"], ultimasFalas: [fala(20, "F2", "olá")] }, tempos: { foraDaParte: 1 } };
    expect(deslocarResultado(original, 2, 1200)).toEqual({
      segmentos: [fala(1210, "F3", "oi"), fala(1220, "F4", "olá")],
      contexto: { falantes: ["F3", "F4"], ultimasFalas: [fala(1220, "F4", "olá")] },
      tempos: { foraDaParte: 1 },
    });
  });

  it("sem deslocamento de rótulo, só o tempo; o que não é fala passa intacto", () => {
    expect(deslocarResultado({ segmentos: [fala(1, "F1", "a"), { lixo: true }] }, 0, 60)).toEqual({ segmentos: [fala(61, "F1", "a"), { lixo: true }] });
    expect(deslocarResultado(null, 2, 60)).toBeNull();
  });
});

describe("maiorRotuloDaReuniao", () => {
  it("olha as falas, o contexto e os nomes que a dona deu", () => {
    expect(maiorRotuloDaReuniao({ partes: [parte(0, [fala(1, "F2", "x")])], speakerNames: { F5: "Eva" } })).toBe(5);
    expect(maiorRotuloDaReuniao({ partes: [parte(0, [fala(1, "F3", "x")])], speakerNames: null })).toBe(3);
  });
});

describe("planejarJuncao — reuniões em partes", () => {
  const primeira = emPartes("a", [parte(0, [fala(5, "F1", "Ana abre"), fala(300, "F2", "Bia responde")]), parte(1, [fala(700, "F1", "Ana fecha")])], {
    speakerNames: { F1: "Ana", F2: "Bia" }, etiquetas: ["Clientes"], contactId: 7,
  });
  const segunda = emPartes("b", [parte(0, [fala(2, "F1", "Caio começa"), fala(40, "F2", "Duda")])], {
    speakerNames: { F1: "Caio" }, etiquetas: ["clientes", "Vendas"], ondeFoi: "Zoom", contextId: "ctx-9",
  });

  it("a primeira fica como está; as partes da segunda entram depois, com a posição, o início, o tempo e os rótulos deslocados", () => {
    const plano = planejarJuncao(DONA, [primeira, segunda], AGORA);
    expect(plano.esperadas).toBe(3);
    expect(plano.duracaoSegundos).toBe(1800);
    expect(plano.retranscreve).toBe(false);
    expect(plano.gravacoes).toEqual([]);
    // Só a parte da segunda muda: a primeira já está no lugar.
    expect(plano.partes).toHaveLength(1);
    const [movida] = plano.partes;
    expect(movida).toMatchObject({ id: segunda.partes[0].id, seq: 2, offsetMs: 1_200_000, status: "transcribed", retranscrever: false });
    // A segunda não escolheu idioma (a linha de antes da G16): as falas levam o padrão, em que foram transcritas.
    expect((movida.result as { segmentos: unknown[] }).segmentos).toEqual([
      { ...fala(1202, "F3", "Caio começa"), idioma: "pt-BR" }, { ...fala(1240, "F4", "Duda"), idioma: "pt-BR" },
    ]);
  });

  it("G16: as falas da reunião com idioma escolhido levam esse idioma; as do \"Detectar sozinho\" ficam com o que a IA viu", () => {
    const alvoAuto = emPartes("a", [parte(0, [{ ...fala(5, "F1", "Ciao a tutti"), idioma: "it" } as ReturnType<typeof fala>])], { language: "auto" });
    const emIngles = emPartes("b", [parte(0, [fala(2, "F1", "Hello everyone"), { ...fala(40, "F2", "[inaudível]"), lacuna: true } as ReturnType<typeof fala>])], { language: "en" });
    const tambemAuto = emPartes("c", [parte(0, [{ ...fala(1, "F1", "Hola"), idioma: "es" } as ReturnType<typeof fala>, fala(9, "F1", "sem idioma")])], { language: "auto" });
    const plano = planejarJuncao(DONA, [alvoAuto, emIngles, tambemAuto], AGORA);
    const segmentosDe = (id: string) => (plano.partes.find(p => p.id === id)!.result as { segmentos: Array<Record<string, unknown>> }).segmentos;
    // A fala do inglês ganha o "en"; a lacuna, não.
    expect(segmentosDe(emIngles.partes[0].id).map(s => s.idioma)).toEqual(["en", undefined]);
    // No "Detectar sozinho", o idioma é o que a IA marcou; a fala sem marca fica sem.
    expect(segmentosDe(tambemAuto.partes[0].id).map(s => s.idioma)).toEqual(["es", undefined]);
  });

  it("os nomes das vozes vão junto, nos rótulos novos; os detalhes juntam etiquetas e ficam com o primeiro que houver", () => {
    const plano = planejarJuncao(DONA, [primeira, segunda], AGORA);
    expect(plano.nomes).toEqual({ F1: "Ana", F2: "Bia", F3: "Caio" });
    expect(plano.etiquetas).toEqual(["Clientes", "Vendas"]);
    expect(plano.ondeFoi).toBe("Zoom");
    expect(plano.contactId).toBe(7);
    expect(plano.contextId).toBe("ctx-9");
  });

  it("a parte que não chegou na primeira conta a duração padrão e empurra o início da seguinte", () => {
    const comLacuna = emPartes("a", [parte(0, [fala(5, "F1", "x")])], { expectedSlices: 2 });
    const plano = planejarJuncao(DONA, [comLacuna, segunda], AGORA);
    expect(plano.esperadas).toBe(3);
    // As linhas (o expected_slices gravado) não contam a lacuna: a fila não espera por ela de novo.
    expect(plano.linhas).toBe(2);
    expect(plano.partes[0]).toMatchObject({ seq: 2, offsetMs: 1_200_000 });
  });

  it("três reuniões: os rótulos seguem somando, na ordem escolhida", () => {
    const terceira = emPartes("c", [parte(0, [fala(1, "F1", "Eva")])], { speakerNames: { F1: "Eva" } });
    const plano = planejarJuncao(DONA, [primeira, segunda, terceira], AGORA);
    expect(plano.nomes).toEqual({ F1: "Ana", F2: "Bia", F3: "Caio", F5: "Eva" });
    const daTerceira = plano.partes.find(p => p.id === terceira.partes[0].id)!;
    expect(daTerceira).toMatchObject({ seq: 3, offsetMs: 1_800_000 });
    expect((daTerceira.result as { segmentos: Array<{ falante: string }> }).segmentos[0].falante).toBe("F5");
  });
});

describe("planejarJuncao — envio único", () => {
  it("a gravação vira uma parte 'received', e tudo o que vem depois é transcrito de novo, sem os nomes", () => {
    const primeira = emPartes("a", [parte(0, [fala(5, "F1", "Ana")])], { speakerNames: { F1: "Ana" } });
    const meio = envioUnico("b");
    const terceira = emPartes("c", [parte(0, [fala(1, "F1", "Caio")])], { speakerNames: { F1: "Caio" } });
    const plano = planejarJuncao(DONA, [primeira, meio, terceira], AGORA);
    expect(plano.retranscreve).toBe(true);
    // As duas começam outra conversa: a fila as transcreve sem o contexto da anterior.
    expect(plano.gravacoes).toEqual([expect.objectContaining({ gravacaoId: "gravacao-b", seq: 1, durationMs: 300_000, mimeType: "audio/webm", outraReuniao: true })]);
    expect(plano.partes).toEqual([expect.objectContaining({
      id: terceira.partes[0].id, seq: 2, status: "received", result: { [MARCA_DE_OUTRA_REUNIAO]: true }, offsetMs: null, retranscrever: true,
    })]);
    // A primeira, antes do envio único, guarda os nomes; a terceira, transcrita de novo, não.
    expect(plano.nomes).toEqual({ F1: "Ana" });
    expect(plano.esperadas).toBe(3);
  });

  it("o alvo de envio único também vira parte, na posição 0", () => {
    const plano = planejarJuncao(DONA, [envioUnico("a"), envioUnico("b")], AGORA);
    expect(plano.gravacoes.map(g => [g.gravacaoId, g.seq, g.outraReuniao])).toEqual([["gravacao-a", 0, false], ["gravacao-b", 1, true]]);
    expect(plano.nomes).toBeNull();
  });

  it("só a primeira parte retranscrita de cada reunião leva a marca de outra conversa; a lacuna sem áudio não conta", () => {
    const tres = emPartes("c", [
      parte(0, [], { status: "failed", lastError: "AUDIO_AUSENTE", result: null }), parte(1, [fala(1, "F1", "x")]), parte(2, [fala(2, "F1", "y")]),
    ]);
    const plano = planejarJuncao(DONA, [envioUnico("a"), tres], AGORA);
    expect(plano.partes.map(p => [p.seq, p.status, p.result])).toEqual([
      [1, "failed", null], [2, "received", { [MARCA_DE_OUTRA_REUNIAO]: true }], [3, "received", null],
    ]);
  });

  it("parte sem áudio no bucket segue lacuna na retranscrição", () => {
    const comFalha = emPartes("c", [parte(0, [], { status: "failed", lastError: "AUDIO_AUSENTE", result: null })]);
    const plano = planejarJuncao(DONA, [envioUnico("a"), comFalha], AGORA);
    expect(plano.partes).toEqual([expect.objectContaining({ seq: 1, status: "failed", retranscrever: false })]);
  });
});

describe("planejarJuncao — recusas", () => {
  const boa = () => emPartes(`r-${Math.random()}`, [parte(0, [fala(1, "F1", "x")])]);
  const recusa = (fn: () => unknown) => { try { fn(); } catch (erro) { return erro as InstanceType<typeof RecusaDaJuncao>; } throw new Error("não recusou"); };

  it("reunião que não está pronta, ou sem consentimento: CONFLICT", () => {
    for (const status of ["processing", "recording", "uploading", "failed"]) {
      const erro = recusa(() => planejarJuncao(DONA, [boa(), { ...boa(), status }], AGORA));
      expect([erro.codigoTrpc, erro.message]).toEqual(["CONFLICT", RECUSAS_DA_JUNCAO.foraDoEstado]);
    }
    const semConsentimento = recusa(() => planejarJuncao(DONA, [boa(), { ...boa(), consentGranted: false }], AGORA));
    expect(semConsentimento.message).toBe(RECUSAS_DA_JUNCAO.foraDoEstado);
  });

  it("documento e YouTube não se juntam", () => {
    for (const origem of ["pdf", "foto", "youtube"]) {
      const erro = recusa(() => planejarJuncao(DONA, [boa(), { ...boa(), origem }], AGORA));
      expect([erro.codigoTrpc, erro.message]).toEqual(["PRECONDITION_FAILED", RECUSAS_DA_JUNCAO.soAudio]);
    }
  });

  it("sem áudio guardado (sem partes, gravação fora do espaço da reunião, ou vencendo antes do fim): SEM_AUDIO", () => {
    expect(recusa(() => planejarJuncao(DONA, [boa(), emPartes("x", [])], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.semAudio);
    const alheia = envioUnico("y");
    alheia.gravacao!.storageKey = "meetings/OUTRA/y/recording.webm";
    expect(recusa(() => planejarJuncao(DONA, [boa(), alheia], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.semAudio);
    const vencendo = emPartes("z", [parte(0, [fala(1, "F1", "x")], { expiresAt: AGORA + LIMITE_PROCESSAMENTO_MS - 1 })]);
    expect(recusa(() => planejarJuncao(DONA, [boa(), vencendo], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.semAudio);
    // Na retranscrição a margem é a do reprocesso, que cresce com as partes.
    const quase = emPartes("w", [parte(0, [fala(1, "F1", "x")], { expiresAt: AGORA + LIMITE_PROCESSAMENTO_MS + 1 })]);
    expect(planejarJuncao(DONA, [boa(), quase], AGORA).esperadas).toBe(2);
    expect(margemDoReprocesso(2)).toBeGreaterThan(LIMITE_PROCESSAMENTO_MS);
    expect(recusa(() => planejarJuncao(DONA, [envioUnico("v"), quase], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.semAudio);
  });

  it("parte ainda por resolver numa reunião pronta: não se mexe", () => {
    const pendente = emPartes("p", [parte(0, [], { status: "received", result: null })]);
    expect(recusa(() => planejarJuncao(DONA, [boa(), pendente], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.foraDoEstado);
  });

  it("passaria do teto de partes, de tempo ou de vozes: LONGA_DEMAIS", () => {
    const muitas = emPartes("m", Array.from({ length: PARTES_POR_REUNIAO_MAX }, (_, seq) => parte(seq, [fala(seq * 600, "F1", "x")], { durationMs: 1000 })));
    expect(recusa(() => planejarJuncao(DONA, [boa(), muitas], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.longaDemais);
    const longa = emPartes("l", Array.from({ length: 73 }, (_, seq) => parte(seq, [fala(seq * 600, "F1", "x")])));
    expect(recusa(() => planejarJuncao(DONA, [boa(), longa], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.longaDemais);
    const vozes = emPartes("v", [parte(0, [fala(1, `F${MAIOR_ROTULO}`, "x")])]);
    expect(recusa(() => planejarJuncao(DONA, [boa(), vozes], AGORA)).message).toBe(RECUSAS_DA_JUNCAO.longaDemais);
  });

  it("menos de duas ou mais que o teto: BAD_REQUEST", () => {
    expect(recusa(() => planejarJuncao(DONA, [boa()], AGORA)).codigoTrpc).toBe("BAD_REQUEST");
    expect(recusa(() => planejarJuncao(DONA, Array.from({ length: 11 }, boa), AGORA)).codigoTrpc).toBe("BAD_REQUEST");
  });
});
