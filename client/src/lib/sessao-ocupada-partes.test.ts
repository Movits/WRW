import { describe, expect, it, vi } from "vitest";

const apagarTodasAsPartes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./partes-no-aparelho", () => ({ apagarTodasAsPartes }));

const { liberarTodas, ocupar } = await import("./sessao-ocupada");

describe("fim da sessão apaga a cópia das partes no aparelho (G9)", () => {
  it("mesmo sem nada ocupado, e também com uma ocupação aberta", () => {
    apagarTodasAsPartes.mockResolvedValue(undefined);
    liberarTodas();
    expect(apagarTodasAsPartes).toHaveBeenCalledTimes(1);
    ocupar("enviando");
    liberarTodas();
    expect(apagarTodasAsPartes).toHaveBeenCalledTimes(2);
  });
});
