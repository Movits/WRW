import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O raciocínio por função, desligado por padrão (P2B, item IA4).
 *
 * A sondagem da bancada de texto (16/11/2026) mandou ao endpoint do Gemini
 * compatível com a OpenAI os dois campos que a llm.ts sabia mandar,
 * `reasoning: { effort }` e `thinking: { thinking_level }`, e levou 400
 * INVALID_ARGUMENT nos dois. O campo que a documentação do Gemini aceita é
 * `reasoning_effort`, no nível de cima do corpo. O que estes testes prendem,
 * no CORPO do pedido (o fetch é o dublê; o invokeLLM real roda inteiro):
 *
 * 1. sem pedido, o corpo é o de sempre, sem `reasoning_effort` e sem os campos
 *    que o endpoint recusa: em produção nada muda;
 * 2. com `raciocinio`, o nível sobe como `reasoning_effort`, sozinho (nunca com
 *    `extra_body`, que a documentação proíbe junto); nível fora da lista nem
 *    sai, falha antes do fetch, e os campos antigos (`reasoning`, `thinking`) ou
 *    o nome do corpo (`reasoning_effort`), passados por fora do tipo, também;
 * 3. a extração, o resumo guardado e o Pergunte pedem o nível da variável da
 *    PRÓPRIA função (LLM_RACIOCINIO_EXTRACAO, _RESUMO e _PERGUNTA), lida a cada
 *    chamada, como a bancada precisa para trocar de braço num processo só; quem
 *    chama o pedirJsonAIA com funcao null não lê nenhuma delas;
 * 4. valor recusado avisa no log uma vez, sem levar ao log o que pode ser uma
 *    chave, e não manda nada;
 * 5. o boot mostra o que cada função pede.
 *
 * Nada aqui sai para a internet nem lê banco.
 */

const VARIAVEIS_DO_RACIOCINIO = ["LLM_RACIOCINIO_EXTRACAO", "LLM_RACIOCINIO_RESUMO", "LLM_RACIOCINIO_PERGUNTA"];
// Dublê de chave sem o formato de uma chave do Google: com ele, a varredura de
// segredos do /abrir-pr e a proteção de push do GitHub o tomariam por chave.
const CHAVE_FALSA = "chave-falsa-com-digitos-0123456789";

const reuniao = vi.hoisted(() => ({
  transcricao: [
    "Bom dia a todos. Hoje vamos falar da exportação de café para a Alemanha.",
    "O contêiner sai do porto de Santos no dia 12 de março.",
    "Então fica decidido que a Carla fecha o contrato com o importador até sexta-feira.",
  ].join("\n"),
}));

// O Pergunte lê a reunião (status) e depois a transcrição (o texto e, desde a
// H6, as falas): uma linha com os três campos serve às duas leituras.
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "ready", transcript: reuniao.transcricao, segments: null }] }) }) }),
  }),
}));

type Corpo = Record<string, unknown>;
const corpos: Corpo[] = [];
let conteudoDaIA = "{}";
let fetchFalso: ReturnType<typeof vi.fn>;
let avisos: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Módulos novos a cada teste: o aviso de recusa sai uma vez por valor e por
  // processo, e o ENV de _core/env.ts é lido na importação.
  vi.resetModules();
  // O .env de quem roda a suíte não decide o teste: cada caso diz o que vale.
  for (const nome of [...VARIAVEIS_DO_RACIOCINIO, "LLM_MODEL", "GOOGLE_API_KEY"]) vi.stubEnv(nome, undefined);
  vi.stubEnv("LLM_API_URL", "https://ia.teste.local/v1beta/openai");
  vi.stubEnv("LLM_API_KEY", "chave-falsa-que-nunca-pode-aparecer");
  corpos.length = 0;
  conteudoDaIA = "{}";
  fetchFalso = vi.fn(async (_url: string, init: RequestInit) => {
    corpos.push(JSON.parse(String(init.body)) as Corpo);
    return new Response(
      JSON.stringify({ id: "r1", created: 0, model: "gemini-teste-1", choices: [{ index: 0, message: { role: "assistant", content: conteudoDaIA }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchFalso);
  avisos = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const mensagens = [{ role: "user" as const, content: "Quanto é 2 + 2?" }];
const avisosDoRaciocinio = () => avisos.mock.calls.map(argumentos => argumentos.map(String).join(" ")).filter(linha => linha.includes("LLM_RACIOCINIO_"));
const camposDoRaciocinio = (corpo: Corpo) => Object.keys(corpo).filter(campo => /reasoning|thinking|extra_body/.test(campo)).sort();

// As três funções da reunião, pelo código do app, até o fetch.
async function extrair(texto = reuniao.transcricao) {
  conteudoDaIA = JSON.stringify({ entities: [], contacts: [] });
  const { extractMeetingData } = await import("./meeting-service");
  return extractMeetingData(texto);
}
async function resumir(opcoes: { limiteDaEntrada?: number } = {}) {
  conteudoDaIA = JSON.stringify({ emoji: null, acoes: [], foco: { texto: "", trecho: "", confianca: 0 }, tarefas: [], decisoes: [], bloqueios: [], questoes: [] });
  const { gerarResumoDaReuniao } = await import("./resumo-da-reuniao");
  return gerarResumoDaReuniao({ transcricao: reuniao.transcricao, segmentos: [], idioma: "pt-BR" }, opcoes);
}
async function perguntar() {
  // Os campos da resposta de antes e de depois da H6: a pergunta sai igual.
  conteudoDaIA = JSON.stringify({ respondida: false, resposta: "", trecho: "", citacoes: [] });
  const { perguntarAReuniao } = await import("./reuniao-com-ia");
  return perguntarAReuniao("dona-1", "reuniao-1", "Quando sai o contêiner?", "pt-BR");
}

describe("invokeLLM: o corpo do pedido", () => {
  it("sem raciocínio, o corpo é o de sempre: nenhum campo de raciocínio sobe", async () => {
    const { invokeLLM } = await import("./_core/llm");
    await invokeLLM({ messages: mensagens });

    expect(fetchFalso).toHaveBeenCalledTimes(1);
    // Mutante "manda um padrão": em produção, todo pedido mudaria de uma vez.
    expect(Object.keys(corpos[0]).sort()).toEqual(["messages", "model"]);
  });

  it.each(["minimal", "low", "medium", "high"] as const)("raciocinio %s sobe como reasoning_effort, no nível de cima e sozinho", async nivel => {
    const { invokeLLM } = await import("./_core/llm");
    await invokeLLM({ messages: mensagens, raciocinio: nivel });

    expect(corpos[0].reasoning_effort).toBe(nivel);
    // Nada de `reasoning` ou `thinking` (o 400 da sondagem) nem de extra_body,
    // que a documentação proíbe junto do reasoning_effort.
    expect(camposDoRaciocinio(corpos[0])).toEqual(["reasoning_effort"]);
  });

  it("nível fora da lista falha antes do fetch, em vez de virar um 400 retentado", async () => {
    const { invokeLLM } = await import("./_core/llm");
    for (const nivel of ["baixo", "none", "xhigh", "LOW"]) {
      await expect(invokeLLM({ messages: mensagens, raciocinio: nivel as never })).rejects.toThrow(/raciocínio inválido/);
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("os campos que o endpoint recusava e o nome do corpo, passados por fora do tipo, falham antes do fetch", async () => {
    const { invokeLLM } = await import("./_core/llm");
    // A sondagem antiga da bancada manda os dois primeiros. Descartados em
    // silêncio, o pedido voltaria 200, com o raciocínio padrão, e a medida
    // pareceria a do nível pedido.
    const porForaDoTipo = [{ reasoning: { effort: "low" } }, { thinking: { thinking_level: "low" } }, { reasoning_effort: "low" }];
    for (const extra of porForaDoTipo) {
      const campo = Object.keys(extra)[0];
      await expect(invokeLLM({ messages: mensagens, ...extra } as never)).rejects.toThrow(`não aceita "${campo}": o raciocínio vai em raciocinio`);
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("a variável de cada função", () => {
  it("sem nenhuma LLM_RACIOCINIO_*, as três funções pedem como sempre pediram", async () => {
    await extrair();
    await resumir();
    await perguntar();

    expect(corpos).toHaveLength(3);
    for (const corpo of corpos) {
      expect(camposDoRaciocinio(corpo)).toEqual([]);
      expect(Object.keys(corpo).sort()).toEqual(["messages", "model", "response_format"]);
    }
    expect(avisosDoRaciocinio()).toEqual([]);
  });

  it("a extração pede o nível de LLM_RACIOCINIO_EXTRACAO em cada janela da reunião longa", async () => {
    vi.stubEnv("LLM_RACIOCINIO_EXTRACAO", "low");
    const { JANELA_DA_EXTRACAO } = await import("./meeting-service");
    const longa = "Fala da reunião sobre a exportação de café para a Alemanha.\n".repeat(Math.ceil((JANELA_DA_EXTRACAO * 2.5) / 60));
    await extrair(longa);

    expect(corpos.length).toBeGreaterThanOrEqual(3);
    for (const corpo of corpos) expect(corpo.reasoning_effort).toBe("low");
  });

  it("o resumo pede o nível de LLM_RACIOCINIO_RESUMO em cada janela e na junção", async () => {
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "low");
    await resumir({ limiteDaEntrada: 100 });

    // Duas ou mais janelas e a junção: nenhuma chamada fica no padrão.
    expect(corpos.length).toBeGreaterThanOrEqual(3);
    for (const corpo of corpos) expect(corpo.reasoning_effort).toBe("low");
  });

  it("o Pergunte pede o nível de LLM_RACIOCINIO_PERGUNTA", async () => {
    vi.stubEnv("LLM_RACIOCINIO_PERGUNTA", "low");
    await expect(perguntar()).resolves.toEqual({ respondida: false });

    expect(corpos).toHaveLength(1);
    expect(corpos[0].reasoning_effort).toBe("low");
  });

  it("quem chama o pedirJsonAIA com funcao null não pede raciocínio nem troca de modelo, nem com as variáveis das três definidas", async () => {
    for (const nome of VARIAVEIS_DO_RACIOCINIO) vi.stubEnv(nome, "low");
    // E o modelo da função (IA1): a chamada sem função não pode lê-lo.
    for (const nome of ["LLM_MODEL_EXTRACAO", "LLM_MODEL_RESUMO", "LLM_MODEL_PERGUNTA"]) vi.stubEnv(nome, "gemini-9.9-da-funcao");
    vi.stubEnv("LLM_MODEL", "gemini-1.0-geral");
    const { pedirJsonAIA } = await import("./ia-em-json");
    // Como chamam o mapa mental, a tradução do resumo e o e-mail de retorno,
    // funções que a bancada não mediu: a função é obrigatória no tipo, e elas
    // declaram null.
    const pedido = { sistema: "Responda em JSON.", usuario: "Monte o mapa da reunião.", nome: "mapa_mental", schema: { type: "object" }, timeoutMs: 5_000, orcamentoMs: 5_000 };
    await pedirJsonAIA({ ...pedido, funcao: null });
    // O controle: a mesma chamada, com a função, pede o nível e o modelo dela.
    await pedirJsonAIA({ ...pedido, funcao: "resumo" });

    // Mutante "sem função vale a do resumo": o mapa mental passaria a
    // raciocinar menos e a trocar de modelo quando alguém ligasse
    // LLM_RACIOCINIO_RESUMO ou LLM_MODEL_RESUMO.
    expect(corpos).toHaveLength(2);
    expect(camposDoRaciocinio(corpos[0])).toEqual([]);
    expect(corpos[0].model).toBe("gemini-1.0-geral");
    expect(corpos[1].reasoning_effort).toBe("low");
    expect(corpos[1].model).toBe("gemini-9.9-da-funcao");
    expect(avisosDoRaciocinio()).toEqual([]);
  });

  it("cada função lê só a sua variável: ligar uma não liga as outras", async () => {
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "low");
    vi.stubEnv("LLM_RACIOCINIO_PERGUNTA", "medium");
    await extrair();
    await resumir();
    await perguntar();

    // Mutante "a função errada": o resumo com o nível da pergunta, ou a
    // extração pegando a variável de outra, muda um destes três.
    expect(corpos.map(corpo => corpo.reasoning_effort)).toEqual([undefined, "low", "medium"]);
    expect("reasoning_effort" in corpos[0]).toBe(false);
  });

  it("a variável é lida a cada chamada: a bancada troca de braço sem recarregar o módulo", async () => {
    const { gerarResumoDaReuniao } = await import("./resumo-da-reuniao");
    conteudoDaIA = JSON.stringify({ emoji: null, acoes: [], foco: { texto: "", trecho: "", confianca: 0 }, tarefas: [], decisoes: [], bloqueios: [], questoes: [] });
    const entrada = { transcricao: reuniao.transcricao, segmentos: [], idioma: "pt-BR" as const };

    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "low");
    await gerarResumoDaReuniao(entrada);
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", undefined);
    await gerarResumoDaReuniao(entrada);
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "minimal");
    await gerarResumoDaReuniao(entrada);

    expect(corpos.map(corpo => corpo.reasoning_effort)).toEqual(["low", undefined, "minimal"]);
  });

  it("caixa e espaços em volta não contam", async () => {
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "  LOW ");
    await resumir();

    expect(corpos[0].reasoning_effort).toBe("low");
    expect(avisosDoRaciocinio()).toEqual([]);
  });

  it("valor fora da lista não manda nada e avisa no log uma vez por variável e valor", async () => {
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "baixo");
    await resumir();
    await resumir();
    // "none" só desliga o raciocínio no 2.5, e "xhigh" é de um modelo só.
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "none");
    await resumir();
    vi.stubEnv("LLM_RACIOCINIO_PERGUNTA", "baixo");
    await perguntar();

    for (const corpo of corpos) expect(camposDoRaciocinio(corpo)).toEqual([]);
    const linhas = avisosDoRaciocinio();
    expect(linhas).toHaveLength(3);
    expect(linhas[0]).toContain('LLM_RACIOCINIO_RESUMO recusado ("baixo")');
    expect(linhas[0]).toContain("minimal, low, medium, high");
    expect(linhas[1]).toContain('LLM_RACIOCINIO_RESUMO recusado ("none")');
    expect(linhas[2]).toContain('LLM_RACIOCINIO_PERGUNTA recusado ("baixo")');
  });

  it("uma chave colada no campo errado não vai ao log", async () => {
    vi.stubEnv("LLM_RACIOCINIO_EXTRACAO", CHAVE_FALSA);
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "   ");
    await extrair();
    await resumir();

    for (const corpo of corpos) expect(camposDoRaciocinio(corpo)).toEqual([]);
    const linhas = avisosDoRaciocinio();
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toContain("LLM_RACIOCINIO_EXTRACAO recusado (valor fora do log)");
    expect(linhas[1]).toContain("LLM_RACIOCINIO_RESUMO recusado (vazio)");
    expect(linhas.join("\n")).not.toContain(CHAVE_FALSA);
  });
});

describe("a linha [IA] raciocínio do boot", () => {
  it("sem variável, as três no padrão do modelo", async () => {
    const { linhaDoRaciocinioDeIa } = await import("./_core/raciocinio-de-ia");
    expect(linhaDoRaciocinioDeIa()).toBe("[IA] raciocínio · extração padrão do modelo · resumo padrão do modelo · pergunta padrão do modelo");
  });

  it("mostra o nível que vale depois da guarda, sem o valor recusado que pode ser uma chave", async () => {
    vi.stubEnv("LLM_RACIOCINIO_EXTRACAO", CHAVE_FALSA);
    vi.stubEnv("LLM_RACIOCINIO_RESUMO", "Low");
    const { linhaDoRaciocinioDeIa } = await import("./_core/raciocinio-de-ia");

    const linha = linhaDoRaciocinioDeIa();
    expect(linha).toBe("[IA] raciocínio · extração padrão do modelo · resumo low · pergunta padrão do modelo");
    expect(linha).not.toContain(CHAVE_FALSA);
    expect(avisosDoRaciocinio()).toHaveLength(1);
  });

  it("sai no começo do boot, logo depois da linha dos modelos", () => {
    const boot = readFileSync(join(__dirname, "_core", "index.ts"), "utf8");
    const comeco = boot.indexOf("async function startServer");
    const fim = boot.indexOf("const app = express();");
    expect(comeco).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(comeco);
    const inicioDoBoot = boot.slice(comeco, fim);
    expect(inicioDoBoot).toContain("console.log(linhaDoRaciocinioDeIa());");
    expect(inicioDoBoot.indexOf("console.log(linhaDoRaciocinioDeIa());")).toBeGreaterThan(inicioDoBoot.indexOf("console.log(linhaDosModelosDeIa());"));
  });
});
