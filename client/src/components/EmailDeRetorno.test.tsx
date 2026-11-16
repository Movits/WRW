import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO } from "@shared/email-de-retorno";
import { EmailDeRetorno, LIMITE_DO_LINK_DE_EMAIL, linkDoRascunho, type EstadoDoEmailDeRetorno } from "./EmailDeRetorno";

/**
 * O rascunho de e-mail de retorno na tela (H20). O tRPC vira um dublê com
 * estado: o mutate guarda o pedido e responde com o que o teste combinou,
 * chamando o onSuccess do hook como o React Query. O que o servidor faz com o
 * banco e a IA está em server/email-de-retorno.test.ts.
 */

const duble = vi.hoisted(() => ({
  resposta: undefined as unknown,
  chamadas: [] as unknown[],
}));

vi.mock("@/lib/trpc", async () => {
  const { useState } = await import("react");
  return {
    trpc: {
      meetings: {
        rascunharEmailDeRetorno: {
          useMutation: (opcoes: { onSuccess?: (dados: unknown) => void } = {}) => {
            const [erro, setErro] = useState<unknown>(null);
            return {
              isPending: false,
              isError: !!erro,
              error: erro,
              mutate: (variaveis: unknown) => {
                duble.chamadas.push(variaveis);
                if (duble.resposta instanceof Error) setErro(duble.resposta);
                else {
                  setErro(null);
                  opcoes.onSuccess?.(duble.resposta);
                }
              },
            };
          },
        },
      },
    },
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const NOMES = { F1: "Ana", F3: "Bruno" };
const RASCUNHO = {
  assunto: "Retorno para {DESTINATARIO}",
  corpo: "Olá, {DESTINATARIO},\n\nObrigada pela reunião.\n{F1} manda a minuta até sexta.\n{F2} confirma o prazo.\n\nAbraços,",
};
// Erro como o servidor devolve: o envelope tRPC traz data.code.
const erroDoServidor = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });
const escrever = (props: Partial<Parameters<typeof EmailDeRetorno>[0]> = {}) =>
  render(<EmailDeRetorno meetingId={ID} confirmados={2} idiomaDoResumo="pt-BR" nomes={NOMES} {...props}/>);
const campoDoNome = () => screen.getByRole("combobox", { name: "Para quem?" });
const botaoEscrever = () => screen.getByRole("button", { name: /Escrever rascunho/ });
function pedirPara(nome: string) {
  fireEvent.change(campoDoNome(), { target: { value: nome } });
  fireEvent.click(botaoEscrever());
}
const area = { writeText: vi.fn(async (_texto: string) => undefined) };

beforeEach(() => {
  duble.resposta = RASCUNHO;
  duble.chamadas = [];
  area.writeText.mockReset();
  area.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: area, configurable: true });
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.message).mockClear();
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("E-mail de retorno — o pedido", () => {
  it("sem item confirmado no resumo: o botão fica desligado, e a tela diz o que falta", () => {
    escrever({ confirmados: 0 });
    fireEvent.change(campoDoNome(), { target: { value: "Carla" } });
    expect(botaoEscrever()).toBeDisabled();
    expect(screen.getByText("Confirme ao menos um item do resumo para escrever o e-mail.")).toBeInTheDocument();
  });

  it("sem o nome de quem recebe, não pede", () => {
    escrever();
    fireEvent.change(campoDoNome(), { target: { value: "   " } });
    expect(botaoEscrever()).toBeDisabled();
  });

  it("o pedido leva a relação, o tom e o idioma escolhidos, e nunca o nome digitado", () => {
    escrever({ idiomaDoResumo: "en" });
    // O idioma começa no do resumo, marcado como o original.
    const idioma = screen.getByRole("combobox", { name: "Idioma do e-mail" });
    expect(idioma).toHaveValue("en");
    expect(within(idioma).getByRole("option", { name: /English \(original\)/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Relação" }), { target: { value: "leadership" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Tom" }), { target: { value: "urgent" } });
    fireEvent.change(idioma, { target: { value: "es" } });
    pedirPara("  Carla Souza ");

    expect(duble.chamadas).toEqual([{ meetingId: ID, relacao: "leadership", tom: "urgent", idioma: "es" }]);
    expect(JSON.stringify(duble.chamadas)).not.toContain("Carla");
  });

  it("o nome de uma voz da reunião vai como a voz de quem recebe (o rótulo, não o nome)", () => {
    escrever();
    pedirPara(" ana ");
    expect(duble.chamadas).toEqual([{ meetingId: ID, relacao: "external", tom: "professional", idioma: "pt-BR", vozDoDestinatario: "F1" }]);
  });

  it("as vozes com nome viram sugestões no campo do nome", () => {
    escrever();
    const lista = document.getElementById(campoDoNome().getAttribute("list")!)!;
    expect(Array.from(lista.querySelectorAll("option"), opcao => opcao.getAttribute("value"))).toEqual(["Ana", "Bruno"]);
  });
});

describe("E-mail de retorno — a prévia", () => {
  it("a marca vira o nome digitado e os rótulos, os nomes das vozes; a voz sem nome sai como 'Falante n', com o aviso", () => {
    escrever();
    pedirPara("Carla");
    expect(screen.getByRole("textbox", { name: "Assunto" })).toHaveValue("Retorno para Carla");
    expect(screen.getByRole("textbox", { name: "Texto do e-mail" })).toHaveValue(
      "Olá, Carla,\n\nObrigada pela reunião.\nAna manda a minuta até sexta.\nFalante 2 confirma o prazo.\n\nAbraços,",
    );
    expect(screen.getByText(/Sem nome na reunião: Falante 2\./)).toBeInTheDocument();
    expect(screen.getByText("Rascunho da IA: confira e ajuste antes de enviar. Ele não fica guardado na WRW.")).toBeInTheDocument();
    // Depois do primeiro rascunho, o botão refaz.
    fireEvent.click(screen.getByRole("button", { name: /Refazer rascunho/ }));
    expect(duble.chamadas).toHaveLength(2);
  });

  it("Abrir no e-mail: mailto sem destinatário, com o assunto e o texto, e as quebras de linha em CRLF", () => {
    escrever();
    pedirPara("Carla");
    const abrir = screen.getByRole("link", { name: /Abrir no e-mail/ });
    const assunto = "Retorno para Carla";
    const corpo = "Olá, Carla,\r\n\r\nObrigada pela reunião.\r\nAna manda a minuta até sexta.\r\nFalante 2 confirma o prazo.\r\n\r\nAbraços,";
    expect(abrir).toHaveAttribute("href", `mailto:?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(corpo)}`);
    expect(abrir.getAttribute("href")).toContain("%0D%0A");
  });

  it("o que a dona ajusta na prévia vale para o link e para a cópia", async () => {
    escrever();
    pedirPara("Carla");
    fireEvent.change(screen.getByRole("textbox", { name: "Assunto" }), { target: { value: "Próximos passos" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do e-mail" }), { target: { value: "Oi, Carla. Segue o combinado." } });
    expect(screen.getByRole("link", { name: /Abrir no e-mail/ })).toHaveAttribute("href", `mailto:?subject=${encodeURIComponent("Próximos passos")}&body=${encodeURIComponent("Oi, Carla. Segue o combinado.")}`);

    fireEvent.click(screen.getByRole("button", { name: /Copiar o texto/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Texto copiado."));
    expect(area.writeText).toHaveBeenCalledWith("Oi, Carla. Segue o combinado.");
  });

  it("a cópia que o navegador recusa deixa o texto selecionado no campo e avisa", async () => {
    area.writeText.mockRejectedValue(new Error("NotAllowedError"));
    escrever();
    pedirPara("Carla");
    fireEvent.click(screen.getByRole("button", { name: /Copiar o texto/ }));
    await waitFor(() => expect(toast.message).toHaveBeenCalledWith("Não deu para copiar automaticamente. O texto ficou selecionado no campo: copie por ali."));
    const texto = screen.getByRole("textbox", { name: "Texto do e-mail" }) as HTMLTextAreaElement;
    expect([texto.selectionStart, texto.selectionEnd]).toEqual([0, texto.value.length]);
  });

  it("texto longo demais para o link: o link leva só o assunto, a tela avisa, e abrir copia o texto", async () => {
    const longo = "Ação combinada na reunião. ".repeat(120);
    duble.resposta = { assunto: "Retorno", corpo: longo };
    escrever();
    pedirPara("Carla");
    const abrir = screen.getByRole("link", { name: /Abrir no e-mail/ });
    expect(abrir).toHaveAttribute("href", "mailto:?subject=Retorno");
    expect(screen.getByText(/O texto é longo demais para ir inteiro ao app de e-mail/)).toBeInTheDocument();

    // O jsdom não abre o app de e-mail: o clique fica só com o que a tela faz.
    const semNavegar = (evento: Event) => evento.preventDefault();
    window.addEventListener("click", semNavegar);
    try {
      fireEvent.click(abrir);
    } finally {
      window.removeEventListener("click", semNavegar);
    }
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Texto copiado: cole no corpo do e-mail."));
    expect(area.writeText).toHaveBeenCalledWith(longo);
  });

  it("o rascunho guardado pela página volta depois de trocar de aba (o componente remonta)", () => {
    const registro: { current: EstadoDoEmailDeRetorno | null } = { current: null };
    const primeira = escrever({ registro });
    fireEvent.change(screen.getByRole("combobox", { name: "Tom" }), { target: { value: "direct" } });
    pedirPara("Carla");
    fireEvent.change(screen.getByRole("textbox", { name: "Assunto" }), { target: { value: "Assunto ajustado" } });
    primeira.unmount();

    escrever({ registro });
    expect(campoDoNome()).toHaveValue("Carla");
    expect(screen.getByRole("combobox", { name: "Tom" })).toHaveValue("direct");
    expect(screen.getByRole("textbox", { name: "Assunto" })).toHaveValue("Assunto ajustado");
    expect(screen.getByRole("button", { name: /Refazer rascunho/ })).toBeInTheDocument();
  });
});

describe("E-mail de retorno — os erros no idioma da tela", () => {
  it.each([
    ["sem item confirmado (a frase do servidor)", erroDoServidor("PRECONDITION_FAILED", MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO), "Confirm at least one summary item to write the email."],
    ["o teto de pedidos à IA", erroDoServidor("TOO_MANY_REQUESTS", "Muitos pedidos à IA em sequência. Aguarde alguns minutos e tente de novo."), "Too many requests in a row. Wait a few minutes and try again."],
    ["a IA fora do ar", erroDoServidor("SERVICE_UNAVAILABLE", "O serviço de IA não respondeu agora. Tente de novo em instantes."), "The AI service did not respond just now. Please try again in a moment."],
    ["a reunião que não existe mais", erroDoServidor("NOT_FOUND", "Reunião não encontrada."), null],
  ])("%s", async (_caso, erro, esperado) => {
    await act(async () => { await i18n.changeLanguage("en"); });
    duble.resposta = erro;
    escrever();
    fireEvent.change(screen.getByRole("combobox", { name: "To whom?" }), { target: { value: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: /Write draft/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(esperado ?? i18n.t("meetings.meetingNotFound"));
    expect(screen.queryByRole("textbox", { name: "Subject" })).not.toBeInTheDocument();
  });
});

describe("linkDoRascunho", () => {
  it("cabe no limite: o link completo; não cabe: só o assunto", () => {
    expect(linkDoRascunho("Oi", "Linha 1\nLinha 2")).toEqual({ href: "mailto:?subject=Oi&body=Linha%201%0D%0ALinha%202", completo: true });
    // Letra de escrita não latina ocupa 9 caracteres no link.
    const chines = "会议".repeat(Math.ceil(LIMITE_DO_LINK_DE_EMAIL / 18) + 1);
    expect(linkDoRascunho("主题", chines)).toEqual({ href: `mailto:?subject=${encodeURIComponent("主题")}`, completo: false });
  });
});
