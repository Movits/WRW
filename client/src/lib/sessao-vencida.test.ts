import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { destinoPorSessaoVencida } from "./sessao-vencida";

/**
 * A sessão que vence no meio do uso manda ao login levando a tela de volta
 * (main.tsx). Só o erro de "não autenticada" do tRPC redireciona, e nunca a
 * partir das páginas públicas, para não entrar em laço.
 */
describe("destinoPorSessaoVencida", () => {
  const vencida = new TRPCClientError(UNAUTHED_ERR_MSG);

  it("leva ao login com o caminho de volta, codificado", () => {
    expect(destinoPorSessaoVencida(vencida, { pathname: "/gravar", search: "" })).toBe("/login?voltar=%2Fgravar");
    expect(destinoPorSessaoVencida(vencida, { pathname: "/meetings/abc", search: "?t=90" })).toBe("/login?voltar=%2Fmeetings%2Fabc%3Ft%3D90");
  });

  it.each(["/login", "/register", "/forgot-password", "/reset-password", "/"])("na página pública %s não redireciona", (pathname) => {
    expect(destinoPorSessaoVencida(vencida, { pathname, search: "" })).toBeNull();
  });

  it("outro erro do tRPC ou erro que não é do tRPC não redireciona", () => {
    expect(destinoPorSessaoVencida(new TRPCClientError("Banco de dados indisponível"), { pathname: "/gravar", search: "" })).toBeNull();
    expect(destinoPorSessaoVencida(new Error(UNAUTHED_ERR_MSG), { pathname: "/gravar", search: "" })).toBeNull();
  });
});
