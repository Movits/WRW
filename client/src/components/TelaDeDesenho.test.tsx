import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelaDeDesenho } from "./TelaDeDesenho";

/**
 * A tela de desenho (H4h) com o canvas dublado (o jsdom não desenha): a caneta
 * desenha, a palma da mão (o toque depois da caneta) não, desfazer e limpar
 * mexem nos traços, e guardar entrega o PNG à tela que chamou, que o sobe como
 * anexo. O desenho em si (a largura pela pressão, a escala) está em
 * client/src/lib/desenho.test.ts; o que só se vê com a caneta de verdade no
 * iPad fica para a conferência no aparelho.
 */

const tracados: string[] = [];
function pincelFalso() {
  return {
    setTransform: () => undefined, fillRect: () => tracados.push("folha"), beginPath: () => undefined, moveTo: () => undefined,
    lineTo: () => tracados.push("linha"), stroke: () => undefined, arc: () => tracados.push("ponto"), fill: () => undefined,
  };
}

beforeEach(() => {
  tracados.length = 0;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => pincelFalso() as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,QUJD");
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 400, height: 300 } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ponteiro = (tipo: string, id = 1) => ({ pointerType: tipo, pointerId: id, clientX: 10, clientY: 10, pressure: 0.5 });

function desenharUmTraco(folha: Element, tipo: string, id = 1) {
  fireEvent.pointerDown(folha, ponteiro(tipo, id));
  fireEvent.pointerMove(folha, { ...ponteiro(tipo, id), clientX: 50, clientY: 40 });
  fireEvent.pointerUp(folha, ponteiro(tipo, id));
}

describe("a tela de desenho", () => {
  it("a caneta desenha; guardar entrega o PNG e fecha", async () => {
    const aoGuardar = vi.fn(async () => undefined);
    const aoFechar = vi.fn();
    render(<TelaDeDesenho aberta aoFechar={aoFechar} aoGuardar={aoGuardar}/>);
    const folha = await screen.findByRole("img", { name: "Folha de desenho" });
    const guardar = screen.getByRole("button", { name: "Guardar no resumo" });
    expect(guardar).toBeDisabled();
    desenharUmTraco(folha, "pen");
    expect(tracados).toContain("linha");
    expect(guardar).not.toBeDisabled();
    fireEvent.click(guardar);
    await waitFor(() => expect(aoGuardar).toHaveBeenCalledWith("data:image/png;base64,QUJD"));
    await waitFor(() => expect(aoFechar).toHaveBeenCalled());
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledWith("image/png");
  });

  it("depois da caneta, o toque (a palma da mão) não desenha; desfazer e limpar tiram os traços", async () => {
    render(<TelaDeDesenho aberta aoFechar={vi.fn()} aoGuardar={vi.fn(async () => undefined)}/>);
    const folha = await screen.findByRole("img", { name: "Folha de desenho" });
    const guardar = screen.getByRole("button", { name: "Guardar no resumo" });
    desenharUmTraco(folha, "touch");
    expect(guardar).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Limpar/ }));
    expect(guardar).toBeDisabled();
    desenharUmTraco(folha, "pen", 2);
    desenharUmTraco(folha, "touch", 3);
    // Só o traço da caneta ficou: desfazer uma vez deixa a folha vazia.
    fireEvent.click(screen.getByRole("button", { name: /Desfazer/ }));
    expect(guardar).toBeDisabled();
  });

  it("se a imagem não sobe, a folha fica aberta para tentar de novo", async () => {
    const aoFechar = vi.fn();
    render(<TelaDeDesenho aberta aoFechar={aoFechar} aoGuardar={vi.fn(async () => { throw new Error("não subiu"); })}/>);
    const folha = await screen.findByRole("img", { name: "Folha de desenho" });
    desenharUmTraco(folha, "mouse");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Guardar no resumo" })); });
    expect(aoFechar).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Guardar no resumo" })).not.toBeDisabled();
  });
});
