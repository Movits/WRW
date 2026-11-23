import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHAVE_DAS_VOZES_NA_TRANSCRICAO, CHAVE_DOS_HORARIOS_NA_TRANSCRICAO, mmss, segmentosValidos, tempoDeFala, TranscricaoPorFalante, type SegmentoDaTela } from "./TranscricaoPorFalante";

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

  // Conferência de tela de 20/11/2026 (captura 13c): a vinheta de um vídeo do
  // YouTube veio como "[música]" com o falante F2, e o tempo de fala mostrava
  // "Falante 2: 00:12, 8%", uma voz que não existe.
  it("a marca sem fala ([música], [ruído]) não é voz: fica fora do tempo de fala e sem rótulo na lista", () => {
    const comVinheta: SegmentoDaTela[] = [
      { inicio: 0, fim: 12, falante: "F2", texto: "[música]" },
      { inicio: 12, fim: 132, falante: "F1", texto: "Hoje eu vou contar como o Pix nasceu." },
      { inicio: 132, fim: 140, falante: "F1", texto: "[ruído] [música]" },
      { inicio: 140, fim: 150, falante: "F3", texto: "[inaudível] obrigado" },
    ];
    expect(tempoDeFala(comVinheta)).toEqual([
      { falante: "F1", segundos: 120, fracao: 120 / 130 },
      { falante: "F3", segundos: 10, fracao: 10 / 130 },
    ]);
    render(<TranscricaoPorFalante segmentos={comVinheta} />);
    const tempo = screen.getByText("Tempo de fala").closest("div")!;
    expect(within(tempo).queryByText("Falante 2")).not.toBeInTheDocument();
    const lista = document.querySelector("ol")!;
    expect(within(lista).queryByText("Falante 2")).not.toBeInTheDocument();
    expect(within(lista).getByText("[música]")).toBeInTheDocument();
    expect(within(lista).getAllByText("Falante 1")).toHaveLength(1);
    expect(within(lista).getByText("Falante 3")).toBeInTheDocument();
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

/**
 * D2 (HN-26 do HiNoter): mostrar ou esconder as vozes e os horários (guardado
 * no navegador de quem lê) e ouvir só uma voz, que filtra a lista e pede ao
 * player para tocar só as falas dela.
 */
describe("TranscricaoPorFalante — vozes, horários e ouvir só uma voz (D2)", () => {
  afterEach(() => {
    localStorage.removeItem(CHAVE_DAS_VOZES_NA_TRANSCRICAO);
    localStorage.removeItem(CHAVE_DOS_HORARIOS_NA_TRANSCRICAO);
  });
  const lista = () => document.querySelector("ol")!;

  it("esconder as vozes tira o rótulo de cada fala; esconder os horários tira o tempo, também do trecho que não chegou; a escolha fica guardada", () => {
    const { unmount } = render(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={vi.fn()} />);
    const vozes = screen.getByRole("button", { name: "Vozes" });
    const horarios = screen.getByRole("button", { name: "Horários" });
    expect(vozes).toHaveAttribute("aria-pressed", "true");
    expect(horarios).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(vozes);
    expect(vozes).toHaveAttribute("aria-pressed", "false");
    expect(within(lista()).queryByText("Falante 1")).not.toBeInTheDocument();
    expect(localStorage.getItem(CHAVE_DAS_VOZES_NA_TRANSCRICAO)).toBe("0");
    fireEvent.click(horarios);
    // O horário sai da fala; o ▶ dela fica, só com o ícone (o tempo vai no nome).
    expect(screen.getByRole("button", { name: "Ouvir a partir de 20:00" }).textContent).toBe("");
    expect(within(lista()).queryByText("20:00")).not.toBeInTheDocument();
    expect(within(lista()).getByText("trecho não recebido")).toBeInTheDocument();
    expect(within(lista()).queryByText(/10:00–20:00/)).not.toBeInTheDocument();
    // O texto das falas continua.
    expect(within(lista()).getByText("O frete fica para sexta.")).toBeInTheDocument();
    unmount();
    render(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Vozes" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Horários" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Vozes" }));
    expect(within(lista()).getAllByText("Falante 1")).toHaveLength(2);
  });

  it("com os horários escondidos, cada fala continua com o ▶ que leva o player ao trecho, só com o ícone; no YouTube, o link para o vídeo; sem player, nada", () => {
    localStorage.setItem(CHAVE_DOS_HORARIOS_NA_TRANSCRICAO, "0");
    const aoIrPara = vi.fn();
    const { unmount } = render(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={aoIrPara} />);
    expect(screen.getByRole("button", { name: "Horários" })).toHaveAttribute("aria-pressed", "false");
    // Um ▶ por fala (a lacuna não tem), sem o horário escrito.
    const tocar = screen.getAllByRole("button", { name: /^Ouvir a partir de / });
    expect(tocar.map(botao => botao.getAttribute("aria-label"))).toEqual(["Ouvir a partir de 00:00", "Ouvir a partir de 01:00", "Ouvir a partir de 20:00"]);
    for (const botao of tocar) expect(botao.textContent).toBe("");
    fireEvent.click(tocar[2]);
    expect(aoIrPara).toHaveBeenCalledWith(1200);
    unmount();

    const { unmount: fecharYoutube } = render(<TranscricaoPorFalante segmentos={FALAS} linkDoTempo={segundo => `https://www.youtube.com/watch?v=abcdefghijk&t=${segundo}s`} />);
    const assistir = screen.getByRole("link", { name: "Ver no YouTube a partir de 20:00 (abre em nova aba)" });
    expect(assistir).toHaveAttribute("href", "https://www.youtube.com/watch?v=abcdefghijk&t=1200s");
    expect(assistir.textContent).toBe("");
    fecharYoutube();

    // Sem player (a gravação venceu), não há para onde ir: nenhum botão.
    render(<TranscricaoPorFalante segmentos={FALAS} />);
    expect(screen.queryByRole("button", { name: /Ouvir a partir de/ })).not.toBeInTheDocument();
  });

  it("no celular (abaixo de sm), a barra do tempo de fala vai para uma linha só dela, embaixo do nome; a partir de sm, volta ao meio da linha", () => {
    // Com o botão de ouvir só esta voz na linha, o nome, o tempo e o botão deixavam a barra com 16 px a 375 px.
    render(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={vi.fn()} aoOuvirSoAVoz={vi.fn()} aoNomear={vi.fn()} />);
    for (const nome of ["Falante 1", "Falante 2"]) {
      const linha = screen.getByRole("button", { name: `Ouvir só a voz de ${nome}` }).closest("li")!;
      expect(linha).toHaveClass("flex-wrap", "sm:flex-nowrap");
      const barra = linha.querySelector("[data-barra-do-tempo-de-fala]");
      expect(barra).toHaveClass("order-last", "basis-full", "sm:order-none", "sm:flex-1");
      // O nome fica com o resto da primeira linha no celular, e com a coluna de sempre a partir de sm.
      expect(within(linha).getByRole("button", { name: `Dar nome a esta voz: ${nome}` })).toHaveClass("flex-1", "sm:w-24", "sm:flex-none");
    }
    // O campo do nome, aberto, fica com a primeira linha inteira no celular: ao lado do tempo, o campo e o
    // Salvar passavam por cima dele.
    fireEvent.click(screen.getByRole("button", { name: "Dar nome a esta voz: Falante 2" }));
    const campo = screen.getByRole("textbox", { name: "Nome do falante 2" });
    expect(campo.closest("form")!.parentElement).toHaveClass("basis-full", "sm:flex-initial");
    expect(campo.closest("li")!.querySelector("[data-barra-do-tempo-de-fala]")).toHaveClass("order-last", "basis-full");
  });

  it("o armazenamento que lança não quebra a transcrição: mostra tudo, e a escolha vale na visita", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("bloqueado"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("bloqueado"); });
    try {
      render(<TranscricaoPorFalante segmentos={FALAS} />);
      expect(within(lista()).getAllByText("Falante 1")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Vozes" }));
      expect(within(lista()).queryByText("Falante 1")).not.toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ouvir só esta voz: o botão de cada voz pede ao player; escolhida, a lista mostra só as falas dela, e tocar de novo volta a todas", () => {
    const aoOuvirSoAVoz = vi.fn();
    const { rerender } = render(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={vi.fn()} aoOuvirSoAVoz={aoOuvirSoAVoz} />);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir só a voz de Falante 2" }));
    expect(aoOuvirSoAVoz).toHaveBeenCalledWith("F2");
    rerender(<TranscricaoPorFalante segmentos={FALAS} aoIrPara={vi.fn()} soAVoz="F2" aoOuvirSoAVoz={aoOuvirSoAVoz} />);
    expect(screen.getByRole("button", { name: "Ouvir só a voz de Falante 2" })).toHaveAttribute("aria-pressed", "true");
    expect(lista().querySelectorAll(":scope > li")).toHaveLength(1);
    expect(within(lista()).getByText("O frete fica para sexta.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Ouvindo e mostrando só as falas de Falante 2.");
    fireEvent.click(screen.getByRole("button", { name: "Ouvir só a voz de Falante 2" }));
    expect(aoOuvirSoAVoz).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Ouvir todas as vozes" }));
    expect(aoOuvirSoAVoz).toHaveBeenLastCalledWith(null);
  });

  it("com o nome dado à voz (H3), o botão e o aviso usam o nome", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} nomes={{ F1: "Ana" }} soAVoz="F1" aoOuvirSoAVoz={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ouvir só a voz de Ana" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Ouvindo e mostrando só as falas de Ana.");
  });

  it("sem player (a gravação venceu), não há o botão de ouvir só uma voz", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} />);
    expect(screen.queryByRole("button", { name: /Ouvir só a voz/ })).not.toBeInTheDocument();
  });
});

describe("TranscricaoPorFalante — a edição da dona (H18)", () => {
  const originais = new Map([[1, { texto: "O frete fica para quinta.", falante: "F1" }]]);
  const edicao = (editando: boolean, extra: Partial<{ aoSalvarTrecho: ReturnType<typeof vi.fn>; aoRestaurar: ReturnType<typeof vi.fn> }> = {}) => ({
    originais, editando, aoSalvarTrecho: extra.aoSalvarTrecho ?? vi.fn(async () => true), aoRestaurar: extra.aoRestaurar ?? vi.fn(async () => undefined),
  });

  it("sem a edição (o link aberto), nenhum botão nem marca de editado", () => {
    render(<TranscricaoPorFalante segmentos={FALAS} />);
    expect(screen.queryByRole("button", { name: /Editar o trecho/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Editado por você")).not.toBeInTheDocument();
  });

  it("fora da edição, só a marca no trecho mudado; na edição, o botão em cada fala (nunca no trecho que não chegou), o original e a voz de antes", () => {
    const { rerender } = render(<TranscricaoPorFalante segmentos={FALAS} edicao={edicao(false)} />);
    expect(screen.getAllByText("Editado por você")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Editar o trecho/ })).not.toBeInTheDocument();
    rerender(<TranscricaoPorFalante segmentos={FALAS} edicao={edicao(true)} />);
    expect(screen.getAllByRole("button", { name: /Editar o trecho de/ }).map(b => b.getAttribute("aria-label"))).toEqual([
      "Editar o trecho de 00:00", "Editar o trecho de 01:00", "Editar o trecho de 20:00",
    ]);
    // O original da IA, com a voz de antes, porque ela mudou.
    const original = screen.getByText("O frete fica para quinta.");
    expect(original.closest("p")).toHaveTextContent("Falante 1: O frete fica para quinta.");
  });

  it("salvar manda só o que mudou, pela posição do trecho; Esc fecha sem mandar nada", async () => {
    const aoSalvarTrecho = vi.fn(async () => true);
    render(<TranscricaoPorFalante segmentos={FALAS} edicao={edicao(true, { aoSalvarTrecho })} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 20:00" }));
    fireEvent.keyDown(screen.getByLabelText("Texto do trecho"), { key: "Escape" });
    expect(screen.queryByLabelText("Texto do trecho")).not.toBeInTheDocument();
    // O foco volta ao "Editar" do trecho.
    await waitFor(() => expect(screen.getByRole("button", { name: "Editar o trecho de 20:00" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 20:00" }));
    // Sem mudança, salvar só fecha.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    expect(aoSalvarTrecho).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 20:00" }));
    fireEvent.change(screen.getByLabelText("Voz"), { target: { value: "F2" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    expect(aoSalvarTrecho).toHaveBeenCalledWith(3, { falante: "F2" });
    // O texto vazio não sai.
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 00:00" }));
    fireEvent.change(screen.getByLabelText("Texto do trecho"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("a recusa mantém o formulário aberto; voltar ao original pede pela posição", async () => {
    const aoSalvarTrecho = vi.fn(async () => false);
    const aoRestaurar = vi.fn(async () => undefined);
    render(<TranscricaoPorFalante segmentos={FALAS} edicao={edicao(true, { aoSalvarTrecho, aoRestaurar })} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar o trecho de 01:00" }));
    fireEvent.change(screen.getByLabelText("Texto do trecho"), { target: { value: "O frete fica para segunda." } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar" })); });
    expect(aoSalvarTrecho).toHaveBeenCalledWith(1, { texto: "O frete fica para segunda." });
    expect(screen.getByLabelText("Texto do trecho")).toHaveValue("O frete fica para segunda.");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Voltar o trecho de 01:00 ao original" })); });
    expect(aoRestaurar).toHaveBeenCalledWith(1);
  });
});
