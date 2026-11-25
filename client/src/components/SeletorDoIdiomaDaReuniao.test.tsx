import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DicaDoIdiomaDaReuniao, IdiomasDetectados, OpcaoDoIdiomaOriginal, SeletorDoIdiomaDaReuniao } from "./SeletorDoIdiomaDaReuniao";

/**
 * O "Idioma da reunião" com "Detectar sozinho" e os outros idiomas que a IA
 * transcreve (G16), a opção do original na lista da tradução e a linha dos
 * idiomas que a IA reconheceu. Os nomes dos 99 idiomas fora da tela vêm do
 * Intl.DisplayNames, no idioma de quem lê.
 */
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("SeletorDoIdiomaDaReuniao", () => {
  it("\"Detectar sozinho\" no topo, os 10 da tela e os outros pelo nome em português, em ordem alfabética", () => {
    render(<SeletorDoIdiomaDaReuniao id="idioma" valor="pt-BR" aoMudar={() => {}}/>);
    const seletor = screen.getByRole("combobox");
    const opcoes = within(seletor).getAllByRole("option") as HTMLOptionElement[];
    expect(opcoes[0]).toHaveTextContent("Detectar sozinho");
    expect(opcoes[0].value).toBe("auto");
    expect(opcoes).toHaveLength(1 + 109);
    const daTela = within(screen.getByRole("group", { name: "Idiomas do site" })).getAllByRole("option") as HTMLOptionElement[];
    expect(daTela.map(opcao => opcao.value)).toEqual(["pt-BR", "en", "es", "fr", "ar", "zh", "hi", "de", "ja", "ru"]);
    const outros = within(screen.getByRole("group", { name: "Outros idiomas" })).getAllByRole("option") as HTMLOptionElement[];
    expect(outros).toHaveLength(99);
    expect(outros.find(opcao => opcao.value === "it")).toHaveTextContent("Italiano");
    expect(outros.find(opcao => opcao.value === "ko")).toHaveTextContent("Coreano");
    const nomes = outros.map(opcao => opcao.textContent ?? "");
    expect(nomes).toEqual([...nomes].sort(new Intl.Collator("pt-BR").compare));
  });

  it("escolher \"Detectar sozinho\" ou um idioma de fora da tela devolve o código dele", () => {
    const aoMudar = vi.fn();
    render(<SeletorDoIdiomaDaReuniao valor="pt-BR" aoMudar={aoMudar}/>);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "auto" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "it" } });
    expect(aoMudar.mock.calls).toEqual([["auto"], ["it"]]);
  });

  it("com a tela em árabe, os outros idiomas vêm com o nome em árabe", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<SeletorDoIdiomaDaReuniao valor="auto" aoMudar={() => {}}/>);
    expect(screen.getByRole("option", { name: "الإيطالية" })).toBeInTheDocument();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("auto");
  });

  it("a dica muda com \"Detectar sozinho\"", () => {
    const { rerender } = render(<DicaDoIdiomaDaReuniao valor="pt-BR"/>);
    expect(screen.queryByText(/reconhece o idioma de cada fala/)).not.toBeInTheDocument();
    rerender(<DicaDoIdiomaDaReuniao valor="auto"/>);
    expect(screen.getByText(/A IA reconhece o idioma de cada fala, mesmo quando a conversa muda de idioma no meio/)).toBeInTheDocument();
  });
});

describe("OpcaoDoIdiomaOriginal", () => {
  it("o original fora dos 10 da tela ganha a opção, marcada (original); o dos 10 já está na lista", () => {
    const { rerender } = render(<select><OpcaoDoIdiomaOriginal idioma="it"/></select>);
    expect(screen.getByRole("option", { name: "Italiano (original)" })).toHaveValue("it");
    rerender(<select><OpcaoDoIdiomaOriginal idioma="en"/></select>);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("IdiomasDetectados", () => {
  const fala = (inicio: number, fim: number, idioma: string) => ({ inicio, fim, falante: "F1", texto: "uma fala", idioma });

  it("nada na reunião com o idioma escolhido", () => {
    const { container } = render(<IdiomasDetectados escolha="pt-BR" idiomaDaTranscricao="pt-BR" segmentos={[fala(0, 10, "en")]}/>);
    expect(container).toBeEmptyDOMElement();
  });

  it("um idioma só: a frase diz qual, mesmo sem as falas (o envio único)", () => {
    render(<IdiomasDetectados escolha="auto" idiomaDaTranscricao="ko" segmentos={null}/>);
    expect(screen.getByRole("note")).toHaveTextContent("Idioma reconhecido pela IA: coreano.");
  });

  it("a conversa que mudou de idioma: os idiomas com a fração de cada um e o do resumo", () => {
    render(<IdiomasDetectados escolha="auto" idiomaDaTranscricao="en" segmentos={[fala(0, 70, "en"), fala(70, 100, "pt-BR"), fala(100, 101, "es")]}/>);
    // O espanhol (1%) é uma palavra solta: fica de fora.
    const nota = screen.getByRole("note");
    expect(nota).toHaveTextContent(/Idiomas reconhecidos pela IA: inglês \(69\s?%\), português \(30\s?%\)\. O resumo sai em inglês, o que mais aparece\./);
    expect(nota).not.toHaveTextContent("espanhol");
  });
});
