import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ImportacaoEmAndamento } from "./ImportacaoEmAndamento";

/** O andamento do MP3 enviado em partes (H9a): leitura, partes, cancelamento. */

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

const barra = () => screen.getByRole("progressbar", { name: "Andamento do envio do arquivo" });

describe("ImportacaoEmAndamento", () => {
  it("lendo: a porcentagem dos bytes lidos, no texto e na barra", () => {
    render(<ImportacaoEmAndamento andamento={{ fase: "lendo", lidos: 1, total: 3 }} aoCancelar={vi.fn()}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Lendo o arquivo… 33%");
    expect(barra()).toHaveAttribute("aria-valuenow", "33");
  });

  it("enviando: a parte que está subindo e a fração das que já subiram; o Cancelar chama quem cancela", () => {
    const aoCancelar = vi.fn();
    render(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 3, total: 4 }} aoCancelar={aoCancelar}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Enviando o arquivo: parte 4 de 4");
    expect(barra()).toHaveAttribute("aria-valuenow", "75");
    fireEvent.click(screen.getByRole("button", { name: /Cancelar envio/ }));
    expect(aoCancelar).toHaveBeenCalledTimes(1);
  });

  it("cancelando: a barra fica sem valor (indeterminada) e o Cancelar, desligado", () => {
    render(<ImportacaoEmAndamento andamento={{ fase: "cancelando" }} aoCancelar={vi.fn()}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Cancelando o envio…");
    expect(barra()).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("button", { name: /Cancelar envio/ })).toBeDisabled();
  });

  it("no idioma da tela (árabe, da direita para a esquerda)", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 0, total: 2 }} aoCancelar={vi.fn()}/>);
    expect(screen.getByRole("status")).toHaveTextContent("جارٍ إرسال الملف: الجزء 1 من 2");
    expect(screen.getByRole("button", { name: /إلغاء الإرسال/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Enviando|Cancelar/);
  });
});
