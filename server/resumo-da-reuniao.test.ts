import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Segmento } from "./transcricao-de-fatia";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O resumo guardado da reunião (H4), com a IA dublada. Prova:
 *
 * - o prompt pede o idioma da reunião e leva as falas com o rótulo da voz,
 *   nunca um nome que a dona deu (ele nem chega aqui);
 * - item com trecho inventado sai; negação fica; rótulo copiado no trecho não
 *   derruba o item;
 * - responsável e prazo só ficam se aparecem perto do trecho; voz que não
 *   existe derruba o item; no envio único, sem falas, rótulo de voz também;
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

  it("responsável e prazo só ficam se aparecem perto do trecho", async () => {
    invokeLLM.mockResolvedValue(resposta({
      ...VAZIO,
      acoes: [
        // O Roberto e a sexta-feira foram ditos na 1ª fala, longe da planilha.
        { texto: "Preparar a planilha de custos do frete", responsavel: "Roberto", prazo: "até sexta-feira", trecho: "Eu preparo a planilha de custos do frete", confianca: 0.8 },
        // Quem fala no trecho é a voz F2: o rótulo dela fica.
        { texto: "Ver o seguro da carga", responsavel: "{F2}", prazo: null, trecho: "Falta ver o seguro da carga com a corretora", confianca: 0.8 },
        // A F1 não fala perto da planilha (só na 1ª e na 3ª fala).
        { texto: "Levar a planilha à próxima reunião", responsavel: "{F1}", prazo: "na próxima reunião", trecho: "planilha de custos do frete para a próxima reunião", confianca: 0.8 },
      ],
    }));
    const [planilha, seguro, levar] = (await gerarResumoDaReuniao(ENTRADA)).itens;
    expect(planilha).toMatchObject({ assignee: null, due: null });
    expect(seguro).toMatchObject({ assignee: "{F2}", due: null });
    expect(levar).toMatchObject({ assignee: null, due: "na próxima reunião" });
  });

  it("o nome do responsável fica só com as palavras ditas perto do trecho", async () => {
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
