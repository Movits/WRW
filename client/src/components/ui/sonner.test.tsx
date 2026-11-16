import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toast } from "sonner";
import { Toaster } from "./sonner";

/**
 * O Toaster do app: o X dos avisos que só fecham na mão (G13a) é anunciado no
 * idioma de quem lê. O padrão do sonner é "Close toast", em inglês, em todos os
 * idiomas.
 */
describe("Toaster", () => {
  it("o X do aviso que fecha na mão é anunciado no idioma da tela, e não em inglês", async () => {
    render(<Toaster />);
    act(() => { toast("Aviso de teste", { closeButton: true }); });
    expect(await screen.findByRole("button", { name: "Fechar" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close toast" })).not.toBeInTheDocument();
  });
});
