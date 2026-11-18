import { describe, expect, it } from "vitest";
import {
  avisoCabe,
  ehAreaLogada,
  lerPedidoDoSite,
  MINUTOS_PARA_TRAVAR_DE_NOVO,
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
