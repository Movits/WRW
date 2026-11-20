import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import {
  DESTINATARIAS_POR_ENVIO_MAX,
  EMAILS_DIGITADOS_POR_ENVIO_MAX,
  MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO,
  MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU,
  MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA,
} from "@shared/resumo-por-email";
import { ResumoPorEmail } from "./ResumoPorEmail";

/**
 * O painel "Mandar o resumo por e-mail" (H22) no detalhe da reunião. O tRPC é
 * um dublê que registra o mutate e as opções, no molde de
 * CompartilharReuniao.test.tsx; o que o servidor faz está em
 * server/resumo-por-email*.test.ts. Aqui: fechado não pede nada ao servidor;
 * aberto, junta quem recebe (a dona, as participantes da agenda, os e-mails
 * digitados), pede a confirmação com o link desligado, mostra a prévia no
 * idioma da reunião, traduz as recusas, manda de novo o que não saiu e liga o
 * envio automático. E a tela em árabe e a 375 px.
 */

type Opcoes = { onSuccess?: (data: unknown) => void; onError?: (erro: unknown) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return {
    mutacoes, registrar,
    painel: vi.fn(),
    invalidarPainel: vi.fn(), dadosDoPainel: vi.fn(), invalidarReuniao: vi.fn(),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      meetings: {
        resumoPorEmail: { invalidate: duble.invalidarPainel, setData: duble.dadosDoPainel },
        get: { invalidate: duble.invalidarReuniao },
      },
    }),
    meetings: {
      resumoPorEmail: { useQuery: (...args: unknown[]) => duble.painel(...args) },
      mandarResumoPorEmail: duble.registrar("mandar"),
      mandarResumoPorEmailDeNovo: duble.registrar("deNovo"),
      envioAutomaticoDoResumo: duble.registrar("automatico"),
    },
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const ANA = "ana@exemplo.invalid";
const CAIO = "caio@exemplo.invalid";
const PAINEL = {
  idioma: "pt-BR",
  linkLigado: true,
  emailDaDona: "glenda@exemplo.invalid",
  nomeDaDona: "Glenda",
  automatico: false,
  participantes: [{ nome: "Ana", email: ANA }, { nome: null, email: CAIO }],
  envios: [] as Array<Record<string, unknown>>,
  podeMandarDeNovo: false,
};
const consulta = (dados: Partial<typeof PAINEL> = {}) => ({ data: { ...PAINEL, ...dados }, isPending: false, isError: false, error: null });
const erroDoServidor = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });
const mutacao = (nome: string) => duble.mutacoes[nome];

function abrir(props: Partial<{ linkLigado: boolean; titulo: string }> = {}) {
  const resultado = render(<ResumoPorEmail meetingId={ID} titulo={props.titulo ?? "Reunião com a Apex"} linkLigado={props.linkLigado ?? true}/>);
  fireEvent.click(screen.getByRole("button", { name: /Mandar por e-mail|Send by email|إرسال بالبريد الإلكتروني/ }));
  return resultado;
}
const digitar = (texto: string) => {
  fireEvent.change(screen.getByLabelText(i18n.t("resumoPorEmail.outrosRotulo")), { target: { value: texto } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("resumoPorEmail.adicionar") }));
};
const botaoMandar = () => screen.getByRole("button", { name: i18n.t("resumoPorEmail.mandar") });

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  duble.painel.mockReset();
  duble.painel.mockReturnValue(consulta());
  duble.invalidarPainel.mockReset();
  duble.dadosDoPainel.mockReset();
  duble.invalidarReuniao.mockReset();
  for (const f of [toast.success, toast.error, toast.warning]) vi.mocked(f).mockReset();
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("fechado", () => {
  it("só o título e o botão: nenhuma consulta ao servidor enquanto a dona não toca", () => {
    render(<ResumoPorEmail meetingId={ID} titulo="Reunião" linkLigado/>);
    expect(screen.getByRole("heading", { name: "Mandar o resumo por e-mail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mandar por e-mail" })).toHaveAttribute("aria-expanded", "false");
    expect(duble.painel).not.toHaveBeenCalled();
  });
});

describe("quem recebe", () => {
  it("a dona, as participantes da agenda (todas com um toque) e os digitados vão no pedido, com a contagem sem repetir", () => {
    abrir();
    expect(duble.painel).toHaveBeenCalledWith({ meetingId: ID });
    fireEvent.click(screen.getByRole("checkbox", { name: /Para mim/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Todas" }));
    digitar("zeca@exemplo.invalid, ANA@exemplo.invalid");
    // A Ana já estava escolhida pela agenda: não entra duas vezes.
    expect(screen.getByRole("alert")).toHaveTextContent("“ANA@exemplo.invalid” já está na lista.");
    expect(screen.getByText(`4 de até ${DESTINATARIAS_POR_ENVIO_MAX} pessoas`)).toBeInTheDocument();
    fireEvent.click(botaoMandar());
    expect(mutacao("mandar").mutate).toHaveBeenCalledWith({
      meetingId: ID, paraMim: true, participantes: [ANA, CAIO], outros: ["zeca@exemplo.invalid"],
    });
  });

  it("sem ninguém escolhido, o botão fica desligado", () => {
    abrir();
    expect(botaoMandar()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /caio@exemplo\.invalid/ }));
    expect(botaoMandar()).toBeEnabled();
  });

  it("e-mail inválido não entra e fica no campo para corrigir", () => {
    abrir();
    digitar("zeca.exemplo.invalid");
    expect(screen.getByRole("alert")).toHaveTextContent("“zeca.exemplo.invalid” não parece um e-mail válido.");
    expect(screen.getByLabelText("E-mail de quem vai receber")).toHaveValue("zeca.exemplo.invalid");
    expect(botaoMandar()).toBeDisabled();
  });

  it(`até ${EMAILS_DIGITADOS_POR_ENVIO_MAX} e-mails digitados: o seguinte fica no campo com o aviso, e um sai pelo X`, () => {
    abrir();
    digitar(Array.from({ length: EMAILS_DIGITADOS_POR_ENVIO_MAX + 1 }, (_, i) => `d${i}@exemplo.invalid`).join(" "));
    expect(screen.getByRole("alert")).toHaveTextContent(`Dá para digitar até ${EMAILS_DIGITADOS_POR_ENVIO_MAX} e-mails por envio.`);
    expect(screen.getByLabelText("E-mail de quem vai receber")).toHaveValue(`d${EMAILS_DIGITADOS_POR_ENVIO_MAX}@exemplo.invalid`);
    fireEvent.click(screen.getByRole("button", { name: "Tirar d0@exemplo.invalid" }));
    expect(screen.queryByText("d0@exemplo.invalid")).not.toBeInTheDocument();
  });

  it("reunião sem participantes com e-mail na agenda: o aviso, e o campo para digitar", () => {
    duble.painel.mockReturnValue(consulta({ participantes: [] }));
    abrir();
    expect(screen.getByText("Esta reunião não tem participantes com e-mail na agenda. Digite os e-mails abaixo.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Todas" })).not.toBeInTheDocument();
  });
});

describe("o link aberto", () => {
  it("desligado: o aviso e a caixa da confirmação; só com ela o pedido sai, com a frase vista, o idioma e a versão 2", () => {
    abrir({ linkLigado: false });
    expect(screen.getByText(/O link aberto desta reunião está desligado/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Para mim/ }));
    expect(botaoMandar()).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: i18n.t("meetings.share.authorization") }));
    fireEvent.click(botaoMandar());
    expect(mutacao("mandar").mutate).toHaveBeenCalledWith(expect.objectContaining({
      autorizacao: {
        autorizacaoDasPessoas: true, idioma: "pt-BR", textoExibido: i18n.t("meetings.share.authorization"), versaoDaAutorizacao: VERSAO_DA_AUTORIZACAO_COM_NOMES,
      },
    }));
  });

  it("ligado: nada de caixa, e o pedido vai sem a autorização", () => {
    abrir();
    expect(screen.queryByRole("checkbox", { name: i18n.t("meetings.share.authorization") })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Para mim/ }));
    fireEvent.click(botaoMandar());
    expect(mutacao("mandar").mutate.mock.calls[0][0]).not.toHaveProperty("autorizacao");
  });
});

describe("a resposta", () => {
  it("saiu tudo: o aviso, a seleção limpa e o painel e a reunião relidos (o link pode ter ligado)", () => {
    abrir();
    fireEvent.click(screen.getByRole("checkbox", { name: /Para mim/ }));
    act(() => mutacao("mandar").opcoes.onSuccess?.({ enviados: 1, falharam: 0, linkLigadoAgora: true }));
    expect(toast.success).toHaveBeenCalledWith("Resumo mandado. E-mails que saíram: 1.");
    expect(screen.getByRole("checkbox", { name: /Para mim/ })).not.toBeChecked();
    expect(duble.invalidarPainel).toHaveBeenCalledWith({ meetingId: ID });
    expect(duble.invalidarReuniao).toHaveBeenCalledWith({ meetingId: ID });
  });

  it("parte não saiu: o aviso diz quantos e que o pedido ficou guardado", () => {
    abrir();
    act(() => mutacao("mandar").opcoes.onSuccess?.({ enviados: 2, falharam: 1, linkLigadoAgora: false }));
    expect(toast.warning).toHaveBeenCalledWith("Saíram 2 e-mails, e 1 não saíram agora. O pedido ficou guardado: tente de novo.");
  });

  it("a recusa do servidor sai no idioma da tela (o teto, a Resend fora, o link desligado)", async () => {
    abrir();
    act(() => mutacao("mandar").opcoes.onError?.(erroDoServidor("TOO_MANY_REQUESTS", MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA)));
    expect(toast.error).toHaveBeenLastCalledWith(MENSAGEM_RESUMO_POR_EMAIL_TETO_DA_DONA);
    await act(async () => { await i18n.changeLanguage("en"); });
    act(() => mutacao("mandar").opcoes.onError?.(erroDoServidor("SERVICE_UNAVAILABLE", MENSAGEM_RESUMO_POR_EMAIL_NAO_SAIU)));
    expect(toast.error).toHaveBeenLastCalledWith("The email did not go out right now. The request was saved: try again in a moment.");
    act(() => mutacao("mandar").opcoes.onError?.(erroDoServidor("PRECONDITION_FAILED", MENSAGEM_RESUMO_POR_EMAIL_LINK_DESLIGADO)));
    expect(toast.error).toHaveBeenLastCalledWith("The open link of this meeting is off. Confirm the people's authorization to turn it on and send.");
    // Reunião de outra conta: a frase da tela, nunca a do servidor em português.
    act(() => mutacao("mandar").opcoes.onError?.(erroDoServidor("NOT_FOUND", "Reunião não encontrada.")));
    expect(toast.error).toHaveBeenLastCalledWith(i18n.t("meetings.meetingNotFound"));
    // A falha que o servidor não explica: o genérico traduzido.
    act(() => mutacao("mandar").opcoes.onError?.(erroDoServidor("BAD_REQUEST", "[{\"code\":\"invalid_type\"}]")));
    expect(toast.error).toHaveBeenLastCalledWith("Could not send right now. Try again.");
    expect(duble.invalidarPainel).toHaveBeenCalled();
  });
});

describe("o que já foi mandado", () => {
  it("cada envio com a origem e o estado; o Tentar de novo aparece quando há o que mandar e manda", () => {
    duble.painel.mockReturnValue(consulta({
      podeMandarDeNovo: true,
      envios: [
        { id: "1", destinatario: ANA, origem: "participante", status: "falhou", automatico: false, createdAt: 1_700_000_000_000, enviadoEm: null },
        { id: "2", destinatario: "glenda@exemplo.invalid", origem: "dona", status: "enviado", automatico: true, createdAt: 1_700_000_000_000, enviadoEm: 1_700_000_100_000 },
        { id: "3", destinatario: null, origem: "digitado", status: "enviado", automatico: false, createdAt: 1_700_000_000_000, enviadoEm: 1_700_000_100_000 },
      ],
    }));
    abrir();
    const lista = screen.getByRole("heading", { name: "Já mandado" }).parentElement!.parentElement!;
    const linhas = within(lista).getAllByRole("listitem");
    expect(linhas[0]).toHaveTextContent(ANA);
    expect(linhas[0]).toHaveTextContent("Participante");
    expect(linhas[0]).toHaveTextContent("Não saiu");
    expect(linhas[1]).toHaveTextContent("Automático");
    expect(linhas[1]).toHaveTextContent("Enviado");
    expect(linhas[2]).toHaveTextContent("—");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(mutacao("deNovo").mutate).toHaveBeenCalledWith({ meetingId: ID });
    act(() => mutacao("deNovo").opcoes.onSuccess?.({ enviados: 1, falharam: 0 }));
    expect(toast.success).toHaveBeenCalledWith("E-mails mandados de novo: 1.");
  });

  it("sem nada para mandar de novo, sem o botão", () => {
    duble.painel.mockReturnValue(consulta({ envios: [{ id: "1", destinatario: ANA, origem: "participante", status: "enviado", automatico: false, createdAt: 1, enviadoEm: 2 }] }));
    abrir();
    expect(screen.queryByRole("button", { name: "Tentar de novo" })).not.toBeInTheDocument();
  });
});

describe("o envio automático", () => {
  it("desligado por padrão; marcar liga para a conta, e a resposta atualiza o painel", () => {
    abrir();
    const caixa = screen.getByRole("checkbox", { name: /Me mandar o resumo por e-mail quando cada reunião ficar pronta/ });
    expect(caixa).not.toBeChecked();
    fireEvent.click(caixa);
    expect(mutacao("automatico").mutate).toHaveBeenCalledWith({ ligado: true });
    act(() => mutacao("automatico").opcoes.onSuccess?.({ automatico: true }));
    expect(duble.dadosDoPainel).toHaveBeenCalledWith({ meetingId: ID }, expect.any(Function));
    expect(toast.success).toHaveBeenCalledWith("Envio automático ligado.");
  });
});

describe("a prévia do e-mail", () => {
  it("o texto fixo que as participantes recebem, no idioma da reunião, com o nome da dona e o título", () => {
    duble.painel.mockReturnValue(consulta({ idioma: "en" }));
    abrir();
    expect(screen.getByText("O e-mail tem um texto fixo e vai em English, o idioma da reunião.")).toBeInTheDocument();
    expect(screen.getByText("Glenda shared a meeting summary with you")).toBeInTheDocument();
    expect(screen.getByText("Glenda shared with you the summary of the meeting “Reunião com a Apex”, recorded on WRW.")).toBeInTheDocument();
  });
});

describe("em árabe e a 375 px", () => {
  it("a tela em árabe; e-mail sempre da esquerda para a direita; a prévia de reunião em árabe da direita para a esquerda", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    duble.painel.mockReturnValue(consulta({ idioma: "ar" }));
    abrir();
    expect(screen.getByRole("heading", { name: "إرسال الملخص بالبريد الإلكتروني" })).toBeInTheDocument();
    expect(screen.getByLabelText("البريد الإلكتروني لمن سيستلم")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText(ANA)).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("(glenda@exemplo.invalid)")).toHaveAttribute("dir", "ltr");
    const previa = screen.getByText("شاركت Glenda معك ملخص اجتماع").closest("[lang]")!;
    expect(previa).toHaveAttribute("lang", "ar");
    expect(previa).toHaveAttribute("dir", "rtl");
    // A tela em árabe com a reunião em português: a prévia segue o idioma do e-mail.
    duble.painel.mockReturnValue(consulta({ idioma: "pt-BR" }));
    abrir();
    expect(screen.getAllByText("Glenda compartilhou com você o resumo de uma reunião")[0].closest("[lang]")).toHaveAttribute("dir", "ltr");
  });

  it("a 375 px: botões na largura toda, linhas que quebram e e-mail longo que não estoura a tela", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const longo = `${"nome.muito.comprido".repeat(6)}@exemplo.invalid`;
    duble.painel.mockReturnValue(consulta({
      participantes: [{ nome: "Ana", email: longo }],
      envios: [{ id: "1", destinatario: longo, origem: "participante", status: "enviado", automatico: false, createdAt: 1, enviadoEm: 2 }],
    }));
    abrir();
    // Abaixo de sm (640 px), cada botão ocupa a linha; acima, volta ao tamanho do texto.
    for (const nome of ["Fechar", "Adicionar", "Mandar o resumo"]) {
      expect(screen.getByRole("button", { name: nome }).className).toMatch(/(^|\s)w-full(\s|$)/);
      expect(screen.getByRole("button", { name: nome }).className).toMatch(/(^|\s)sm:w-auto(\s|$)/);
    }
    // O campo e o botão empilham no celular.
    expect(screen.getByLabelText("E-mail de quem vai receber").closest("form")!.className).toMatch(/(^|\s)flex-col(\s|$)/);
    // O endereço comprido quebra em qualquer ponto, e nada fixa largura.
    for (const elemento of screen.getAllByText(longo)) expect(elemento.className).toMatch(/break-all/);
    expect(document.body.innerHTML).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/);
  });
});
