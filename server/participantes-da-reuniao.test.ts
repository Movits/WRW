import { describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * As partes das participantes (R1b) e das vozes (H3c) que não falam com o
 * banco: o token do convite e o hash, a credencial da participante, o nome da
 * conta, os parsers das colunas das vozes, as juntadas na tela, o teto dos
 * convites e a leitora das rotas do link. O que depende do banco está em
 * server/participantes-da-reuniao.integracao.test.ts.
 */

const autenticar = vi.hoisted(() => vi.fn());
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: (...args: unknown[]) => autenticar(...args) } }));

const { comNovaTentativaNoDeadlock, gerarTokenDoConvite, hashDoConvite, nomeDaConta, tetoDosConvites } = await import("./participantes-da-reuniao");
const { leitoraDaRota } = await import("./leitora-do-link");
const { VOZES_ZERADAS } = await import("./meeting-service");
const { BancoIndisponivel } = await import("./banco-indisponivel");
const { contasDasVozes, vozesJuntadas, CONTA_DA_DONA } = await import("@shared/const");
const { nomesComJuntadas, falasComJuntadas, vozesNoTexto } = await import("@shared/vozes-no-texto");
const {
  credencialDaParticipante, reuniaoDaCredencial, FORMATO_DO_CONVITE, CONVITES_POR_JANELA, RECUSAS_DOS_PARTICIPANTES,
} = await import("@shared/participantes-da-reuniao");
const { rotaDoConvite, rotaDaReuniaoCompartilhada } = await import("@shared/rotas");

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const PARTICIPACAO = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

describe("dois aceites ao mesmo tempo: o deadlock do InnoDB", () => {
  // Como o drizzle entrega: o erro da consulta, com o do driver em `cause`.
  const deadlock = () => Object.assign(new Error("Failed query: select ... for update"), {
    cause: Object.assign(new Error("Deadlock found when trying to get lock; try restarting transaction"), { code: "ER_LOCK_DEADLOCK", errno: 1213 }),
  });

  it("a transação vítima roda de novo, e a nova leitura decide (a perdedora leva o código traduzido, não o erro cru)", async () => {
    const recusa = Object.assign(new Error(RECUSAS_DOS_PARTICIPANTES.conviteInvalido), { code: "NOT_FOUND" });
    const trabalho = vi.fn().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(recusa);
    await expect(comNovaTentativaNoDeadlock(trabalho)).rejects.toBe(recusa);
    expect(trabalho).toHaveBeenCalledTimes(2);
    const certo = vi.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce({ meetingId: ID });
    await expect(comNovaTentativaNoDeadlock(certo)).resolves.toEqual({ meetingId: ID });
  });

  it("outro erro não se repete, e o deadlock que insiste sai depois de 3 tentativas", async () => {
    const outro = new Error("Table 'meeting_participants' is marked as crashed");
    const uma = vi.fn().mockRejectedValue(outro);
    await expect(comNovaTentativaNoDeadlock(uma)).rejects.toBe(outro);
    expect(uma).toHaveBeenCalledTimes(1);
    const sempre = vi.fn().mockImplementation(() => Promise.reject(deadlock()));
    await expect(comNovaTentativaNoDeadlock(sempre)).rejects.toMatchObject({ cause: { code: "ER_LOCK_DEADLOCK" } });
    expect(sempre).toHaveBeenCalledTimes(3);
  });
});

describe("o convite por link", () => {
  it("o token tem 192 bits em base64url (32 caracteres), muda a cada convite, e o banco guarda só o sha256", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => gerarTokenDoConvite()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(FORMATO_DO_CONVITE);
    const token = gerarTokenDoConvite();
    expect(hashDoConvite(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDoConvite(token)).not.toContain(token);
    expect(hashDoConvite(token)).toBe(hashDoConvite(token));
  });

  it("o endereço do convite e o da reunião compartilhada", () => {
    expect(rotaDoConvite("abc_DEF-123")).toBe("/convite/abc_DEF-123");
    expect(rotaDaReuniaoCompartilhada(ID)).toBe(`/reunioes-compartilhadas/${ID}`);
  });

  it("o teto: 30 convites a cada 10 minutos por dona, com o código traduzível; a vaga devolvida volta", () => {
    const dona = `dona-teto-${Math.random()}`;
    const soltas = Array.from({ length: CONVITES_POR_JANELA }, () => tetoDosConvites().reservar(dona));
    expect(() => tetoDosConvites().reservar(dona)).toThrow(RECUSAS_DOS_PARTICIPANTES.muitosConvites);
    // Outra dona não divide o balde.
    expect(() => tetoDosConvites().reservar(`${dona}-outra`)).not.toThrow();
    soltas[0]();
    expect(() => tetoDosConvites().reservar(dona)).not.toThrow();
  });
});

describe("a credencial da participante", () => {
  it("é 'participante:<id da reunião>' e não se confunde com o token do link", () => {
    expect(credencialDaParticipante(ID)).toBe(`participante:${ID}`);
    expect(reuniaoDaCredencial(credencialDaParticipante(ID))).toBe(ID);
    expect(reuniaoDaCredencial(`participante:${ID.toUpperCase()}`)).toBe(ID);
    for (const outra of ["A".repeat(32), `participante:${ID}x`, `participante:nao-e-id`, `xparticipante:${ID}`, ""]) {
      expect(reuniaoDaCredencial(outra)).toBeNull();
    }
  });

  it("a rota do link lê a sessão só com a credencial: o link de sempre nunca a lê", async () => {
    autenticar.mockReset();
    expect(await leitoraDaRota({} as never, "A".repeat(32))).toBeNull();
    expect(autenticar).not.toHaveBeenCalled();
    autenticar.mockResolvedValueOnce({ id: 7, openId: "conta-7", name: "não vai" });
    expect(await leitoraDaRota({} as never, credencialDaParticipante(ID))).toEqual({ id: 7, openId: "conta-7" });
    // Sem sessão (o sdk recusa): null, e a rota responde como ao link desligado.
    autenticar.mockRejectedValueOnce(new Error("sem cookie"));
    expect(await leitoraDaRota({} as never, credencialDaParticipante(ID))).toBeNull();
    // O banco fora do ar é erro, nunca "sem sessão".
    autenticar.mockRejectedValueOnce(new BancoIndisponivel());
    await expect(leitoraDaRota({} as never, credencialDaParticipante(ID))).rejects.toBeInstanceOf(BancoIndisponivel);
  });
});

describe("o nome da conta que vira nome de voz", () => {
  it("o nome do perfil, ou o da conta, aparado e cortado em 60; nunca outra coisa", () => {
    expect(nomeDaConta("  Ana Perfil ", "Ana Conta")).toBe("Ana Perfil");
    expect(nomeDaConta("   ", "Ana Conta")).toBe("Ana Conta");
    expect(nomeDaConta(null, null)).toBe("");
    expect(nomeDaConta("x".repeat(80), null)).toHaveLength(60);
  });
});

describe("as colunas das vozes (H3c)", () => {
  it("contasDasVozes: só F1 a F99 com 'owner' ou o id de uma participação; o resto da coluna (JSON livre) cai", () => {
    expect(contasDasVozes({ F1: "owner", F2: PARTICIPACAO, F3: "123", F0: "owner", X1: PARTICIPACAO, F4: 7, F5: PARTICIPACAO.toUpperCase() }))
      .toEqual({ F1: CONTA_DA_DONA, F2: PARTICIPACAO, F5: PARTICIPACAO });
    for (const vazio of [null, undefined, "texto", [], 3]) expect(contasDasVozes(vazio)).toEqual({});
  });

  it("vozesJuntadas: sem a voz a si mesma, sem cadeia e sem ciclo", () => {
    expect(vozesJuntadas({ F3: "F1", F4: "F4", F5: "x", F6: "F3", F7: "F8", F8: "F7", F9: "F1" })).toEqual({ F3: "F1", F9: "F1" });
    for (const vazio of [null, undefined, "texto", [], 3]) expect(vozesJuntadas(vazio)).toEqual({});
  });

  it("na tela, a voz juntada leva o nome da principal ou, sem nome, o rótulo da principal", () => {
    const rotulo = (n: number) => `Falante ${n}`;
    const nomes = nomesComJuntadas({ F1: "Ana", F4: "Velho" }, { F3: "F1", F4: "F2" }, rotulo);
    expect(nomes).toEqual({ F1: "Ana", F3: "Ana", F4: "Falante 2" });
    expect(vozesNoTexto("{F3} e {F4} combinaram com {F1}.", nomes, rotulo)).toBe("Ana e Falante 2 combinaram com Ana.");
    // Sem juntadas, o mesmo mapa.
    expect(nomesComJuntadas({ F1: "Ana" }, {}, rotulo)).toEqual({ F1: "Ana" });
  });

  it("as falas da voz juntada contam como da principal (o tempo de fala soma as duas)", () => {
    const falas = [{ falante: "F1", texto: "a" }, { falante: "F3", texto: "b" }, { falante: "F2", texto: "c" }];
    expect(falasComJuntadas(falas, { F3: "F1" }).map(f => f.falante)).toEqual(["F1", "F1", "F2"]);
    expect(falasComJuntadas(falas, {})).toBe(falas);
  });

  it("reprocessar zera as três colunas das vozes juntas: a transcrição nova renumera as vozes", () => {
    expect(VOZES_ZERADAS).toEqual({ speakerNames: null, speakerAccounts: null, speakerMerges: null });
  });
});
