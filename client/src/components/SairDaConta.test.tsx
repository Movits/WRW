import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useAuth } from "@/_core/hooks/useAuth";
import { ocupar, sessaoOcupada, type MotivoDaOcupacao } from "@/lib/sessao-ocupada";
import AdminPanel from "@/pages/AdminPanel";
import { GlobalMenu } from "./AppHeader";
import { useSairDaConta } from "./SairDaConta";

/**
 * Sair da conta com a sessão ocupada (PR S do gravador). Até o envio, a
 * gravação, o envio e o áudio ainda não enviado só existem nesta aba
 * (lib/sessao-ocupada.ts): o Sair os perdia sem perguntar. Agora, ocupada, o
 * Sair abre um diálogo com o motivo, "Continuar aqui" é o padrão (com o foco)
 * e só "Sair mesmo assim" chama o logout. Livre, sai direto, como antes.
 *
 * São dois lugares de Sair: o menu global (o do cabeçalho de toda tela logada,
 * que o Dashboard monta na própria barra; ver Dashboard.sair.test.tsx) e o
 * painel administrativo. A guarda no fim deste arquivo cobra que um terceiro,
 * se nascer, passe pelo mesmo diálogo; a seguinte, que todo fim da sessão no
 * navegador (o logout e a exclusão da conta) solte as ocupações.
 */

const duble = vi.hoisted(() => {
  // O auth.logout do servidor: o que o Sair do menu global chama.
  const sairNoServidor = vi.fn();
  const ignorar = (prop: string | symbol) => typeof prop === "symbol" || prop === "then" || prop === "$$typeof";
  const procedimento = (caminho: string) => ({
    useQuery: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: () => {} }),
    useMutation: () => ({ mutate: caminho === "auth.logout" ? sairNoServidor : () => {}, mutateAsync: async () => {}, isPending: false }),
  });
  const utils = new Proxy({}, {
    get: (_, r) => ignorar(r) ? undefined : new Proxy({}, {
      get: (_, p) => ignorar(p) ? undefined : new Proxy({}, { get: (_, m) => ignorar(m) ? undefined : () => {} }),
    }),
  });
  const trpc = new Proxy({}, {
    get: (_, router) => {
      if (ignorar(router)) return undefined;
      if (router === "useUtils") return () => utils;
      return new Proxy({}, { get: (_, proc) => ignorar(proc) ? undefined : procedimento(`${String(router)}.${String(proc)}`) });
    },
  });
  return { sairNoServidor, trpc };
});

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: duble.trpc }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

// O menu (Radix) mede o conteúdo com ResizeObserver, que o jsdom não tem.
class ResizeObserverFalso { observe() {} unobserve() {} disconnect() {} }

// O logout do useAuth, que o painel administrativo chama.
let sairDoUseAuth: ReturnType<typeof vi.fn>;
function sessaoDe(role: string) {
  sairDoUseAuth = vi.fn();
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 1, name: "Glenda", role },
    loading: false, error: null, isAuthenticated: true, refresh: vi.fn(), logout: sairDoUseAuth,
  } as unknown as ReturnType<typeof useAuth>);
}

// O registro da sessão ocupada é um só no app: cada teste libera o que abriu.
const abertas: Array<() => void> = [];
function ocupada(motivo: MotivoDaOcupacao) {
  abertas.push(ocupar(motivo));
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverFalso);
  sessaoDe("silver");
  expect(sessaoOcupada()).toBe(false);
});

afterEach(async () => {
  for (const liberar of abertas.splice(0)) liberar();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("pt-BR");
});

const TEXTO_DO_MOTIVO: Record<MotivoDaOcupacao, string> = {
  gravando: "Há uma gravação em andamento nesta aba.",
  enviando: "Um áudio desta aba ainda está sendo enviado.",
  "audio-nao-enviado": "Há um áudio gravado nesta aba que ainda não foi enviado.",
};
const PERDE = "Se sair agora, esse áudio se perde.";

const dialogo = () => screen.queryByRole("alertdialog");
const continuarAqui = () => screen.getByRole("button", { name: "Continuar aqui" });
const sairMesmoAssim = () => screen.getByRole("button", { name: "Sair mesmo assim" });

/** Um botão de Sair qualquer, ligado ao hook como as telas ligam. */
function BotaoDeSair({ sair }: { sair: () => void }) {
  const { pedirSaida, dialogo } = useSairDaConta(sair);
  return <><button onClick={pedirSaida}>Sair da conta</button>{dialogo}</>;
}

describe("useSairDaConta — o diálogo antes do logout", () => {
  it("com a sessão livre, sai direto: o logout na hora e nenhum diálogo", () => {
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    expect(sair).toHaveBeenCalledTimes(1);
    expect(dialogo()).not.toBeInTheDocument();
  });

  it.each(["gravando", "enviando", "audio-nao-enviado"] as const)("ocupada (%s): o diálogo diz o motivo e que o áudio se perde, e o logout não sai", async motivo => {
    ocupada(motivo);
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));

    expect(sair).not.toHaveBeenCalled();
    expect(dialogo()).toBeInTheDocument();
    const caixa = screen.getByRole("alertdialog", { name: "Sair agora?" });
    expect(caixa).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO[motivo]} ${PERDE}`);
    // "Continuar aqui" é o padrão: o foco já está nele (Enter fica).
    await waitFor(() => expect(continuarAqui()).toHaveFocus());
  });

  it("com vários motivos, fala do principal: a gravação vem antes do áudio por enviar", () => {
    ocupada("audio-nao-enviado");
    ocupada("gravando");
    render(<BotaoDeSair sair={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO.gravando} ${PERDE}`);
  });

  it("aberto, o texto acompanha a sessão: a gravação que para sozinha vira áudio por enviar", () => {
    const liberarGravacao = ocupar("gravando");
    abertas.push(liberarGravacao);
    render(<BotaoDeSair sair={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO.gravando} ${PERDE}`);
    // O limite de tempo fecha o arquivo com o diálogo aberto: o áudio fica na tela, por enviar.
    act(() => {
      ocupada("audio-nao-enviado");
      liberarGravacao();
    });
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO["audio-nao-enviado"]} ${PERDE}`);
  });

  it("a sessão que desocupa com o diálogo aberto: o texto do clique fica, e nada sai sozinho", () => {
    const liberarEnvio = ocupar("enviando");
    abertas.push(liberarEnvio);
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    // O envio termina com o diálogo na tela.
    act(() => liberarEnvio());
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO.enviando} ${PERDE}`);
    expect(sair).not.toHaveBeenCalled();
    fireEvent.click(sairMesmoAssim());
    expect(sair).toHaveBeenCalledTimes(1);
  });

  it("'Continuar aqui' fecha sem sair, e o Esc também", () => {
    ocupada("gravando");
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    fireEvent.click(continuarAqui());
    expect(dialogo()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    expect(dialogo()).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(dialogo()).not.toBeInTheDocument();
    expect(sair).not.toHaveBeenCalled();
  });

  it("'Sair mesmo assim' chama o logout uma vez e fecha o diálogo", () => {
    ocupada("enviando");
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    fireEvent.click(sairMesmoAssim());
    expect(sair).toHaveBeenCalledTimes(1);
    expect(dialogo()).not.toBeInTheDocument();
  });

  it("a sessão que desocupa com o diálogo fechado volta a sair direto", () => {
    const sair = vi.fn();
    render(<BotaoDeSair sair={sair} />);
    ocupada("gravando");
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    fireEvent.click(continuarAqui());
    for (const liberar of abertas.splice(0)) liberar();
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    expect(sair).toHaveBeenCalledTimes(1);
    expect(dialogo()).not.toBeInTheDocument();
  });

  it("o diálogo sai no idioma da tela", async () => {
    await i18n.changeLanguage("en");
    ocupada("audio-nao-enviado");
    render(<BotaoDeSair sair={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sair da conta" }));
    const caixa = screen.getByRole("alertdialog", { name: "Sign out now?" });
    expect(caixa).toHaveAccessibleDescription("This tab has recorded audio that hasn't been sent yet. If you sign out now, that audio will be lost.");
    expect(screen.getByRole("button", { name: "Stay here" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out anyway" })).toBeInTheDocument();
  });
});

describe("o Sair do menu global (cabeçalho de toda tela logada)", () => {
  async function clicarEmSair() {
    fireEvent.keyDown(screen.getByRole("button", { name: /menu/i }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sair" }));
  }

  it("livre: o auth.logout sai na hora, sem diálogo", async () => {
    render(<GlobalMenu />);
    await clicarEmSair();
    expect(duble.sairNoServidor).toHaveBeenCalledTimes(1);
    expect(dialogo()).not.toBeInTheDocument();
  });

  it("gravando: o diálogo abre com o foco em 'Continuar aqui', que fecha sem sair", async () => {
    ocupada("gravando");
    render(<GlobalMenu />);
    await clicarEmSair();
    expect(duble.sairNoServidor).not.toHaveBeenCalled();
    expect(dialogo()).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Sair agora?" })).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO.gravando} ${PERDE}`);
    // O menu fechou e devolveria o foco ao botão dele: o diálogo o segura.
    await waitFor(() => expect(continuarAqui()).toHaveFocus());
    fireEvent.click(continuarAqui());
    expect(dialogo()).not.toBeInTheDocument();
    expect(duble.sairNoServidor).not.toHaveBeenCalled();
    // O menu e o diálogo travam o toque fora deles (pointer-events no body); um
    // aberto por cima do outro não pode deixar a tela travada depois de fechar.
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("gravando: só 'Sair mesmo assim' chama o auth.logout", async () => {
    ocupada("gravando");
    render(<GlobalMenu />);
    await clicarEmSair();
    expect(duble.sairNoServidor).not.toHaveBeenCalled();
    fireEvent.click(sairMesmoAssim());
    expect(duble.sairNoServidor).toHaveBeenCalledTimes(1);
    expect(dialogo()).not.toBeInTheDocument();
  });
});

describe("o Sair do painel administrativo (pt-BR fixo, diálogo traduzido)", () => {
  beforeEach(() => {
    sessaoDe("admin");
    window.history.replaceState(null, "", "/admin");
  });

  it("livre: sai na hora e volta ao início, sem diálogo", () => {
    render(<AdminPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(sairDoUseAuth).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/");
    expect(dialogo()).not.toBeInTheDocument();
  });

  it("com o envio no ar: 'Continuar aqui' não sai; 'Sair mesmo assim' sai e volta ao início", async () => {
    ocupada("enviando");
    render(<AdminPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(sairDoUseAuth).not.toHaveBeenCalled();
    expect(dialogo()).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Sair agora?" })).toHaveAccessibleDescription(`${TEXTO_DO_MOTIVO.enviando} ${PERDE}`);
    await waitFor(() => expect(continuarAqui()).toHaveFocus());
    fireEvent.click(continuarAqui());
    expect(sairDoUseAuth).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/admin");

    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    fireEvent.click(sairMesmoAssim());
    expect(sairDoUseAuth).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/");
  });

  it("em inglês, o painel segue em pt-BR e o diálogo sai traduzido", async () => {
    await i18n.changeLanguage("en");
    ocupada("gravando");
    render(<AdminPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(sairDoUseAuth).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog", { name: "Sign out now?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stay here" })).toBeInTheDocument();
  });
});

// As guardas de texto do fim deste arquivo leem o código do client, sem os
// testes e sem os JSON das línguas.
const RAIZ = join(process.cwd(), "client", "src");

function arquivos(dir: string, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome !== "locales") arquivos(caminho, achados);
    } else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) {
      achados.push(caminho);
    }
  }
  return achados;
}

const doClient = (caminho: string) => relative(RAIZ, caminho).split(sep).join("/");

/**
 * Guarda de texto, como a de App.cabecalho-de-todas-as-telas.test.ts: todo
 * arquivo do client que pode tirar a sessão (a mutation auth.logout ou o
 * logout do useAuth, chamado ou passado sem chamar) chama o useSairDaConta.
 * Limites conhecidos: a leitura é do arquivo, não do React; ela não prova que
 * TODO botão do arquivo passa pelo diálogo, e sim que nenhuma tela nova de Sair
 * nasce sem ele. E o objeto do useAuth guardado numa variável e desestruturado
 * depois (`const a = useAuth(); const { logout } = a`) escapa. Os testes acima
 * provam os dois lugares que existem hoje.
 */
describe("guarda: toda saída da conta passa pelo diálogo", () => {
  // O useAuth define o logout; o diálogo é de quem desenha o botão.
  const SEM_DIALOGO_DE_PROPOSITO = ["_core/hooks/useAuth.ts"];
  // Qualquer `.logout` (a mutation, o do useAuth chamado ou passado a um
  // onClick), menos a chave de tradução entre aspas; e o logout desestruturado
  // do useAuth.
  const SAI_DA_CONTA = [/\.logout\b(?!["'`])/, /\{[^}]*\blogout\b[^}]*\}\s*=\s*useAuth\(/];

  it("quem pode sair da conta chama o useSairDaConta e desenha o diálogo dele", () => {
    const quemSai = arquivos(RAIZ)
      .filter(caminho => SAI_DA_CONTA.some(padrao => padrao.test(readFileSync(caminho, "utf8"))))
      .map(doClient);
    // A guarda não é vazia: os dois lugares de hoje estão na lista.
    expect(quemSai).toEqual(expect.arrayContaining(["components/AppHeader.tsx", "pages/AdminPanel.tsx", "_core/hooks/useAuth.ts"]));
    // O Dashboard sai pelo menu global: não tem logout próprio.
    expect(quemSai).not.toContain("pages/Dashboard.tsx");
    for (const arquivo of quemSai.filter(a => !SEM_DIALOGO_DE_PROPOSITO.includes(a))) {
      const fonte = readFileSync(join(RAIZ, arquivo), "utf8");
      expect(fonte, arquivo).toMatch(/\buseSairDaConta\(/);
      // E desenha o diálogo que o hook devolve: sem ele, o Sair ocupado não faria nada.
      expect(fonte, arquivo).toMatch(/\{\s*\w+\.dialogo\s*\}/);
    }
  });

  it("os padrões pegam o logout chamado, o passado sem chamar e o da mutation, e não a chave de tradução", () => {
    const sai = (codigo: string) => SAI_DA_CONTA.some(padrao => padrao.test(codigo));
    for (const codigo of [
      "const sair = trpc.auth.logout.useMutation({",
      "const { user, logout } = useAuth();",
      "const auth = useAuth(); return <button onClick={auth.logout}>Sair</button>;",
      "const sair = useAuth().logout;",
      "utils.client.auth.logout.mutate()",
      "await auth.logout();",
    ]) expect(sai(codigo), codigo).toBe(true);
    expect(sai('<span>{t("dashboard.logout")}</span>')).toBe(false);
  });
});

/**
 * Guarda irmã da de cima: todo arquivo do client que encerra a sessão no
 * navegador (zera o auth.me no cache) também solta as ocupações
 * (liberarTodas). Sem isso, o envio avulso que segue no ar deixa a aba já
 * deslogada ocupada, e o navegador pergunta ao fechá-la ou no próximo login
 * nela: foi o que a exclusão da conta fazia. Não exige o diálogo do Sair, que a
 * exclusão dispensa por ter a confirmação dela. Os limites são os da guarda de
 * cima: ela lê o arquivo, não o React.
 */
describe("guarda: todo fim da sessão no navegador solta as ocupações", () => {
  const ZERA_A_SESSAO = /\bauth\.me\.setData\(\s*undefined\s*,\s*null\s*\)/;

  it("quem zera o auth.me no cache chama o liberarTodas", () => {
    const quemZera = arquivos(RAIZ)
      .filter(caminho => ZERA_A_SESSAO.test(readFileSync(caminho, "utf8")))
      .map(doClient);
    // A guarda não é vazia: os dois de hoje, o logout do useAuth e a exclusão da conta.
    expect(quemZera).toEqual(expect.arrayContaining(["_core/hooks/useAuth.ts", "components/ExcluirMinhaConta.tsx"]));
    for (const arquivo of quemZera) {
      expect(readFileSync(join(RAIZ, arquivo), "utf8"), arquivo).toMatch(/\bliberarTodas\(\)/);
    }
  });

  it("o padrão pega o cache zerado, e não a atualização do usuário que segue logado", () => {
    expect(ZERA_A_SESSAO.test("utils.auth.me.setData(undefined, null);")).toBe(true);
    // O fim do cadastro (Onboarding) atualiza o usuário no cache sem tirar a sessão.
    expect(ZERA_A_SESSAO.test("utils.auth.me.setData(undefined, atual => (atual ? { ...atual, onboardingCompleted: true } : atual));")).toBe(false);
  });
});
