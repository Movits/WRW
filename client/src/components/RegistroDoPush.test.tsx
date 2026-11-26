import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { RegistroDoPush } from "./RegistroDoPush";
import { EVENTO_DO_TOKEN_DO_PUSH } from "@/lib/push-do-app";

const duble = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { pushNoCelular: { registrar: { useMutation: () => ({ mutate: duble.mutate }) } } },
}));

type JanelaComToken = Window & { __wrwTokenDoPush?: unknown };
const TOKEN = "ExponentPushToken[abcdefghijklmnopqrstuv]";

beforeEach(() => duble.mutate.mockReset());
afterEach(() => {
  delete (window as JanelaComToken).__wrwTokenDoPush;
});

describe("RegistroDoPush", () => {
  it("no navegador (sem token do app), não manda nada", () => {
    render(<RegistroDoPush />);
    expect(duble.mutate).not.toHaveBeenCalled();
  });

  it("manda o token que o app deixou na página, com o idioma da tela, uma vez só", () => {
    (window as JanelaComToken).__wrwTokenDoPush = { token: TOKEN, plataforma: "android" };
    const { rerender } = render(<RegistroDoPush />);
    rerender(<RegistroDoPush />);
    expect(duble.mutate).toHaveBeenCalledTimes(1);
    expect(duble.mutate.mock.calls[0][0]).toEqual({ token: TOKEN, plataforma: "android", idioma: "pt-BR" });
  });

  it("o token que chega depois, pelo evento do app, também vai", () => {
    render(<RegistroDoPush />);
    expect(duble.mutate).not.toHaveBeenCalled();
    act(() => {
      (window as JanelaComToken).__wrwTokenDoPush = { token: TOKEN, plataforma: "ios" };
      window.dispatchEvent(new Event(EVENTO_DO_TOKEN_DO_PUSH));
    });
    expect(duble.mutate).toHaveBeenCalledTimes(1);
    expect(duble.mutate.mock.calls[0][0]).toMatchObject({ plataforma: "ios" });
  });

  it("token fora da forma não vai", () => {
    (window as JanelaComToken).__wrwTokenDoPush = { token: TOKEN, plataforma: "windows" };
    render(<RegistroDoPush />);
    expect(duble.mutate).not.toHaveBeenCalled();
  });
});
