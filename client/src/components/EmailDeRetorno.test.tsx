import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { MENSAGEM_EMAIL_SEM_ITEM_CONFIRMADO } from "@shared/email-de-retorno";
import { EmailDeRetorno, LIMITE_DO_LINK_DE_EMAIL, linkDoRascunho, useGuardaDoEmailDeRetorno } from "./EmailDeRetorno";

/**
 * O rascunho de e-mail de retorno na tela (H20). O React Query e os hooks do
 * tRPC são os de verdade: o "escrevendo", o botão desligado e a resposta que
 * chega depois de uma troca de aba vêm do useMutation, e não de um dublê que
 * responde na hora (foi esse dublê que deixou passar a resposta perdida na
 * volta à aba Resumo). Só a rede é um link falso: cada pedido responde sozinho
 * com `rede.resposta` ou, com `rede.segurar`, espera o teste chamar
 * `responder`. A página de teste imita o MeetingDetail: a guarda fica nela, e o
 * EmailDeRetorno só existe na aba Resumo. O que o servidor faz com o banco e a
 * IA está em server/email-de-retorno.test.ts.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const NOMES = { F1: "Ana", F3: "Bruno" };
const RASCUNHO = {
  assunto: "Retorno para {DESTINATARIO}",
  corpo: "Olá, {DESTINATARIO},\n\nObrigada pela reunião.\n{F1} manda a minuta até sexta.\n{F2} confirma o prazo.\n\nAbraços,",
};

type Resposta = { assunto: string; corpo: string } | Error;
const rede = {
  resposta: RASCUNHO as Resposta,
  segurar: false,
  chamadas: [] as unknown[],
  pendentes: [] as Array<(resposta: Resposta) => void>,
};

function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    const responder = (resposta: Resposta) => {
      if (resposta instanceof Error) return observer.error(resposta instanceof TRPCClientError ? resposta : TRPCClientError.from(resposta));
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    };
    if (op.path !== "meetings.rascunharEmailDeRetorno") {
      responder(new Error(`rota não simulada: ${op.path}`));
      return () => undefined;
    }
    rede.chamadas.push(op.input);
    const resposta = rede.resposta;
    if (rede.segurar) rede.pendentes.push(responder);
    else void Promise.resolve().then(() => responder(resposta));
    return () => undefined;
  });
}

// Erro como o servidor devolve: o envelope tRPC traz data.code.
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });

type Props = Omit<Parameters<typeof EmailDeRetorno>[0], "guarda">;
// Como o MeetingDetail: a guarda fica na página, e o EmailDeRetorno só existe na aba Resumo.
function Pagina(props: Props) {
  const guarda = useGuardaDoEmailDeRetorno();
  const [naAbaResumo, setNaAbaResumo] = useState(true);
  return <>
    <button type="button" onClick={() => setNaAbaResumo(aberta => !aberta)}>Trocar de aba</button>
    {naAbaResumo && <EmailDeRetorno {...props} guarda={guarda}/>}
  </>;
}

function escrever(props: Partial<Props> = {}) {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <Pagina meetingId={ID} confirmados={2} idiomaDoResumo="pt-BR" nomes={NOMES} {...props}/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const campoDoNome = () => screen.getByRole("combobox", { name: "Para quem?" });
const botaoEscrever = () => screen.getByRole("button", { name: /Escrever rascunho/ });
const assunto = () => screen.getByRole("textbox", { name: "Assunto" });
const trocarDeAba = () => fireEvent.click(screen.getByRole("button", { name: "Trocar de aba" }));
function pedirPara(nome: string) {
  fireEvent.change(campoDoNome(), { target: { value: nome } });
  fireEvent.click(botaoEscrever());
}
/** Pede e espera a prévia, que chega pelo React Query depois do clique. */
async function pedirEVer(nome: string) {
  pedirPara(nome);
  await screen.findByRole("textbox", { name: "Assunto" });
}
/** Deixa o React Query avisar a tela (ele avisa no tique seguinte). */
const assentar = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
/** A resposta segura (rede.segurar) chega agora. */
const responder = (indice: number, resposta: Resposta = RASCUNHO) => act(async () => {
  rede.pendentes[indice](resposta);
  await new Promise(resolve => setTimeout(resolve, 10));
});
const area = { writeText: vi.fn(async (_texto: string) => undefined) };

beforeEach(() => {
  Object.assign(rede, { resposta: RASCUNHO, segurar: false, chamadas: [], pendentes: [] });
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

  it("o pedido leva a relação, o tom e o idioma escolhidos, e nunca o nome digitado", async () => {
    escrever({ idiomaDoResumo: "en" });
    // O idioma começa no do resumo, marcado como o original.
    const idioma = screen.getByRole("combobox", { name: "Idioma do e-mail" });
    expect(idioma).toHaveValue("en");
    expect(within(idioma).getByRole("option", { name: /English \(original\)/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Relação" }), { target: { value: "leadership" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Tom" }), { target: { value: "urgent" } });
    fireEvent.change(idioma, { target: { value: "es" } });
    await pedirEVer("  Carla Souza ");

    expect(rede.chamadas).toEqual([{ meetingId: ID, relacao: "leadership", tom: "urgent", idioma: "es" }]);
    expect(JSON.stringify(rede.chamadas)).not.toContain("Carla");
  });

  it("o nome de uma voz da reunião vai como a voz de quem recebe (o rótulo, não o nome)", async () => {
    escrever();
    await pedirEVer(" ana ");
    expect(rede.chamadas).toEqual([{ meetingId: ID, relacao: "external", tom: "professional", idioma: "pt-BR", vozDoDestinatario: "F1" }]);
  });

  it("as vozes com nome viram sugestões no campo do nome", () => {
    escrever();
    const lista = document.getElementById(campoDoNome().getAttribute("list")!)!;
    expect(Array.from(lista.querySelectorAll("option"), opcao => opcao.getAttribute("value"))).toEqual(["Ana", "Bruno"]);
  });
});

describe("E-mail de retorno — a espera pela IA e a troca de aba", () => {
  it("enquanto a IA escreve: o aviso de que ela está escrevendo, o botão desligado, e um segundo pedido não sai", async () => {
    rede.segurar = true;
    escrever();
    pedirPara("Carla");
    expect(await screen.findByRole("status")).toHaveTextContent("A IA está escrevendo o rascunho…");
    expect(botaoEscrever()).toBeDisabled();
    // Nem pelo Enter no campo, que envia o formulário mesmo com o botão desligado.
    fireEvent.submit(campoDoNome().closest("form")!);
    await assentar();
    expect(rede.chamadas).toHaveLength(1);

    await responder(0);
    expect(assunto()).toHaveValue("Retorno para Carla");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refazer rascunho/ })).toBeEnabled();
  });

  it("ir à Transcrição e voltar antes da resposta: o 'escrevendo' continua, e a resposta aparece na volta, sem pedido novo", async () => {
    rede.segurar = true;
    escrever();
    fireEvent.change(screen.getByRole("combobox", { name: "Tom" }), { target: { value: "direct" } });
    pedirPara("Carla");
    await screen.findByRole("status");
    trocarDeAba();
    expect(screen.queryByRole("region", { name: "E-mail de retorno" })).not.toBeInTheDocument();
    trocarDeAba();

    // A volta mostra o pedido em curso, e não um formulário zerado com o botão ligado.
    expect(screen.getByRole("status")).toHaveTextContent("A IA está escrevendo o rascunho…");
    expect(botaoEscrever()).toBeDisabled();
    expect(campoDoNome()).toHaveValue("Carla");
    expect(screen.getByRole("combobox", { name: "Tom" })).toHaveValue("direct");

    await responder(0);
    expect(assunto()).toHaveValue("Retorno para Carla");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Mexer num campo depois não apaga o rascunho, e outra troca de aba o mantém.
    fireEvent.change(screen.getByRole("combobox", { name: "Tom" }), { target: { value: "friendly" } });
    trocarDeAba();
    trocarDeAba();
    expect(assunto()).toHaveValue("Retorno para Carla");
    expect(screen.getByRole("combobox", { name: "Tom" })).toHaveValue("friendly");
    expect(rede.chamadas).toHaveLength(1);
  });

  it("a resposta que chega com a aba Resumo fechada aparece na volta", async () => {
    rede.segurar = true;
    escrever();
    pedirPara("Carla");
    await screen.findByRole("status");
    trocarDeAba();
    await responder(0);
    trocarDeAba();
    expect(assunto()).toHaveValue("Retorno para Carla");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("o pedido que falha com a aba Resumo fechada mostra o erro na volta", async () => {
    rede.segurar = true;
    escrever();
    pedirPara("Carla");
    await screen.findByRole("status");
    trocarDeAba();
    await responder(0, erroDoServidor("SERVICE_UNAVAILABLE", "O serviço de IA não respondeu agora. Tente de novo em instantes."));
    trocarDeAba();
    expect(screen.getByRole("alert")).toHaveTextContent(i18n.t("meetings.ai.unavailable"));
    expect(botaoEscrever()).toBeEnabled();
  });
});

describe("E-mail de retorno — a prévia", () => {
  it("a marca vira o nome digitado e os rótulos, os nomes das vozes; a voz sem nome sai como 'Falante n', com o aviso", async () => {
    escrever();
    await pedirEVer("Carla");
    expect(assunto()).toHaveValue("Retorno para Carla");
    expect(screen.getByRole("textbox", { name: "Texto do e-mail" })).toHaveValue(
      "Olá, Carla,\n\nObrigada pela reunião.\nAna manda a minuta até sexta.\nFalante 2 confirma o prazo.\n\nAbraços,",
    );
    expect(screen.getByText(/Sem nome na reunião: Falante 2\./)).toBeInTheDocument();
    expect(screen.getByText("Rascunho da IA: confira e ajuste antes de enviar. Ele não fica guardado na WRW.")).toBeInTheDocument();
    // Depois do primeiro rascunho, o botão refaz.
    fireEvent.click(screen.getByRole("button", { name: /Refazer rascunho/ }));
    await waitFor(() => expect(rede.chamadas).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("e-mail em outro idioma que o da tela: a voz sem nome sai no idioma do e-mail, e o aviso a cita como está no texto", async () => {
    escrever();
    fireEvent.change(screen.getByRole("combobox", { name: "Idioma do e-mail" }), { target: { value: "en" } });
    rede.resposta = { assunto: "Follow-up: {F2} confirms", corpo: "Hi {DESTINATARIO},\n\n{F1} sends the draft by Friday.\n{F2} confirms the deadline." };
    await pedirEVer("Carla");
    expect(assunto()).toHaveValue("Follow-up: Speaker 2 confirms");
    expect(screen.getByRole("textbox", { name: "Texto do e-mail" })).toHaveValue("Hi Carla,\n\nAna sends the draft by Friday.\nSpeaker 2 confirms the deadline.");
    // O aviso continua no idioma da tela.
    expect(screen.getByText(/Sem nome na reunião: Speaker 2\./)).toBeInTheDocument();
  });

  it("Abrir no e-mail: mailto sem destinatário, com o assunto e o texto, e as quebras de linha em CRLF", async () => {
    escrever();
    await pedirEVer("Carla");
    const abrir = screen.getByRole("link", { name: /Abrir no e-mail/ });
    const titulo = "Retorno para Carla";
    const corpo = "Olá, Carla,\r\n\r\nObrigada pela reunião.\r\nAna manda a minuta até sexta.\r\nFalante 2 confirma o prazo.\r\n\r\nAbraços,";
    expect(abrir).toHaveAttribute("href", `mailto:?subject=${encodeURIComponent(titulo)}&body=${encodeURIComponent(corpo)}`);
    expect(abrir.getAttribute("href")).toContain("%0D%0A");
  });

  it("o que a dona ajusta na prévia vale para o link e para a cópia", async () => {
    escrever();
    await pedirEVer("Carla");
    fireEvent.change(assunto(), { target: { value: "Próximos passos" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Texto do e-mail" }), { target: { value: "Oi, Carla. Segue o combinado." } });
    expect(screen.getByRole("link", { name: /Abrir no e-mail/ })).toHaveAttribute("href", `mailto:?subject=${encodeURIComponent("Próximos passos")}&body=${encodeURIComponent("Oi, Carla. Segue o combinado.")}`);

    fireEvent.click(screen.getByRole("button", { name: /Copiar o texto/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Texto copiado."));
    expect(area.writeText).toHaveBeenCalledWith("Oi, Carla. Segue o combinado.");
  });

  it("a cópia que o navegador recusa deixa o texto selecionado no campo e avisa", async () => {
    area.writeText.mockRejectedValue(new Error("NotAllowedError"));
    escrever();
    await pedirEVer("Carla");
    fireEvent.click(screen.getByRole("button", { name: /Copiar o texto/ }));
    await waitFor(() => expect(toast.message).toHaveBeenCalledWith("Não deu para copiar automaticamente. O texto ficou selecionado no campo: copie por ali."));
    const texto = screen.getByRole("textbox", { name: "Texto do e-mail" }) as HTMLTextAreaElement;
    expect([texto.selectionStart, texto.selectionEnd]).toEqual([0, texto.value.length]);
  });

  it("texto longo demais para o link: o link leva só o assunto, a tela avisa, e abrir copia o texto", async () => {
    const longo = "Ação combinada na reunião. ".repeat(120);
    rede.resposta = { assunto: "Retorno", corpo: longo };
    escrever();
    await pedirEVer("Carla");
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

  it("o rascunho e as escolhas voltam depois de trocar de aba (o componente remonta)", async () => {
    escrever();
    fireEvent.change(screen.getByRole("combobox", { name: "Tom" }), { target: { value: "direct" } });
    await pedirEVer("Carla");
    fireEvent.change(assunto(), { target: { value: "Assunto ajustado" } });
    trocarDeAba();
    trocarDeAba();

    expect(campoDoNome()).toHaveValue("Carla");
    expect(screen.getByRole("combobox", { name: "Tom" })).toHaveValue("direct");
    expect(assunto()).toHaveValue("Assunto ajustado");
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
    rede.resposta = erro;
    escrever();
    fireEvent.change(screen.getByRole("combobox", { name: "To whom?" }), { target: { value: "Carla" } });
    fireEvent.click(screen.getByRole("button", { name: /Write draft/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(esperado ?? i18n.t("meetings.meetingNotFound"));
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
