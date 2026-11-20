import { describe, expect, it, vi } from "vitest";
import {
  avisoCabe,
  ehAreaLogada,
  lerPedidoDoSite,
  MINUTOS_PARA_TRAVAR_DE_NOVO,
  MOTIVO_PARA_DESLIGAR,
  MOTIVO_PARA_LIGAR,
  mudarATrava,
  precisaTravarAoVoltar,
  scriptDoEstado,
} from "../mobile/regras/trava";

/**
 * A trava do app das lojas (mobile/regras/trava.ts): as regras que não dependem do
 * React Native. Ficam aqui porque a pasta mobile/ não tem suíte própria e o CI
 * da raiz não olha para ela (mobile/CLAUDE.md); a função é pura, como as do
 * client testadas em server/*.test.ts.
 */

const MINUTO = 60_000;

describe("quando o app pede o Face ID de novo", () => {
  it("são 10 minutos em segundo plano", () => {
    expect(MINUTOS_PARA_TRAVAR_DE_NOVO).toBe(10);
  });

  it("antes de 10 minutos, não pede; com 10 ou mais, pede", () => {
    const saiu = 1_000_000;
    expect(precisaTravarAoVoltar(saiu, saiu + 9 * MINUTO + 59_000)).toBe(false);
    expect(precisaTravarAoVoltar(saiu, saiu + 10 * MINUTO)).toBe(true);
    expect(precisaTravarAoVoltar(saiu, saiu + 3 * 60 * MINUTO)).toBe(true);
  });

  it("sem saída registrada (o app nem foi para segundo plano), não pede", () => {
    expect(precisaTravarAoVoltar(null, Date.now())).toBe(false);
  });
});

describe("onde o aviso depois do login aparece", () => {
  it.each(["/gravar", "/meetings", "/meetings/abc", "/profile", "/agenda", "/proximas-acoes", "/meu-network-inteligente/contatos/7"])(
    "%s é da área logada",
    caminho => expect(ehAreaLogada(caminho)).toBe(true),
  );

  it.each(["/", "/login", "/register", "/forgot-password", "/onboarding", "/r/token", "/privacidade", "/gravarx", ""])(
    "%s não é",
    caminho => expect(ehAreaLogada(caminho)).toBe(false),
  );

  const base = { caminho: "/gravar", biometria: true, ligada: false, avisoRespondido: false };

  it("cabe na área logada, com biometria, trava desligada e aviso nunca respondido", () => {
    expect(avisoCabe(base)).toBe(true);
  });

  it.each([
    ["fora da área logada", { caminho: "/login" }],
    ["sem biometria nem bloqueio de tela", { biometria: false }],
    ["com a trava já ligada", { ligada: true }],
    ["com o aviso já respondido", { avisoRespondido: true }],
  ])("não cabe %s", (_caso, mudanca) => {
    expect(avisoCabe({ ...base, ...mudanca })).toBe(false);
  });
});

describe("a conversa com o Perfil do site", () => {
  it("lê os três pedidos do site", () => {
    for (const acao of ["estado", "ligar", "desligar"] as const) {
      expect(lerPedidoDoSite(JSON.stringify({ tipo: "wrw:trava", acao }))).toEqual({ tipo: "wrw:trava", acao });
    }
  });

  it("ignora qualquer outra mensagem", () => {
    expect(lerPedidoDoSite(JSON.stringify({ tipo: "outro", acao: "ligar" }))).toBeNull();
    expect(lerPedidoDoSite(JSON.stringify({ tipo: "wrw:trava", acao: "apagar" }))).toBeNull();
    expect(lerPedidoDoSite("não é json")).toBeNull();
    expect(lerPedidoDoSite(42)).toBeNull();
    expect(lerPedidoDoSite("x".repeat(300))).toBeNull();
  });

  it("o script conta o estado à página pelo evento wrw:trava, só com os dois campos", () => {
    const script = scriptDoEstado({ disponivel: true, ligada: false, extra: "x" } as never);
    expect(script).toContain('new CustomEvent("wrw:trava", { detail: {"disponivel":true,"ligada":false} })');
    expect(script).not.toContain("extra");
    expect(script.trim().endsWith("true;")).toBe(true);
  });
});

describe("ligar e desligar a trava passam pela pessoa", () => {
  function dubles(respostaDaPessoa: boolean) {
    const conferir = vi.fn(async (_motivo: string) => respostaDaPessoa);
    const gravar = vi.fn(async (_ligada: boolean) => {});
    return { conferir, gravar };
  }

  it("desligar pede o Face ID ou a digital antes e só apaga depois do OK (revisão da #223)", async () => {
    const { conferir, gravar } = dubles(true);
    const ficouLigada = await mudarATrava({ ligar: false, ligadaAgora: true }, conferir, gravar);
    expect(conferir).toHaveBeenCalledWith(MOTIVO_PARA_DESLIGAR);
    expect(gravar).toHaveBeenCalledWith(false);
    expect(conferir.mock.invocationCallOrder[0]).toBeLessThan(gravar.mock.invocationCallOrder[0]);
    expect(ficouLigada).toBe(false);
  });

  it("desligar sem o OK (cancelou, ou não é a dona): a trava segue ligada e nada é gravado", async () => {
    const { conferir, gravar } = dubles(false);
    const ficouLigada = await mudarATrava({ ligar: false, ligadaAgora: true }, conferir, gravar);
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(gravar).not.toHaveBeenCalled();
    expect(ficouLigada).toBe(true);
  });

  it("ligar também pede antes, e sem o OK segue desligada", async () => {
    const comOk = dubles(true);
    expect(await mudarATrava({ ligar: true, ligadaAgora: false }, comOk.conferir, comOk.gravar)).toBe(true);
    expect(comOk.conferir).toHaveBeenCalledWith(MOTIVO_PARA_LIGAR);
    expect(comOk.gravar).toHaveBeenCalledWith(true);

    const semOk = dubles(false);
    expect(await mudarATrava({ ligar: true, ligadaAgora: false }, semOk.conferir, semOk.gravar)).toBe(false);
    expect(semOk.gravar).not.toHaveBeenCalled();
  });

  it("pedido igual ao estado atual não pede nada nem grava", async () => {
    const { conferir, gravar } = dubles(true);
    expect(await mudarATrava({ ligar: true, ligadaAgora: true }, conferir, gravar)).toBe(true);
    expect(await mudarATrava({ ligar: false, ligadaAgora: false }, conferir, gravar)).toBe(false);
    expect(conferir).not.toHaveBeenCalled();
    expect(gravar).not.toHaveBeenCalled();
  });
});
