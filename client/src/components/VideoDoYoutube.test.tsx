import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { linkDoYoutubeNoSegundo } from "@shared/youtube";
import { VideoDoYoutube } from "./VideoDoYoutube";
import { TempoDoTrecho } from "./ReuniaoComIA";
import { TranscricaoPorFalante, type SegmentoDaTela } from "./TranscricaoPorFalante";

/**
 * A reunião que veio de um vídeo do YouTube (H13) não tem player: a CSP da WRW
 * não deixa embutir o YouTube (frame-src 'none'), e o "▶" de cada fala, item do
 * resumo e citação do Pergunte é um link para o vídeo naquele segundo, numa aba
 * nova. O endereço sai da regra de shared/youtube.ts (provada em
 * server/youtube.test.ts); aqui, o que a tela faz com ele, também a 375 px e
 * em árabe. A página inteira está em pages/Meetings.test.tsx e
 * pages/ReuniaoAberta.test.tsx.
 */

const ID = "dQw4w9WgXcQ";
const CANONICA = `https://www.youtube.com/watch?v=${ID}`;
const linkDoTempo = (segundo: number) => linkDoYoutubeNoSegundo(ID, segundo);

const FALAS: SegmentoDaTela[] = [
  { inicio: 7, fim: 12, falante: "F1", texto: "Bem-vindas ao painel sobre exportação." },
  { inicio: 600, fim: 1200, falante: "", texto: "", lacuna: true },
  { inicio: 1200, fim: 1260, falante: "F2", texto: "Obrigada pelo convite." },
];

// Classe de lado físico (esquerda/direita), que não espelha em árabe.
const LADO_FISICO = /^(?:[a-z0-9-]+:)*-?(?:left|right|ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(?:-|$)/;
function ladosFisicos(raiz: Element) {
  return [raiz, ...raiz.querySelectorAll("*")].flatMap(elemento => [...elemento.classList].filter(classe => LADO_FISICO.test(classe)));
}

afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

// Abre em aba nova sem dar à página do YouTube acesso a esta (window.opener) nem o endereço de onde veio.
function abreEmAbaNova(link: HTMLElement) {
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
}

describe("VideoDoYoutube: o vídeo no lugar da gravação", () => {
  it("o link abre o vídeo pela URL canônica numa aba nova, com o aviso da primeira hora e o de privacidade da dona", () => {
    render(<VideoDoYoutube id={ID}/>);
    expect(screen.getByRole("heading", { name: "Vídeo do YouTube" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Abrir o vídeo no YouTube (abre em nova aba)" });
    expect(link).toHaveAttribute("href", CANONICA);
    abreEmAbaNova(link);
    expect(screen.getByText("A transcrição cobre só os primeiros 60 minutos do vídeo.")).toBeInTheDocument();
    expect(screen.getByText(/A WRW não guarda o vídeo, só o link dele/)).toBeInTheDocument();
    // Nenhum player: nem áudio, nem vídeo, nem frame (a CSP barraria o embed).
    expect(document.querySelector("audio, video, iframe")).toBeNull();
  });

  it("pelo link aberto, o mesmo link, sem o aviso de privacidade da conta da dona", () => {
    render(<VideoDoYoutube id={ID} peloLink/>);
    expect(screen.getByRole("link", { name: /Abrir o vídeo no YouTube/ })).toHaveAttribute("href", CANONICA);
    expect(screen.getByText("A transcrição cobre só os primeiros 60 minutos do vídeo.")).toBeInTheDocument();
    expect(screen.queryByText(/A WRW não guarda o vídeo/)).not.toBeInTheDocument();
  });
});

describe("TempoDoTrecho: o ▶ do item do resumo e da citação do Pergunte", () => {
  it("com o link do vídeo, o ▶ é um link para o YouTube no segundo, numa aba nova, e não o botão do player", () => {
    const aoIrPara = vi.fn();
    render(<TempoDoTrecho segundos={725.6} aoIrPara={aoIrPara} linkDoTempo={linkDoTempo}/>);
    const link = screen.getByRole("link", { name: "Ver no YouTube a partir de 12:05 (abre em nova aba)" });
    expect(link).toHaveAttribute("href", `${CANONICA}&t=725s`);
    expect(link).toHaveTextContent("12:05");
    abreEmAbaNova(link);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("sem o link do vídeo, continua o botão que leva o player ao ponto", () => {
    const aoIrPara = vi.fn();
    render(<TempoDoTrecho segundos={42} aoIrPara={aoIrPara}/>);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir a partir de 00:42" }));
    expect(aoIrPara).toHaveBeenCalledWith(42);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("TranscricaoPorFalante: o tempo de cada fala abre o vídeo", () => {
  it("cada fala leva ao vídeo no segundo em que começa; o trecho que não chegou continua só texto", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} linkDoTempo={linkDoTempo}/>);
    const links = within(document.querySelector("ol")!).getAllByRole("link");
    expect(links.map(link => link.getAttribute("href"))).toEqual([`${CANONICA}&t=7s`, `${CANONICA}&t=1200s`]);
    links.forEach(abreEmAbaNova);
    expect(screen.getByRole("link", { name: "Ver no YouTube a partir de 20:00 (abre em nova aba)" })).toHaveTextContent("20:00");
    expect(screen.getByText(/10:00–20:00 · trecho não recebido/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
  });

  it("a busca filtra as falas e o link de cada uma continua no segundo dela", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} linkDoTempo={linkDoTempo}/>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "convite" } });
    expect(within(document.querySelector("ol")!).getAllByRole("link").map(link => link.getAttribute("href"))).toEqual([`${CANONICA}&t=1200s`]);
  });
});

describe("o ▶ do vídeo a 375 px e em árabe", () => {
  it("em árabe: a tela vira da direita para a esquerda, o rótulo é traduzido, e o tempo e o endereço não mudam", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    render(<TranscricaoPorFalante segmentos={FALAS} linkDoTempo={linkDoTempo}/>);
    expect(document.documentElement.dir).toBe("rtl");
    const link = screen.getByRole("link", { name: "المشاهدة على YouTube من 20:00 (يُفتح في علامة تبويب جديدة)" });
    expect(link).toHaveAttribute("href", `${CANONICA}&t=1200s`);
    expect(link).toHaveTextContent("20:00");
  });

  // O jsdom não mede layout: o teste fixa as classes que fazem a fala caber
  // numa tela de 375 px, nos dois sentidos da escrita.
  it.each(["pt-BR", "ar"])("em %s, a 375 px: o tempo não encolhe, o texto da fala quebra ao lado dele, e só há lados lógicos", async idioma => {
    await act(async () => { await i18n.changeLanguage(idioma); });
    const { container } = render(<TranscricaoPorFalante segmentos={FALAS} linkDoTempo={linkDoTempo}/>);
    const [link] = within(document.querySelector("ol")!).getAllByRole("link");
    expect(link).toHaveClass("shrink-0");
    // A coluna da fala pode encolher (min-w-0): o texto quebra a linha em vez de empurrar a tela para o lado.
    expect(link.nextElementSibling).toHaveClass("min-w-0");
    expect(ladosFisicos(container)).toEqual([]);
  });

  it.each(["pt-BR", "ar"])("em %s: o bloco do vídeo e o ▶ do resumo só usam lados lógicos", async idioma => {
    await act(async () => { await i18n.changeLanguage(idioma); });
    const { container } = render(<><VideoDoYoutube id={ID}/><TempoDoTrecho segundos={42} linkDoTempo={linkDoTempo}/></>);
    expect(ladosFisicos(container)).toEqual([]);
    expect(screen.getByRole("link", { name: i18n.t("meetings.youtube.watchFrom", { tempo: "00:42" }) })).toHaveAttribute("href", `${CANONICA}&t=42s`);
  });
});
