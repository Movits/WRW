import { fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ConexaoGoogleAgenda, avisoDaVolta, mensagemDoErroDaGoogleAgenda } from "./ConexaoGoogleAgenda";
import { RESULTADOS_DA_GOOGLE_AGENDA } from "@shared/google-agenda";

/**
 * A seção da Google Agenda no Perfil (H16b), com o tRPC dublado. Prova o que a
 * dona vê e o que vai ao servidor: sem a função, nada aparece; a falha da
 * consulta é erro (nunca "nenhuma conta conectada"); conectar é um <a href> de
 * página inteira, só no endereço certo; desconectar pede confirmação; a volta
 * da Google vira um aviso traduzido, e o `?google=` sai da URL.
 */

type Opcoes = { onSuccess?: (data: unknown) => unknown; onError?: (erro: unknown) => void };

const duble = vi.hoisted(() => ({
  estado: vi.fn(),
  opcoes: {} as Opcoes,
  mutate: vi.fn(),
  isPending: false,
  invalidate: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ googleAgenda: { estado: { invalidate: duble.invalidate } } }),
    googleAgenda: {
      estado: { useQuery: (...args: unknown[]) => duble.estado(...args) },
      desconectar: {
        useMutation: (opcoes: Opcoes = {}) => {
          duble.opcoes = opcoes;
          return { mutate: duble.mutate, isPending: duble.isPending };
        },
      },
    },
  },
}));

const consulta = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn(), ...extra });
const naOrigem = () => window.location.origin;

/** O userAgent da casca das lojas (#180): o padrão do sistema com "WRWApp/1.0" no fim. */
const UA_DA_CASCA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WRWApp/1.0";
function abrirNaCasca() {
  Object.defineProperty(window.navigator, "userAgent", { value: UA_DA_CASCA, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  duble.isPending = false;
  duble.opcoes = {};
  window.history.replaceState(null, "", "/profile");
});
afterEach(async () => {
  // Tira o userAgent da casca: volta o do jsdom, do protótipo.
  delete (window.navigator as unknown as Record<string, unknown>).userAgent;
  await i18n.changeLanguage("pt-BR");
});

describe("quando a seção aparece", () => {
  it("sem a função no servidor, nada aparece", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: false }));
    const { container } = render(<ConexaoGoogleAgenda />);
    expect(container).toBeEmptyDOMElement();
  });

  it("carregando, nada (nem 'nenhuma conta')", () => {
    duble.estado.mockReturnValue(consulta(undefined, { isLoading: true }));
    const { container } = render(<ConexaoGoogleAgenda />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a falha da consulta é erro com Tentar de novo, nunca 'nenhuma conta conectada'", () => {
    const refetch = vi.fn();
    duble.estado.mockReturnValue(consulta(undefined, {
      isError: true, refetch,
      error: { message: "Banco de dados indisponível; tente de novo em instantes", data: { code: "INTERNAL_SERVER_ERROR" } },
    }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByRole("heading", { name: "Google Agenda" })).toBeInTheDocument();
    const alerta = screen.getByRole("alert");
    expect(screen.queryByText("Nenhuma conta Google conectada.")).not.toBeInTheDocument();
    fireEvent.click(within(alerta).getByRole("button"));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("conectar", () => {
  it("sem conexão, no endereço certo: o botão é um link de página inteira para a rota do servidor", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByText("Nenhuma conta Google conectada.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Conectar a Google Agenda/ });
    expect(link).toHaveAttribute("href", "/api/google-agenda/conectar");
    expect(screen.queryByRole("button", { name: /Desconectar/ })).not.toBeInTheDocument();
  });

  it("antes de autorizar, o subtítulo diz em que a MarquesaMatch mexe (H5c) e a nota de privacidade é o texto da Cris (23/11)", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByText(
      "Conecte a sua conta Google para a MarquesaMatch pôr na sua Google Agenda as reuniões que você marcar e as suas próximas ações com prazo.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Ao conectar a Google Agenda, a MarquesaMatch poderá consultar e criar eventos para agendar reuniões. Nenhum outro dado da conta Google é acessado, e a agenda pode ser desconectada a qualquer momento.",
    )).toBeInTheDocument();
  });

  it("noutro endereço (o do Render, por exemplo): sem o botão, com o caminho para o endereço certo", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: "https://wrwglobal.org", conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.queryByRole("link", { name: /Conectar a Google Agenda/ })).not.toBeInTheDocument();
    expect(screen.getByText("Para conectar a Google Agenda, entre na MarquesaMatch pelo endereço wrwglobal.org.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir wrwglobal.org/ })).toHaveAttribute("href", "https://wrwglobal.org/profile");
  });
});

describe("no app das lojas (a casca da #180, uma WebView)", () => {
  // A ida à Google sairia para o navegador do sistema, sem o cookie da ida nem
  // a sessão, e a Google recusa login dentro de WebView: conectar não terminaria.
  it("sem conexão: no lugar do botão, o aviso para conectar pelo navegador", () => {
    abrirNaCasca();
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.queryByRole("link", { name: /Conectar a Google Agenda/ })).not.toBeInTheDocument();
    expect(screen.getByText(`Pelo app não dá para conectar a Google Agenda. Abra ${window.location.host} no navegador, entre na sua conta e conecte no Perfil.`))
      .toBeInTheDocument();
  });

  it("a conexão que parou de funcionar: sem Reconectar, com o aviso, e desconectar continua", () => {
    abrirNaCasca();
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: "revogada" }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.queryByRole("link", { name: /Reconectar/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Pelo app não dá para conectar a Google Agenda/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Desconectar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    expect(duble.mutate).toHaveBeenCalledTimes(1);
  });

  it("conectada e funcionando: nada a avisar; noutro endereço, o aviso do app no lugar do link (que ficaria na WebView)", () => {
    abrirNaCasca();
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: null }));
    const { unmount } = render(<ConexaoGoogleAgenda />);
    expect(screen.queryByText(/Pelo app não dá para conectar/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Desconectar/ })).toBeInTheDocument();
    unmount();
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: "https://wrwglobal.org", conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByText(/Abra wrwglobal.org no navegador/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Abrir wrwglobal.org/ })).not.toBeInTheDocument();
  });

  it("o mesmo userAgent sem a marca da casca (o Safari do iPhone) conecta normalmente", () => {
    Object.defineProperty(window.navigator, "userAgent", { value: UA_DA_CASCA.replace(" WRWApp/1.0", " Safari/604.1"), configurable: true });
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByRole("link", { name: /Conectar a Google Agenda/ })).toHaveAttribute("href", "/api/google-agenda/conectar");
  });
});

describe("conectada", () => {
  it("mostra a conta e desconecta só depois de confirmar; Manter desiste", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: null }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByText("Conectada à conta Google dona@exemplo.com.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Conectar a Google Agenda/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Reconectar/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Desconectar/ }));
    expect(duble.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/Os eventos que já estão na sua Google Agenda continuam lá/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manter" }));
    expect(duble.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Desconectar/ }));
    fireEvent.click(screen.getByRole("button", { name: "Desconectar" }));
    expect(duble.mutate).toHaveBeenCalledTimes(1);
  });

  it("sem o e-mail da conta, diz só que está conectada", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: null, falha: null }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByText("Conectada a uma conta Google.")).toBeInTheDocument();
  });

  it("desconectada: avisa, e relê o estado; sem a confirmação da Google, o aviso diz o que fazer", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: null }));
    render(<ConexaoGoogleAgenda />);
    duble.opcoes.onSuccess?.({ googleNaoConfirmou: false });
    expect(toast.success).toHaveBeenCalledWith("Google Agenda desconectada.");
    expect(duble.invalidate).toHaveBeenCalled();
    duble.opcoes.onSuccess?.({ googleNaoConfirmou: true });
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("a Google não confirmou"), expect.anything());
  });

  it("a recusa do desconectar sai traduzida pelo código", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: null }));
    render(<ConexaoGoogleAgenda />);
    duble.opcoes.onError?.({ message: "A conexão com a Google Agenda não está disponível.", data: { code: "NOT_FOUND" } });
    expect(toast.error).toHaveBeenCalledWith("A conexão com a Google Agenda não está disponível agora.");
  });

  it("a conexão que parou de funcionar pede Reconectar (no endereço certo), e ainda deixa desconectar", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: "revogada" }));
    render(<ConexaoGoogleAgenda />);
    expect(screen.getByRole("status")).toHaveTextContent("Esta conexão parou de funcionar.");
    expect(screen.getByRole("link", { name: /Reconectar/ })).toHaveAttribute("href", "/api/google-agenda/conectar");
    expect(screen.getByRole("button", { name: /Desconectar/ })).toBeInTheDocument();
  });
});

describe("a volta da Google (?google=)", () => {
  it("vira um aviso só, e o parâmetro sai da URL (os outros ficam)", () => {
    window.history.replaceState(null, "", "/profile?aba=1&google=conectada");
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: true, email: "dona@exemplo.com", falha: null }));
    const { rerender } = render(<ConexaoGoogleAgenda />);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Google Agenda conectada.");
    expect(`${window.location.pathname}${window.location.search}`).toBe("/profile?aba=1");
    rerender(<ConexaoGoogleAgenda />);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("a negada é informação; a permissão que faltou é erro com o que fazer", () => {
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: false }));
    window.history.replaceState(null, "", "/profile?google=negada");
    render(<ConexaoGoogleAgenda />);
    expect(toast.info).toHaveBeenCalledWith("A conexão com a Google Agenda não foi autorizada.");
    expect(window.location.search).toBe("");
  });

  it("a conexão que falhou com a autorização ainda na Google: aviso longo, que diz como tirar o acesso", () => {
    window.history.replaceState(null, "", "/profile?google=erro-acesso-ficou");
    duble.estado.mockReturnValue(consulta({ disponivel: true, origem: naOrigem(), conectada: false }));
    render(<ConexaoGoogleAgenda />);
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("tire o acesso da MarquesaMatch nas configurações da sua conta Google"), { duration: 15000 });
    expect(window.location.search).toBe("");
  });

  it("o aviso vem mesmo se a função saiu do ar no meio (a seção não aparece)", () => {
    window.history.replaceState(null, "", "/profile?google=erro");
    duble.estado.mockReturnValue(consulta({ disponivel: false }));
    render(<ConexaoGoogleAgenda />);
    expect(toast.error).toHaveBeenCalledWith("Não deu para conectar a Google Agenda. Tente de novo em instantes.");
  });

  it("valor desconhecido não vira aviso nem mexe na URL", () => {
    window.history.replaceState(null, "", "/profile?google=qualquer");
    duble.estado.mockReturnValue(consulta({ disponivel: false }));
    render(<ConexaoGoogleAgenda />);
    for (const tipo of ["success", "error", "info", "warning"] as const) expect(toast[tipo]).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?google=qualquer");
  });

  it("todo resultado tem aviso traduzido nos idiomas (en e ar como amostra)", async () => {
    const tPt = i18n.getFixedT("pt-BR");
    for (const resultado of RESULTADOS_DA_GOOGLE_AGENDA) {
      const aviso = avisoDaVolta(tPt, resultado);
      expect(aviso.texto).not.toMatch(/^googleAgenda\./);
    }
    await i18n.changeLanguage("en");
    expect(avisoDaVolta(i18n.t.bind(i18n), "sem-permissao").texto).toBe("The calendar permission was missing. Connect again and leave the Google Calendar option checked.");
    await i18n.changeLanguage("ar");
    expect(avisoDaVolta(i18n.t.bind(i18n), "conectada").texto).toBe("تم ربط تقويم Google.");
    expect(mensagemDoErroDaGoogleAgenda(i18n.t.bind(i18n), { data: { code: "NOT_FOUND" } })).toBe("الربط مع تقويم Google غير متاح الآن.");
  });
});
