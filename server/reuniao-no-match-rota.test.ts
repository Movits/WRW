import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
process.env.DATABASE_URL ??= "mysql://teste:teste@localhost/teste";

/**
 * N5 — o que a rota faz depois de confirmar um item que vai ao PERFIL da dona
 * (revisão da N5). O serviço é dublado: aqui se prova a fiação da rota, que o
 * teste de integração não alcança (a dona dele é sempre Prata).
 *
 * - O item que MUDOU o perfil refaz a régua da Prata: a conta Bronze a que só
 *   faltavam Tenho e Preciso sobe na hora, sem salvar o Perfil.
 * - O item que o perfil já tinha não muda nada, e a régua nem roda.
 * - O último item do perfil de uma reunião recalcula o motor de perfis.
 *
 * O serviço com banco (confirmarItemDaDona, ignorarItemDaDona) está em
 * server/reuniao-no-match.integracao.test.ts; a régua, em server/nivel-do-perfil.test.ts.
 */
const servico = vi.hoisted(() => ({
  confirmarItemDaDona: vi.fn(),
  recalcularOMotorDePerfis: vi.fn(async (_userId: number) => {}),
  reavaliarNivelPeloPerfil: vi.fn(async (_usuaria: { id: number; role: string }) => ({ promovidaAPrata: true })),
}));
vi.mock("./reuniao-no-match", async original => ({
  ...await original<typeof import("./reuniao-no-match")>(),
  confirmarItemDaDona: servico.confirmarItemDaDona,
  recalcularOMotorDePerfis: servico.recalcularOMotorDePerfis,
}));
vi.mock("./nivel-do-perfil", async original => ({
  ...await original<typeof import("./nivel-do-perfil")>(),
  reavaliarNivelPeloPerfil: servico.reavaliarNivelPeloPerfil,
}));

const { networkInteligenteRouter } = await import("./routers/networkInteligente");

const BRONZE = { id: 9, openId: "dona-9", email: "dona@local", role: "bronze", onboardingCompleted: true };
const chamar = () => networkInteligenteRouter.createCaller({ user: BRONZE, req: { headers: {}, socket: {} }, res: { cookie: () => {} } } as never);
const ID = "5b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const doPerfil = (dados: { mudouPerfil?: boolean; reuniaoDecidida?: boolean } = {}) =>
  ({ alvo: "perfil" as const, campo: "preciso" as const, meetingId: "m-1", mudouPerfil: true, reuniaoDecidida: false, ...dados });

beforeEach(() => {
  servico.confirmarItemDaDona.mockReset();
  servico.recalcularOMotorDePerfis.mockClear();
  servico.reavaliarNivelPeloPerfil.mockClear();
});

describe("confirmar um item do perfil (N5)", () => {
  it("o item que mudou o perfil refaz a régua da Prata: a conta Bronze sobe na hora", async () => {
    servico.confirmarItemDaDona.mockResolvedValue(doPerfil());
    expect(await chamar().confirmarPendencia({ id: ID, categoria: "outra_necessidade" })).toMatchObject({ alvo: "perfil", mudouPerfil: true, promovidaAPrata: true });
    expect(servico.confirmarItemDaDona).toHaveBeenCalledWith(expect.objectContaining({ id: 9, openId: "dona-9" }), ID, expect.objectContaining({ categoria: "outra_necessidade" }));
    expect(servico.reavaliarNivelPeloPerfil).toHaveBeenCalledTimes(1);
    expect(servico.reavaliarNivelPeloPerfil).toHaveBeenCalledWith(expect.objectContaining({ id: 9, role: "bronze" }));
    // A reunião ainda tem item do perfil esperando: o motor de perfis espera também.
    expect(servico.recalcularOMotorDePerfis).not.toHaveBeenCalled();
  });

  it("o item que o perfil já tinha não muda nada: a régua nem roda", async () => {
    servico.confirmarItemDaDona.mockResolvedValue(doPerfil({ mudouPerfil: false }));
    expect(await chamar().confirmarPendencia({ id: ID })).toMatchObject({ mudouPerfil: false, promovidaAPrata: false });
    expect(servico.reavaliarNivelPeloPerfil).not.toHaveBeenCalled();
  });

  it("o último item do perfil da reunião recalcula o motor de perfis, uma vez, para a dona", async () => {
    servico.confirmarItemDaDona.mockResolvedValue(doPerfil({ reuniaoDecidida: true }));
    await chamar().confirmarPendencia({ id: ID });
    expect(servico.recalcularOMotorDePerfis).toHaveBeenCalledTimes(1);
    expect(servico.recalcularOMotorDePerfis).toHaveBeenCalledWith(9);
  });
});
