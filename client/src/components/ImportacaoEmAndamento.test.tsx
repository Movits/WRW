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

  it("a parte que não subiu e vai de novo: o texto diz isso, a barra fica onde estava e o Cancelar segue valendo", () => {
    const aoCancelar = vi.fn();
    render(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 1, total: 4, tentandoDeNovo: true }} aoCancelar={aoCancelar}/>);
    expect(screen.getByRole("status")).toHaveTextContent("A conexão falhou. Tentando enviar de novo a parte 2 de 4…");
    expect(barra()).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(screen.getByRole("button", { name: /Cancelar envio/ }));
    expect(aoCancelar).toHaveBeenCalledTimes(1);
  });

  it("com a tela acesa garantida, a dica de manter o app aberto; sem ela (iPhone, navegador sem Wake Lock), o aviso de manter a tela acesa, no lugar da dica", () => {
    const { rerender } = render(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 0, total: 2 }} aoCancelar={vi.fn()}/>);
    expect(screen.getByText("Mantenha o app aberto até o envio terminar.")).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    rerender(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 0, total: 2 }} aoCancelar={vi.fn()} telaPodeApagar/>);
    expect(screen.getByRole("note")).toHaveTextContent("Mantenha esta tela aberta e o aparelho desbloqueado até o envio terminar: se a tela apagar ou você trocar de app, o envio para até você voltar.");
    expect(screen.queryByText("Mantenha o app aberto até o envio terminar.")).not.toBeInTheDocument();
  });

  it("cancelando: a barra fica sem valor (indeterminada) e o Cancelar, desligado", () => {
    render(<ImportacaoEmAndamento andamento={{ fase: "cancelando" }} aoCancelar={vi.fn()}/>);
    expect(screen.getByRole("status")).toHaveTextContent("Cancelando o envio…");
    expect(barra()).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("button", { name: /Cancelar envio/ })).toBeDisabled();
  });

  // Conferência de tela do pacote 4b: em árabe o ícone girando ficava colado ao
  // texto ("جارٍ إرسال الملف…"): a margem era a da direita (mr-2), que na escrita
  // da direita para a esquerda fica do lado de fora. A lógica (me-2) acompanha o ícone.
  it("o ícone girando e o do aviso têm a margem do lado do texto também em árabe (me-2, e não mr-2)", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 0, total: 2 }} aoCancelar={vi.fn()} telaPodeApagar/>);
    const girando = screen.getByRole("status").querySelector("svg")!;
    expect(girando).toHaveClass("animate-spin", "me-2");
    expect(girando).not.toHaveClass("mr-2");
    const doAviso = screen.getByRole("note").querySelector("svg")!;
    expect(doAviso).toHaveClass("me-2");
    expect(doAviso).not.toHaveClass("mr-2");
  });

  it("no idioma da tela (árabe, da direita para a esquerda)", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<ImportacaoEmAndamento andamento={{ fase: "enviando", enviadas: 0, total: 2 }} aoCancelar={vi.fn()}/>);
    expect(screen.getByRole("status")).toHaveTextContent("جارٍ إرسال الملف: الجزء 1 من 2");
    expect(screen.getByRole("button", { name: /إلغاء الإرسال/ })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Enviando|Cancelar/);
  });
});
