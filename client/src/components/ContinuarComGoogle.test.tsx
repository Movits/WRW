import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ContinuarComGoogle } from "./ContinuarComGoogle";
import { avisoDaContaGoogle, buscaSemOResultado, mensagemDoErroDaContaGoogle } from "@/lib/entrar-com-google";
import { ERRO_DA_CONTA_GOOGLE, RESULTADOS_DA_CONTA_GOOGLE } from "@shared/entrar-com-google";

/**
 * "Continuar com Google" no login e no cadastro (A8), com o tRPC dublado: sem a
 * função no servidor ou dentro de WebView, o botão some; com ela, é um <a href>
 * absoluto na origem do FRONTEND_URL, com o modo e o voltar; a volta com
 * `?conta-google=` vira um aviso traduzido, e o parâmetro sai da URL.
 */

const duble = vi.hoisted(() => ({ disponivel: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: { contaGoogle: { disponivel: { useQuery: (...args: unknown[]) => duble.disponivel(...args) } } },
}));

const ORIGEM = "https://wrwglobal.org";
const UA_DO_INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0";

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/login");
  duble.disponivel.mockReturnValue({ data: { disponivel: true, origem: ORIGEM } });
});
afterEach(async () => {
  delete (window.navigator as unknown as Record<string, unknown>).userAgent;
  await i18n.changeLanguage("pt-BR");
});

describe("o botão", () => {
  it("com a função, é um link de página inteira na origem do FRONTEND_URL, com o modo e o voltar", () => {
    render(<ContinuarComGoogle modo="entrar" voltar="/reunioes/7" />);
    const link = screen.getByRole("link", { name: /Continuar com Google/ });
    expect(link).toHaveAttribute("href", `${ORIGEM}/api/entrar-com-google/ir?modo=entrar&voltar=%2Freunioes%2F7`);
  });

  it("no cadastro, leva o modo cadastrar", () => {
    render(<ContinuarComGoogle modo="cadastrar" />);
    expect(screen.getByRole("link", { name: /Continuar com Google/ })).toHaveAttribute("href", `${ORIGEM}/api/entrar-com-google/ir?modo=cadastrar`);
  });

  it("sem a função no servidor, ou carregando, não aparece", () => {
    duble.disponivel.mockReturnValue({ data: { disponivel: false } });
    const { container, rerender } = render(<ContinuarComGoogle modo="entrar" />);
    expect(container).toBeEmptyDOMElement();
    duble.disponivel.mockReturnValue({ data: undefined });
    rerender(<ContinuarComGoogle modo="entrar" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dentro de WebView (o navegador do Instagram), não aparece nem pergunta ao servidor", () => {
    Object.defineProperty(window.navigator, "userAgent", { value: UA_DO_INSTAGRAM, configurable: true });
    const { container } = render(<ContinuarComGoogle modo="entrar" />);
    expect(container).toBeEmptyDOMElement();
    expect(duble.disponivel).toHaveBeenCalledWith(undefined, expect.objectContaining({ enabled: false }));
  });

  it("enquanto o formulário envia, o clique não sai da tela", () => {
    render(<ContinuarComGoogle modo="entrar" desligado />);
    const link = screen.getByRole("link", { name: /Continuar com Google/ });
    expect(link).toHaveAttribute("aria-disabled", "true");
    const evento = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(evento);
    expect(evento.defaultPrevented).toBe(true);
  });

  it("em árabe, o botão e o aviso saem no idioma", async () => {
    await i18n.changeLanguage("ar");
    window.history.replaceState(null, "", "/login?conta-google=conta-existe");
    render(<ContinuarComGoogle modo="entrar" />);
    expect(screen.getByRole("link", { name: /المتابعة باستخدام Google/ })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("يوجد بالفعل حساب");
  });
});

describe("a volta da Google", () => {
  it("conta-existe vira um aviso que manda entrar com a senha e ligar no Perfil, e o parâmetro sai da URL", () => {
    window.history.replaceState(null, "", "/login?voltar=%2Fagenda&conta-google=conta-existe");
    render(<ContinuarComGoogle modo="entrar" />);
    expect(screen.getByRole("status")).toHaveTextContent("Já existe uma conta com o e-mail desta conta Google");
    expect(window.location.search).toBe("?voltar=%2Fagenda");
  });

  it("o erro sai como alerta, mesmo com a função desligada no meio", () => {
    duble.disponivel.mockReturnValue({ data: { disponivel: false } });
    window.history.replaceState(null, "", "/register?conta-google=email-nao-verificado");
    render(<ContinuarComGoogle modo="cadastrar" />);
    expect(screen.getByRole("alert")).toHaveTextContent("O Google não confirma o e-mail desta conta");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("resultado desconhecido não mostra nada", () => {
    window.history.replaceState(null, "", "/login?conta-google=qualquer-coisa");
    render(<ContinuarComGoogle modo="entrar" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("as frases", () => {
  const t = (chave: string) => i18n.t(chave);
  it("todo resultado tem frase própria, traduzida nos 10 idiomas", async () => {
    for (const lingua of ["pt-BR", "en", "es", "fr", "de", "ru", "hi", "ar", "zh", "ja"]) {
      await i18n.changeLanguage(lingua);
      const frases = RESULTADOS_DA_CONTA_GOOGLE.map(resultado => avisoDaContaGoogle(t, resultado).texto);
      for (const frase of frases) expect(frase, lingua).not.toMatch(/^contaGoogle\./);
      expect(new Set(frases).size, lingua).toBe(frases.length);
    }
  });

  it("as recusas do tRPC saem pelo código, nunca a frase do servidor", () => {
    expect(mensagemDoErroDaContaGoogle(t, { message: ERRO_DA_CONTA_GOOGLE.semSenha, data: { code: "PRECONDITION_FAILED" } }))
      .toContain("Esqueci minha senha");
    expect(mensagemDoErroDaContaGoogle(t, { message: ERRO_DA_CONTA_GOOGLE.naoLigada, data: { code: "NOT_FOUND" } }))
      .toBe(i18n.t("contaGoogle.errors.notLinked"));
  });

  it("a busca perde só o resultado", () => {
    expect(buscaSemOResultado("?conta-google=ligada")).toBe("");
    expect(buscaSemOResultado("?a=1&conta-google=ligada&b=2")).toBe("?a=1&b=2");
  });
});
