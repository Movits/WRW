import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TextoDoDocumento } from "./TextoDoDocumento";

/**
 * O texto que a IA leu do documento (H12 e H12b), na aba "Texto do documento"
 * do detalhe da dona: página a página, com o número de cada uma, a página sem
 * texto mantida (a numeração bate com a do PDF), os destaques do que a
 * extração achou e os atalhos para cada página. O jsdom não mede layout: a 375
 * px o que se prova são as classes que fazem caber (quebra de palavra, atalhos
 * que quebram linha), e em árabe a direção vem do próprio texto (dir="auto").
 */
const PAGINAS = [
  { pagina: 1, texto: "Proposta de exportação de café para Lisboa." },
  { pagina: 2, texto: "" },
  { pagina: 3, texto: "Contato: Ana Souza, ana@exemplo.com.\nTelefone na assinatura." },
];
const ENTIDADES = [{ entityType: "person", value: "Ana Souza" }, { entityType: "email", value: "ana@exemplo.com" }];

let rolar: ReturnType<typeof vi.fn>;
beforeEach(() => {
  rolar = vi.fn();
  // O jsdom não rola: o atalho só precisa pedir a rolagem à página certa.
  Element.prototype.scrollIntoView = rolar as unknown as typeof Element.prototype.scrollIntoView;
});
afterEach(async () => {
  cleanup();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("TextoDoDocumento", () => {
  it("cada página com o número dela, na ordem, e a página sem texto continua, com o aviso", () => {
    render(<TextoDoDocumento paginas={PAGINAS} entidades={ENTIDADES} idPrefixo="doc-1"/>);
    expect(screen.getAllByRole("heading", { level: 3 }).map(titulo => titulo.textContent)).toEqual(["Página 1", "Página 2", "Página 3"]);
    const segunda = screen.getByRole("region", { name: "Página 2" });
    expect(segunda).toHaveTextContent("A IA não encontrou texto legível nesta página.");
    const terceira = screen.getByRole("region", { name: "Página 3" });
    // O texto mantém as quebras de linha da página e não estoura a largura do celular.
    const paragrafo = within(terceira).getByText(/Telefone na assinatura/).closest("p");
    expect(paragrafo).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(paragrafo).toHaveAttribute("dir", "auto");
  });

  it("os destaques do que a extração achou, como na transcrição", () => {
    render(<TextoDoDocumento paginas={PAGINAS} entidades={ENTIDADES} idPrefixo="doc-1"/>);
    const pessoa = screen.getByText("Ana Souza");
    expect(pessoa.tagName).toBe("MARK");
    expect(pessoa).toHaveAttribute("title", "Pessoa");
    expect(screen.getByText("ana@exemplo.com").tagName).toBe("MARK");
  });

  it("os atalhos levam a cada página (e quebram linha, sem rolagem lateral a 375 px)", () => {
    render(<TextoDoDocumento paginas={PAGINAS} entidades={null} idPrefixo="doc-1"/>);
    const atalhos = screen.getByRole("navigation", { name: "Ir para a página" });
    expect(atalhos).toHaveClass("flex-wrap");
    fireEvent.click(within(atalhos).getByRole("button", { name: "3" }));
    expect(rolar).toHaveBeenCalledTimes(1);
    expect(rolar.mock.contexts[0]).toBe(document.getElementById("doc-1-pagina-3"));
  });

  it("uma página só: sem atalhos", () => {
    render(<TextoDoDocumento paginas={[PAGINAS[0]]} entidades={null} idPrefixo="doc-1"/>);
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByText("Proposta de exportação de café para Lisboa.")).toBeInTheDocument();
  });

  it("em árabe: os títulos e o aviso no idioma da tela, com os números dela; o texto lido segue na direção dele", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<TextoDoDocumento paginas={PAGINAS} entidades={null} idPrefixo="doc-1"/>);
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getAllByRole("heading", { level: 3 })[0]).toHaveTextContent(`الصفحة ${(1).toLocaleString("ar")}`);
    expect(screen.getByText("لم يجد الذكاء الاصطناعي نصًا مقروءًا في هذه الصفحة.")).toBeInTheDocument();
    expect(screen.getByText("Proposta de exportação de café para Lisboa.")).toHaveAttribute("dir", "auto");
    expect(document.body.textContent).not.toMatch(/Página|Ir para/);
  });
});
