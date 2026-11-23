import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorDoTextoCorrido } from "./EditarTranscricao";

/**
 * O editor da transcrição de texto corrido (H18, a do envio único): o
 * rascunho da dona e o texto que vem do servidor. A recusa por conflito
 * (outra aba salvou antes) relê a reunião, e o texto novo chega por aqui;
 * o que a dona escreveu não pode sumir com ele.
 */
describe("EditorDoTextoCorrido: o rascunho da dona diante do texto do servidor", () => {
  const SALVO = "Texto salvo pela aba A.";
  const DA_OUTRA_ABA = "Texto que a outra aba salvou antes.";
  const MEU = "Minha revisão de vários parágrafos, escrita na aba B.";

  it("o texto do servidor muda com o rascunho sujo (a recusa por conflito): o que a dona escreveu fica, e o Cancelar volta ao salvo", () => {
    const editar = vi.fn(async () => null);
    const { rerender } = render(<EditorDoTextoCorrido texto={SALVO} editar={editar} salvando={false} />);
    const campo = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: MEU } });

    rerender(<EditorDoTextoCorrido texto={DA_OUTRA_ABA} editar={editar} salvando={false} />);

    expect(campo.value).toBe(MEU);
    expect(screen.getByRole("button", { name: "Salvar" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(campo.value).toBe(DA_OUTRA_ABA);
  });

  it("sem mudança da dona, o rascunho acompanha o texto novo do servidor", () => {
    const editar = vi.fn(async () => null);
    const { rerender } = render(<EditorDoTextoCorrido texto={SALVO} editar={editar} salvando={false} />);
    rerender(<EditorDoTextoCorrido texto={DA_OUTRA_ABA} editar={editar} salvando={false} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(DA_OUTRA_ABA);
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("a edição salva aqui: o texto do servidor passa a ser o do rascunho, e nada fica por salvar", async () => {
    const editar = vi.fn(async () => ({ mudou: true }) as never);
    const { rerender } = render(<EditorDoTextoCorrido texto={SALVO} editar={editar} salvando={false} />);
    const campo = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(campo, { target: { value: MEU } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    expect(editar).toHaveBeenCalledWith({ tipo: "textoCorrido", texto: MEU });

    rerender(<EditorDoTextoCorrido texto={MEU} editar={editar} salvando={false} />);

    expect(campo.value).toBe(MEU);
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });
});
