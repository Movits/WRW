import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { CLASSE_DA_IMPRESSAO, DocumentoDaReuniao, ImpressaoDaReuniao, type ReuniaoExportada } from "./ImpressaoDaReuniao";

/**
 * O documento do PDF da reunião (H8), que a tela de impressão do aparelho
 * transforma em PDF. Os rótulos saem no idioma da REUNIÃO, com o `t` fixo
 * nele: em pt-BR e em árabe (da direita para a esquerda), com a tela em
 * pt-BR nos dois casos. Que só os itens confirmados chegam aqui é regra do
 * servidor (server/exportar-reuniao.integracao.test.ts); aqui, o que chega é
 * o que sai, e seção sem item não aparece.
 */

// Meio-dia em UTC: o mesmo dia 16 nos fusos de -11 a +11 (o CI roda em UTC).
const CRIADA = Date.UTC(2026, 10, 16, 12, 0);
const REUNIAO: ReuniaoExportada = {
  titulo: "Reunião com a importadora",
  emoji: "🤝",
  criadaEm: CRIADA,
  idioma: "pt-BR",
  duracaoSegundos: 3725,
  nomes: { F1: "Ana" },
  itens: [
    { secao: "action", assunto: null, texto: "{F2} manda a proposta", responsavel: "{F2}", prazo: "sexta-feira", feita: true },
    { secao: "action", assunto: null, texto: "{F1} revisa o contrato", responsavel: "{F1}", prazo: null, feita: false },
    { secao: "task", assunto: "Contrato com {F1}", texto: "Revisar as cláusulas", responsavel: null, prazo: "até dezembro", feita: false },
    { secao: "decision", assunto: null, texto: "A entrega fica para dezembro", responsavel: null, prazo: null, feita: false },
  ],
  transcricao: {
    editada: false,
    texto: null,
    falas: [
      { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia." },
      { inicio: 4, fim: 60, falante: "", texto: "", lacuna: true },
      { inicio: 3600, fim: 3725, falante: "F2", texto: "Fechamos na sexta." },
    ],
  },
  exportadaEm: CRIADA + 3_600_000,
};

function documento(reuniao: ReuniaoExportada = REUNIAO) {
  const { container } = render(<DocumentoDaReuniao reuniao={reuniao} t={i18n.getFixedT(reuniao.idioma)}/>);
  return container.querySelector("article")!;
}
const titulos = (nivel: number) => screen.getAllByRole("heading", { level: nivel }).map(titulo => titulo.textContent);

describe("O PDF da reunião em pt-BR", () => {
  it("o título com o emoji, a data por extenso e a duração; o documento declara o idioma e a direção", () => {
    const artigo = documento();
    expect(artigo).toHaveAttribute("lang", "pt-BR");
    expect(artigo).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("🤝Reunião com a importadora");
    expect(artigo).toHaveTextContent("16 de novembro de 2026");
    expect(artigo).toHaveTextContent("Duração: 1:02:05");
  });

  it("o resumo, só com as seções que têm item, na ordem do formato; a transcrição depois", () => {
    documento();
    expect(titulos(2)).toEqual(["Resumo da reunião", "Transcrição"]);
    expect(titulos(3)).toEqual(["Ações", "Tarefas e arranjos de trabalho", "Decisões e mudanças de escopo"]);
  });

  it("cada item com os nomes das vozes, o responsável, o prazo e a caixa da ação; a feita leva a marca", () => {
    const artigo = documento();
    const itens = within(artigo).getAllByRole("listitem").slice(0, 4);
    expect(itens[0]).toHaveTextContent("✓Falante 2 manda a proposta (feita)Responsável: Falante 2 · Prazo: sexta-feira");
    expect(itens[1]).toHaveTextContent("Ana revisa o contratoResponsável: Ana");
    expect(itens[1]).not.toHaveTextContent("(feita)");
    expect(itens[2]).toHaveTextContent("Contrato com Ana: Revisar as cláusulasPrazo: até dezembro");
    expect(itens[3]).toHaveTextContent("A entrega fica para dezembro");
    // Só as ações têm a caixa de marcar; marcada só a feita.
    const caixas = artigo.querySelectorAll(".documento-da-reuniao__caixa");
    expect(Array.from(caixas, caixa => caixa.textContent)).toEqual(["✓", ""]);
    // Nada do que a tela mostra para conferir.
    expect(artigo).not.toHaveTextContent("Para conferir");
    expect(artigo).not.toHaveTextContent("{F");
  });

  it("as falas com o tempo e o nome da voz (ou Falante n), e o trecho que não chegou", () => {
    const artigo = documento();
    const falas = within(artigo).getAllByRole("listitem").slice(4);
    expect(falas[0]).toHaveTextContent("00:00AnaBom dia.");
    expect(falas[1]).toHaveTextContent("00:04–01:00 · trecho não recebido");
    expect(falas[2]).toHaveTextContent("1:00:00Falante 2Fechamos na sexta.");
    // O tempo é sempre da esquerda para a direita.
    expect(within(falas[2]).getByText("1:00:00")).toHaveAttribute("dir", "ltr");
  });

  it("o rodapé diz de onde e quando o PDF saiu", () => {
    expect(documento()).toHaveTextContent("Exportado da MarquesaMatch em 16 de novembro de 2026");
  });

  it("sem item confirmado, o resumo não aparece; a transcrição sem falas sai como texto corrido", () => {
    const artigo = documento({ ...REUNIAO, itens: [], transcricao: { texto: "Linha um.\nLinha dois.", falas: [] } });
    expect(titulos(2)).toEqual(["Transcrição"]);
    expect(artigo.querySelector(".documento-da-reuniao__texto-corrido")?.textContent).toBe("Linha um.\nLinha dois.");
  });

  it("a transcrição que a dona editou (H18) sai com a marca de revisada; a que não foi editada, sem ela", () => {
    const editada = documento({ ...REUNIAO, transcricao: { ...REUNIAO.transcricao!, editada: true } });
    expect(editada).toHaveTextContent("Transcrição revisada por quem gravou a reunião.");
    cleanup();
    const daIA = documento({ ...REUNIAO, transcricao: { ...REUNIAO.transcricao!, editada: false } });
    expect(daIA).not.toHaveTextContent("revisada");
  });

  it("sem transcrição, o aviso de que ela não está disponível; sem emoji e sem duração, só o título e a data", () => {
    const artigo = documento({ ...REUNIAO, emoji: null, duracaoSegundos: null, transcricao: null });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Reunião com a importadora");
    expect(artigo).not.toHaveTextContent("Duração");
    expect(artigo).toHaveTextContent("A transcrição ainda não está disponível.");
  });
});

describe("O PDF da reunião em árabe, com a tela em pt-BR", () => {
  const EM_ARABE: ReuniaoExportada = { ...REUNIAO, idioma: "ar", titulo: "اجتماع مع المستورد", nomes: {} };

  it("o documento é da direita para a esquerda, em árabe, e os rótulos saem em árabe", () => {
    const artigo = documento(EM_ARABE);
    expect(artigo).toHaveAttribute("lang", "ar");
    expect(artigo).toHaveAttribute("dir", "rtl");
    expect(titulos(2)).toEqual(["ملخص الاجتماع", "النص المكتوب"]);
    expect(titulos(3)).toEqual(["الإجراءات", "المهام وترتيبات العمل", "القرارات وتغييرات النطاق"]);
    expect(artigo).toHaveTextContent("المسؤول: المتحدث 2");
    expect(artigo).toHaveTextContent("الموعد النهائي: sexta-feira");
    expect(artigo).toHaveTextContent("(منجزة)");
    // Nada do pt-BR da tela entra no documento.
    for (const emPortugues of ["Resumo da reunião", "Transcrição", "Responsável", "Falante", "(feita)", "Exportado"]) {
      expect(artigo).not.toHaveTextContent(emPortugues);
    }
  });

  it("as vozes em árabe, o tempo da esquerda para a direita, a data e o rodapé no calendário do árabe", () => {
    const artigo = documento(EM_ARABE);
    const falas = within(artigo).getAllByRole("listitem").slice(4);
    expect(falas[0]).toHaveTextContent("المتحدث 1");
    expect(within(falas[0]).getByText("00:00")).toHaveAttribute("dir", "ltr");
    expect(falas[1]).toHaveTextContent("مقطع لم يُستلم");
    expect(artigo.querySelector("header")).toHaveTextContent("نوفمبر");
    expect(artigo.querySelector("footer")).toHaveTextContent(/^تم التصدير من MarquesaMatch في .*نوفمبر/);
  });
});

describe("O portal da impressão", () => {
  it("fica no fim do <body>, fora da página, e o body ganha a classe que mostra só ele na impressão", () => {
    const { container, unmount } = render(<ImpressaoDaReuniao reuniao={REUNIAO} t={i18n.getFixedT("pt-BR")}/>);
    const portal = document.body.querySelector(":scope > .impressao-da-reuniao");
    expect(portal).not.toBeNull();
    expect(container.contains(portal)).toBe(false);
    expect(portal!.querySelector("article")).toHaveAttribute("lang", "pt-BR");
    expect(document.body).toHaveClass(CLASSE_DA_IMPRESSAO);
    unmount();
    expect(document.body.querySelector(".impressao-da-reuniao")).toBeNull();
    expect(document.body).not.toHaveClass(CLASSE_DA_IMPRESSAO);
  });
});
