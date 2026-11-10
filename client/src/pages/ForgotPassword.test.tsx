import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { LANGUAGES } from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { PASSWORD_RESET_GENERIC_MESSAGE } from "../../../server/password-reset-security";

/**
 * "Esqueci a senha" com tela neutra (relato da cliente de 20/10/2026: com um
 * e-mail diferente do cadastrado, a tela dizia "Link enviado!" e nada chegava).
 * A resposta de auth.forgotPassword continua igual com conta e sem conta (PR
 * #90, presa por server/auth.esqueci-senha-nao-enumera.test.ts). A tela é que
 * deixa de afirmar o envio: diz que o pedido chegou, repete o e-mail pedido e
 * explica o que fazer se nada chegar.
 */

type Erro = { message: string; data?: { code?: string; path?: string; httpStatus?: number } };
type Resposta = { success: boolean; message: string };
type Opcoes = { onSuccess: (dados: Resposta, variaveis: { email: string }) => void; onError: (erro: Erro) => void };

// A resposta de verdade de auth.forgotPassword, igual com conta e sem conta. A
// frase é do servidor, em português: a tela não a mostra em nenhum idioma.
const RESPOSTA: Resposta = { success: true, message: PASSWORD_RESET_GENERIC_MESSAGE };

const duble = vi.hoisted(() => ({
  opcoes: null as unknown as Opcoes,
  mutate: vi.fn(),
  pendente: false,
  dados: undefined as Resposta | undefined,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    auth: {
      forgotPassword: {
        useMutation: (opcoes: Opcoes) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: duble.pendente, data: duble.dados };
        },
      },
    },
  },
}));
vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import ForgotPassword from "./ForgotPassword";

// As traduções antigas de "Link enviado!": nenhuma pode voltar como título.
const TITULOS_ANTIGOS = [
  "Link enviado!", "Link sent!", "¡Enlace enviado!", "Lien envoyé !", "Link gesendet!", "Ссылка отправлена!",
  "लिंक भेजा गया!", "تم إرسال الرابط!", "链接已发送！", "リンクを送信しました！",
];

// As chaves novas da tela: cada idioma precisa da sua, traduzida, e não do pt-BR.
const CHAVES_NOVAS = [
  "forgotPasswordCheckTitle", "forgotPasswordCheckDesc", "forgotPasswordNotArrivedTitle", "forgotPasswordNotArrivedTypo",
  "forgotPasswordNotArrivedSpam", "forgotPasswordNotArrivedWait", "forgotPasswordNotArrivedNoAccount", "forgotPasswordFixEmail",
  "forgotPasswordInvalidEmail", "tooManyRequests", "forgotPasswordTooManyRequests",
];
// As que aparecem na tela do pedido recebido (as três últimas são avisos de erro dos formulários).
const AVISOS_DE_ERRO = ["forgotPasswordInvalidEmail", "tooManyRequests", "forgotPasswordTooManyRequests"];
const CHAVES_DA_TELA_DO_PEDIDO = CHAVES_NOVAS.filter(c => !AVISOS_DE_ERRO.includes(c));

const EMAIL = "ana.souza@exemplo.com.br";

const campoDoEmail = () => document.querySelector<HTMLInputElement>("input#email")!;

/**
 * Preenche o e-mail, envia e faz o servidor responder com sucesso. O onSuccess
 * recebe a resposta real e o que a tela passou ao mutate, como no React Query,
 * e a resposta fica também no `data` da mutação, que a tela poderia ler.
 */
function pedirLink(email = EMAIL) {
  render(<ForgotPassword />);
  fireEvent.change(campoDoEmail(), { target: { value: email } });
  fireEvent.submit(campoDoEmail().closest("form")!);
  duble.dados = RESPOSTA;
  act(() => duble.opcoes.onSuccess(RESPOSTA, duble.mutate.mock.lastCall![0]));
}

beforeEach(() => {
  duble.mutate.mockReset();
  duble.pendente = false;
  duble.dados = undefined;
});

afterEach(async () => {
  // Desmonta antes: no Vitest 2 os afterEach rodam em pilha, e este viria antes do
  // cleanup do setup. Com a tela montada, trocar o idioma a redesenharia no fim do teste.
  cleanup();
  await i18n.changeLanguage("pt-BR");
});

describe("Esqueci a senha — o formulário", () => {
  it("o campo se apresenta ao gerenciador de senhas e ao teclado do celular", () => {
    render(<ForgotPassword />);
    const campo = campoDoEmail();
    expect(campo).toHaveAttribute("type", "email");
    expect(campo).toHaveAttribute("name", "email");
    expect(campo).toHaveAttribute("autocomplete", "username");
    expect(campo).toHaveAttribute("inputmode", "email");
    expect(campo).toHaveAttribute("autocapitalize", "none");
    expect(campo).toHaveAttribute("spellcheck", "false");
  });

  it("envia o e-mail digitado ao servidor", () => {
    render(<ForgotPassword />);
    fireEvent.change(campoDoEmail(), { target: { value: EMAIL } });
    fireEvent.submit(campoDoEmail().closest("form")!);
    expect(duble.mutate).toHaveBeenCalledWith({ email: EMAIL });
  });

  it("durante o envio o campo fica só de leitura, para o e-mail pedido não mudar", () => {
    duble.pendente = true;
    render(<ForgotPassword />);
    expect(campoDoEmail()).toHaveAttribute("readonly");
  });

  it("o limite de pedidos de recuperação (TOO_MANY_REQUESTS da rota) aparece no aviso do formulário, no idioma da tela", async () => {
    await i18n.changeLanguage("en");
    render(<ForgotPassword />);
    const doServidor = "Muitos pedidos de recuperação de senha a partir desta rede. Aguarde alguns minutos e tente de novo.";
    act(() => duble.opcoes.onError({ message: doServidor, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429, path: "auth.forgotPassword" } }));
    const aviso = screen.getByRole("alert");
    // O limite é por rede e dura minutos: o aviso diz isso, e não "um instante".
    expect(aviso).toHaveTextContent(i18n.t("auth.forgotPasswordTooManyRequests"));
    expect(aviso).toHaveTextContent(/network/);
    expect(aviso).toHaveTextContent(/minutes/);
    expect(aviso).not.toHaveTextContent("Muitos pedidos de recuperação");
    expect(campoDoEmail()).toBeInTheDocument();
  });

  it("o limite geral da API (429 sem path, de antes do tRPC) mostra a frase dele, e não a dos pedidos de recuperação", async () => {
    await i18n.changeLanguage("en");
    render(<ForgotPassword />);
    // O envelope de responderLimite (server/_core/limite-de-requisicoes.ts).
    const doLimiteGeral = "Muitas requisições em pouco tempo. Aguarde alguns segundos e tente de novo.";
    act(() => duble.opcoes.onError({ message: doLimiteGeral, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(doLimiteGeral);
    expect(aviso).not.toHaveTextContent(i18n.t("auth.forgotPasswordTooManyRequests"));
  });

  it("e-mail que o servidor recusa pelo formato vira um aviso legível, e o campo segue editável para corrigir", async () => {
    await i18n.changeLanguage("en");
    render(<ForgotPassword />);
    fireEvent.change(campoDoEmail(), { target: { value: "nome@gmailcom" } });
    fireEvent.submit(campoDoEmail().closest("form")!);
    const doZod = JSON.stringify([{ code: "invalid_format", format: "email", path: ["email"], message: "Invalid email address" }]);
    act(() => duble.opcoes.onError({ message: doZod, data: { code: "BAD_REQUEST", httpStatus: 400, path: "auth.forgotPassword" } }));
    const aviso = screen.getByRole("alert");
    // Em inglês, para separar o aviso traduzido de uma frase fixa em português.
    expect(aviso).toHaveTextContent(i18n.t("auth.forgotPasswordInvalidEmail"));
    expect(aviso).not.toHaveTextContent("Este e-mail não parece válido");
    expect(aviso).not.toHaveTextContent("invalid_format");
    expect(campoDoEmail()).toHaveValue("nome@gmailcom");
    expect(campoDoEmail()).not.toHaveAttribute("readonly");
  });

  it("falha sem resposta do servidor (rede, proxy) mostra o texto genérico traduzido, não o técnico", async () => {
    await i18n.changeLanguage("en");
    render(<ForgotPassword />);
    act(() => duble.opcoes.onError({ message: "Failed to fetch" }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("errorBoundary.serverUnavailable"));
    expect(aviso).not.toHaveTextContent("Failed to fetch");
    expect(aviso).not.toHaveTextContent(String(i18n.getResource("pt-BR", "translation", "errorBoundary.serverUnavailable")));
  });

  it("banco fora do ar: a mensagem do servidor sai pelo tradutor comum", async () => {
    await i18n.changeLanguage("en");
    render(<ForgotPassword />);
    // Como chega de verdade: o tRPC põe o path em todo erro lançado na rota, e
    // não só no limite. O aviso de limite exige também o código.
    act(() => duble.opcoes.onError({ message: MENSAGEM_BANCO_INDISPONIVEL, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "auth.forgotPassword" } }));
    const aviso = screen.getByRole("alert");
    expect(aviso).toHaveTextContent(i18n.t("errors.databaseUnavailable"));
    expect(aviso).not.toHaveTextContent(MENSAGEM_BANCO_INDISPONIVEL);
    expect(aviso).not.toHaveTextContent(i18n.t("auth.forgotPasswordTooManyRequests"));
  });
});

describe("Esqueci a senha — depois do pedido", () => {
  it("diz que o pedido chegou, sem afirmar que um link saiu, e repete o e-mail pedido", () => {
    pedirLink();
    expect(screen.getByRole("heading", { name: "Pedido recebido" })).toBeInTheDocument();
    expect(screen.getByText(/Se existir uma conta WRW com o e-mail abaixo/)).toBeInTheDocument();
    expect(screen.getByTestId("email-digitado")).toHaveTextContent(EMAIL);
    expect(screen.getByTestId("email-digitado")).toHaveAttribute("dir", "ltr");
    expect(screen.queryByText(/Link enviado/)).not.toBeInTheDocument();
    // O subtítulo do formulário promete "enviaremos um link": sai junto com ele.
    expect(screen.queryByText(/enviaremos um link/)).not.toBeInTheDocument();
    // Nem a frase da resposta, que promete que "você receberá instruções".
    expect(document.body).not.toHaveTextContent(PASSWORD_RESET_GENERIC_MESSAGE);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("repete o e-mail que foi no pedido, mesmo que o campo tenha mudado antes da resposta", () => {
    render(<ForgotPassword />);
    fireEvent.change(campoDoEmail(), { target: { value: EMAIL } });
    fireEvent.submit(campoDoEmail().closest("form")!);
    fireEvent.change(campoDoEmail(), { target: { value: "ana.souza@exemplo.com" } });
    act(() => duble.opcoes.onSuccess(RESPOSTA, { email: EMAIL }));
    expect(screen.getByTestId("email-digitado").textContent).toBe(EMAIL);
  });

  it("os espaços digitados nas pontas não vão ao servidor nem aparecem na tela", () => {
    // Espaço não separável (U+00A0): a limpeza do campo type="email" só tira o
    // espaço comum, então quem prova o trim da tela é este caso.
    pedirLink(` ${EMAIL} `);
    expect(duble.mutate).toHaveBeenCalledWith({ email: EMAIL });
    expect(screen.getByTestId("email-digitado").textContent).toBe(EMAIL);
  });

  it("o foco vai ao título 'Pedido recebido', que o leitor de tela lê, sem a moldura de campo", () => {
    pedirLink();
    const titulo = screen.getByRole("heading", { name: "Pedido recebido" });
    expect(document.activeElement).toBe(titulo);
    // Inline, porque a regra global de :focus-visible vence a classe (ver o componente).
    expect(titulo.style.outline).toBe("none");
    // Sem moldura só vale fora da ordem do Tab: com tabindex 0, o Tab pararia no
    // título sem indicador nenhum.
    expect(titulo).toHaveAttribute("tabindex", "-1");
  });

  it("explica o que fazer se nada chegar, nos quatro casos", () => {
    pedirLink();
    expect(screen.getByText("Não chegou em alguns minutos?")).toBeInTheDocument();
    expect(screen.getByText(/Confira se o e-mail acima é o mesmo do seu cadastro/)).toBeInTheDocument();
    expect(screen.getByText(/Procure também nas pastas de spam/)).toBeInTheDocument();
    expect(screen.getByText(/cada pedido cancela o anterior/)).toBeInTheDocument();
    expect(screen.getByText(/Ainda não tem conta na WRW\?/)).toBeInTheDocument();
  });

  it("'Corrigir o e-mail' volta ao formulário com o e-mail preservado e selecionado", () => {
    // Campo type="email" não expõe selectionStart/End (a especificação devolve
    // null), mas aceita select(): a prova é a chamada.
    const selecionar = vi.spyOn(HTMLInputElement.prototype, "select");
    pedirLink();
    fireEvent.click(screen.getByRole("button", { name: "Corrigir o e-mail" }));
    const campo = campoDoEmail();
    expect(campo).toHaveValue(EMAIL);
    expect(document.activeElement).toBe(campo);
    expect(selecionar).toHaveBeenCalledTimes(1);
    expect(campo).not.toHaveAttribute("readonly");
    expect(screen.getByText(/enviaremos um link/)).toBeInTheDocument();
    selecionar.mockRestore();
  });

  it("o ciclo do relato: pedir, corrigir o e-mail e pedir de novo leva ao segundo 'Pedido recebido', com o e-mail novo", () => {
    pedirLink();
    fireEvent.click(screen.getByRole("button", { name: "Corrigir o e-mail" }));
    const corrigido = "ana.souza@exemplo.com";
    fireEvent.change(campoDoEmail(), { target: { value: corrigido } });
    fireEvent.submit(campoDoEmail().closest("form")!);
    expect(duble.mutate).toHaveBeenCalledTimes(2);
    expect(duble.mutate).toHaveBeenLastCalledWith({ email: corrigido });
    act(() => duble.opcoes.onSuccess(RESPOSTA, duble.mutate.mock.lastCall![0]));
    const titulo = screen.getByRole("heading", { name: "Pedido recebido" });
    expect(screen.getByTestId("email-digitado").textContent).toBe(corrigido);
    expect(document.activeElement).toBe(titulo);
    expect(titulo).toHaveAttribute("tabindex", "-1");
  });

  it("'Criar conta' leva ao cadastro", () => {
    pedirLink();
    expect(screen.getByRole("link", { name: "Criar conta" })).toHaveAttribute("href", "/register");
  });

  it.each(LANGUAGES.map(l => l.code))("em %s, a tela do pedido sai traduzida e sem o título antigo", async (idioma) => {
    await i18n.changeLanguage(idioma);
    pedirLink();
    const tela = screen.getByRole("status");
    const texto = tela.textContent ?? "";
    expect(texto, idioma).not.toMatch(/auth\./);
    expect(texto, idioma).not.toContain("{{");
    const titulo = tela.querySelector("h3")?.textContent ?? "";
    expect(titulo.length, idioma).toBeGreaterThan(0);
    expect(TITULOS_ANTIGOS, idioma).not.toContain(titulo);
    expect(document.body, idioma).not.toHaveTextContent(PASSWORD_RESET_GENERIC_MESSAGE);
    // A TELA, e não só o JSON: cada texto do pedido recebido sai no idioma escolhido.
    expect(titulo, idioma).toBe(i18n.t("auth.forgotPasswordCheckTitle"));
    for (const chave of CHAVES_DA_TELA_DO_PEDIDO) {
      expect(document.body.textContent, `${idioma}: auth.${chave} fora da tela`).toContain(i18n.t(`auth.${chave}`));
    }
    // Cada chave nova existe no próprio idioma (sem cair no pt-BR) e foi traduzida.
    for (const chave of CHAVES_NOVAS) {
      const valor = i18n.getResource(idioma, "translation", `auth.${chave}`);
      expect(typeof valor === "string" && valor.length > 0, `${idioma}: auth.${chave}`).toBe(true);
      if (idioma !== "pt-BR") expect(valor, `${idioma}: auth.${chave} igual ao pt-BR`).not.toBe(i18n.getResource("pt-BR", "translation", `auth.${chave}`));
    }
  });
});
