import { describe, expect, it } from "vitest";
import { caminhoDeVoltaSeguro, destinoDepoisDoLogin, urlDoLogin } from "./caminho-de-volta";

/**
 * O ?voltar= do login (30/10/2026). A sessão que vence e o link aberto
 * deslogada voltam à tela pedida depois de entrar, e só a uma tela do próprio
 * site: o link de login não pode virar trampolim para outro endereço.
 */

describe("caminhoDeVoltaSeguro", () => {
  it.each(["/gravar", "/meetings/abc", "/network?aba=x", "/opportunities/5#topo"])("aceita %s", (caminho) => {
    expect(caminhoDeVoltaSeguro(caminho)).toBe(caminho);
  });

  it.each([
    undefined, null, 42, "", "gravar", "//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/x", "https://evil.com",
    "http:/evil.com", "javascript:alert(1)", " /gravar", "/", "/login?voltar=/x", "/LOGIN", "/login/",
    "/reset-password?token=x", "/register", "/forgot-password", "/onboarding", "/404", "/" + "a".repeat(600),
    // Segmentos "." e ".." que, normalizados, deixam duas barras no começo.
    "/..//evil.com", "/.//evil.com", "/%2e%2e//evil.com", "/%2E//evil.com", "/x/..//evil.com", "/.///evil.com",
    "/gravar/..//evil.com", "/./..//evil.com/x?y#z",
    // Codificados: o wouter decodifica antes de casar a rota.
    "/%6Cogin", "/%72eset-password?token=x", "/%6cogin/",
  ])("recusa %j", (valor) => {
    expect(caminhoDeVoltaSeguro(valor)).toBeNull();
  });
});

describe("urlDoLogin", () => {
  it("leva o caminho codificado", () => {
    expect(urlDoLogin("/meetings/1?x=2")).toBe("/login?voltar=%2Fmeetings%2F1%3Fx%3D2");
  });

  it.each([undefined, null, "", "//evil.com", "/login"])("sem caminho seguro (%j), é só /login", (valor) => {
    expect(urlDoLogin(valor)).toBe("/login");
  });
});

describe("destinoDepoisDoLogin", () => {
  it("cadastro por concluir vai ao /onboarding, com ou sem voltar", () => {
    expect(destinoDepoisDoLogin(false, "")).toBe("/onboarding");
    expect(destinoDepoisDoLogin(false, "?voltar=%2Fnetwork")).toBe("/onboarding");
  });

  it("sem voltar, vai ao gravador", () => {
    expect(destinoDepoisDoLogin(true, "")).toBe("/gravar");
    expect(destinoDepoisDoLogin(true, undefined)).toBe("/gravar");
  });

  it("voltar para fora do site ou para uma tela de entrada vai ao gravador", () => {
    expect(destinoDepoisDoLogin(true, "?voltar=https%3A%2F%2Fevil.com")).toBe("/gravar");
    expect(destinoDepoisDoLogin(true, "?voltar=%2F%2Fevil.com")).toBe("/gravar");
    expect(destinoDepoisDoLogin(true, "?voltar=%2Flogin")).toBe("/gravar");
    expect(destinoDepoisDoLogin(true, "?voltar=%2F..%2F%2Fevil.com")).toBe("/gravar");
    expect(destinoDepoisDoLogin(true, "?voltar=%2F.%2F%2Fevil.com")).toBe("/gravar");
  });

  it("segmentos de ponto que ficam dentro do site são normalizados, não recusados", () => {
    expect(caminhoDeVoltaSeguro("/a/../gravar")).toBe("/gravar");
  });

  it("ida e volta: o caminho que sai no urlDoLogin é o que o login devolve", () => {
    const caminho = "/meetings/8b1f6a2e?t=90#trecho";
    const url = urlDoLogin(caminho);
    expect(destinoDepoisDoLogin(true, url.slice(url.indexOf("?")))).toBe(caminho);
  });
});
