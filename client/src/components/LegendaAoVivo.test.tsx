import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { RECUSAS_DA_LEGENDA, VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA } from "@shared/legenda-ao-vivo";
import { RECUSAS_DA_LIXEIRA } from "@shared/lixeira-de-reunioes";
import { CHAVE_DO_TAMANHO_DA_LETRA, TAMANHOS_DA_LETRA } from "@/lib/legenda-ao-vivo";
import { instalarReconhecimentoFalso } from "@/test/reconhecimento-falso";
import { LegendaAoVivo } from "./LegendaAoVivo";

/**
 * A legenda ao vivo do gravador na tela (G15b). O reconhecimento é o de
 * mentira (test/reconhecimento-falso.ts); o ligar no servidor (a prova na
 * auditoria) é um dublê, e o que ele grava está em
 * server/legenda-ao-vivo.integracao.test.ts.
 */
const duble = vi.hoisted(() => ({ ligar: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { useUtils: () => duble.utils },
}));
// O mesmo objeto a cada render, como o useUtils do tRPC.
(duble as unknown as { utils: unknown }).utils = { client: { meetings: { ligarLegendaAoVivo: { mutate: (...args: unknown[]) => duble.ligar(...args) } } } };

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const erroDoServidor = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });
const AGENTE_ORIGINAL = Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent");

let falso: ReturnType<typeof instalarReconhecimentoFalso>;

beforeEach(() => {
  duble.ligar.mockReset().mockResolvedValue({ success: true });
  falso = instalarReconhecimentoFalso();
  localStorage.clear();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (AGENTE_ORIGINAL) Object.defineProperty(Navigator.prototype, "userAgent", AGENTE_ORIGINAL);
  await i18n.changeLanguage("pt-BR");
});

type Props = Parameters<typeof LegendaAoVivo>[0];
const desenhar = (props: Partial<Props> = {}) => {
  const todas: Props = { meetingId: ID, idioma: "pt-BR", ativa: true, microfoneCaiu: false, ...props };
  const tela = render(<LegendaAoVivo {...todas}/>);
  return { ...tela, mudar: (novas: Partial<Props>) => tela.rerender(<LegendaAoVivo {...todas} {...novas}/>) };
};

/** Toca no Ligar, marca a caixa e confirma: a legenda liga depois da prova. */
async function ligarComAviso() {
  fireEvent.click(screen.getByRole("button", { name: "Ligar a legenda" }));
  const aviso = await screen.findByRole("alertdialog");
  fireEvent.click(within(aviso).getByRole("checkbox"));
  await act(async () => { fireEvent.click(within(aviso).getByRole("button", { name: "Ligar a legenda" })); });
  return aviso;
}

describe("LegendaAoVivo (G15b)", () => {
  it("onde o navegador não tem o reconhecimento de voz, o botão não aparece", () => {
    vi.unstubAllGlobals();
    const { container } = desenhar();
    expect(container).toBeEmptyDOMElement();
  });

  it("no celular, mesmo com o reconhecimento, o botão não aparece até o teste no aparelho (decisão vetável)", () => {
    Object.defineProperty(Navigator.prototype, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    });
    const { container } = desenhar();
    expect(container).toBeEmptyDOMElement();
  });

  it("antes de ligar, o aviso: o Google no Chrome, não separa quem fala, não fica guardada; nada ouve antes da confirmação", async () => {
    desenhar();
    expect(screen.getByRole("heading", { name: "Legenda ao vivo" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ligar a legenda" }));
    const aviso = await screen.findByRole("alertdialog");
    expect(within(aviso).getByText("Ligar a legenda ao vivo?")).toBeInTheDocument();
    expect(aviso).toHaveTextContent("No Chrome, ele costuma mandar o áudio a um servidor do Google para virar texto");
    expect(aviso).toHaveTextContent("A legenda não separa quem fala");
    expect(aviso).toHaveTextContent("Ela não fica guardada");
    expect(aviso).toHaveTextContent("A transcrição da reunião continua sendo a da IA");
    // Sem a caixa marcada, não liga.
    const confirmar = within(aviso).getByRole("button", { name: "Ligar a legenda" });
    expect(confirmar).toBeDisabled();
    expect(falso.criados).toHaveLength(0);
    expect(duble.ligar).not.toHaveBeenCalled();
    // "Agora não" fecha sem ligar nada.
    fireEvent.click(within(aviso).getByRole("button", { name: "Agora não" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(falso.criados).toHaveLength(0);
    expect(duble.ligar).not.toHaveBeenCalled();
  });

  it("confirmada, a prova vai ao servidor com o aviso que a dona viu, e só então a legenda ouve, no idioma da reunião", async () => {
    desenhar();
    await ligarComAviso();
    expect(duble.ligar).toHaveBeenCalledTimes(1);
    const pedido = duble.ligar.mock.calls[0][0];
    expect(pedido).toMatchObject({ meetingId: ID, concordanciaDasPessoas: true, versaoDoAviso: VERSAO_VIGENTE_DO_AVISO_DA_LEGENDA, idioma: "pt-BR" });
    expect(pedido.textoExibido).toContain("Ligar a legenda ao vivo?");
    expect(pedido.textoExibido).toContain("servidor do Google");
    expect(pedido.textoExibido).toContain("As pessoas desta reunião sabem");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(falso.criados).toHaveLength(1);
    expect(falso.atual()).toMatchObject({ lang: "pt-BR", emCurso: true });
    expect(screen.getByText("Ouvindo… o texto aparece aqui alguns segundos depois da fala.")).toBeInTheDocument();
    expect(screen.getByText(/Legenda em português, do navegador/)).toBeInTheDocument();
  });

  it("o texto aparece na caixa (o provisório mais apagado) e some ao desligar; ligar de novo na mesma gravação não pergunta outra vez", async () => {
    desenhar();
    await ligarComAviso();
    falso.resultados(["Bom dia a todas.", { texto: "vamos começar", final: false }]);
    const caixa = screen.getByRole("region", { name: "Texto da legenda ao vivo" });
    expect(within(caixa).getByText("Bom dia a todas.")).toHaveAttribute("dir", "auto");
    expect(within(caixa).getByText("vamos começar")).toHaveClass("text-white/55");

    fireEvent.click(screen.getByRole("button", { name: /Desligar/ }));
    expect(falso.atual().chamadas.abort).toBe(1);
    expect(screen.queryByText("Bom dia a todas.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ligar a legenda" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(duble.ligar).toHaveBeenCalledTimes(1);
    expect(falso.criados).toHaveLength(2);
    expect(falso.atual().emCurso).toBe(true);
  });

  it("a letra cresce e diminui nos limites, e o aparelho lembra o tamanho", async () => {
    desenhar();
    await ligarComAviso();
    const caixa = screen.getByRole("region", { name: "Texto da legenda ao vivo" });
    expect(caixa).toHaveStyle({ fontSize: `${TAMANHOS_DA_LETRA[1]}px` });
    const maior = screen.getByRole("button", { name: "Aumentar a letra da legenda" });
    const menor = screen.getByRole("button", { name: "Diminuir a letra da legenda" });
    fireEvent.click(maior);
    expect(caixa).toHaveStyle({ fontSize: `${TAMANHOS_DA_LETRA[2]}px` });
    expect(localStorage.getItem(CHAVE_DO_TAMANHO_DA_LETRA)).toBe("2");
    fireEvent.click(menor);
    fireEvent.click(menor);
    expect(caixa).toHaveStyle({ fontSize: `${TAMANHOS_DA_LETRA[0]}px` });
    expect(menor).toBeDisabled();
    for (let i = 0; i < TAMANHOS_DA_LETRA.length; i++) fireEvent.click(maior);
    expect(caixa).toHaveStyle({ fontSize: `${TAMANHOS_DA_LETRA[TAMANHOS_DA_LETRA.length - 1]}px` });
    expect(maior).toBeDisabled();
  });

  it("o tamanho guardado no aparelho vale na próxima gravação", async () => {
    localStorage.setItem(CHAVE_DO_TAMANHO_DA_LETRA, "4");
    desenhar();
    await ligarComAviso();
    expect(screen.getByRole("region", { name: "Texto da legenda ao vivo" })).toHaveStyle({ fontSize: `${TAMANHOS_DA_LETRA[4]}px` });
  });

  it.each([
    ["a reunião que não existe mais", erroDoServidor("NOT_FOUND", "Reunião não encontrada."), "Esta reunião não existe mais."],
    ["a gravação que foi para a lixeira por outro aparelho", erroDoServidor("NOT_FOUND", RECUSAS_DA_LIXEIRA.naLixeira), "Esta reunião está na lixeira."],
    ["a reunião que já não grava", erroDoServidor("PRECONDITION_FAILED", RECUSAS_DA_LEGENDA.foraDaGravacao), "A legenda só liga enquanto a reunião está gravando."],
    ["o teto", erroDoServidor("TOO_MANY_REQUESTS", RECUSAS_DA_LEGENDA.demais), "A legenda foi ligada muitas vezes em sequência. Aguarde alguns minutos e tente de novo."],
    ["o banco fora do ar", erroDoServidor("INTERNAL_SERVER_ERROR", MENSAGEM_BANCO_INDISPONIVEL), "Banco de dados indisponível; tente de novo em instantes"],
  ])("sem a prova (%s), a legenda não liga: o aviso fica aberto com a recusa traduzida", async (_caso, erro, frase) => {
    duble.ligar.mockRejectedValue(erro);
    desenhar();
    const aviso = await ligarComAviso();
    expect(within(aviso).getByRole("alert")).toHaveTextContent(frase);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(falso.criados).toHaveLength(0);
  });

  it("em inglês, a recusa e o aviso saem traduzidos, nunca o código", async () => {
    await i18n.changeLanguage("en");
    duble.ligar.mockRejectedValue(erroDoServidor("PRECONDITION_FAILED", RECUSAS_DA_LEGENDA.foraDaGravacao));
    desenhar();
    fireEvent.click(screen.getByRole("button", { name: "Turn on captions" }));
    const aviso = await screen.findByRole("alertdialog");
    expect(aviso).toHaveTextContent("In Chrome, it usually sends the audio to a Google server");
    fireEvent.click(within(aviso).getByRole("checkbox"));
    await act(async () => { fireEvent.click(within(aviso).getByRole("button", { name: "Turn on captions" })); });
    expect(within(aviso).getByRole("alert")).toHaveTextContent("Captions can only be turned on while the meeting is recording.");
    expect(aviso).not.toHaveTextContent(RECUSAS_DA_LEGENDA.foraDaGravacao);
    expect(duble.ligar.mock.calls[0][0]).toMatchObject({ idioma: "en" });
  });

  it("com a gravação pausada, a legenda diz que pausou junto, e volta a ouvir com a gravação", async () => {
    const { mudar } = desenhar();
    await ligarComAviso();
    falso.resultados(["Antes da pausa."]);
    mudar({ ativa: false });
    expect(screen.getByRole("status")).toHaveTextContent("Legenda pausada junto com a gravação");
    expect(screen.getByText("Antes da pausa.")).toBeInTheDocument();
    expect(falso.atual().emCurso).toBe(false);
    mudar({ ativa: true });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(falso.atual().emCurso).toBe(true);
  });

  it("pausada antes de qualquer texto, a pausa é dita dentro da caixa, uma vez só", async () => {
    const { mudar } = desenhar();
    await ligarComAviso();
    mudar({ ativa: false });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("A legenda está pausada junto com a gravação.");
  });

  it("o microfone da gravação que cai desliga a legenda, com o aviso", async () => {
    const { mudar } = desenhar();
    await ligarComAviso();
    mudar({ ativa: false, microfoneCaiu: true });
    expect(screen.getByRole("alert")).toHaveTextContent("A legenda desligou porque o microfone da gravação desconectou.");
    expect(screen.getByRole("button", { name: "Ligar a legenda" })).toBeInTheDocument();
  });

  it("a falha do navegador desliga com a frase dela (o idioma sem suporte diz qual)", async () => {
    desenhar({ idioma: "it" });
    await ligarComAviso();
    expect(falso.atual().lang).toBe("it");
    falso.errar("language-not-supported");
    expect(screen.getByRole("alert")).toHaveTextContent("O reconhecimento de voz deste navegador não tem italiano.");
  });

  it("no “Detectar sozinho”, a legenda ouve no idioma da tela e diz isso", async () => {
    desenhar({ idioma: "auto" });
    await ligarComAviso();
    expect(falso.atual().lang).toBe("pt-BR");
    expect(screen.getByText(/a legenda fica no idioma da tela/)).toBeInTheDocument();
  });

  it("em árabe, o aviso e os botões saem em árabe, e a linha segue a direção do próprio texto", async () => {
    await i18n.changeLanguage("ar");
    desenhar({ idioma: "ar" });
    fireEvent.click(screen.getByRole("button", { name: "تشغيل التسميات التوضيحية" }));
    const aviso = await screen.findByRole("alertdialog");
    expect(aviso).toHaveTextContent("في Chrome، يُرسَل الصوت عادةً إلى خادم تابع لـ Google");
    fireEvent.click(within(aviso).getByRole("checkbox"));
    await act(async () => { fireEvent.click(within(aviso).getByRole("button", { name: "تشغيل التسميات التوضيحية" })); });
    expect(falso.atual().lang).toBe("ar-SA");
    falso.resultados(["صباح الخير للجميع."]);
    expect(screen.getByText("صباح الخير للجميع.")).toHaveAttribute("dir", "auto");
  });

  it("a confirmação que volta do servidor depois do fim da gravação não liga nada", async () => {
    let responder: (valor: unknown) => void = () => {};
    duble.ligar.mockReturnValue(new Promise(resolver => { responder = resolver; }));
    const { unmount } = desenhar();
    fireEvent.click(screen.getByRole("button", { name: "Ligar a legenda" }));
    const aviso = await screen.findByRole("alertdialog");
    fireEvent.click(within(aviso).getByRole("checkbox"));
    fireEvent.click(within(aviso).getByRole("button", { name: "Ligar a legenda" }));
    expect(duble.ligar).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { responder({ success: true }); });
    expect(falso.criados).toHaveLength(0);
  });

  it("sair da tela (o fim da gravação) solta o reconhecimento", async () => {
    const { unmount } = desenhar();
    await ligarComAviso();
    const atual = falso.atual();
    unmount();
    expect(atual.chamadas.abort).toBe(1);
  });
});
