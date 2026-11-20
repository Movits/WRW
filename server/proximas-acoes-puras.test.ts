import { describe, expect, it } from "vitest";
import { NOME_DO_FALANTE_MAX } from "@shared/const";
import {
  hojeNoRelogio,
  palavrasDoNome,
  prazoValido,
  situacaoDoPrazo,
  sugerirContatoPeloNome,
  TEXTO_DA_ACAO_MAX,
  viraProximaAcao,
} from "@shared/proximas-acoes";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

const { camposDaAcaoDoItem, textosComNomes } = await import("./proximas-acoes");
const { conferirResumo } = await import("./resumo-da-reuniao");

/**
 * As funções puras das próximas ações (H5a), que o servidor e a tela dividem
 * (shared/proximas-acoes.ts), e as do servidor que não tocam o banco.
 */

const REDE = [
  { id: 1, fullName: "Ana Paula Souza" },
  { id: 2, fullName: "Carla Mendes" },
  { id: 3, fullName: "José da Silva" },
  { id: 4, fullName: "Bia Lima" },
  { id: 5, fullName: "Bia Torres" },
  { id: 6, fullName: "Ana Souza" },
];

describe("sugerirContatoPeloNome: só quando a resposta é uma, sem IA", () => {
  it("um nome só aponta o único contato com esse primeiro nome", () => {
    expect(sugerirContatoPeloNome("Carla", REDE)?.id).toBe(2);
    expect(sugerirContatoPeloNome("jose", REDE)?.id).toBe(3);
  });

  it("duas com o mesmo primeiro nome: nenhuma sugestão", () => {
    expect(sugerirContatoPeloNome("Bia", REDE)).toBeNull();
    expect(sugerirContatoPeloNome("Ana", REDE)).toBeNull();
  });

  it("nome e sobrenome: o primeiro nome igual e o resto dentro do nome; entre duas, a de nome inteiro igual", () => {
    expect(sugerirContatoPeloNome("Bia Torres", REDE)?.id).toBe(5);
    // "Ana Paula Souza" e "Ana Souza" têm as duas palavras; só a segunda é igual.
    expect(sugerirContatoPeloNome("Ana Souza", REDE)?.id).toBe(6);
    expect(sugerirContatoPeloNome("Ana Paula", REDE)?.id).toBe(1);
  });

  it("sem acento, sem caixa, sem partícula e sem pontuação", () => {
    expect(sugerirContatoPeloNome("JOSÉ SILVA", REDE)?.id).toBe(3);
    expect(sugerirContatoPeloNome("josé  da silva.", REDE)?.id).toBe(3);
  });

  it("o primeiro nome tem de bater: sobrenome sozinho, outra pessoa ou nada não sugerem", () => {
    expect(sugerirContatoPeloNome("Souza", REDE)).toBeNull();
    expect(sugerirContatoPeloNome("Mariana", REDE)).toBeNull();
    expect(sugerirContatoPeloNome("Carla Souza", REDE)).toBeNull();
    expect(sugerirContatoPeloNome("", REDE)).toBeNull();
    expect(sugerirContatoPeloNome(null, REDE)).toBeNull();
    expect(sugerirContatoPeloNome("A", [{ id: 9, fullName: "A" }])).toBeNull();
    expect(sugerirContatoPeloNome("Carla", [])).toBeNull();
  });

  it("outras escritas: a palavra inteira compara, e a marca da letra não sai", () => {
    expect(palavrasDoNome("Ольга Иванова")).toEqual(["ольга", "иванова"]);
    expect(sugerirContatoPeloNome("Йоко", [{ id: 1, fullName: "Иоко" }, { id: 2, fullName: "Йоко Оно" }])?.id).toBe(2);
    expect(palavrasDoNome("Maria de la Peña")).toEqual(["maria", "pena"]);
  });
});

describe("o prazo", () => {
  it("prazoValido: AAAA-MM-DD de um dia que existe, de 2000 a 2100", () => {
    expect(prazoValido("2026-11-20")).toBe(true);
    expect(prazoValido("2028-02-29")).toBe(true);
    expect(prazoValido("2026-02-29")).toBe(false);
    expect(prazoValido("2026-13-01")).toBe(false);
    expect(prazoValido("2026-1-1")).toBe(false);
    expect(prazoValido("1999-12-31")).toBe(false);
    expect(prazoValido("2101-01-01")).toBe(false);
    expect(prazoValido("2026-11-20T00:00")).toBe(false);
  });

  it("hojeNoRelogio é o dia local, com zeros", () => {
    expect(hojeNoRelogio(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("situacaoDoPrazo: atrasada, hoje ou nada; a feita e a sem prazo não se destacam", () => {
    expect(situacaoDoPrazo("2026-11-15", false, "2026-11-16")).toBe("atrasada");
    expect(situacaoDoPrazo("2026-11-16", false, "2026-11-16")).toBe("hoje");
    expect(situacaoDoPrazo("2026-11-17", false, "2026-11-16")).toBeNull();
    expect(situacaoDoPrazo("2026-11-15", true, "2026-11-16")).toBeNull();
    expect(situacaoDoPrazo(null, false, "2026-11-16")).toBeNull();
  });
});

describe("do item à ação, sem banco", () => {
  it("só ação e tarefa viram próxima ação", () => {
    expect(["action", "task", "focus", "decision", "blocker", "question"].filter(viraProximaAcao)).toEqual(["action", "task"]);
  });

  it("camposDaAcaoDoItem: a tarefa usa o assunto como texto; assunto em branco cai no texto", () => {
    const base = { text: "Paragrafo", assignee: "{F1}", due: "sexta", excerpt: "trecho" };
    expect(camposDaAcaoDoItem({ ...base, subject: "Assunto" })).toEqual({
      texto: "Assunto", detalhe: "Paragrafo", responsavel: "{F1}", prazoDito: "sexta", trecho: "trecho",
    });
    expect(camposDaAcaoDoItem({ ...base, subject: "  " })).toMatchObject({ texto: "Paragrafo", detalhe: null });
    expect(camposDaAcaoDoItem({ ...base, subject: null })).toMatchObject({ texto: "Paragrafo", detalhe: null });
  });

  it("a tarefa sem assunto mais longa que o resumo guarda cabe no texto da ação, também com os nomes das vozes no lugar dos rótulos", () => {
    // A IA mandou mais do que cabe: o resumo corta o parágrafo da tarefa em 700 letras.
    const paragrafo = `{F1} fecha o contrato com {F2} 📄 ${"x".repeat(900)}`;
    const [tarefa] = conferirResumo(
      { tarefas: [{ assunto: "", texto: paragrafo, responsavel: null, prazo: null, trecho: "fecho o contrato com você", confianca: 0.9 }] },
      { transcricao: "Eu fecho o contrato com você amanhã.", segmentos: [], rotulada: true, vozes: new Set(["F1", "F2"]) },
    );
    expect(tarefa).toMatchObject({ section: "task", subject: null });
    expect(Array.from(tarefa.text)).toHaveLength(700);
    // Sem assunto, o parágrafo inteiro é o texto da ação.
    const campos = camposDaAcaoDoItem(tarefa);
    expect(campos.texto).toBe(tarefa.text);
    // A edição devolve o texto com os nomes das vozes (a soltura também os grava), até 60 letras cada.
    const { texto } = textosComNomes(campos, { F1: "A".repeat(NOME_DO_FALANTE_MAX), F2: "B".repeat(NOME_DO_FALANTE_MAX) });
    expect(texto.length).toBeGreaterThan(700);
    expect(texto.length).toBeLessThanOrEqual(TEXTO_DA_ACAO_MAX);
  });

  it("textosComNomes: a voz com nome vira o nome; a sem nome fica rótulo; nulo fica nulo", () => {
    expect(textosComNomes({ texto: "{F1} liga para {F2}", detalhe: null, responsavel: "{F1}" }, { F1: "Ana" })).toEqual({
      texto: "Ana liga para {F2}", detalhe: null, responsavel: "Ana",
    });
  });
});
