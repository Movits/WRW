import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O laço da varredura das gravações vencidas (server/varredura-de-gravacoes.ts):
 * uma passada no boot, sem segurar quem o liga, e outra 5 min depois do fim de
 * cada passada; nunca duas juntas; erro é log; o que apagou vai para a
 * auditoria; e o desligamento para o laço sem esperar além do teto. A varredura
 * em si (limparGravacoesVencidas) é dublê: o que ela faz no banco está em
 * server/retencao-do-audio.integracao.test.ts.
 */

const limparGravacoesVencidas = vi.hoisted(() => vi.fn());
const createAuditLog = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./meeting-service", () => ({ limparGravacoesVencidas: (...args: unknown[]) => limparGravacoesVencidas(...args) }));
vi.mock("./security", () => ({ createAuditLog: (...args: unknown[]) => createAuditLog(...(args as [])) }));

type Laco = typeof import("./varredura-de-gravacoes");
let laco: Laco;
const bucketAntes = process.env.STORAGE_BUCKET;

/** Uma passada que só termina quando o teste manda. */
function passadaPendente() {
  let terminar: (resultado: { encontradas: number; apagadas: number }) => void = () => {};
  let falhar: (erro: unknown) => void = () => {};
  limparGravacoesVencidas.mockImplementationOnce(() => new Promise((resolver, rejeitar) => { terminar = resolver; falhar = rejeitar; }));
  return { terminar: (r = { encontradas: 0, apagadas: 0 }) => terminar(r), falhar: (erro: unknown) => falhar(erro) };
}
/** Deixa correr as microtarefas encadeadas no fim de uma passada (log, auditoria, agendar a próxima). */
const esvaziar = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  limparGravacoesVencidas.mockReset();
  limparGravacoesVencidas.mockResolvedValue({ encontradas: 0, apagadas: 0 });
  createAuditLog.mockClear();
  process.env.STORAGE_BUCKET = "bucket-de-teste";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  laco = await import("./varredura-de-gravacoes");
});

afterEach(async () => {
  // A espera do desligamento é um setTimeout, falso aqui: o relógio anda para
  // ela vencer, e uma passada deixada pendente por um teste não vaza no seguinte.
  const parando = laco.pararVarreduraDeGravacoes(0);
  await vi.advanceTimersByTimeAsync(1);
  await parando;
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (bucketAntes === undefined) delete process.env.STORAGE_BUCKET;
  else process.env.STORAGE_BUCKET = bucketAntes;
});

describe("o laço da varredura das gravações", () => {
  it("liga e devolve na hora: a passada do boot começa já, sem ser aguardada por quem liga", () => {
    passadaPendente();
    expect(laco.iniciarVarreduraDeGravacoes()).toBeUndefined();
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(1);
    const [opcoes] = limparGravacoesVencidas.mock.calls[0] as [{ deveParar: () => boolean }];
    expect(opcoes.deveParar()).toBe(false);
  });

  it("a passada seguinte vem 5 min depois do FIM da anterior, e uma passada lenta nunca ganha outra junto", async () => {
    const lenta = passadaPendente();
    laco.iniciarVarreduraDeGravacoes();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(1);

    lenta.terminar();
    await esvaziar();
    await vi.advanceTimersByTimeAsync(laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS - 1);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(3);
  });

  it("erro numa passada é log, não rejeição solta, e a passada seguinte vem do mesmo jeito", async () => {
    limparGravacoesVencidas.mockRejectedValueOnce(new Error("bucket fora"));
    laco.iniciarVarreduraDeGravacoes();
    await esvaziar();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain("bucket fora");
    await vi.advanceTimersByTimeAsync(laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(2);
  });

  it("a passada que apagou algo vai para a auditoria (CRON_CLEANUP_RECORDINGS, com a origem) e para o log; a que não apagou nada, não", async () => {
    limparGravacoesVencidas.mockResolvedValueOnce({ encontradas: 3, apagadas: 2 });
    laco.iniciarVarreduraDeGravacoes();
    await esvaziar();
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: null, action: "CRON_CLEANUP_RECORDINGS", resource: "meeting_recordings", status: "success",
      details: { encontradas: 3, apagadas: 2, origem: "Boot" },
    }));
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).toContain("2 de 3");

    await vi.advanceTimersByTimeAsync(laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(2);
    expect(createAuditLog).toHaveBeenCalledTimes(1);
  });

  it("a auditoria fora do ar não derruba o laço", async () => {
    limparGravacoesVencidas.mockResolvedValueOnce({ encontradas: 1, apagadas: 1 });
    createAuditLog.mockRejectedValueOnce(new Error("audit_logs fora"));
    laco.iniciarVarreduraDeGravacoes();
    await esvaziar();
    expect(console.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(2);
  });

  it("sem STORAGE_BUCKET (dev com banco e sem bucket), a passada é pulada: não há o que apagar", async () => {
    delete process.env.STORAGE_BUCKET;
    laco.iniciarVarreduraDeGravacoes();
    await vi.advanceTimersByTimeAsync(3 * laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).not.toHaveBeenCalled();
  });
});

describe("o desligamento do laço", () => {
  it("sem passada em curso: para na hora, e nenhuma passada nova começa", async () => {
    laco.iniciarVarreduraDeGravacoes();
    await esvaziar();
    expect(await laco.pararVarreduraDeGravacoes()).toEqual({ emCurso: false, terminou: true });
    await vi.advanceTimersByTimeAsync(3 * laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(1);
  });

  it("com passada em curso: ela recebe o aviso de parar antes do próximo áudio, e o desligamento a espera terminar", async () => {
    const emCurso = passadaPendente();
    laco.iniciarVarreduraDeGravacoes();
    const [opcoes] = limparGravacoesVencidas.mock.calls[0] as [{ deveParar: () => boolean }];
    const parando = laco.pararVarreduraDeGravacoes(1_000);
    expect(opcoes.deveParar()).toBe(true);
    emCurso.terminar();
    expect(await parando).toEqual({ emCurso: true, terminou: true });
    await vi.advanceTimersByTimeAsync(3 * laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(1);
  });

  it("a espera tem teto: um bucket travado não segura o desligamento além dele, e a passada não se reagenda depois", async () => {
    const travada = passadaPendente();
    laco.iniciarVarreduraDeGravacoes();
    const parando = laco.pararVarreduraDeGravacoes(1_000);
    await vi.advanceTimersByTimeAsync(999);
    let resolvido = false;
    void parando.then(() => { resolvido = true; });
    await esvaziar();
    expect(resolvido).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await parando).toEqual({ emCurso: true, terminou: false });

    travada.terminar();
    await esvaziar();
    await vi.advanceTimersByTimeAsync(3 * laco.INTERVALO_DA_VARREDURA_DE_GRAVACOES_MS);
    expect(limparGravacoesVencidas).toHaveBeenCalledTimes(1);
  });
});
