import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * As duas páginas públicas do rodapé.
 *
 * O defeito que este arquivo guarda: /termos dizia, em texto escrito no código,
 * que os termos "estão em elaboração com a assessoria jurídica e serão
 * publicados nesta página antes da abertura ao público" — enquanto o cadastro
 * já exigia o aceite do Termo Geral de Uso do Dr. Ronei na última etapa. Quem
 * clicava no rodapé lia o contrário do que a plataforma fazia, e quem ainda não
 * tinha conta não tinha como ler o que ia aceitar.
 *
 * Agora a página mostra o documento PUBLICADO. Os testes abaixo cobrem os três
 * estados que existem de verdade: com versão vigente, sem versão publicada e
 * carregando.
 */

const duble = vi.hoisted(() => ({
  resposta: { data: undefined as unknown, isLoading: false, isError: false, refetch: () => {} },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    consent: {
      termoGeralPublico: { useQuery: () => duble.resposta },
    },
  },
}));

vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// O Streamdown é carregado por import() dentro de lazy(): no teste basta o
// texto cru, que é o mesmo fallback que a usuária vê enquanto ele baixa.
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

import { PrivacyPage, TermsPage } from "./LegalPage";

const TERMO = {
  version: 3,
  text: "# TERMO GERAL DE USO\n\n1.1. A plataforma conecta pessoas empreendedoras.\n\n☐ LI E ACEITO integralmente",
  publishedAt: "2026-09-16T00:00:00.000Z",
};

describe("página pública de Termos", () => {
  it("mostra o texto e a versão do documento vigente", async () => {
    duble.resposta = { data: TERMO, isPending: false, isLoading: false, isError: false, refetch: () => {} };

    render(<TermsPage />);

    await waitFor(() => expect(screen.getByText(/TERMO GERAL DE USO/)).toBeInTheDocument());
    expect(screen.getByText(/Vers[ãa]o 3/)).toBeInTheDocument();
    expect(screen.getByText(/A plataforma conecta pessoas empreendedoras/)).toBeInTheDocument();
  });

  it("não promete mais um termo futuro quando o termo já existe", async () => {
    duble.resposta = { data: TERMO, isPending: false, isLoading: false, isError: false, refetch: () => {} };

    render(<TermsPage />);

    await waitFor(() => expect(screen.getByText(/TERMO GERAL DE USO/)).toBeInTheDocument());
    expect(document.body.textContent ?? "").not.toMatch(/em elabora[çc][ãa]o/i);
  });

  it("tira a linha da caixa de aceite, que na tela é a caixa de verdade do cadastro", async () => {
    duble.resposta = { data: TERMO, isPending: false, isLoading: false, isError: false, refetch: () => {} };

    render(<TermsPage />);

    await waitFor(() => expect(screen.getByText(/TERMO GERAL DE USO/)).toBeInTheDocument());
    expect(document.body.textContent ?? "").not.toMatch(/LI E ACEITO/);
  });

  it("sem versão publicada, diz que não há o que mostrar em vez de inventar um texto", () => {
    duble.resposta = { data: null, isPending: false, isLoading: false, isError: false, refetch: () => {} };

    render(<TermsPage />);

    expect(screen.getByText(/ainda n[ãa]o est[áa] publicada/i)).toBeInTheDocument();
  });

  it("enquanto carrega, avisa que está buscando o termo vigente", () => {
    duble.resposta = { data: undefined, isPending: true, isLoading: true, isError: false, refetch: () => {} };

    render(<TermsPage />);

    expect(screen.getByText(/Carregando o termo vigente/i)).toBeInTheDocument();
  });

  it("com o banco fora do ar, diz que falhou — não que o termo não existe", () => {
    // Banco fora do ar é ERRO, nunca "sem dados": afirmar que o documento não
    // foi publicado, quando ele existe e a consulta é que caiu, seria mentir
    // para quem veio ler o contrato.
    duble.resposta = { data: undefined, isPending: false, isLoading: false, isError: true, refetch: () => {} };

    render(<TermsPage />);

    expect(screen.getByText(/N[ãa]o consegui carregar o termo agora/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Tentar de novo/i })).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/ainda n[ãa]o est[áa] publicada/i);
  });
});

describe("a tela entre uma tentativa e outra", () => {
  it("no intervalo entre as tentativas, continua dizendo que está carregando", () => {
    // No React Query 5, `isLoading` é `isPending && isFetching`: entre duas
    // tentativas ele fica FALSO, com os dados ainda indefinidos. A tela pisca
    // "a versão vigente ainda não está publicada" se olhar só para `isLoading`.
    // Foi o que o primeiro smoke desta tela mostrou.
    duble.resposta = { data: undefined, isPending: true, isLoading: false, isError: false, refetch: () => {} };

    render(<TermsPage />);

    expect(screen.getByText(/Carregando o termo vigente/i)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/ainda n[ãa]o est[áa] publicada/i);
  });
});

describe("página pública de Privacidade", () => {
  // Até 25/11/2026 a página dizia que a política "está sendo redigida". O Google
  // exige a política publicada para verificar o app (login com Google e Google
  // Agenda), e o Roberto decidiu publicar já o texto provisório, até a Cris
  // mandar o definitivo.

  it("não diz mais que a política está sendo redigida", () => {
    render(<PrivacyPage />);

    expect(document.body.textContent ?? "").not.toMatch(/sendo redigida/i);
  });

  it("diz no topo que é a versão provisória de 25/11/2026, em revisão jurídica", () => {
    render(<PrivacyPage />);

    expect(screen.getByText("Versão provisória de 25/11/2026, em revisão pela assessoria jurídica.")).toBeInTheDocument();
  });

  it("tem as seções principais da política", () => {
    render(<PrivacyPage />);

    const secoes = screen.getAllByRole("heading", { level: 2 }).map(h => h.textContent ?? "");
    for (const esperada of [
      /Quem trata os seus dados/,
      /Encarregado/,
      /Que dados tratamos/,
      /Intelig[êe]ncia artificial/,
      /compartilhados/,
      /Transfer[êe]ncia internacional/,
      /administra[çc][ãa]o [àa]s grava[çc][õo]es/,
      /Bases legais/,
      /quanto tempo guardamos/,
      /Seguran[çc]a/,
      /direitos/,
      /Exclus[ãa]o da conta/,
      /Cookies/,
      /Menores/,
      /Altera[çc][õo]es/,
    ]) {
      expect(secoes.some(s => esperada.test(s)), `falta a seção ${esperada}`).toBe(true);
    }
  });

  it("nomeia a controladora e o canal do Encarregado que o Termo Geral traz", () => {
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/GK Gest[ãa]o Administrativa e de Neg[óo]cios LTDA/);
    expect(texto).toContain("62.982.808/0001-79");
    expect(texto).toContain("wrw@wrwglobal.org");
  });

  it("diz os prazos que o código cumpre: áudio 30 dias, transcrição até a exclusão", () => {
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/[áa]udio[^.]*30 dias/i);
    expect(texto).toMatch(/transcri[çc][ãa]o[^.]*at[ée] voc[êe] excluir a reuni[ãa]o/i);
    expect(texto).toContain("art. 33 da LGPD");
    expect(texto).toContain("art. 18 da LGPD");
  });

  it("não promete que só a dona acessa a reunião: participantes e membras de equipe também leem", () => {
    // Achado da validação da #261: a R1b (participantes) e a R2 (equipes) leem
    // a reunião pronta, e o texto dizia "só você acessa".
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/participantes que\s+voc[êe] convida/);
    expect(texto).toMatch(/membros da equipe/);
    expect(texto).not.toMatch(/A reuni[ãa]o [ée] sua: s[óo] voc[êe] acessa/);
  });

  it("na exclusão da conta, diz o que fica e as exceções dos arquivos no armazenamento", () => {
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/consentimentos e das revoga[çc][õo]es do perfil de voz/);
    expect(texto).toMatch(/quatro tipos de registro de auditoria/);
    expect(texto).toMatch(/foto de perfil e os arquivos dos documentos de\s+oportunidade/);
    expect(texto).toMatch(/aceites dos termos/);
  });

  it("não condiciona o acesso Ouro a um termo que pode não estar vigente", () => {
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).not.toMatch(/com o seu consentimento ao termo do Smart Match/);
    expect(texto).toMatch(/Quando o\s+termo de acesso Ouro estiver publicado/);
  });

  it("cobre a cópia do áudio no aparelho e os escopos openid e email da conexão da Agenda", () => {
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/C[óo]pia do [áa]udio no seu aparelho/);
    expect(texto).toMatch(/A conex[ãa]o tamb[ée]m pede o identificador e o e-mail/);
    expect(texto).toMatch(/sala de negocia[çc][ãa]o/);
  });

  it("usa o nome visível Marquesa Global Match, e não os antigos", () => {
    render(<PrivacyPage />);

    const texto = document.body.textContent ?? "";
    expect(texto).toMatch(/Marquesa Global Match/);
    expect(texto).not.toMatch(/MarquesaMatch|\bWRW\b|Mulheres que Movem/);
  });

  it("continua apontando para o Termo Geral", () => {
    render(<PrivacyPage />);

    expect(screen.getByText(/Termo Geral de Uso, Prote[çc][ãa]o de Dados e Intermedia[çc][ãa]o Digital/)).toBeInTheDocument();
  });
});
