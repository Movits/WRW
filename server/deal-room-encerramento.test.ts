import { beforeEach, describe, expect, it, vi } from "vitest";

// server/auth.ts exige JWT_SECRET já na carga do módulo.
vi.hoisted(() => {
  process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";
});

/**
 * A11 / etapa 12 — encerrar a negociação registrando o negócio e a comissão.
 *
 * O que estas checagens protegem, e por quê:
 *
 * - O teto de 50% incide sobre os HONORÁRIOS DA INTERMEDIAÇÃO (Dra. Glenda,
 *   12/09/2026), não sobre o lucro nem sobre o valor do negócio. São colunas
 *   separadas de propósito, e a comissão sai dos honorários.
 * - Quem encerra é quem negociou. Ouro entra em sala alheia para acompanhar,
 *   mas registrar negócio dos outros não é leitura, é ato de parte.
 * - Encerrar é evento único: a segunda chamada devolve o registro que já existe
 *   em vez de criar um segundo.
 * - Honorários maiores que o valor do negócio são erro de digitação e
 *   inflariam a comissão devida.
 */

type Linha = Record<string, unknown>;

// vi.mock é içado para o topo do arquivo: o que a fábrica usa precisa nascer
// em vi.hoisted, senão a referência não existe ainda quando ela roda.
const { estado, criarNotificacaoMock, fakeDb } = vi.hoisted(() => {
  const estado = {
    salas: [] as Record<string, unknown>[],
    fechamentos: [] as Record<string, unknown>[],
    notificacoes: [] as Record<string, unknown>[],
    inserirLanca: null as Error | null,
  };
  const criarNotificacaoMock = vi.fn(async (n: Record<string, unknown>) => { estado.notificacoes.push(n); });
  // O drizzle guarda o nome da tabela num símbolo, não numa propriedade comum.
  const SIMBOLO_NOME = Symbol.for("drizzle:Name");
  const nomeDa = (tabela: unknown) =>
    String((tabela as Record<symbol, unknown>)?.[SIMBOLO_NOME] ?? "");
  const fakeDb = {
    select: () => ({
      from: (tabela: unknown) => ({
        where: () => ({
          limit: async () => {
            const nome = nomeDa(tabela);
            if (nome === "deal_closures") return estado.fechamentos.slice(0, 1);
            if (nome === "deal_rooms") return estado.salas.slice(0, 1);
            return [];
          },
        }),
      }),
    }),
    insert: (tabela: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        if (estado.inserirLanca) throw estado.inserirLanca;
        if (nomeDa(tabela) === "deal_closures") estado.fechamentos.push({ id: 1, ...v });
      },
    }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { Object.assign(estado.salas[0] ?? {}, v); } }) }),
  };
  return { estado, criarNotificacaoMock, fakeDb };
});

vi.mock("./db", () => ({
  exigirDb: async () => fakeDb,
  getDb: async () => fakeDb,
  createNotification: criarNotificacaoMock,
}));

import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function contexto(id: number, role = "silver"): TrpcContext {
  return {
    user: { id, role, openId: `u${id}`, email: `u${id}@t.test`, name: `U${id}` },
    req: { headers: {}, socket: {} },
    res: { status: () => undefined, cookie: () => undefined, clearCookie: () => undefined },
  } as unknown as TrpcContext;
}

const SALA_ATIVA = { id: 10, opportunityId: 99, ownerId: 1, interestedId: 2, status: "active" };

const encerrar = (userId: number, entrada: Record<string, unknown>, role = "silver") =>
  appRouter.createCaller(contexto(userId, role)).dealRoom.closeRoom({
    roomId: 10, currency: "BRL", dealValue: 100_000, intermediationFee: 20_000, commissionPercent: 10,
    ...entrada,
  } as never);

describe("Deal Room — encerrar registrando o negócio e a comissão", () => {
  beforeEach(() => {
    estado.salas = [{ ...SALA_ATIVA }];
    estado.fechamentos = [];
    estado.notificacoes = [];
    estado.inserirLanca = null;
    criarNotificacaoMock.mockClear();
  });

  it("grava valor, honorários, percentual e a comissão que isso dá", async () => {
    const r = await encerrar(1, {});
    expect(r.success).toBe(true);
    const gravado = estado.fechamentos[0];
    expect(gravado.dealValue).toBe("100000.00");
    expect(gravado.intermediationFee).toBe("20000.00");
    expect(gravado.commissionPercent).toBe("10.00");
    // 10% dos 20.000 de honorários da intermediação — e não dos 100.000 do
    // negócio. A Dra. Glenda respondeu em 12/09 que o teto incide sobre os
    // honorários, não sobre o lucro nem sobre o valor do negócio.
    expect(gravado.commissionAmount).toBe("2000.00");
    expect(gravado.closedByUserId).toBe(1);
  });

  it("a sala passa a closed e a outra parte é notificada", async () => {
    await encerrar(1, {});
    expect(estado.salas[0].status).toBe("closed");
    expect(criarNotificacaoMock).toHaveBeenCalledTimes(1);
    const n = criarNotificacaoMock.mock.calls[0][0] as Linha;
    expect(n.userId).toBe(2); // quem NÃO encerrou
    expect(n.type).toBe("deal_closed");
  });

  it("recusa percentual acima do teto de 50% que a cliente fixou", async () => {
    await expect(encerrar(1, { commissionPercent: 50.01 })).rejects.toThrow();
    await expect(encerrar(1, { commissionPercent: 80 })).rejects.toThrow();
    // 50 exato é o teto, não o primeiro valor proibido.
    await expect(encerrar(1, { commissionPercent: 50 })).resolves.toMatchObject({ success: true });
  });

  it("recusa honorários maiores que o valor do negócio", async () => {
    await expect(encerrar(1, { dealValue: 1000, intermediationFee: 5000 })).rejects.toThrow(/honorários da intermediação/i);
  });

  // ── A MUDANÇA DE 12/09, e a razão de ela estar num teste ────────────────────
  // A primeira versão deste procedimento pedia `declaredProfit` e calculava a
  // comissão sobre o lucro. A pergunta foi feita direto à Dra. Glenda em 12/09
  // ("o teto de 50% incide sobre o lucro ou sobre o valor do negócio?") e a
  // resposta não foi nenhuma das duas: "Incide sobre o valor dos honorários da
  // intermediação do negócio". Trocar só o nome da variável não prova nada —
  // o que prova é o contrato recusar o campo antigo e a conta sair da base certa.
  it("o campo antigo declaredProfit é recusado: o contrato mudou, não só o nome", async () => {
    await expect(
      encerrar(1, { declaredProfit: 20_000, intermediationFee: undefined } as never),
    ).rejects.toThrow();
  });

  it("a comissão sai dos honorários, e não do valor do negócio nem de um lucro", async () => {
    // Três números propositalmente diferentes: negócio 500.000, honorários
    // 40.000, percentual 25%. A conta certa é 25% de 40.000 = 10.000. Se
    // alguém religar a conta no valor do negócio, dá 125.000 e o teste cai.
    await encerrar(1, { dealValue: 500_000, intermediationFee: 40_000, commissionPercent: 25 });
    const gravado = estado.fechamentos[0];
    expect(gravado.dealValue).toBe("500000.00");
    expect(gravado.intermediationFee).toBe("40000.00");
    expect(gravado.commissionAmount).toBe("10000.00");
  });

  it("quem não participa da negociação não encerra, nem sendo Ouro", async () => {
    await expect(encerrar(3, {}, "gold")).rejects.toThrow(/participa/i);
    expect(estado.fechamentos).toHaveLength(0);
  });

  it("sala que ainda espera o aceite do acordo não pode ser encerrada", async () => {
    estado.salas = [{ ...SALA_ATIVA, status: "awaiting_nda" }];
    await expect(encerrar(1, {})).rejects.toThrow(/acordo/i);
  });

  it("encerrar de novo devolve o registro que já existe, sem criar outro", async () => {
    await encerrar(1, {});
    expect(estado.fechamentos).toHaveLength(1);
    const segunda = await encerrar(2, { dealValue: 999, intermediationFee: 100 });
    expect(segunda.jaEstavaFechado).toBe(true);
    expect(estado.fechamentos).toHaveLength(1);
    expect(estado.fechamentos[0].dealValue).toBe("100000.00");
  });

  it("corrida perdida no índice único não vira erro para quem chamou", async () => {
    // A outra parte gravou entre a consulta e o insert: o índice único recusa,
    // mas o resultado que esta chamada pediu já aconteceu.
    estado.inserirLanca = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
    estado.fechamentos = [];
    const chamada = encerrar(1, {});
    // simula a linha da outra parte aparecendo na releitura
    estado.fechamentos.push({ id: 7, roomId: 10, dealValue: "5000.00" });
    await expect(chamada).resolves.toMatchObject({ jaEstavaFechado: true });
  });
});
