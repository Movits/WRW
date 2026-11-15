import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O assistente da FAQ da Home (`faq.ask`, público) responde pelo que o prompt
 * diz. Na entrega de 16/09 o prompt ainda mandava a IA dizer que o
 * compartilhamento de contatos com a rede e a comissão "ainda não existem",
 * enquanto a mesma Home anuncia "Disponibilize contatos de forma anonimizada
 * para oportunidades da rede" e o Meu Network Inteligente já tem o SIM/NÃO por
 * contato (`networkInteligente.definirDisponibilidade`) e o registro de
 * conexões com status de comissão. Este teste lê o prompt que chega ao modelo.
 */

const llm = vi.hoisted(() => ({
  invokeLLM: vi.fn(async (_params: { messages: Array<{ role: string; content: string }> }) => ({
    choices: [{ message: { content: "resposta" } }],
  })),
}));

vi.mock("./_core/llm", () => ({ invokeLLM: llm.invokeLLM }));

import { FAQ_LIMIT, faqRouter } from "./routers/faq";

let ipSeq = 0;
function contexto() {
  ipSeq += 1;
  return {
    req: { headers: {}, socket: { remoteAddress: `10.0.0.${ipSeq}` } },
    res: {},
    user: null,
  } as never;
}

async function promptEnviado(pergunta: string) {
  const resposta = await faqRouter.createCaller(contexto()).ask({ question: pergunta });
  expect(resposta.answer).toBe("resposta");
  const chamada = llm.invokeLLM.mock.calls.at(-1)?.[0];
  const sistema = chamada?.messages.find(m => m.role === "system")?.content ?? "";
  const usuaria = chamada?.messages.find(m => m.role === "user")?.content;
  expect(usuaria).toBe(pergunta);
  return sistema;
}

describe("faq.ask: o prompt não nega o que a plataforma já oferece", () => {
  beforeEach(() => llm.invokeLLM.mockClear());

  it("apresenta a plataforma como WRW — Women Rocking the World (marca de 15/09/2026)", async () => {
    const prompt = await promptEnviado("O que é a WRW?");
    expect(prompt).toMatch(/^Você é a assistente virtual da plataforma WRW — Women Rocking the World —/);
    // A sigla antiga só aparece na linha que ensina a responder a quem ainda a usa;
    // o nome antigo por extenso não vai ao prompt, para a IA não repeti-lo ao visitante.
    const comNomeAntigo = prompt.split("\n").filter(l => /\bMMM\b|Mulheres que Movem/.test(l));
    expect(comNomeAntigo).toHaveLength(1);
    expect(comNomeAntigo[0]).toMatch(/use sempre WRW/);
    expect(prompt).not.toMatch(/Mulheres que Movem|Women Moving/i);
  });

  it("não manda dizer que disponibilizar contatos à rede ou a comissão não existem", async () => {
    const prompt = await promptEnviado("Posso disponibilizar meus contatos para oportunidades da rede?");
    expect(prompt).toContain("Meu Network Inteligente");
    expect(prompt).not.toMatch(/compartilhamento de contatos com a rede[^.\n]*ainda não exist/i);
    expect(prompt).not.toMatch(/comissão[^.\n]*ainda não exist/i);
  });

  it("descreve a disponibilização anonimizada: padrão NÃO, só ID anônimo e o que tem e precisa", async () => {
    const prompt = await promptEnviado("Meus contatos são compartilhados com a rede?");
    const linha = prompt.split("\n").find(l => l.includes("Meu Network Inteligente")) ?? "";
    expect(linha).toMatch(/privados por padrão/);
    expect(linha).toMatch(/disponibilizar cada contato para oportunidades da rede/);
    expect(linha).toMatch(/começa em NÃO/);
    expect(linha).toMatch(/ID anônimo/);
    expect(linha).toMatch(/nunca nome, telefone, e-mail, áudio, transcrição ou notas/);
  });

  it("a gravação vai até 12 horas, com o aviso de hora; o arquivo enviado segue nos 10 minutos e 10 MB (G13b)", async () => {
    const linha = (await promptEnviado("Quanto tempo posso gravar?")).split("\n").find(l => l.includes("Meu Network Inteligente")) ?? "";
    expect(linha).toMatch(/grava reuniões gratuitamente, cada uma com até 12 horas/);
    expect(linha).toMatch(/a cada hora de gravação, a plataforma pede que ela confirme que a gravação continua/);
    expect(linha).toMatch(/sem a confirmação em 10 minutos, a gravação para e o que foi gravado segue para a transcrição/);
    expect(linha).toMatch(/um arquivo de áudio pronto também pode ser enviado, com até 10 minutos e 10 MB/);
    // O teto de 10 minutos é do envio único (o arquivo), não mais da gravação.
    expect(linha).not.toMatch(/grava ou envia reuniões de até 10 minutos/);
  });

  it("registro com status de comissão, sem percentual; planos pagos e minutos extras continuam inexistentes", async () => {
    const linha = (await promptEnviado("Tem comissão?")).split("\n").find(l => l.includes("Meu Network Inteligente")) ?? "";
    expect(linha).toMatch(/status da comissão/);
    expect(linha).toMatch(/não informe percentual/);
    expect(linha).toMatch(/Não prometa planos pagos nem minutos extras: ainda não existem/);
    expect(linha).not.toMatch(/\d+\s*%/);
  });
});

/**
 * O teto do FAQ (cada pergunta é uma chamada paga ao LLM) contava pelo primeiro
 * item do X-Forwarded-For: trocar o cabeçalho a cada pergunta o anulava. Agora
 * conta pelo IP real (CF-Connecting-IP no Render), com 60 por minuto porque a
 * sala do lançamento divide o mesmo IP.
 */
describe("faq.ask: teto por IP real", () => {
  beforeEach(() => {
    process.env.RENDER = "true";
    llm.invokeLLM.mockClear();
  });
  afterEach(() => {
    delete process.env.RENDER;
  });

  const perguntar = (ipReal: string, i: number) =>
    faqRouter
      .createCaller({
        req: {
          headers: { "cf-connecting-ip": ipReal, "x-forwarded-for": `203.0.113.${i}, ${ipReal}` },
          ip: "10.226.0.9",
          socket: { remoteAddress: "10.226.0.9" },
        },
        res: {},
        user: null,
      } as never)
      .ask({ question: "O que é a WRW?" });

  it("60 perguntas do mesmo IP passam; a 61ª leva TOO_MANY_REQUESTS mesmo trocando o X-Forwarded-For", async () => {
    expect(FAQ_LIMIT).toBe(60);
    for (let i = 0; i < 60; i++) await perguntar("198.51.100.77", i);
    expect(llm.invokeLLM).toHaveBeenCalledTimes(60);

    const erro = await perguntar("198.51.100.77", 99).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(TRPCError);
    expect((erro as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    expect(llm.invokeLLM).toHaveBeenCalledTimes(60);

    // Outra rede segue perguntando.
    await expect(perguntar("198.51.100.78", 0)).resolves.toEqual({ answer: "resposta" });
  });
});
