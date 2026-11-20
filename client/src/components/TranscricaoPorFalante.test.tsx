import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mmss, segmentosValidos, tempoDeFala, TranscricaoPorFalante, type SegmentoDaTela } from "./TranscricaoPorFalante";

const FALAS: SegmentoDaTela[] = [
  { inicio: 0, fim: 60, falante: "F1", texto: "Bom dia, vamos falar do contrato." },
  { inicio: 60, fim: 90, falante: "F2", texto: "O frete fica para sexta." },
  { inicio: 600, fim: 1200, falante: "", texto: "", lacuna: true },
  { inicio: 1200, fim: 1260, falante: "F1", texto: "Fechado o contrato." },
];

describe("TranscricaoPorFalante (D1)", () => {
  it("cada fala com 'Falante n' e o tempo; o trecho que não chegou aparece como tal", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} />);
    const lista = document.querySelector("ol")!;
    expect(within(lista).getAllByText("Falante 1")).toHaveLength(2);
    expect(within(lista).getByText("Falante 2")).toBeInTheDocument();
    expect(within(lista).getByText(/10:00–20:00 · trecho não recebido/)).toBeInTheDocument();
  });

  it("clicar no tempo pula o player para o início da fala", () => {
    const aoIrPara = vi.fn();
    render(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={aoIrPara} />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 20:00" }));
    expect(aoIrPara).toHaveBeenCalledWith(1200);
  });

  it("a busca filtra as falas e destaca o termo; sem resultado, diz isso", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "contrato" } });
    expect(document.querySelectorAll("ol li")).toHaveLength(2);
    expect(document.querySelectorAll("mark")).toHaveLength(2);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "inexistente" } });
    expect(screen.getByText("Nada encontrado com esse termo.")).toBeInTheDocument();
  });

  it("o termo do link (?q) já abre filtrado", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} termoInicial="frete" />);
    expect(document.querySelectorAll("ol li")).toHaveLength(1);
  });

  it("tempo de fala por voz, da que mais falou para a que menos, sem contar a lacuna", () => {
    expect(tempoDeFala(FALAS)).toEqual([
      { falante: "F1", segundos: 120, fracao: 0.8 },
      { falante: "F2", segundos: 30, fracao: 0.2 },
    ]);
    render(<TranscricaoPorFalante segmentos={FALAS} />);
    expect(screen.getByText("02:00 · 80%")).toBeInTheDocument();
  });

  it("só segmentos no formato do contrato entram (a transcrição antiga, sem falantes, fica de fora)", () => {
    expect(segmentosValidos(null)).toEqual([]);
    expect(segmentosValidos([{ texto: "sem tempo" }, ...FALAS])).toHaveLength(4);
    expect(mmss(3725)).toBe("1:02:05");
  });
});

describe("TranscricaoPorFalante — nomes das vozes (H3)", () => {
  it("com nomes, cada fala e o tempo de fala mostram o nome; sem nome, 'Falante n'", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} nomes={{ F1: "Ana" }} />);
    const lista = document.querySelector("ol")!;
    expect(within(lista).getAllByText("Ana")).toHaveLength(2);
    expect(within(lista).getByText("Falante 2")).toBeInTheDocument();
  });

  it("sem aoNomear (o link aberto), não há como renomear", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} nomes={{ F1: "Ana" }} />);
    expect(screen.queryByTitle("Dar nome a esta voz")).not.toBeInTheDocument();
  });

  it("a dona dá nome a uma voz: o campo abre com o nome atual e salvar chama aoNomear", async () => {
    const aoNomear = vi.fn(async () => undefined);
    render(<TranscricaoPorFalante segmentos={FALAS} nomes={{ F1: "Ana" }} aoNomear={aoNomear} />);
    fireEvent.click(screen.getAllByTitle("Dar nome a esta voz")[1]);
    const campo = screen.getByRole("textbox", { name: "Nome do falante 2" });
    expect(campo).toHaveValue("");
    fireEvent.change(campo, { target: { value: "Bia" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    expect(aoNomear).toHaveBeenCalledWith("F2", "Bia");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Nome do falante 2" })).not.toBeInTheDocument());
  });

  it("salvar que falha deixa o campo aberto para tentar de novo", async () => {
    const aoNomear = vi.fn(async () => { throw new Error("rede"); });
    render(<TranscricaoPorFalante segmentos={FALAS} aoNomear={aoNomear} />);
    fireEvent.click(screen.getAllByTitle("Dar nome a esta voz")[0]);
    fireEvent.change(screen.getByRole("textbox", { name: "Nome do falante 1" }), { target: { value: "Ana" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    expect(screen.getByRole("textbox", { name: "Nome do falante 1" })).toHaveValue("Ana");
  });

  it("com o link que mostra os nomes ligado, o campo do nome avisa que o nome aparece também para quem tem o link (H3b)", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} aoNomear={vi.fn(async () => undefined)} nomeNoLink="aparece" />);
    fireEvent.click(screen.getAllByTitle("Dar nome a esta voz")[0]);
    expect(screen.getByRole("textbox", { name: "Nome do falante 1" })).toHaveAccessibleDescription("Este nome aparece também para quem tem o link da reunião.");
  });

  it("com o link da confirmação antiga, o campo do nome diz que quem tem o link não vê o nome, e como mostrá-lo (H3b)", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} aoNomear={vi.fn(async () => undefined)} nomeNoLink="naoAparece" />);
    fireEvent.click(screen.getAllByTitle("Dar nome a esta voz")[0]);
    expect(screen.getByRole("textbox", { name: "Nome do falante 1" }))
      .toHaveAccessibleDescription("Quem tem o link da reunião não vê este nome. Para mostrá-lo, desligue o link e compartilhe de novo.");
    expect(screen.queryByText(/aparece também para quem tem o link/)).not.toBeInTheDocument();
  });

  it("sem o link, o campo não tem dica nenhuma", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} aoNomear={vi.fn(async () => undefined)} />);
    fireEvent.click(screen.getAllByTitle("Dar nome a esta voz")[0]);
    expect(screen.getByRole("textbox", { name: "Nome do falante 1" })).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/quem tem o link/)).not.toBeInTheDocument();
  });
});
