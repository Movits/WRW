import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { quandoTentarDeNovo, SenhaDoLinkAberto } from "./SenhaDoLinkAberto";

/**
 * A tela da senha do link aberto (H23): quem recebeu o link digita os 6
 * dígitos. O tRPC é um dublê que registra o mutate e as opções dele; o que o
 * servidor responde a cada caso está em server/link-com-senha-rota.test.ts e
 * server/link-com-senha.integracao.test.ts.
 */

type Opcoes = { onSuccess?: (resultado: unknown) => void; onError?: (erro: unknown) => void };
const duble = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));

vi.mock("@/lib/trpc", () => ({
  trpc: { reuniaoAberta: { entrar: { useMutation: () => ({ mutate: duble.mutate, isPending: duble.isPending }) } } },
}));

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const erroDoServidor = (code: string, message = "frase do servidor") => Object.assign(new Error(message), { data: { code } });

function abrir(aoEntrar = vi.fn()) {
  render(<SenhaDoLinkAberto token={TOKEN} aoEntrar={aoEntrar}/>);
  return { aoEntrar, campo: screen.getByRole("textbox") as HTMLInputElement };
}
function digitarEMandar(campo: HTMLInputElement, senha: string) {
  fireEvent.change(campo, { target: { value: senha } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("meetings.openLink.password.submit") }));
}
const opcoesDoUltimoPedido = () => duble.mutate.mock.calls.at(-1)![1] as Opcoes;

beforeEach(() => {
  duble.mutate.mockReset();
  duble.isPending = false;
});
afterEach(async () => {
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
});

describe("a tela da senha do link", () => {
  it("pede os 6 dígitos com o teclado numérico, sem nada da reunião, e o campo já recebe o foco", () => {
    const { campo } = abrir();
    expect(screen.getByRole("heading", { name: "Reunião protegida por senha" })).toBeInTheDocument();
    expect(screen.getByText(/Digite a senha que você recebeu com o link/)).toBeInTheDocument();
    expect(campo).toHaveAccessibleName("Senha de 6 dígitos");
    expect(campo).toHaveAttribute("inputmode", "numeric");
    expect(campo).toHaveAttribute("autocomplete", "off");
    expect(campo).toHaveAttribute("dir", "ltr");
    expect(campo).toHaveFocus();
  });

  it("menos de 6 dígitos: avisa e não gasta tentativa no servidor", () => {
    const { campo } = abrir();
    digitarEMandar(campo, "12345");
    expect(screen.getByRole("alert")).toHaveTextContent("Digite os 6 dígitos da senha.");
    expect(campo).toHaveAttribute("aria-invalid", "true");
    expect(campo).toHaveAccessibleDescription("Digite os 6 dígitos da senha.");
    expect(duble.mutate).not.toHaveBeenCalled();
  });

  it("manda a senha só com os algarismos: o teclado árabe e o espaço do meio valem", () => {
    const { campo } = abrir();
    digitarEMandar(campo, "١٢٣ ٤٥٦");
    expect(duble.mutate).toHaveBeenCalledWith({ token: TOKEN, senha: "123456" }, expect.anything());
  });

  it("certa: a página relê a reunião", () => {
    const { aoEntrar, campo } = abrir();
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onSuccess?.({ entrou: true }));
    expect(aoEntrar).toHaveBeenCalledTimes(1);
  });

  it("errada: avisa, limpa o campo e devolve o foco a ele; a reunião não é relida", () => {
    const { aoEntrar, campo } = abrir();
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onSuccess?.({ entrou: false, motivo: "senha" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Senha incorreta. Confira os 6 dígitos e tente de novo.");
    expect(campo).toHaveValue("");
    expect(campo).toHaveFocus();
    expect(aoEntrar).not.toHaveBeenCalled();
  });

  it("na espera: diz quanto falta, no idioma da tela", () => {
    const { campo } = abrir();
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onSuccess?.({ entrou: false, motivo: "espera", segundos: 90 }));
    expect(screen.getByRole("alert")).toHaveTextContent("Muitas tentativas erradas. Tente de novo em 2 minutos.");
  });

  it("erro do servidor: o banco fora do ar tem a frase dele; o resto, a frase geral, nunca a do servidor", () => {
    const { campo } = abrir();
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onError?.(erroDoServidor("INTERNAL_SERVER_ERROR", MENSAGEM_BANCO_INDISPONIVEL)));
    expect(screen.getByRole("alert")).not.toHaveTextContent("frase do servidor");
    expect(screen.getByRole("alert").textContent).toBe(i18n.t("errors.databaseUnavailable"));
    // Outra frase interna do servidor não aparece crua a quem não tem conta.
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onError?.(erroDoServidor("INTERNAL_SERVER_ERROR", "Falha interna: detalhe técnico")));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível conferir a senha agora. Tente de novo.");
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onError?.(erroDoServidor("NOT_FOUND")));
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível conferir a senha agora. Tente de novo.");
    digitarEMandar(campo, "482913");
    act(() => opcoesDoUltimoPedido().onError?.(erroDoServidor("BAD_REQUEST")));
    expect(screen.getByRole("alert")).toHaveTextContent("Digite os 6 dígitos da senha.");
  });

  it("enquanto confere, o botão fica desligado e o Enter não manda de novo", () => {
    duble.isPending = true;
    const { campo } = abrir();
    expect(screen.getByRole("button", { name: /Abrir a reunião/ })).toBeDisabled();
    fireEvent.change(campo, { target: { value: "482913" } });
    fireEvent.submit(campo.closest("form")!);
    expect(duble.mutate).not.toHaveBeenCalled();
  });
});

describe("a tela da senha em árabe (da direita para a esquerda)", () => {
  it("os textos em árabe, a página da direita para a esquerda, e a senha sempre da esquerda para a direita", async () => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    const { campo } = abrir();
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByRole("heading", { name: "اجتماع محمي بكلمة مرور" })).toBeInTheDocument();
    expect(campo).toHaveAccessibleName("كلمة مرور من 6 أرقام");
    expect(campo).toHaveAttribute("dir", "ltr");
    // O teclado árabe digita ١٢٣٤٥٦: vale como 123456.
    digitarEMandar(campo, "٤٨٢٩١٣");
    expect(duble.mutate).toHaveBeenCalledWith({ token: TOKEN, senha: "482913" }, expect.anything());
    act(() => opcoesDoUltimoPedido().onSuccess?.({ entrou: false, motivo: "espera", segundos: 30 }));
    expect(screen.getByRole("alert").textContent).toBe(`محاولات خاطئة كثيرة. حاول مرة أخرى ${quandoTentarDeNovo(30, "ar")}.`);
  });

  it("quanto falta sai do próprio navegador, no plural e na ordem de cada idioma", () => {
    expect(quandoTentarDeNovo(30, "pt-BR")).toBe("em 30 segundos");
    expect(quandoTentarDeNovo(0.2, "pt-BR")).toBe("em 1 segundo");
    expect(quandoTentarDeNovo(61, "pt-BR")).toBe("em 2 minutos");
    expect(quandoTentarDeNovo(3600, "en")).toBe("in 60 minutes");
    expect(quandoTentarDeNovo(120, "ar")).toMatch(/[؀-ۿ]/);
  });
});
