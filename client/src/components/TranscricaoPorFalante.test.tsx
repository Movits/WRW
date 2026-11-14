import { fireEvent, render, screen, within } from "@testing-library/react";
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
