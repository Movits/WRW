import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { rotaDaReuniao } from "@shared/rotas";
import { VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE } from "@shared/youtube";
import { VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO } from "@shared/aviso-de-gravacao";
import { ResumoDoYoutube } from "./ResumoDoYoutube";

/**
 * "Resumir um vídeo do YouTube" (H13), na lista de Reuniões: a janela confere
 * o link com a mesma regra do servidor (shared/youtube.ts), exige o aviso do
 * YouTube aceito e manda a versão dele; a reunião nasce no servidor e a tela
 * vai ao detalhe. As recusas chegam como código e saem traduzidas. O servidor
 * está em server/youtube-rota.test.ts e server/youtube.integracao.test.ts.
 */

type Pedido = { title: string; url: string; language: string; consentGranted: true; consentNoticeVersion: string };
type Opcoes = { onSuccess: (resposta: { id: string }) => void };

const duble = vi.hoisted(() => ({
  navegar: vi.fn(),
  invalidarLista: vi.fn(),
  pedido: { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null as unknown },
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("wouter", async original => ({ ...(await original<typeof import("wouter")>()), useLocation: () => ["/meetings", duble.navegar] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { list: { invalidate: duble.invalidarLista } } }),
    meetings: { resumirVideoDoYoutube: { useMutation: () => duble.pedido } },
  },
}));

const ID_DA_REUNIAO = "c0ffee00-0000-4000-8000-000000000001";

beforeEach(() => {
  duble.navegar.mockReset();
  duble.invalidarLista.mockReset();
  duble.pedido = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };
  vi.mocked(toast.success).mockReset();
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

function abrirJanela() {
  render(<ResumoDoYoutube/>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.youtube.openButton") }));
  return screen.getByRole("dialog");
}

function preencher(campos: { link?: string; titulo?: string; idioma?: string; aceito?: boolean }) {
  if (campos.link !== undefined) fireEvent.change(screen.getByLabelText("Link do vídeo"), { target: { value: campos.link } });
  if (campos.titulo !== undefined) fireEvent.change(screen.getByLabelText("Título da reunião"), { target: { value: campos.titulo } });
  if (campos.idioma !== undefined) fireEvent.change(screen.getByLabelText("Idioma falado no vídeo"), { target: { value: campos.idioma } });
  if (campos.aceito) fireEvent.click(screen.getByRole("checkbox", { name: "Li o aviso e quero que a IA do Google leia este vídeo para transcrevê-lo e resumi-lo." }));
}
const enviar = () => fireEvent.click(screen.getByRole("button", { name: "Resumir vídeo" }));

describe("Resumir um vídeo do YouTube: a janela", () => {
  it("o botão abre a janela com o aviso do YouTube (a primeira hora, o teto por dia) e a caixa do aviso desmarcada", () => {
    const janela = abrirJanela();
    expect(within(janela).getByRole("heading", { name: "Resumir um vídeo do YouTube" })).toBeInTheDocument();
    expect(within(janela).getByText(/só os primeiros 60 minutos são transcritos/)).toBeInTheDocument();
    expect(within(janela).getByText(/Limite: 5 vídeos a cada 24 horas\./)).toBeInTheDocument();
    expect(within(janela).getByText(/A MarquesaMatch não guarda o vídeo: guarda o link, a transcrição e o resumo/)).toBeInTheDocument();
    expect(within(janela).getByRole("checkbox")).not.toBeChecked();
    // O idioma falado começa no da tela.
    expect(within(janela).getByLabelText("Idioma falado no vídeo")).toHaveValue("pt-BR");
  });

  it("enviar sem nada: os três avisos, e nada vai ao servidor", () => {
    abrirJanela();
    enviar();
    expect(screen.getByText("Cole o link do vídeo.")).toBeInTheDocument();
    expect(screen.getByText("Dê um título para a reunião.")).toBeInTheDocument();
    expect(screen.getByText("Marque a caixa para confirmar que leu o aviso.")).toBeInTheDocument();
    expect(screen.getByLabelText("Link do vídeo")).toHaveAttribute("aria-invalid", "true");
    expect(duble.pedido.mutate).not.toHaveBeenCalled();
  });

  it.each([
    ["outro site", "https://vimeo.com/123456789"],
    ["um canal", "https://www.youtube.com/@canaldeexemplo"],
    ["uma playlist sem vídeo", "https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG"],
    ["domínio que só imita o YouTube", "https://www.youtube.com.exemplo.com/watch?v=dQw4w9WgXcQ"],
  ])("link de %s: o aviso traduzido, pela mesma regra do servidor, e nada vai ao servidor", (_caso, link) => {
    abrirJanela();
    preencher({ link, titulo: "Palestra sobre exportação", aceito: true });
    enviar();
    expect(screen.getByText("Este link não é de um vídeo do YouTube. Copie o endereço do vídeo (youtube.com/watch?v=… ou youtu.be/…).")).toBeInTheDocument();
    expect(duble.pedido.mutate).not.toHaveBeenCalled();
  });

  it("pedido certo: o link sem espaços, o título, o idioma escolhido e a versão do aviso do YouTube; a reunião nasce, a lista é relida e a tela vai ao detalhe", () => {
    abrirJanela();
    preencher({ link: "  https://youtu.be/dQw4w9WgXcQ?si=Ab12_cd  ", titulo: " Palestra sobre exportação ", idioma: "es", aceito: true });
    enviar();
    expect(duble.pedido.mutate).toHaveBeenCalledTimes(1);
    const [pedido, opcoes] = duble.pedido.mutate.mock.calls[0] as [Pedido, Opcoes];
    expect(pedido).toEqual({
      title: "Palestra sobre exportação", url: "https://youtu.be/dQw4w9WgXcQ?si=Ab12_cd", language: "es",
      consentGranted: true, consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_YOUTUBE,
    });
    // A versão do aviso é a do YouTube, que fala do vídeo, e não a do aviso de gravação.
    expect(pedido.consentNoticeVersion).not.toBe(VERSAO_VIGENTE_DO_AVISO_DE_GRAVACAO);

    act(() => opcoes.onSuccess({ id: ID_DA_REUNIAO }));
    expect(toast.success).toHaveBeenCalledWith("Vídeo enviado à IA. A transcrição leva alguns minutos.");
    expect(duble.invalidarLista).toHaveBeenCalled();
    expect(duble.navegar).toHaveBeenCalledWith(rotaDaReuniao(ID_DA_REUNIAO));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    ["o teto de vídeos por dia", { message: "YOUTUBE_TETO_DIARIO", data: { code: "TOO_MANY_REQUESTS" } }, "Você já mandou 5 vídeos à IA nas últimas 24 horas, o limite de um dia. Tente de novo mais tarde."],
    ["o link recusado pelo servidor", { message: "YOUTUBE_LINK_INVALIDO", data: { code: "BAD_REQUEST" } }, "Este link não é de um vídeo do YouTube. Copie o endereço do vídeo (youtube.com/watch?v=… ou youtu.be/…)."],
  ])("a recusa do servidor (%s) sai traduzida pelo código, nunca o código cru", (_caso, erro, frase) => {
    duble.pedido = { ...duble.pedido, isError: true, error: erro };
    abrirJanela();
    expect(screen.getByRole("alert")).toHaveTextContent(frase);
    expect(screen.queryByText(new RegExp(erro.message))).not.toBeInTheDocument();
  });

  it("fechar a janela limpa a recusa anterior", () => {
    duble.pedido = { ...duble.pedido, isError: true, error: { message: "YOUTUBE_TETO_DIARIO", data: { code: "TOO_MANY_REQUESTS" } } };
    abrirJanela();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(duble.pedido.reset).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("enviando, a janela não fecha nem deixa mudar os campos", () => {
    duble.pedido = { ...duble.pedido, isPending: true };
    abrirJanela();
    expect(screen.getByLabelText("Link do vídeo")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resumir vídeo" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// Classe de lado físico (esquerda/direita), que não espelha em árabe. O
// próprio cartão da janela é centrado (left-[50%] e translate-x), o que vale
// nos dois sentidos: a conferência é no que vai dentro dele.
const LADO_FISICO = /^(?:[a-z0-9-]+:)*-?(?:left|right|ml|mr|pl|pr|border-l|border-r|rounded-l|rounded-r|text-left|text-right)(?:-|$)/;
function ladosFisicos(raiz: Element) {
  return [...raiz.querySelectorAll("*")].flatMap(elemento => [...elemento.classList].filter(classe => LADO_FISICO.test(classe)));
}

describe("Resumir um vídeo do YouTube: a 375 px e em árabe", () => {
  // O jsdom não mede layout: o teste fixa as classes que fazem a janela caber
  // numa tela de 375 px e espelhar em árabe.
  it.each(["pt-BR", "ar"])("em %s: a janela cabe na altura da tela e rola, os botões empilham no celular, e só há lados lógicos", async idioma => {
    await act(async () => { await i18n.changeLanguage(idioma); });
    const janela = abrirJanela();
    expect(document.documentElement.dir).toBe(idioma === "ar" ? "rtl" : "ltr");
    // A janela nunca passa da altura da tela (o aviso é longo): rola por dentro.
    expect(janela).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
    // No celular, os botões ficam um em cima do outro, com o de enviar no alto.
    const enviarBotao = within(janela).getByRole("button", { name: i18n.t("meetings.youtube.submit") });
    expect(enviarBotao.parentElement).toHaveClass("flex-col-reverse", "sm:flex-row");
    // O cabeçalho alinha ao início da linha (a direita em árabe), não à esquerda.
    const cabecalho = within(janela).getByRole("heading", { name: i18n.t("meetings.youtube.dialogTitle") }).parentElement!;
    expect(cabecalho).toHaveClass("sm:text-start");
    expect(cabecalho).not.toHaveClass("sm:text-left");
    expect(ladosFisicos(janela)).toEqual([]);
  });

  it("em árabe: os textos em árabe, o link fica da esquerda para a direita, e o idioma falado começa no árabe", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    const janela = abrirJanela();
    expect(within(janela).getByRole("heading", { name: "تلخيص فيديو من YouTube" })).toBeInTheDocument();
    const link = within(janela).getByLabelText("رابط الفيديو");
    expect(link).toHaveAttribute("dir", "ltr");
    expect(within(janela).getByLabelText("اللغة المحكية في الفيديو")).toHaveValue("ar");
    fireEvent.click(within(janela).getByRole("button", { name: "تلخيص الفيديو" }));
    expect(within(janela).getByText("الصقي رابط الفيديو.")).toBeInTheDocument();
    expect(duble.pedido.mutate).not.toHaveBeenCalled();
  });
});
