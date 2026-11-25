import { createHash } from "node:crypto";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { CODIGOS } from "@/i18n";
import { VERSAO_DA_AUTORIZACAO_COM_NOMES } from "@shared/const";
import { CompartilharReuniao, enderecoDoLinkAberto, linkDoEmail, linkDoWhatsApp } from "./CompartilharReuniao";

/**
 * O painel "Compartilhar por link" no detalhe da reunião (pedido do Roberto em
 * 12/11/2026): ligar pede a confirmação de que as pessoas autorizaram, a caixa
 * que fala dos nomes das vozes (versão 2, H3b); ligado, o link sai por cópia,
 * WhatsApp e e-mail, e o link da caixa antiga avisa a dona que tem nomes;
 * desligar pede confirmação. O tRPC é um dublê que registra o mutate e as
 * opções, no molde de Meetings.test.tsx; o que o servidor faz está em
 * server/reuniao-aberta-rota.test.ts.
 */

type Opcoes = { onSuccess?: (data: unknown, pedido?: unknown) => void; onError?: (erro: unknown) => void };

const duble = vi.hoisted(() => {
  const mutacoes: Record<string, { opcoes: Opcoes; mutate: ReturnType<typeof vi.fn> }> = {};
  const registrar = (nome: string) => ({
    useMutation: (opcoes: Opcoes = {}) => {
      const m = (mutacoes[nome] ??= { opcoes, mutate: vi.fn() });
      m.opcoes = opcoes;
      return { mutate: m.mutate, isPending: false };
    },
  });
  return { mutacoes, registrar, setData: vi.fn(), invalidate: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ meetings: { get: { setData: duble.setData, invalidate: duble.invalidate } } }),
    meetings: {
      ligarLinkAberto: duble.registrar("ligar"),
      desligarLinkAberto: duble.registrar("desligar"),
      // A senha e o áudio do link ligado (H23).
      novaSenhaDoLink: duble.registrar("novaSenha"),
      tirarSenhaDoLink: duble.registrar("tirarSenha"),
      mudarAudioDoLink: duble.registrar("mudarAudio"),
    },
  },
}));

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const erroDoServidor = (code: string, message = "frase do servidor") => Object.assign(new Error(message), { data: { code } });

beforeEach(() => {
  for (const m of Object.values(duble.mutacoes)) m.mutate.mockReset();
  duble.setData.mockReset();
  duble.invalidate.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.message).mockReset();
});
// O jsdom não tem área de transferência: cada teste põe a sua e tira no fim.
const porAreaDeTransferencia = (writeText: (texto: string) => Promise<void>) =>
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
afterEach(() => { Reflect.deleteProperty(window.navigator, "clipboard"); });

describe("os endereços que o painel monta", () => {
  it("o link é o domínio em que a dona está mais /r/{token}", () => {
    expect(enderecoDoLinkAberto(TOKEN, "https://wrwglobal.org")).toBe(`https://wrwglobal.org/r/${TOKEN}`);
    expect(enderecoDoLinkAberto(TOKEN)).toBe(`${window.location.origin}/r/${TOKEN}`);
  });

  it("WhatsApp e e-mail levam a mensagem inteira codificada: & ? # e quebra de linha não cortam o texto", () => {
    const mensagem = "Reunião “Vinho & café? #1”\nhttps://wrwglobal.org/r/x";
    const whatsapp = new URL(linkDoWhatsApp(mensagem));
    expect(whatsapp.origin).toBe("https://wa.me");
    expect(whatsapp.searchParams.get("text")).toBe(mensagem);
    const email = linkDoEmail("Assunto & tal?", mensagem);
    expect(email.startsWith("mailto:?subject=")).toBe(true);
    // Sem destinatário: quem escolhe é a dona, no app de e-mail dela.
    const parametros = new URLSearchParams(email.slice("mailto:?".length));
    expect(parametros.get("subject")).toBe("Assunto & tal?");
    expect(parametros.get("body")).toBe(mensagem);
  });
});

describe("sem link: ligar pede a confirmação de que as pessoas autorizaram", () => {
  it("o botão Criar link só aparece depois de Compartilhar e só funciona com a caixa marcada", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={null}/>);
    expect(screen.getByRole("heading", { name: "Compartilhar por link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Criar link/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    const criar = screen.getByRole("button", { name: /Criar link/ });
    expect(criar).toBeDisabled();
    fireEvent.click(criar);
    expect(duble.mutacoes.ligar.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /com os nomes que eu der às vozes/ }));
    expect(criar).toBeEnabled();
    fireEvent.click(criar);
    // A prova leva a frase que a dona viu, o idioma da tela dela e a versão da
    // caixa: a 2 fala dos nomes das vozes, e só com ela o link os mostra (H3b).
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith({
      meetingId: ID,
      autorizacaoDasPessoas: true,
      idioma: "pt-BR",
      textoExibido: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram que quem receber o link ouça a gravação e leia a transcrição, com os nomes que eu der às vozes.",
      versaoDaAutorizacao: 2,
      // As escolhas do link (H23): de início, com senha e com o áudio.
      comSenha: true,
      incluirAudio: true,
    });
  });

  it("a caixa vai com a frase e o idioma da tela de quem confirma: em inglês, a frase em inglês, com a mesma versão", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    try {
      render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
      fireEvent.click(screen.getByRole("button", { name: /Share/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /with the names I give the voices/ }));
      fireEvent.click(screen.getByRole("button", { name: /Create link/ }));
      expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith(expect.objectContaining({
        idioma: "en",
        textoExibido: "I confirm that everyone who spoke in this meeting agreed that whoever receives the link may listen to the recording and read the transcript, with the names I give the voices.",
        versaoDaAutorizacao: 2,
      }));
    } finally {
      await act(async () => { await i18n.changeLanguage("pt-BR"); });
    }
  });

  it("antes de ligar, o painel diz que quem tem o link vê os nomes que a dona der às vozes", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    expect(screen.getByText(/Os nomes que você der às vozes aparecem para quem tem o link/)).toBeInTheDocument();
  });

  it("Cancelar volta ao começo: desmarca a confirmação e devolve as escolhas do link ao começo (H23)", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /autorizaram/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /senha de 6 dígitos/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Incluir o áudio/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getByRole("checkbox", { name: /autorizaram/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /senha de 6 dígitos/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Incluir o áudio/ })).toBeChecked();
  });

  it("ligado no servidor, o token entra na tela na hora, já mostrando os nomes, e a reunião é relida", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onSuccess?.({ token: TOKEN }));
    expect(duble.setData).toHaveBeenCalledWith({ meetingId: ID }, expect.any(Function));
    const atualizar = duble.setData.mock.calls[0][1] as (anterior: unknown) => unknown;
    // Este painel liga sempre com a caixa que fala dos nomes: o link novo os mostra.
    // O servidor de antes da H23 não devolve a senha: o link sai sem senha e com o áudio.
    expect(atualizar({ meeting: { id: ID, shareToken: null, linkMostraNomes: false }, transcript: null }))
      .toEqual({ meeting: { id: ID, shareToken: TOKEN, linkMostraNomes: true, linkComSenha: false, linkComAudio: true }, transcript: null });
    expect(atualizar(undefined)).toBeUndefined();
    expect(duble.invalidate).toHaveBeenCalledWith({ meetingId: ID });
  });

  it("recusa do servidor vira frase traduzida, não a do servidor", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onError?.(erroDoServidor("PRECONDITION_FAILED")));
    expect(toast.error).toHaveBeenCalledWith("Só dá para compartilhar uma reunião pronta.");
    act(() => duble.mutacoes.ligar.opcoes.onError?.(erroDoServidor("BAD_REQUEST")));
    expect(toast.error).toHaveBeenLastCalledWith("Não foi possível mudar o compartilhamento. Tente de novo.");
  });
});

/**
 * A frase da caixa nos 10 idiomas (H3b). A tela manda a versão 2 seja qual for
 * o idioma de quem confirma, e só a versão 2 abre os nomes das vozes pelo link:
 * em todo idioma, a frase marcada tem de ser a que fala dos nomes. O
 * conferir-locales só confere as chaves, e os testes acima só leem pt-BR e en;
 * um conflito de JSON resolvido para o lado errado, ou uma revisão que tire os
 * nomes de um idioma, passaria em silêncio. O sha256 é o mesmo `textoHash` que
 * a auditoria grava ao ligar o link.
 */
describe("a frase da caixa nos 10 idiomas, com a versão que ela grava (H3b)", () => {
  // As frases de 12/11/2026, que não falavam dos nomes: as da versão 1.
  const SHA256_DA_FRASE_DE_12_11: Record<string, string> = {
    "pt-BR": "80ff7ceb97a05f379d15b7a9cb1679a7ae2fcfc68a2fd1d62b7e80e79b4ffcc7",
    en: "5934e5107b998f63a6cdd608cceff826cd910447e442e4a811618b8de13b0d02",
    es: "2d6582aabf5d6c8d048c39cda7abe11ef3731a8d12d341625b656fe05b7d5e5e",
    fr: "4100a1954345d545d13cd6b9ce2d0b383cc3a52546e7049833d3ec3df584c491",
    de: "e7707b42cc0a72901c48b41fe46c0f5d48427b2a29c8a5313c8253228d3478f0",
    ru: "8a9654ff26172134ea7a0c74b7d64acfa57bb0eabf157b5a3eb6db902919e162",
    hi: "deb8a46a89ae28c1a8f92e90f1dabb90458870b9fa2a85763052746dd509886f",
    ar: "9a8bacc2f06a740c0723292f5072ad5a6506ab8c1d67800be54c6426d6ccd8df",
    zh: "a60d9e54523c332eef06b0bda88904f5605b4c645f0118234b0e6f382034356b",
    ja: "70f8e36f72bcf6a7e43c3f20daa48a93f5caf00d965eb775544e03d4aea756bd",
  };
  // As frases da versão 2, que falam dos nomes que a dona der às vozes. Mudou a
  // frase de algum idioma (a revisão da Cris, por exemplo)? Decida antes se
  // VERSAO_DA_AUTORIZACAO_COM_NOMES sobe, porque os links ligados com a frase
  // anterior seguem mostrando os nomes; só então troque o hash aqui.
  const SHA256_DA_VERSAO_2: Record<string, string> = {
    "pt-BR": "da77276a96d51cf1ba34f23ccdc50f602323793d0a1d1aed4d32bc340546b7c9",
    en: "af90b43ef3ca0a90fd97aecb9eceda793aa2330f485ff7f8c4c9fd66dd8e8d30",
    es: "6017e9d59a278904aef5b1e7841de4ae2dcfdc20d1334855bbd237b3a71b3147",
    fr: "f170c383af9ca82ddc2a746d719b0302a0ac756e721283e459a2a5c3ece06d39",
    de: "3bb0e1e5b50470bd78666541c1f3efc9a2f67029bdc0b79c66604533916d4b80",
    ru: "f7e1091a34348c9e1dce2592066fca4aed0f98974781f0e284fbb8e0b8969f77",
    hi: "9fba46552a0eeb7b0f2b6a3a3d8e55ad3076180cc9f0056a0e318f72f39caad9",
    ar: "07e94fdf3dc5b9fcb26fffe3552b05bc53e486b92f13de79ef11c9afefdcd10c",
    zh: "fbd46c449dea8d95d459c2aa69cb50ae5014b08c52f3f95ae15b18d9dfa8eca8",
    ja: "644af344d1d59e9ebdff35937711fb142504f1625c9718390d953c3e6478b6b6",
  };
  const sha256 = (texto: string) => createHash("sha256").update(texto).digest("hex");

  it("as duas listas cobrem os 10 idiomas da tela", () => {
    expect(Object.keys(SHA256_DA_FRASE_DE_12_11).sort()).toEqual([...CODIGOS].sort());
    expect(Object.keys(SHA256_DA_VERSAO_2).sort()).toEqual([...CODIGOS].sort());
  });

  it.each(CODIGOS)("%s: a dona marca a frase da versão 2, e ela vai para a prova com a versão 2, nunca a frase de 12/11", async idioma => {
    await act(async () => { await i18n.changeLanguage(idioma); });
    try {
      render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
      fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.share.button") }));
      fireEvent.click(screen.getByRole("checkbox", { name: i18n.t("meetings.share.authorization") }));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.share.createButton") }));
      expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledTimes(1);
      const { idioma: idiomaDaProva, textoExibido, versaoDaAutorizacao } = duble.mutacoes.ligar.mutate.mock.calls[0][0];
      expect(idiomaDaProva).toBe(idioma);
      expect(versaoDaAutorizacao).toBe(VERSAO_DA_AUTORIZACAO_COM_NOMES);
      // A caixa marcada mostra a mesma frase que vai para a prova.
      expect(screen.getByRole("checkbox", { name: textoExibido })).toBeChecked();
      expect(sha256(textoExibido), `${idioma}: voltou a frase de 12/11, que não fala dos nomes`).not.toBe(SHA256_DA_FRASE_DE_12_11[idioma]);
      expect(sha256(textoExibido), `${idioma}: mudou a frase? decida se VERSAO_DA_AUTORIZACAO_COM_NOMES sobe`).toBe(SHA256_DA_VERSAO_2[idioma]);
    } finally {
      await act(async () => { await i18n.changeLanguage("pt-BR"); });
    }
  });
});

describe("com link: copiar, WhatsApp, e-mail e desligar", () => {
  const endereco = `${window.location.origin}/r/${TOKEN}`;

  it("mostra o endereço, e WhatsApp e e-mail levam o título e o link", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={TOKEN}/>);
    expect(screen.getByRole("heading", { name: "Compartilhada por link" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveValue(endereco);
    const mensagem = `Reunião “Reunião com a Ana” na Marquesa Global Match: ${endereco}`;
    const whatsapp = screen.getByRole("link", { name: /WhatsApp/ });
    expect(new URL(whatsapp.getAttribute("href")!).searchParams.get("text")).toBe(mensagem);
    expect(whatsapp).toHaveAttribute("target", "_blank");
    expect(whatsapp).toHaveAttribute("rel", expect.stringContaining("noopener"));
    const email = screen.getByRole("link", { name: /E-mail/ }).getAttribute("href")!;
    const parametros = new URLSearchParams(email.slice("mailto:?".length));
    expect(parametros.get("subject")).toBe("Reunião “Reunião com a Ana” na Marquesa Global Match");
    expect(parametros.get("body")).toBe(mensagem);
  });

  it("copiar põe o endereço na área de transferência e avisa", async () => {
    const writeText = vi.fn(async () => {});
    porAreaDeTransferencia(writeText);
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar link/ })); });
    expect(writeText).toHaveBeenCalledWith(endereco);
    expect(toast.success).toHaveBeenCalledWith("Link copiado.");
  });

  it("sem área de transferência, o endereço fica selecionado no campo e a tela diz para copiar dali", async () => {
    porAreaDeTransferencia(vi.fn(async () => { throw new Error("sem permissão"); }));
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    const campo = screen.getByRole("textbox", { name: "Link da reunião" }) as HTMLInputElement;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar link/ })); });
    expect(toast.message).toHaveBeenCalledWith(expect.stringContaining("copie por ali"));
    expect(toast.success).not.toHaveBeenCalled();
    expect(campo.selectionStart).toBe(0);
    expect(campo.selectionEnd).toBe(endereco.length);
  });

  it("desligar pede confirmação; Manter não chama o servidor", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    expect(screen.getByText(/deixa de abrir a reunião na hora/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(duble.mutacoes.desligar.mutate).not.toHaveBeenCalled();
    expect(screen.queryByText(/deixa de abrir a reunião na hora/)).not.toBeInTheDocument();
  });

  it("confirmado, desliga a reunião certa, tira o token da tela e avisa", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    expect(duble.mutacoes.desligar.mutate).toHaveBeenCalledWith({ meetingId: ID });
    act(() => duble.mutacoes.desligar.opcoes.onSuccess?.(undefined));
    const atualizar = duble.setData.mock.calls[0][1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, shareToken: TOKEN, linkMostraNomes: true, linkComSenha: true, linkComAudio: false } }))
      .toEqual({ meeting: { id: ID, shareToken: null, linkMostraNomes: false, linkComSenha: false, linkComAudio: false } });
    expect(toast.success).toHaveBeenCalledWith("Link desligado.");
  });
});

describe("com link da confirmação antiga: o aviso de que os nomes não aparecem (H3b)", () => {
  const AVISO = /não vê os nomes que você deu às vozes/;

  it("com nomes dados e o link da caixa antiga, o painel avisa e diz como mostrar os nomes", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} linkMostraNomes={false} temNomes/>);
    expect(screen.getByText(AVISO)).toHaveTextContent("desligue o link e compartilhe de novo");
  });

  it.each([
    ["o link já mostra os nomes", { linkMostraNomes: true, temNomes: true }],
    ["nenhuma voz tem nome", { linkMostraNomes: false, temNomes: false }],
  ])("sem aviso quando %s", (_caso, props) => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} {...props}/>);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });

  it("sem link, não há aviso: ligar agora já usa a caixa nova", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null} linkMostraNomes={false} temNomes/>);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });
});

describe("o painel anuncia o que mudou e não perde o foco", () => {
  it("Compartilhar: o foco vai para a caixa de autorização", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getByRole("checkbox", { name: /autorizaram/ })).toHaveFocus();
  });

  it("ligado: avisa \"Link criado\" e o foco vai para o campo do link", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onSuccess?.({ token: TOKEN }));
    expect(toast.success).toHaveBeenCalledWith("Link criado.");
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveFocus();
  });

  it("abrir a reunião que já tem link não rouba o foco", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).not.toHaveFocus();
  });

  it("desligar: a pergunta abre com o foco em Manter; desligado, o foco volta para Compartilhar", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    const manter = screen.getByRole("button", { name: "Manter" });
    expect(manter).toHaveFocus();
    expect(manter).toHaveAccessibleDescription(/deixa de abrir a reunião na hora/);
    act(() => duble.mutacoes.desligar.opcoes.onSuccess?.(undefined));
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    expect(screen.getByRole("button", { name: /Compartilhar/ })).toHaveFocus();
  });

  it("o endereço fica da esquerda para a direita, também numa tela em árabe", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByRole("textbox", { name: "Link da reunião" })).toHaveAttribute("dir", "ltr");
  });
});

/**
 * A reunião sem gravação (o vídeo do YouTube, H13, e o documento, H12): o painel,
 * a caixa e a prova não falam de gravação. Conferência de tela de 20/11/2026
 * (captura 14c): no YouTube, o cartão dizia "ouve a gravação" e a caixa (a frase
 * que vai para a prova, MEETING_OPEN_LINK_ON) falava da gravação da reunião, que
 * não existe.
 */
describe("a reunião do YouTube: o painel e a prova falam do vídeo, nunca de gravação", () => {
  it("o cartão diz o que o link mostra do vídeo, e a caixa marcada é a frase que vai para a prova, com a versão que mostra os nomes", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="BC te Explica" token={null} youtube/>);
    expect(screen.getByText(/lê a transcrição e pede à IA o resumo e respostas sobre o vídeo/)).toBeInTheDocument();
    expect(screen.getByText(/Os nomes que você der às vozes aparecem para quem tem o link/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/gravação/);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    // A caixa da autorização, entre as escolhas do link (H23).
    const caixa = screen.getByRole("checkbox", { name: /Confirmo que posso compartilhar a transcrição deste vídeo/ });
    expect(caixa).toHaveAccessibleName("Confirmo que posso compartilhar a transcrição deste vídeo e autorizo que quem receber o link a leia, com o resumo e os nomes que eu der às vozes.");
    expect(document.body.textContent).not.toMatch(/gravação|todas as pessoas que falaram/);
    fireEvent.click(caixa);
    fireEvent.click(screen.getByRole("button", { name: /Criar link/ }));
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith({
      meetingId: ID,
      autorizacaoDasPessoas: true,
      idioma: "pt-BR",
      textoExibido: "Confirmo que posso compartilhar a transcrição deste vídeo e autorizo que quem receber o link a leia, com o resumo e os nomes que eu der às vozes.",
      versaoDaAutorizacao: 2,
      // As escolhas do link (H23): a senha, como veio marcada; o vídeo não tem
      // gravação, e o link sai sem o áudio.
      comSenha: true,
      incluirAudio: false,
    });
  });

  it.each(CODIGOS)("%s: a caixa do vídeo é outra que a da gravação e que a do documento, e é ela que vai para a prova", async idioma => {
    await act(async () => { await i18n.changeLanguage(idioma); });
    try {
      render(<CompartilharReuniao meetingId={ID} titulo="Vídeo" token={null} youtube/>);
      expect(screen.getByText(i18n.t("meetings.youtube.shareIntro"))).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.share.button") }));
      fireEvent.click(screen.getByRole("checkbox", { name: i18n.t("meetings.youtube.shareAuthorization") }));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.share.createButton") }));
      const { textoExibido } = duble.mutacoes.ligar.mutate.mock.calls[0][0];
      expect(textoExibido).toBe(i18n.t("meetings.youtube.shareAuthorization"));
      expect(textoExibido).not.toBe(i18n.t("meetings.share.authorization"));
      expect(textoExibido).not.toBe(i18n.t("meetings.document.shareAuthorization"));
      expect(i18n.t("meetings.youtube.shareIntro")).not.toBe(i18n.t("meetings.share.intro"));
    } finally {
      await act(async () => { await i18n.changeLanguage("pt-BR"); });
    }
  });

  it.each([
    ["do vídeo do YouTube", { youtube: true }],
    ["do documento", { documento: true }],
  ])("desligar o link %s não fala de quem está ouvindo a gravação", (_caso, origem) => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} {...origem}/>);
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    expect(screen.getByRole("button", { name: "Manter" })).toHaveAccessibleDescription("Desligar o link? Quem tem o endereço deixa de conseguir abri-lo na hora. Se você compartilhar de novo, o link será outro.");
    expect(document.body.textContent).not.toMatch(/gravação/);
  });

  it("a reunião gravada continua com o painel e a caixa da gravação", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    expect(screen.getByText(/Quem receber o link ouve a gravação/)).toBeInTheDocument();
  });
});

/**
 * A junção do Pacote 4c com o 4d: o documento (H12) e o vídeo do YouTube (H13)
 * não têm gravação, e o "Incluir o áudio da reunião no link" (H23) não tem o
 * que levar. O painel não oferece a escolha, nem ao ligar nem com o link
 * ligado, e o link sai sem o áudio. A senha vale para todos.
 */
describe("sem gravação (o documento e o vídeo), o painel não oferece o áudio do link (H23)", () => {
  const SEM_GRAVACAO = [
    ["do vídeo do YouTube", { youtube: true }],
    ["do documento", { documento: true }],
  ] as const;

  it.each(SEM_GRAVACAO)("ao ligar o link %s: a autorização e a senha, sem a escolha do áudio, e o link sai sem ele", (_caso, origem) => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null} {...origem}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: /senha de 6 dígitos/ })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: /Incluir o áudio/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Confirmo que posso compartilhar/ }));
    fireEvent.click(screen.getByRole("button", { name: /Criar link/ }));
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith(expect.objectContaining({ comSenha: true, incluirAudio: false }));
  });

  it.each(SEM_GRAVACAO)("com o link %s ligado: pôr, trocar e tirar a senha, sem a escolha do áudio nem o aviso dele", (_caso, origem) => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comAudio={false} {...origem}/>);
    expect(screen.getByRole("button", { name: "Pôr senha" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/sem o áudio e sem o player/)).not.toBeInTheDocument();
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comSenha {...origem}/>);
    expect(screen.getByRole("button", { name: "Trocar a senha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tirar a senha" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("a reunião gravada continua com a escolha do áudio, ao ligar e com o link ligado", () => {
    const { unmount } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getByRole("checkbox", { name: /Incluir o áudio/ })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /autorizaram/ }));
    fireEvent.click(screen.getByRole("button", { name: /Criar link/ }));
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith(expect.objectContaining({ incluirAudio: true }));
    unmount();
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comAudio={false}/>);
    expect(screen.getByRole("checkbox", { name: /Incluir o áudio/ })).not.toBeChecked();
    expect(screen.getByText(/sem o áudio e sem o player/)).toBeInTheDocument();
  });
});

describe("o que o link mostra do resumo (H4f)", () => {
  it("antes de ligar, o painel diz que o link mostra o resumo como a dona o deixar, com o que ela escrever, e o mapa mental", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    expect(screen.getByText("O link mostra também o resumo como você o deixar, com os itens que você escrever ou editar, e o mapa mental.")).toBeInTheDocument();
  });
});

/**
 * A senha de 6 dígitos e o áudio do link (H23, HN-57 do HiNoter): a dona
 * escolhe ao ligar (a senha vem marcada, o áudio também) e muda as duas coisas
 * com o link ligado. A senha vem do servidor e aparece uma vez só, com o texto
 * pronto (o link e a senha) para o WhatsApp e o e-mail.
 */
describe("a senha e o áudio do link (H23)", () => {
  const endereco = `${window.location.origin}/r/${TOKEN}`;
  const textoPronto = (senha: string) => `Reunião “Reunião com a Ana” na Marquesa Global Match: ${endereco}\nSenha: ${senha}`;

  it("ligar sem a senha e sem o áudio: as duas escolhas vão ao servidor", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    fireEvent.click(screen.getByRole("button", { name: /Compartilhar/ }));
    expect(screen.getByRole("checkbox", { name: "Proteger o link com uma senha de 6 dígitos, que a Marquesa Global Match cria para você" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Incluir o áudio da reunião no link" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /autorizaram/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /senha de 6 dígitos/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Incluir o áudio/ }));
    fireEvent.click(screen.getByRole("button", { name: /Criar link/ }));
    expect(duble.mutacoes.ligar.mutate).toHaveBeenCalledWith(expect.objectContaining({ meetingId: ID, comSenha: false, incluirAudio: false }));
  });

  it("ligado com senha: a senha aparece uma vez, com o texto pronto (o link e a senha), que recebe o foco e vai pelo WhatsApp e pelo e-mail", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={null}/>);
    act(() => duble.mutacoes.ligar.opcoes.onSuccess?.({ token: TOKEN, senha: "482913" }, { meetingId: ID, comSenha: true, incluirAudio: true }));
    const atualizar = duble.setData.mock.calls[0][1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, shareToken: null } })).toEqual({ meeting: { id: ID, shareToken: TOKEN, linkMostraNomes: true, linkComSenha: true, linkComAudio: true } });
    // O detalhe relido entrega o token ao painel, como a página faz.
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={TOKEN} comSenha/>);
    expect(screen.getByText("482913")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText(/A senha só aparece agora/)).toBeInTheDocument();
    const caixa = screen.getByRole("textbox", { name: "Texto pronto para mandar" });
    expect(caixa).toHaveValue(textoPronto("482913"));
    expect(caixa).toHaveFocus();
    const [, whatsappDoTexto] = screen.getAllByRole("link", { name: /WhatsApp/ });
    expect(new URL(whatsappDoTexto.getAttribute("href")!).searchParams.get("text")).toBe(textoPronto("482913"));
    const [, emailDoTexto] = screen.getAllByRole("link", { name: /E-mail/ });
    expect(new URLSearchParams(emailDoTexto.getAttribute("href")!.slice("mailto:?".length)).get("body")).toBe(textoPronto("482913"));
    // Pronto: a senha sai da tela, e nem a memória da tela a guarda mais.
    fireEvent.click(screen.getByRole("button", { name: "Pronto" }));
    expect(screen.queryByText("482913")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Texto pronto para mandar" })).not.toBeInTheDocument();
    expect(screen.getByText(/troque a senha para ver uma nova/)).toBeInTheDocument();
  });

  it("copiar o texto pronto; sem área de transferência, o texto fica selecionado", async () => {
    const writeText = vi.fn(async () => {});
    porAreaDeTransferencia(writeText);
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={TOKEN} comSenha/>);
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "135791" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar texto/ })); });
    expect(writeText).toHaveBeenCalledWith(textoPronto("135791"));
    expect(toast.success).toHaveBeenCalledWith("Texto copiado.");

    porAreaDeTransferencia(vi.fn(async () => { throw new Error("sem permissão"); }));
    const caixa = screen.getByRole("textbox", { name: "Texto pronto para mandar" }) as HTMLTextAreaElement;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar texto/ })); });
    expect(toast.message).toHaveBeenCalledWith(expect.stringContaining("copie por ali"));
    expect(caixa.selectionStart).toBe(0);
    expect(caixa.selectionEnd).toBe(textoPronto("135791").length);
  });

  it("com senha: trocar pede confirmação; Manter não chama o servidor; confirmado, a senha nova aparece", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={TOKEN} comSenha/>);
    expect(screen.getByText("Este link pede uma senha de 6 dígitos.")).toBeInTheDocument();
    expect(screen.getByText(/Quem tiver este link e a senha abre a reunião/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Trocar a senha" }));
    expect(screen.getByText(/A senha atual deixa de valer na hora/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manter" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(duble.mutacoes.novaSenha.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Trocar a senha" }));
    fireEvent.click(screen.getByRole("button", { name: "Trocar" }));
    expect(duble.mutacoes.novaSenha.mutate).toHaveBeenCalledWith({ meetingId: ID });
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "135791" }));
    expect(screen.getByText("135791")).toBeInTheDocument();
    expect(screen.queryByText(/A senha atual deixa de valer na hora/)).not.toBeInTheDocument();
    // Conferência de tela do Pacote 4d: a troca dizia "Senha criada.", como o primeiro "Pôr senha".
    expect(toast.success).toHaveBeenCalledWith("Senha trocada.");
    expect(toast.success).not.toHaveBeenCalledWith("Senha criada.");
  });

  it("o aviso diz o que a dona fez: Pôr senha cria, Trocar troca, e Pôr senha de novo, depois de tirar, volta a criar", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Pôr senha" }));
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "246801" }));
    expect(toast.success).toHaveBeenLastCalledWith("Senha criada.");

    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comSenha/>);
    fireEvent.click(screen.getByRole("button", { name: "Trocar a senha" }));
    fireEvent.click(screen.getByRole("button", { name: "Trocar" }));
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "135791" }));
    expect(toast.success).toHaveBeenLastCalledWith("Senha trocada.");

    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    fireEvent.click(screen.getByRole("button", { name: "Pôr senha" }));
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "975310" }));
    expect(toast.success).toHaveBeenLastCalledWith("Senha criada.");
    expect(duble.mutacoes.novaSenha.mutate).toHaveBeenCalledTimes(3);
  });

  it("o aviso da troca nos 10 idiomas é outro, e não o da senha criada", () => {
    for (const idioma of CODIGOS) {
      const trocada = i18n.t("meetings.share.passwordChanged", { lng: idioma });
      expect(trocada, idioma).not.toBe("meetings.share.passwordChanged");
      expect(trocada, idioma).not.toBe(i18n.t("meetings.share.passwordCreated", { lng: idioma }));
    }
  });

  it("com senha: tirar pede confirmação e, confirmado, o link volta a abrir sem senha", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comSenha/>);
    fireEvent.click(screen.getByRole("button", { name: "Tirar a senha" }));
    expect(screen.getByText(/passa a abrir a reunião sem senha/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tirar" }));
    expect(duble.mutacoes.tirarSenha.mutate).toHaveBeenCalledWith({ meetingId: ID });
    act(() => duble.mutacoes.tirarSenha.opcoes.onSuccess?.({ success: true }));
    const atualizar = duble.setData.mock.calls.at(-1)![1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, shareToken: TOKEN, linkComSenha: true } })).toEqual({ meeting: { id: ID, shareToken: TOKEN, linkComSenha: false } });
    expect(toast.success).toHaveBeenCalledWith("Senha tirada: o link abre sem senha.");
  });

  it("sem senha: Pôr senha cria a senha na hora, sem pergunta, e ela sai com o texto pronto para mandar a quem já tem o link", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    expect(screen.getByText("Este link abre sem senha: basta ter o endereço.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trocar a senha" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pôr senha" }));
    expect(duble.mutacoes.novaSenha.mutate).toHaveBeenCalledWith({ meetingId: ID });
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "246801" }));
    expect(screen.getByRole("textbox", { name: "Texto pronto para mandar" })).toHaveValue(`Reunião “Reunião” na Marquesa Global Match: ${endereco}\nSenha: 246801`);
    const atualizar = duble.setData.mock.calls.at(-1)![1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, linkComSenha: false } })).toEqual({ meeting: { id: ID, linkComSenha: true } });
    expect(toast.success).toHaveBeenCalledWith("Senha criada.");
    expect(toast.success).not.toHaveBeenCalledWith("Senha trocada.");
  });

  /**
   * Conferência de tela do Pacote 4d: a 375 px, o link quebra em 4 linhas ou
   * mais, e a caixa de 4 linhas fixas só mostrava a linha da senha rolando
   * dentro dela. O jsdom não faz layout: o scrollHeight dublado faz o papel da
   * altura do texto quebrado na largura da tela.
   */
  it("a caixa do texto pronto cresce até a linha da senha aparecer sem rolar dentro dela, e acompanha a largura da tela", () => {
    let alturaDoTexto = 168;
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => alturaDoTexto });
    try {
      render(<CompartilharReuniao meetingId={ID} titulo="Reunião com a Ana" token={TOKEN} comSenha/>);
      act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "135791" }));
      const caixa = screen.getByRole("textbox", { name: "Texto pronto para mandar" });
      expect(caixa.style.height).toBe("168px");
      // Girou o celular: o link quebra em menos linhas, e a caixa acompanha.
      alturaDoTexto = 96;
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(caixa.style.height).toBe("96px");
      // Fechado o quadro, a caixa sai, e a tela não fica ouvindo o resize.
      fireEvent.click(screen.getByRole("button", { name: "Pronto" }));
      alturaDoTexto = 240;
      act(() => { window.dispatchEvent(new Event("resize")); });
      expect(caixa.style.height).toBe("96px");
    } finally {
      Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
    }
  });

  it("o áudio do link ligado: desmarcar manda o servidor tirar o áudio, e a tela explica o que muda", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN}/>);
    const audio = screen.getByRole("checkbox", { name: "Incluir o áudio da reunião no link" });
    expect(audio).toBeChecked();
    fireEvent.click(audio);
    expect(duble.mutacoes.mudarAudio.mutate).toHaveBeenCalledWith({ meetingId: ID, incluirAudio: false });
    act(() => duble.mutacoes.mudarAudio.opcoes.onSuccess?.({ success: true }, { meetingId: ID, incluirAudio: false }));
    const atualizar = duble.setData.mock.calls.at(-1)![1] as (anterior: unknown) => unknown;
    expect(atualizar({ meeting: { id: ID, linkComAudio: true } })).toEqual({ meeting: { id: ID, linkComAudio: false } });
    expect(toast.success).toHaveBeenCalledWith("O link agora não leva o áudio.");
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comAudio={false}/>);
    expect(screen.getByRole("checkbox", { name: /Incluir o áudio/ })).not.toBeChecked();
    expect(screen.getByText(/sem o áudio e sem o player/)).toBeInTheDocument();
  });

  it("mudança recusada: o link desligado em outra aba e o teto das senhas têm frase própria", () => {
    render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comSenha/>);
    act(() => duble.mutacoes.novaSenha.opcoes.onError?.(erroDoServidor("PRECONDITION_FAILED")));
    expect(toast.error).toHaveBeenLastCalledWith("Este link foi desligado. Atualize a tela.");
    act(() => duble.mutacoes.novaSenha.opcoes.onError?.(erroDoServidor("TOO_MANY_REQUESTS")));
    expect(toast.error).toHaveBeenLastCalledWith("Muitas senhas novas em sequência. Aguarde alguns minutos e tente de novo.");
    act(() => duble.mutacoes.mudarAudio.opcoes.onError?.(erroDoServidor("NOT_FOUND")));
    expect(toast.error).toHaveBeenLastCalledWith(i18n.t("meetings.meetingNotFound"));
    act(() => duble.mutacoes.tirarSenha.opcoes.onError?.(erroDoServidor("BAD_REQUEST")));
    expect(toast.error).toHaveBeenLastCalledWith("Não foi possível mudar o compartilhamento. Tente de novo.");
  });

  it("desligar tira a senha da tela: religado depois, o painel não a traz de volta", () => {
    const { rerender } = render(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comSenha/>);
    act(() => duble.mutacoes.novaSenha.opcoes.onSuccess?.({ senha: "135791" }));
    expect(screen.getByText("135791")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Desligar o link" }));
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    act(() => duble.mutacoes.desligar.opcoes.onSuccess?.(undefined));
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={null}/>);
    rerender(<CompartilharReuniao meetingId={ID} titulo="Reunião" token={TOKEN} comSenha/>);
    expect(screen.queryByText("135791")).not.toBeInTheDocument();
  });
});
