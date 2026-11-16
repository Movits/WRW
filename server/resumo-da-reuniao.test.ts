import { beforeEach, describe, expect, it, vi } from "vitest";
import { FALAS_DA_REUNIAO_SINTETICA, TRANSCRICAO_DA_REUNIAO_SINTETICA } from "./test/reuniao-sintetica";
import type { Segmento } from "./transcricao-de-fatia";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O resumo guardado da reunião (H4), com a IA dublada. Prova:
 *
 * - o prompt pede o idioma da reunião e leva as falas com o rótulo da voz,
 *   nunca um nome que a dona deu (ele nem chega aqui);
 * - item com trecho inventado sai; negação fica; rótulo copiado no trecho não
 *   derruba o item;
 * - o rótulo do responsável fica se a voz fala perto do trecho, o nome se foi
 *   dito na reunião, e o prazo se foi dito perto do trecho; voz que não existe
 *   derruba o item; no envio único, sem falas, rótulo de voz também;
 * - com a reunião sintética da bancada de 16/11 (server/test/reuniao-sintetica.ts):
 *   o nome dito só na abertura, as formas do mesmo prazo, o responsável
 *   composto, as 7 ações e o "[...]" que emendava falas distantes;
 * - e o que a revisão da IA2 pediu: o ordinal ("a segunda possibilidade") não
 *   sustenta o dia da semana; a conjunção depois da vírgula e o "و" colado do
 *   árabe separam pessoas; os pedaços num turno só ficam inteiros; e
 *   responsável e prazo saem da mesma vez em que a frase foi dita;
 * - reunião longa vai em janelas e uma junção, e nada é cortado em silêncio;
 * - resposta cortada, JSON inválido e IA fora do ar viram FalhaDaIA com o código.
 */

const invokeLLM = vi.fn();
vi.mock("./_core/llm", () => ({ invokeLLM: (...args: unknown[]) => invokeLLM(...args) }));
vi.mock("./db", () => ({ getDb: async () => null, exigirDb: async () => { throw new Error("o resumo não lê o banco"); } }));

const { gerarResumoDaReuniao, entradaDoResumo } = await import("./resumo-da-reuniao");
const { FalhaDaIA } = await import("./ia-em-json");

const FALAS: Segmento[] = [
  { inicio: 0, fim: 6, falante: "F1", texto: "Bom dia. O Roberto vai cuidar da publicação nas lojas até sexta-feira." },
  { inicio: 6, fim: 14, falante: "F2", texto: "Certo. O contêiner sai do porto de Santos no dia 12 de março." },
  { inicio: 14, fim: 21, falante: "F1", texto: "Então a Carla fecha o contrato com o importador até sexta-feira." },
  { inicio: 21, fim: 30, falante: "", texto: "", lacuna: true },
  { inicio: 30, fim: 37, falante: "F3", texto: "Decidimos não renovar o contrato com a transportadora antiga." },
  { inicio: 37, fim: 42, falante: "F2", texto: "Falta ver o seguro da carga com a corretora." },
  { inicio: 42, fim: 48, falante: "F3", texto: "Vamos falar das feiras do ano que vem." },
  { inicio: 48, fim: 55, falante: "F3", texto: "A feira de Colônia é em fevereiro." },
  { inicio: 55, fim: 61, falante: "F3", texto: "Ainda não sabemos quem vai representar a empresa." },
  { inicio: 61, fim: 70, falante: "F2", texto: "Eu preparo a planilha de custos do frete para a próxima reunião." },
];
const TEXTO = FALAS.filter(f => !f.lacuna).map(f => f.texto).join("\n");
const ENTRADA = { transcricao: TEXTO, segmentos: FALAS, idioma: "pt-BR" as const };

const VAZIO = { emoji: null, acoes: [], foco: { texto: "", trecho: "", confianca: 0 }, tarefas: [], decisoes: [], bloqueios: [], questoes: [] };
const resposta = (dados: unknown, finish_reason = "stop") => ({ model: "gemini-teste-1", choices: [{ message: { content: JSON.stringify(dados) }, finish_reason }] });
const pedido = (i = 0) => invokeLLM.mock.calls[i][0] as { messages: Array<{ role: string; content: string }>; response_format: { json_schema: { strict: boolean } } };

beforeEach(() => {
  invokeLLM.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("o que vai à IA", () => {
  it("as falas com o rótulo da voz, juntando falas seguidas da mesma voz e sem a lacuna", () => {
    const { texto, rotulada } = entradaDoResumo(TEXTO, [
      { inicio: 0, fim: 2, falante: "F1", texto: "Bom dia." },
      { inicio: 2, fim: 4, falante: "F1", texto: "Vamos começar." },
      { inicio: 4, fim: 9, falante: "", texto: "", lacuna: true },
      { inicio: 9, fim: 12, falante: "F2", texto: "Pode falar." },
    ]);
    expect(rotulada).toBe(true);
    expect(texto).toBe("{F1}: Bom dia. Vamos começar.\n{F2}: Pode falar.");
  });

  it("sem falas (envio único), o texto corrido, sem rótulo", () => {
    expect(entradaDoResumo("Bom dia a todos.", [])).toEqual({ texto: "Bom dia a todos.", rotulada: false });
  });

  it("o prompt pede o idioma da reunião, o formato e o JSON strict; a transcrição vai inteira", async () => {
    invokeLLM.mockResolvedValue(resposta(VAZIO));
    await gerarResumoDaReuniao({ ...ENTRADA, idioma: "en" });
    const [sistema, usuario] = pedido().messages;
    expect(sistema.content).toContain("Escreva todo o texto em inglês");
    expect(sistema.content).toContain("{F2}");
    expect(usuario.content).toContain("{F3}: Decidimos não renovar o contrato com a transportadora antiga.");
    expect(usuario.content).toContain("Eu preparo a planilha de custos do frete");
    expect(pedido().response_format.json_schema.strict).toBe(true);
  });

  it("transcrição vazia não chama a IA", async () => {
    expect(await gerarResumoDaReuniao({ transcricao: "  ", segmentos: [], idioma: "pt-BR" })).toEqual({ emoji: null, modelo: null, itens: [], recebidos: 0 });
    expect(invokeLLM).not.toHaveBeenCalled();
  });
});

describe("a conferência de cada item", () => {
  it("guarda o item sustentado, com a seção, o tempo do trecho, a confiança e o emoji; o modelo vem da resposta", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      emoji: "📱",
      acoes: [{ texto: "Fechar o contrato com o importador", responsavel: "Carla", prazo: "até sexta-feira", trecho: "a Carla fecha o contrato com o importador até sexta-feira", confianca: 0.9 }],
      decisoes: [{ texto: "Não renovar com a transportadora antiga", trecho: "{F3}: Decidimos não renovar o contrato com a transportadora antiga", confianca: 1.7 }],
    }));
    const resumo = await gerarResumoDaReuniao(ENTRADA);
    expect(resumo.emoji).toBe("📱");
    expect(resumo.modelo).toBe("gemini-teste-1");
    expect(resumo.itens).toEqual([
      { section: "action", subject: null, text: "Fechar o contrato com o importador", assignee: "Carla", due: "até sexta-feira", excerpt: "a Carla fecha o contrato com o importador até sexta-feira", startSeconds: 14, confidence: 0.9 },
      // Negação fica; o rótulo copiado sai do trecho; a confiança vai a 1.
      { section: "decision", subject: null, text: "Não renovar com a transportadora antiga", assignee: null, due: null, excerpt: "Decidimos não renovar o contrato com a transportadora antiga", startSeconds: 30, confidence: 1 },
    ]);
  });

  it("trecho inventado derruba o item", async () => {
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, decisoes: [{ texto: "Renovar com a transportadora", trecho: "Decidimos renovar o contrato com a transportadora antiga", confianca: 0.9 }] }));
    expect((await gerarResumoDaReuniao(ENTRADA)).itens).toEqual([]);
  });

  it("o rótulo fica se a voz fala perto do trecho; o prazo, se foi dito perto; o nome, se foi dito na reunião", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      acoes: [
        // O Roberto e a sexta-feira foram ditos na 1ª fala, longe da planilha:
        // o nome dito na reunião fica; o prazo, não.
        { texto: "Preparar a planilha de custos do frete", responsavel: "Roberto", prazo: "até sexta-feira", trecho: "Eu preparo a planilha de custos do frete", confianca: 0.8 },
        // Quem fala no trecho é a voz F2: o rótulo dela fica.
        { texto: "Ver o seguro da carga", responsavel: "{F2}", prazo: null, trecho: "Falta ver o seguro da carga com a corretora", confianca: 0.8 },
        // A F1 não fala perto da planilha (só na 1ª e na 3ª fala).
        { texto: "Levar a planilha à próxima reunião", responsavel: "{F1}", prazo: "na próxima reunião", trecho: "planilha de custos do frete para a próxima reunião", confianca: 0.8 },
        // Ninguém disse "Joana" na reunião.
        { texto: "Cotar o seguro", responsavel: "Joana", prazo: null, trecho: "Falta ver o seguro da carga com a corretora", confianca: 0.8 },
      ],
    }));
    const [planilha, seguro, levar, cotar] = (await gerarResumoDaReuniao(ENTRADA)).itens;
    expect(planilha).toMatchObject({ assignee: "Roberto", due: null });
    expect(seguro).toMatchObject({ assignee: "{F2}", due: null });
    expect(levar).toMatchObject({ assignee: null, due: "na próxima reunião" });
    expect(cotar).toMatchObject({ assignee: null });
  });

  it("o nome do responsável fica só com as palavras ditas na reunião", async () => {
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, acoes: [{ texto: "Fechar o contrato", responsavel: "Carla Mendes", prazo: null, trecho: "a Carla fecha o contrato com o importador", confianca: 0.9 }] }));
    expect((await gerarResumoDaReuniao(ENTRADA)).itens[0].assignee).toBe("Carla");
  });

  it("voz que não existe na reunião derruba o item", async () => {
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, questoes: [{ texto: "{F9} vai representar a empresa?", trecho: "Ainda não sabemos quem vai representar a empresa", confianca: 0.7 }] }));
    expect((await gerarResumoDaReuniao(ENTRADA)).itens).toEqual([]);
  });

  it("voz que existe fica no texto, como rótulo, para a tela trocar pelo nome", async () => {
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, tarefas: [{ assunto: "Frete", texto: "{F2} prepara a planilha de custos do frete.", responsavel: "{F2}", prazo: null, trecho: "Eu preparo a planilha de custos do frete", confianca: 0.8 }] }));
    expect((await gerarResumoDaReuniao(ENTRADA)).itens).toEqual([
      expect.objectContaining({ section: "task", subject: "Frete", text: "{F2} prepara a planilha de custos do frete.", assignee: "{F2}", startSeconds: 61 }),
    ]);
  });

  it("no envio único (sem falas), rótulo de voz derruba o item e não há tempo", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      decisoes: [
        { texto: "{F1} decidiu não renovar", trecho: "Decidimos não renovar o contrato", confianca: 0.9 },
        { texto: "Não renovar o contrato", trecho: "Decidimos não renovar o contrato", confianca: 0.9 },
      ],
    }));
    const { itens } = await gerarResumoDaReuniao({ transcricao: TEXTO, segmentos: [], idioma: "pt-BR" });
    expect(itens).toEqual([expect.objectContaining({ text: "Não renovar o contrato", startSeconds: null })]);
    expect(pedido().messages[0].content).toContain("não use rótulos de voz");
  });

  it("aplica o teto da seção e tira os repetidos", async () => {
    const acao = (n: number) => ({ texto: `Ação ${n}`, responsavel: null, prazo: null, trecho: "O contêiner sai do porto de Santos", confianca: 0.5 });
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, acoes: [acao(1), acao(1), ...[2, 3, 4, 5, 6, 7, 8, 9].map(acao)] }));
    const { itens } = await gerarResumoDaReuniao(ENTRADA);
    expect(itens.map(i => i.text)).toEqual(["Ação 1", "Ação 2", "Ação 3", "Ação 4", "Ação 5", "Ação 6", "Ação 7"]);
  });

  it("emoji que não é um emoji sai", async () => {
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, emoji: "reunião" }));
    expect((await gerarResumoDaReuniao(ENTRADA)).emoji).toBeNull();
  });
});

describe("reunião longa", () => {
  it("acima do limite, um resumo por janela e uma junção; a conferência é contra a transcrição inteira", async () => {
    invokeLLM
      .mockResolvedValueOnce(resposta({ ...VAZIO, acoes: [{ texto: "Parcial 1", responsavel: null, prazo: null, trecho: "x", confianca: 0 }] }))
      .mockResolvedValueOnce(resposta({ ...VAZIO, acoes: [{ texto: "Parcial 2", responsavel: null, prazo: null, trecho: "y", confianca: 0 }] }))
      .mockResolvedValueOnce(resposta({ ...VAZIO, acoes: [{ texto: "Preparar a planilha", responsavel: null, prazo: null, trecho: "Eu preparo a planilha de custos do frete", confianca: 0.8 }] }));
    const { itens } = await gerarResumoDaReuniao(ENTRADA, { limiteDaEntrada: 300 });
    expect(invokeLLM).toHaveBeenCalledTimes(3);
    expect(pedido(0).messages[1].content).toContain("Parte 1 de 2");
    expect(pedido(1).messages[1].content).toContain("Parte 2 de 2");
    // Nada fica de fora: as duas janelas somam a transcrição rotulada inteira.
    const janelas = pedido(0).messages[1].content + pedido(1).messages[1].content;
    for (const fala of FALAS.filter(f => !f.lacuna)) expect(janelas).toContain(fala.texto);
    expect(pedido(2).messages[1].content).toContain("Parcial 1");
    expect(pedido(2).messages[0].content).toContain("Copie cada \"trecho\" exatamente");
    expect(itens.map(i => i.text)).toEqual(["Preparar a planilha"]);
  });
});

describe("falhas da IA viram código", () => {
  it("resposta cortada no teto de saída", async () => {
    invokeLLM.mockResolvedValue(resposta(VAZIO, "length"));
    await expect(gerarResumoDaReuniao(ENTRADA)).rejects.toMatchObject({ name: "FalhaDaIA", codigo: "RESPOSTA_CORTADA" });
  });

  it("JSON inválido", async () => {
    invokeLLM.mockResolvedValue({ model: "x", choices: [{ message: { content: "{não é json" }, finish_reason: "stop" }] });
    await expect(gerarResumoDaReuniao(ENTRADA)).rejects.toMatchObject({ codigo: "RESPOSTA_INVALIDA" });
  });

  it("IA fora do ar", async () => {
    invokeLLM.mockRejectedValue(new Error("LLM sem resposta em 180s"));
    const erro = await gerarResumoDaReuniao(ENTRADA).catch(e => e);
    expect(erro).toBeInstanceOf(FalhaDaIA);
    expect(erro.codigo).toBe("IA_INDISPONIVEL");
  });
});

describe("o que a revisão da H4a1 pediu", () => {
  it("prazo em chinês ou japonês, sem espaço entre as palavras, fica se foi dito perto do trecho", async () => {
    const falas: Segmento[] = [
      { inicio: 0, fim: 6, falante: "F1", texto: "我们下周五之前完成报告。" },
      { inicio: 6, fim: 9, falante: "F2", texto: "好的,我来负责。" },
    ];
    const transcricao = falas.map(f => f.texto).join("\n");
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, acoes: [{ texto: "完成报告", responsavel: "{F1}", prazo: "下周五", trecho: "我们下周五之前完成报告", confianca: 0.9 }] }));
    const { itens } = await gerarResumoDaReuniao({ transcricao, segmentos: falas, idioma: "zh" });
    expect(itens).toEqual([expect.objectContaining({ due: "下周五", assignee: "{F1}", startSeconds: 0 })]);
  });

  describe("frase dita duas vezes: responsável e prazo saem da mesma vez", () => {
    // A proposta é dita pela F1 aos 0 s e pela F2 aos 300 s, a mais de 3 turnos.
    const reuniao = (primeira: string, segunda: string): Segmento[] => [
      { inicio: 0, fim: 5, falante: "F1", texto: primeira },
      { inicio: 5, fim: 9, falante: "F3", texto: "Ótimo, combinado." },
      { inicio: 9, fim: 15, falante: "F1", texto: "Depois falamos do frete." },
      { inicio: 15, fim: 20, falante: "F3", texto: "Certo." },
      { inicio: 20, fim: 26, falante: "F1", texto: "E do seguro também." },
      { inicio: 26, fim: 30, falante: "F3", texto: "Pode ser." },
      { inicio: 30, fim: 36, falante: "F1", texto: "Então está bem." },
      { inicio: 300, fim: 306, falante: "F2", texto: segunda },
    ];
    const resumirAProposta = (falas: Segmento[], responsavel: string) => {
      invokeLLM.mockResolvedValue(resposta({ ...VAZIO, acoes: [{ texto: "Mandar a proposta", responsavel, prazo: "até sexta", trecho: "vou mandar a proposta amanhã cedo", confianca: 0.8 }] }));
      return gerarResumoDaReuniao({ transcricao: falas.map(f => f.texto).join("\n"), segmentos: falas, idioma: "pt-BR" });
    };

    it("o rótulo só se sustenta na 2ª vez e o prazo só na 1ª: fica o rótulo, sem o prazo, com o tempo da 2ª", async () => {
      const falas = reuniao("Eu vou mandar a proposta amanhã cedo, até sexta.", "Eu vou mandar a proposta amanhã cedo, sem falta.");
      const { itens } = await resumirAProposta(falas, "{F2}");
      expect(itens.map(i => [i.assignee, i.due, i.startSeconds])).toEqual([["{F2}", null, 300]]);
    });

    it("o nome dito só perto da 2ª vez vence o prazo dito só perto da 1ª: o prazo sai", async () => {
      // A conduta conservadora: o prazo dito perto da outra vez, onde a pessoa
      // não foi nomeada, pode ser de outra pessoa. O item fica com ela e sem o
      // prazo, e não junta os dois.
      const falas = reuniao("Eu vou mandar a proposta amanhã cedo, até sexta.", "Combinado, Paula: eu vou mandar a proposta amanhã cedo, sem falta.");
      const { itens } = await resumirAProposta(falas, "Paula");
      expect(itens.map(i => [i.assignee, i.due, i.startSeconds])).toEqual([["Paula", null, 300]]);
    });
  });

  it("frase dita duas vezes: vale a vez em volta da qual o responsável fala, e o tempo é o dela", async () => {
    const falas: Segmento[] = [
      { inicio: 0, fim: 5, falante: "F1", texto: "Eu vou mandar a proposta amanhã cedo." },
      { inicio: 5, fim: 9, falante: "F3", texto: "Ótimo, combinado." },
      { inicio: 9, fim: 15, falante: "F1", texto: "Depois falamos do frete." },
      { inicio: 15, fim: 20, falante: "F3", texto: "Certo." },
      { inicio: 20, fim: 26, falante: "F1", texto: "E do seguro também." },
      { inicio: 26, fim: 30, falante: "F3", texto: "Pode ser." },
      { inicio: 30, fim: 36, falante: "F1", texto: "Então está bem." },
      { inicio: 300, fim: 306, falante: "F2", texto: "Eu vou mandar a proposta amanhã cedo, sem falta." },
    ];
    const transcricao = falas.map(f => f.texto).join("\n");
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, acoes: [{ texto: "Mandar a proposta", responsavel: "{F2}", prazo: null, trecho: "vou mandar a proposta amanhã cedo", confianca: 0.8 }] }));
    const { itens } = await gerarResumoDaReuniao({ transcricao, segmentos: falas, idioma: "pt-BR" });
    expect(itens).toEqual([expect.objectContaining({ assignee: "{F2}", startSeconds: 300 })]);
  });

  it("prazo com número fica só se o número foi dito perto do trecho", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      acoes: [
        { texto: "Embarcar o contêiner", responsavel: null, prazo: "dia 12 de março", trecho: "O contêiner sai do porto de Santos no dia 12 de março", confianca: 0.9 },
        { texto: "Confirmar o embarque", responsavel: null, prazo: "dia 13 de março", trecho: "O contêiner sai do porto de Santos", confianca: 0.9 },
      ],
    }));
    const [embarcar, confirmar] = (await gerarResumoDaReuniao(ENTRADA)).itens;
    expect(embarcar.due).toBe("dia 12 de março");
    expect(confirmar.due).toBeNull();
  });

  it("devolve quantos itens a IA mandou, e o log diz só os números quando a conferência tira algum", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, decisoes: ["a", "b", "c"].map(x => ({ texto: "Decisão " + x, trecho: "isto nunca foi dito na reunião " + x, confianca: 0.9 })) }));
    const resumo = await gerarResumoDaReuniao(ENTRADA);
    expect(resumo.itens).toEqual([]);
    expect(resumo.recebidos).toBe(3);
    expect(aviso).toHaveBeenCalledWith("[Resumo] a conferência tirou 3 de 3 itens");
  });

  it("aceita bandeira, tecla, tom de pele e família; recusa dois emojis ou emoji com texto", async () => {
    for (const emoji of ["🇧🇷", "1️⃣", "👍🏽", "👨‍👩‍👧", "⚠️"]) {
      invokeLLM.mockResolvedValueOnce(resposta({ ...VAZIO, emoji }));
      expect((await gerarResumoDaReuniao(ENTRADA)).emoji).toBe(emoji);
    }
    for (const emoji of ["📱📱", "📱 x"]) {
      invokeLLM.mockResolvedValueOnce(resposta({ ...VAZIO, emoji }));
      expect((await gerarResumoDaReuniao(ENTRADA)).emoji).toBeNull();
    }
  });

  it("texto acima do teto é cortado por caractere, sem partir emoji nem deixar um rótulo de voz pela metade", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      acoes: [
        { texto: "😀".repeat(170), responsavel: null, prazo: null, trecho: "O contêiner sai do porto de Santos", confianca: 0.5 },
        { texto: "A".repeat(157) + " {F2} confirma", responsavel: null, prazo: null, trecho: "Falta ver o seguro da carga com a corretora", confianca: 0.5 },
      ],
    }));
    const [emojis, rotulo] = (await gerarResumoDaReuniao(ENTRADA)).itens;
    expect(Array.from(emojis.text)).toHaveLength(160);
    expect(emojis.text).toBe("😀".repeat(160));
    expect(rotulo.text).toBe("A".repeat(157));
  });

  it("confiança em texto vira número; o que não é número vira 0", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      decisoes: [
        { texto: "Não renovar", trecho: "Decidimos não renovar o contrato", confianca: "0.9" },
        { texto: "Ver o seguro", trecho: "Falta ver o seguro da carga", confianca: "muita" },
      ],
    }));
    expect((await gerarResumoDaReuniao(ENTRADA)).itens.map(i => i.confidence)).toEqual([0.9, 0]);
  });

  it("reunião longa: a janela que falha derruba o resumo inteiro, sem a junção", async () => {
    invokeLLM
      .mockResolvedValueOnce(resposta(VAZIO))
      .mockRejectedValueOnce(new Error("LLM sem resposta em 180s"));
    await expect(gerarResumoDaReuniao(ENTRADA, { limiteDaEntrada: 300 })).rejects.toMatchObject({ codigo: "IA_INDISPONIVEL" });
    expect(invokeLLM).toHaveBeenCalledTimes(2);
  });

  it("reunião longa: o trecho que a junção mudou é conferido contra a transcrição inteira e sai", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeLLM
      .mockResolvedValueOnce(resposta(VAZIO))
      .mockResolvedValueOnce(resposta(VAZIO))
      .mockResolvedValueOnce(resposta({ ...VAZIO, acoes: [{ texto: "Preparar a planilha", responsavel: null, prazo: null, trecho: "Eu preparo a planilha de custos do navio", confianca: 0.8 }] }));
    const resumo = await gerarResumoDaReuniao(ENTRADA, { limiteDaEntrada: 300 });
    expect(resumo.itens).toEqual([]);
    expect(resumo.recebidos).toBe(1);
  });

  it("voz que fala muito tempo seguido vira várias linhas, todas com o rótulo", () => {
    const longa = Array.from({ length: 60 }, (_, i) => ({ inicio: i, fim: i + 1, falante: "F1", texto: "uma frase de umas cinquenta letras para encher a linha " + i }));
    const { texto } = entradaDoResumo("", longa);
    const linhas = texto.split("\n");
    expect(linhas.length).toBeGreaterThan(1);
    for (const linha of linhas) {
      expect(linha.startsWith("{F1}: ")).toBe(true);
      expect(linha.length).toBeLessThan(2_100);
    }
  });
});

/**
 * Os achados 1 a 4 e 9 da bancada de texto de 16/11 ("Achados do app, que
 * valem para qualquer modelo"), com as falas da reunião sintética do gabarito
 * (inventada: F1 é a Renata, F2 a Camila, F3 o Fernando; os nomes completos só
 * são ditos na abertura). Os tempos são os do gabarito: a fala 23 começa em
 * 311 s, a 24 em 318, a 33 em 409, a 42 em 489, a 61 em 644, a 84 em 847, a 90
 * em 898 e a 117 em 1119.
 */
describe("a conferência com a reunião sintética da bancada (16/11)", () => {
  const resumir = (dados: Record<string, unknown>) => {
    invokeLLM.mockResolvedValue(resposta({ ...VAZIO, ...dados }));
    return gerarResumoDaReuniao({ transcricao: TRANSCRICAO_DA_REUNIAO_SINTETICA, segmentos: FALAS_DA_REUNIAO_SINTETICA, idioma: "pt-BR" });
  };
  const acao = (texto: string, responsavel: string | null, prazo: string | null, trecho: string) => ({ texto, responsavel, prazo, trecho, confianca: 1 });
  const tarefa = (assunto: string, texto: string, responsavel: string | null, prazo: string | null, trecho: string) => ({ assunto, texto, responsavel, prazo, trecho, confianca: 1 });
  const PLANILHA = "Eu te mando a planilha de custos dos últimos seis meses até segunda que vem.";
  const MARGEM = "chegar a pelo menos 45 por cento de margem bruta antes de fechar com qualquer distribuidor";

  describe("1. responsável escrito por nome", () => {
    it("o nome dito só na abertura fica, mesmo longe do trecho", async () => {
      // "Fernando Okada" só é dito na fala 4, e "Renata" na 0 e na 118: antes,
      // os dois caíam por não estarem a 3 turnos do trecho.
      const { itens } = await resumir({
        acoes: [
          acao("Entregar a simulação de preço do kit", "Fernando Okada", "até o dia 20", "Te entrego até o dia 20."),
          acao("Apresentar a Camila à Sônia por e-mail", "Renata", "até sexta", "Mando um e-mail apresentando vocês duas até sexta."),
        ],
      });
      expect(itens.map(i => [i.assignee, i.due, i.startSeconds])).toEqual([
        ["Fernando Okada", "até o dia 20", 318],
        ["Renata", "até sexta", 489],
      ]);
    });

    it("o nome que ninguém disse cai, e o rótulo só fica se a voz fala perto do trecho", async () => {
      // Da fala 15 à 21 só falam a Camila (F2) e o Fernando (F3).
      const { itens } = await resumir({
        acoes: [
          acao("Chegar a 45% de margem", "{F2}", null, MARGEM),
          acao("Recomendar a margem de 45%", "{F1}", null, MARGEM),
          acao("Rever a margem com o mentor", "Fernanda", null, MARGEM),
        ],
      });
      expect(itens.map(i => i.assignee)).toEqual(["{F2}", null, null]);
    });

    it("o prompt pede o rótulo da voz mesmo quando o nome foi dito", async () => {
      await resumir({});
      const sistema = pedido().messages[0].content;
      expect(sistema).toContain("escreva sempre o rótulo dela");
      expect(sistema).toContain("mesmo que o nome tenha sido dito na reunião");
      expect(sistema).not.toContain("quando o nome não foi dito");
    });

    it("no responsável, o rótulo só vale para a voz que fala perto do trecho; quem só é nomeado ali vai pelo nome, e o prompt pede assim", async () => {
      // Quatro vozes. A Bia (F2) só fala na abertura e no fim, a mais de 3
      // turnos da fala em que a F1 a nomeia responsável.
      const falas: Segmento[] = [
        ["F1", "Bom dia, eu sou a Ana."], ["F2", "Eu sou a Bia."], ["F3", "Eu sou o Caio."], ["F4", "Eu sou a Duda."],
        ["F1", "Vamos aos números do trimestre."], ["F3", "As vendas subiram dez por cento."], ["F4", "O frete ficou mais caro."],
        ["F3", "Precisamos rever a tabela de preços."], ["F1", "Então ficou assim: a Bia manda a planilha de custos até segunda."],
        ["F3", "Certo, e eu reviso a tabela."], ["F4", "Eu cuido do frete."], ["F3", "Mais alguma coisa?"], ["F1", "Por hoje é isso."], ["F2", "Obrigada a todos."],
      ].map(([falante, texto], i) => ({ inicio: i * 10, fim: i * 10 + 9, falante, texto }));
      const trecho = "a Bia manda a planilha de custos até segunda";
      invokeLLM.mockResolvedValue(resposta({
        ...VAZIO,
        acoes: [
          { texto: "Mandar a planilha de custos", responsavel: "{F2}", prazo: "até segunda", trecho, confianca: 1 },
          { texto: "Enviar a planilha de custos", responsavel: "Bia", prazo: "até segunda", trecho, confianca: 1 },
        ],
      }));
      const { itens } = await gerarResumoDaReuniao({ transcricao: falas.map(f => f.texto).join("\n"), segmentos: falas, idioma: "pt-BR" });
      expect(itens.map(i => [i.assignee, i.due, i.startSeconds])).toEqual([
        [null, "até segunda", 80],
        ["Bia", "até segunda", 80],
      ]);
      const sistema = pedido().messages[0].content;
      expect(sistema).toContain("Em \"responsavel\", porém, o rótulo só serve para a voz que fala no trecho ou responde a ele");
      expect(sistema).toContain("quem só é nomeado ali por outra voz vai pelo nome, do jeito que foi dito");
    });

    it("as ações do Flash na bancada: os 5 responsáveis por nome e os prazos ficam (antes, 1 de 5 em cada rodada)", async () => {
      // As ações cruas que o Flash devolveu nas rodadas 1 e 2 (saídas X-resumo-r1 e r2).
      const rodada1 = [
        acao("Mandar a planilha de custos dos últimos seis meses.", "Camila", "segunda-feira", PLANILHA),
        acao("Enviar a simulação de preço para o kit de Natal.", "Fernando", "dia 20", "monto uma simulação de preço para o kit, com o preço mínimo e a margem em cada canal de venda. Te entrego até o dia 20."),
        acao("Enviar modelo de contrato de consignação.", "Fernando", "hoje", "Eu tenho um modelo de contrato de consignação que uso com os meus clientes. Eu mando para vocês duas ainda hoje, depois da reunião."),
        acao("Ligar para a Secretaria da Fazenda.", "Camila", "amanhã", "Amanhã cedo eu ligo para a Secretaria da Fazenda e vejo o que está faltando."),
        acao("Apresentar a Sônia Pacheco por e-mail.", "Renata", "sexta-feira", "Eu te apresento. Mando um e-mail apresentando vocês duas até sexta."),
      ];
      const rodada2 = [
        acao("Enviar o modelo de contrato de consignação", "Fernando Okada", "ainda hoje", "Eu mando para vocês duas ainda hoje, depois da reunião."),
        acao("Ligar para a Secretaria da Fazenda para verificar a inscrição estadual", "Camila Duarte", "amanhã cedo", "Amanhã cedo eu ligo para a Secretaria da Fazenda e vejo o que está faltando."),
        acao("Apresentar a Camila para a Sônia por e-mail", "Renata Albuquerque", "até sexta-feira", "Mando um e-mail apresentando vocês duas até sexta."),
        acao("Enviar a planilha de custos dos últimos seis meses para o Fernando", "Camila Duarte", "até segunda-feira que vem", PLANILHA),
        acao("Montar e entregar a simulação de preço do kit de Natal", "Fernando Okada", "até o dia 20", "Te entrego até o dia 20."),
      ];
      for (const acoes of [rodada1, rodada2]) {
        const { itens } = await resumir({ acoes });
        expect(itens.map(i => [i.assignee, i.due])).toEqual(acoes.map(a => [a.responsavel, a.prazo]));
      }
    });
  });

  describe("2. prazo", () => {
    it("as formas do mesmo prazo casam, e o fim do mês, sem palavra longa, também", async () => {
      const { itens } = await resumir({
        acoes: [
          acao("Apresentar a Camila à Sônia", "{F1}", "sexta-feira", "Mando um e-mail apresentando vocês duas até sexta."),
          acao("Mandar as amostras de tecido", "{F1}", "próxima semana", "três metros de cada uma das quatro cores que eu tenho em estoque. Mando na semana que vem."),
          acao("Enviar a planilha de custos", "{F2}", "segunda-feira", PLANILHA),
          acao("Enviar a planilha ao mentor", "{F2}", "até a próxima segunda-feira", PLANILHA),
          acao("Atualizar o perfil da Camila", "{F1}", "até o fim do mês", "Faço isso até o fim do mês."),
        ],
      });
      expect(itens.map(i => i.due)).toEqual(["sexta-feira", "próxima semana", "segunda-feira", "até a próxima segunda-feira", "até o fim do mês"]);
    });

    it("o prazo que não foi dito perto do trecho continua caindo", async () => {
      const { itens } = await resumir({
        acoes: [
          // Perto da fala 117 se diz o fim do mês, nunca o do ano.
          acao("Atualizar o perfil", "{F1}", "até o fim do ano", "Faço isso até o fim do mês."),
          // "Até sexta" não é "a próxima sexta".
          acao("Apresentar a Sônia", "{F1}", "próxima sexta", "Mando um e-mail apresentando vocês duas até sexta."),
          acao("Apresentar a fornecedora", "{F1}", "sábado", "Mando um e-mail apresentando vocês duas até sexta."),
          // Perto da fala 97 só se diz "semana passada": nem "próxima semana"
          // nem "semana que vem" (antes, este caía só por falta do "próxima" e
          // o "semana que vem" passava, porque "que" e "vem" eram curtas).
          acao("Rever o evento de março", "{F1}", "próxima semana", "A coordenação cancelou na semana passada, porque não fechou o patrocínio."),
          acao("Rever o patrocínio", "{F1}", "semana que vem", "A coordenação cancelou na semana passada, porque não fechou o patrocínio."),
        ],
      });
      expect(itens.map(i => i.due)).toEqual([null, null, null, null, null]);
    });

    it("o ordinal não sustenta o dia da semana: \"A segunda possibilidade\" (fala 44) não vira prazo de segunda", async () => {
      // Perto da fala 42 só se diz "até sexta"; a fala 44, a 2 turnos, abre com "A segunda possibilidade".
      const { itens } = await resumir({
        acoes: [
          acao("Apresentar a Camila à Sônia", "{F1}", "segunda-feira", "Mando um e-mail apresentando vocês duas até sexta."),
          acao("Apresentar a fornecedora", "{F1}", "até segunda", "Mando um e-mail apresentando vocês duas até sexta."),
          // O dia dito como dia da semana segue valendo, também depois de "até a".
          acao("Escrever para a Sônia", "{F1}", "até a sexta-feira", "Mando um e-mail apresentando vocês duas até sexta."),
        ],
      });
      expect(itens.map(i => i.due)).toEqual([null, null, "até a sexta-feira"]);
    });

    it("o prazo com o ordinal (\"segunda quinzena\") casa com o ordinal dito; o dia da semana, não; \"até a sexta\" é dia da semana", async () => {
      const falas: Segmento[] = [
        { inicio: 0, fim: 6, falante: "F1", texto: "A entrega do kit fica para a segunda quinzena de dezembro." },
        { inicio: 6, fim: 12, falante: "F2", texto: "Combinado. Eu termino o relatório até a sexta, sem falta." },
        { inicio: 12, fim: 18, falante: "F1", texto: "E a reunião com o banco fica para a semana que vem." },
      ];
      const kit = "A entrega do kit fica para a segunda quinzena de dezembro";
      invokeLLM.mockResolvedValue(resposta({
        ...VAZIO,
        acoes: [
          { texto: "Entregar o kit", responsavel: "{F1}", prazo: "segunda quinzena de dezembro", trecho: kit, confianca: 1 },
          { texto: "Entregar o kit às empresas", responsavel: "{F1}", prazo: "até segunda", trecho: kit, confianca: 1 },
          // Há um "que vem" por perto, mas a segunda dita é o ordinal.
          { texto: "Entregar o kit aos clientes", responsavel: "{F1}", prazo: "segunda que vem", trecho: kit, confianca: 1 },
          { texto: "Terminar o relatório", responsavel: "{F2}", prazo: "sexta-feira", trecho: "Eu termino o relatório até a sexta", confianca: 1 },
        ],
      }));
      const { itens } = await gerarResumoDaReuniao({ transcricao: falas.map(f => f.texto).join("\n"), segmentos: falas, idioma: "pt-BR" });
      expect(itens.map(i => i.due)).toEqual(["segunda quinzena de dezembro", null, null, "sexta-feira"]);
    });
  });

  describe("3. responsável composto", () => {
    it("fica inteiro quando todas as pessoas se sustentam; senão, sai inteiro, e nunca vira só uma delas", async () => {
      const { itens } = await resumir({
        tarefas: [
          tarefa("Planilha e simulação", "{F2} manda a planilha e {F3} monta a simulação.", "{F2}, {F3}", null, PLANILHA),
          // O par é o que o modelo escreveu: a conferência não tira o Fernando
          // e deixa o "dia 20", que é dele, com a Camila.
          tarefa("Números do kit", "Camila manda a planilha e Fernando entrega a simulação até o dia 20.", "Camila e Fernando", "dia 20", PLANILHA),
          // Ninguém disse "Joana": cai a lista toda, e o prazo, dito perto, fica sem dono.
          tarefa("Custos", "Camila e Joana revisam os custos.", "Camila e Joana", "até segunda que vem", PLANILHA),
          // A F1 não fala perto da fala 18: não sobra só "{F2}".
          tarefa("Margem", "{F2} e {F1} falam da margem.", "{F2} e {F1}", null, MARGEM),
          tarefa("Margem em chinês", "A margem.", "{F2}和{F3}", null, MARGEM),
          tarefa("Margem em árabe", "A margem de novo.", "{F2} و{F3}", null, MARGEM),
          tarefa("Rótulo com nome", "A margem outra vez.", "{F2} (Camila)", null, MARGEM),
        ],
      });
      expect(itens.map(i => [i.assignee, i.due])).toEqual([
        ["{F2}, {F3}", null],
        ["Camila e Fernando", "dia 20"],
        [null, "até segunda que vem"],
        [null, null],
        ["{F2}和{F3}", null],
        ["{F2} و{F3}", null],
        [null, null],
      ]);
    });

    it("a conjunção depois da vírgula, e as dos outros idiomas, também separam as pessoas: todas ficam", async () => {
      // Perto da fala 23 falam as três vozes.
      const formas = [
        "{F2}, {F3}, and {F1}", "{F2}, {F3}, y {F1}", "{F2}, e {F3}", "{F2}, {F3} sowie {F1}", "{F2} ainsi que {F3}", "{F2}, а также {F3}",
        "{F2} तथा {F3}", "{F2} एवं {F3}", "{F2}、{F3}以及{F1}", "{F2}および{F3}", "{F2}及び{F3}", "{F2}や{F3}",
      ];
      for (const forma of formas) {
        const { itens } = await resumir({ tarefas: [tarefa("Planilha", "A planilha de custos.", forma, null, PLANILHA)] });
        expect(itens.map(i => i.assignee), forma).toEqual([forma]);
      }
    });

    it("o nome com uma palavra que ninguém disse não fica inteiro numa lista", async () => {
      // "Silva" nunca é dito: a lista sai inteira, e não vira "Camila Silva e Fernando".
      const { itens } = await resumir({ tarefas: [tarefa("Números do kit", "Camila manda a planilha.", "Camila Silva e Fernando", null, PLANILHA)] });
      expect(itens.map(i => [i.assignee, i.startSeconds])).toEqual([[null, 311]]);
    });

    it("em árabe, o \"و\" colado separa duas pessoas ditas na reunião, que ficam juntas; o nome que começa com \"و\" fica inteiro", async () => {
      // Envio único, sem falas: Ahmad e Sara se apresentam separados.
      const transcricao = ["مرحبا، أنا أحمد.", "وأنا سارة.", "وأنا وليد.", "سأرسل التقرير المالي الكامل إلى العميل قبل يوم الجمعة القادم."].join("\n");
      const trecho = "سأرسل التقرير المالي الكامل إلى العميل قبل يوم الجمعة القادم";
      invokeLLM.mockResolvedValue(resposta({
        ...VAZIO,
        acoes: [
          { texto: "إرسال التقرير", responsavel: "أحمد وسارة", prazo: "يوم الجمعة", trecho, confianca: 1 },
          { texto: "مراجعة التقرير", responsavel: "وليد", prazo: null, trecho, confianca: 1 },
          // A palavra que ninguém disse sai, como em "Carla Mendes".
          { texto: "إرسال التقرير إلى العميل", responsavel: "أحمد الكبير", prazo: null, trecho, confianca: 1 },
        ],
      }));
      const { itens } = await gerarResumoDaReuniao({ transcricao, segmentos: [], idioma: "ar" });
      expect(itens.map(i => [i.assignee, i.due])).toEqual([
        ["أحمد وسارة", "يوم الجمعة"],
        ["وليد", null],
        ["أحمد", null],
      ]);
    });

    it("o prompt pede todas as pessoas separadas por vírgula e o prazo só se vale para todas", async () => {
      await resumir({});
      const sistema = pedido().messages[0].content;
      expect(sistema).toContain("separadas por vírgula (\"{F1}, {F3}\")");
      expect(sistema).toContain("use \"prazo\" só se ele vale para todas");
    });
  });

  describe("4. número de ações", () => {
    it("o prompt pede até 7 ações, e não de 3 a 5", async () => {
      await resumir({});
      const sistema = pedido().messages[0].content;
      expect(sistema).toContain("até 7");
      expect(sistema).not.toContain("de 3 a 5");
    });

    it("as 7 ações da reunião ficam, cada uma com o responsável, o prazo e o tempo", async () => {
      const { itens } = await resumir({
        acoes: [
          acao("Apresentar a Camila à Sônia Pacheco por e-mail", "{F1}", "até sexta", "Mando um e-mail apresentando vocês duas até sexta."),
          acao("Enviar ao Fernando a planilha de custos", "{F2}", "até segunda que vem", PLANILHA),
          acao("Montar a simulação de preço do kit", "{F3}", "até o dia 20", "eu monto uma simulação de preço para o kit, com o preço mínimo e a margem em cada canal de venda"),
          acao("Mandar as amostras de tecido", "{F1}", "na semana que vem", "três metros de cada uma das quatro cores que eu tenho em estoque. Mando na semana que vem."),
          acao("Ligar para a Secretaria da Fazenda", "{F2}", "amanhã cedo", "Amanhã cedo eu ligo para a Secretaria da Fazenda e vejo o que está faltando."),
          acao("Enviar o modelo de contrato de consignação", "{F3}", "ainda hoje, depois da reunião", "Eu mando para vocês duas ainda hoje, depois da reunião."),
          acao("Atualizar o perfil da Camila na plataforma", "{F1}", "até o fim do mês", "Então eu atualizo o seu perfil na plataforma, com o que você procura agora e com o kit para empresas no que você oferece."),
        ],
      });
      expect(itens.map(i => [i.section, i.assignee, i.due, i.startSeconds])).toEqual([
        ["action", "{F1}", "até sexta", 489],
        ["action", "{F2}", "até segunda que vem", 311],
        ["action", "{F3}", "até o dia 20", 318],
        ["action", "{F1}", "na semana que vem", 644],
        ["action", "{F2}", "amanhã cedo", 847],
        ["action", "{F3}", "ainda hoje, depois da reunião", 898],
        ["action", "{F1}", "até o fim do mês", 1119],
      ]);
    });
  });

  describe("9. trecho com [...]", () => {
    it("o [...] que emenda falas distantes fica só com o começo, e a vizinhança não se estica até a outra fala", async () => {
      // Da rodada 3 da Lite: a fala 33 emendada à 60. Com o trecho inteiro, a
      // vizinhança ia da fala 30 à 63, e o prazo das amostras (fala 61) ficava.
      const { itens } = await resumir({
        tarefas: [
          tarefa(
            "Kit de Natal",
            "Ficou decidido fazer 200 kits, com o saquinho de algodão; {F1} manda as amostras na semana que vem.",
            "{F2} e {F1}",
            "Semana que vem para as amostras",
            "Fica decidido então: o kit de Natal vai ter 200 unidades, e não 500. [...] a embalagem do kit vai ser o saquinho de algodão da Tecelagem Aurora, e o acetato sai.",
          ),
        ],
      });
      expect(itens).toEqual([
        expect.objectContaining({ excerpt: "Fica decidido então: o kit de Natal vai ter 200 unidades, e não 500.", startSeconds: 409, assignee: "{F2} e {F1}", due: null }),
      ]);
    });

    it("falas vizinhas que passam de 30 palavras também são cortadas; o que cabe fica inteiro", async () => {
      const { itens } = await resumir({
        tarefas: [
          // Da rodada 3 da Lite: a fala 23 inteira e o fim da 24, 48 palavras.
          tarefa(
            "Números e margem",
            "{F2} manda a planilha até segunda que vem, e {F3} entrega a simulação até o dia 20.",
            "{F2} e {F3}",
            "Segunda que vem para a planilha e dia 20 para a simulação",
            `Combinado. ${PLANILHA} [...] Te entrego até o dia 20.`,
          ),
          // Dentro da mesma fala, 12 palavras: fica como veio.
          tarefa("Apresentação", "{F1} apresenta a Camila à Sônia.", "{F1}", "até sexta", "Eu te apresento. [...] até sexta."),
        ],
      });
      expect(itens.map(i => [i.excerpt, i.startSeconds, i.assignee, i.due])).toEqual([
        [`Combinado. ${PLANILHA}`, 311, "{F2} e {F3}", "Segunda que vem para a planilha e dia 20 para a simulação"],
        ["Eu te apresento. [...] até sexta.", 489, "{F1}", "até sexta"],
      ]);
    });

    it("com o começo abaixo de 5 palavras fica a maior das outras partes; sem nenhuma parte de 5 palavras, o item sai", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { itens, recebidos } = await resumir({
        decisoes: [
          { texto: "O perfil será atualizado até o fim do mês", trecho: "Eu sei. [...] Faço isso até o fim do mês.", confianca: 1 },
          { texto: "O cacau a granel entra no perfil", trecho: "Eu sei. [...] Coloco, sim.", confianca: 1 },
        ],
      });
      expect(itens.map(i => [i.text, i.excerpt, i.startSeconds])).toEqual([["O perfil será atualizado até o fim do mês", "Faço isso até o fim do mês.", 1119]]);
      expect(recebidos).toBe(2);
    });

    it("no mesmo turno os pedaços ficam, por mais palavras que haja entre eles: a ação segue com o rótulo, o prazo e o ▶", async () => {
      // 43 palavras entre os pedaços, numa fala só da F1: a vizinhança, medida
      // em turnos, não se alarga.
      const meio = "porque antes eu preciso conversar com o pessoal do financeiro, revisar os números do trimestre, ver o que mudou no frete, confirmar o desconto com o fornecedor e ainda alinhar com a equipe de vendas o que cada um vai fazer, então eu";
      const falas: Segmento[] = [
        { inicio: 0, fim: 30, falante: "F1", texto: `Eu mando a proposta, ${meio} entrego até sexta-feira.` },
        { inicio: 30, fim: 33, falante: "F2", texto: "Combinado, fico esperando." },
      ];
      const trecho = "Eu mando a proposta [...] até sexta-feira.";
      invokeLLM.mockResolvedValue(resposta({ ...VAZIO, acoes: [acao("Mandar a proposta", "{F1}", "até sexta-feira", trecho)] }));
      const { itens } = await gerarResumoDaReuniao({ transcricao: falas.map(f => f.texto).join("\n"), segmentos: falas, idioma: "pt-BR" });
      expect(itens.map(i => [i.excerpt, i.assignee, i.due, i.startSeconds])).toEqual([[trecho, "{F1}", "até sexta-feira", 0]]);
    });

    it("a fala 2 inteira fica como veio, e não só \"Eu tenho a Tecelagem Aurora.\"", async () => {
      const trecho = "Eu tenho a Tecelagem Aurora. [...] alguém que entenda de certificação orgânica para exportação.";
      const { itens } = await resumir({ questoes: [{ texto: "{F1} procura quem entenda de certificação orgânica para exportação", trecho, confianca: 1 }] });
      expect(itens.map(i => [i.excerpt, i.startSeconds])).toEqual([[trecho, 44]]);
    });

    it("o prompt pede que o trecho não emende partes distantes com reticências", async () => {
      await resumir({});
      expect(pedido().messages[0].content).toContain("não emenda com reticências (\"[...]\") partes distantes da reunião");
    });
  });
});
