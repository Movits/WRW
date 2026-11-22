import { describe, expect, it } from "vitest";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

const { aplicarOperacao, edicaoDaTranscricao, falasDoContrato, RecusaDaEdicao, textoCorridoDasFalas } = await import("./editar-transcricao");
const { contarNoTexto, proximaVozLivre, RECUSAS_DA_EDICAO, substituirNoTexto } = await import("@shared/editar-transcricao");
const { montarTranscricao } = await import("./transcricao-de-fatia");
const { mapaDeOutraVersao } = await import("./fila-do-resumo");

/**
 * Editar a transcrição (H18), sem banco: as contas que a tela e o servidor
 * fazem (shared/editar-transcricao.ts) e o que cada operação faz com as duas
 * versões da transcrição (aplicarOperacao). O banco, a auditoria na transação,
 * a revisão e o link aberto estão em editar-transcricao.integracao.test.ts.
 */

const FALAS = [
  { inicio: 0, fim: 4, falante: "F1", texto: "Bom dia, aqui é a Glenta.", idioma: "pt-BR" },
  { inicio: 4, fim: 9, falante: "F2", texto: "Bom dia, Glenta. A proposta sai sexta.", idioma: "pt-BR" },
  { inicio: 9, fim: 600, falante: "", texto: "", lacuna: true },
  { inicio: 600, fim: 610, falante: "F1", texto: "Ok.", idioma: "pt-BR" },
];
const TEXTO = FALAS.filter(f => !f.lacuna).map(f => f.texto).join("\n");
const daIA = () => ({ texto: TEXTO, segmentos: structuredClone(FALAS), originalTexto: null, originalSegmentos: null });

function recusa(fn: () => unknown): string {
  try {
    fn();
  } catch (erro) {
    expect(erro).toBeInstanceOf(RecusaDaEdicao);
    return (erro as Error).message;
  }
  throw new Error("não recusou");
}

describe("localizar e substituir (shared/editar-transcricao.ts)", () => {
  it("o texto é literal: sinais de expressão regular e o '$&' do texto novo entram como estão", () => {
    expect(contarNoTexto("R$ 10 e R$ 10.", "R$ 10")).toBe(2);
    expect(contarNoTexto("a.b axb", "a.b")).toBe(1);
    expect(substituirNoTexto("custa R$ 10", "R$ 10", "$& reais")).toEqual({ texto: "custa $& reais", quantas: 1 });
    expect(substituirNoTexto("(sic) (sic)", "(sic)", "")).toEqual({ texto: " ", quantas: 2 });
  });

  it("sem diferenciar maiúsculas acha em qualquer caixa, também fora do alfabeto latino básico; diferenciando, só a exata", () => {
    expect(substituirNoTexto("Glenta, GLENTA e glenta", "glenta", "Glenda")).toEqual({ texto: "Glenda, Glenda e Glenda", quantas: 3 });
    expect(substituirNoTexto("Glenta, GLENTA e glenta", "glenta", "Glenda", true)).toEqual({ texto: "Glenta, GLENTA e Glenda", quantas: 1 });
    expect(contarNoTexto("ÇÃO ção", "ção")).toBe(2);
    expect(contarNoTexto("Жанна жанна", "жанна")).toBe(2);
  });

  it("busca vazia não acha nada (e não trava num laço de ocorrências vazias)", () => {
    expect(contarNoTexto("abc", "")).toBe(0);
    expect(substituirNoTexto("abc", "", "x")).toEqual({ texto: "abc", quantas: 0 });
  });

  it("a próxima voz livre vem depois da maior usada; com as 99, nenhuma", () => {
    expect(proximaVozLivre(["F1", "F2"])).toBe("F3");
    expect(proximaVozLivre(["F2", "F7", "F1"])).toBe("F8");
    expect(proximaVozLivre([])).toBe("F1");
    expect(proximaVozLivre(["F99"])).toBeNull();
    expect(proximaVozLivre(["", "X1", "F0"])).toBe("F1");
  });
});

describe("as falas e o texto corrido", () => {
  it("a posição do trecho conta só as falas do contrato, e o lugar na lista guardada é o que muda", () => {
    const comLixo = [{ pagina: 1, texto: "x" }, ...FALAS];
    const falas = falasDoContrato(comLixo);
    expect(falas).toHaveLength(FALAS.length);
    expect(falas[0].lugar).toBe(1);
    expect(falasDoContrato(null)).toEqual([]);
  });

  it("o texto corrido refeito é o mesmo da montagem das partes (sem rótulo, sem o trecho que não chegou)", () => {
    const montada = montarTranscricao([{ seq: 0, inicioSegundos: 0, duracaoSegundos: 9, segmentos: FALAS.slice(0, 2) as never }, { seq: 2, inicioSegundos: 600, duracaoSegundos: 10, segmentos: [FALAS[3]] as never }], 3);
    expect(textoCorridoDasFalas(montada.segmentos)).toBe(montada.texto);
    expect(textoCorridoDasFalas(FALAS)).toBe(TEXTO);
  });
});

describe("aplicarOperacao", () => {
  it("corrigir o texto de um trecho: o texto corrido é refeito, a versão da IA é guardada inteira e o resto do segmento fica", () => {
    const r = aplicarOperacao(daIA(), { tipo: "texto", indice: 0, texto: "  Bom dia, aqui é a Glenda.  " });
    expect(r.mudou).toBe(true);
    if (!r.mudou) return;
    expect((r.segmentos as typeof FALAS)[0]).toEqual({ ...FALAS[0], texto: "Bom dia, aqui é a Glenda." });
    expect((r.segmentos as typeof FALAS)[1]).toEqual(FALAS[1]);
    expect(r.texto).toBe(TEXTO.replace("aqui é a Glenta", "aqui é a Glenda"));
    expect(r.original).toEqual({ texto: TEXTO, segmentos: FALAS });
    expect(r.trechos).toBe(1);
  });

  it("trocar a voz de um trecho muda só o falante, e o texto corrido continua o mesmo", () => {
    const r = aplicarOperacao(daIA(), { tipo: "voz", indice: 1, falante: "F3" });
    expect(r.mudou && (r.segmentos as typeof FALAS)[1]).toEqual({ ...FALAS[1], falante: "F3" });
    expect(r.mudou && r.texto).toBe(TEXTO);
  });

  it("o mesmo texto ou a mesma voz não mudam nada", () => {
    expect(aplicarOperacao(daIA(), { tipo: "texto", indice: 0, texto: FALAS[0].texto }).mudou).toBe(false);
    expect(aplicarOperacao(daIA(), { tipo: "voz", indice: 0, falante: "F1" }).mudou).toBe(false);
  });

  it("recusa o trecho que não existe, o que não chegou, a voz fora do formato e o texto vazio", () => {
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "texto", indice: 9, texto: "x" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "texto", indice: 2, texto: "x" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "texto", indice: -1, texto: "x" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "voz", indice: 0, falante: "F0" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "voz", indice: 2, falante: "F1" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "texto", indice: 0, texto: "   " }))).toBe(RECUSAS_DA_EDICAO.vazio);
  });

  it("substituir troca em todos os trechos (nunca no que não chegou) e conta as ocorrências", () => {
    const r = aplicarOperacao(daIA(), { tipo: "substituir", localizar: "glenta", substituirPor: "Glenda" });
    expect(r.mudou).toBe(true);
    if (!r.mudou) return;
    expect(r.substituicoes).toBe(2);
    expect(r.trechos).toBe(2);
    expect((r.segmentos as typeof FALAS).map(f => f.texto)).toEqual(["Bom dia, aqui é a Glenda.", "Bom dia, Glenda. A proposta sai sexta.", "", "Ok."]);
    expect(r.texto).not.toContain("Glenta");
  });

  it("substituir sem ocorrência não muda nada; a troca que esvaziaria um trecho inteiro é recusada inteira", () => {
    expect(aplicarOperacao(daIA(), { tipo: "substituir", localizar: "inexistente", substituirPor: "x" })).toEqual({ mudou: false, substituicoes: 0 });
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "substituir", localizar: "ok.", substituirPor: "" }))).toBe(RECUSAS_DA_EDICAO.vazio);
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "substituir", localizar: "  ", substituirPor: "x" }))).toBe(RECUSAS_DA_EDICAO.trecho);
  });

  it("voltar um trecho ao original devolve o segmento da IA; com todos de volta, a transcrição deixa de estar editada", () => {
    const editada = aplicarOperacao(daIA(), { tipo: "substituir", localizar: "Glenta", substituirPor: "Glenda" });
    if (!editada.mudou || !editada.original) throw new Error("devia ter editado");
    const versoes = { texto: editada.texto, segmentos: editada.segmentos, originalTexto: editada.original.texto, originalSegmentos: editada.original.segmentos };
    const um = aplicarOperacao(versoes, { tipo: "restaurar", indice: 0 });
    if (!um.mudou) throw new Error("devia ter voltado");
    expect((um.segmentos as typeof FALAS)[0]).toEqual(FALAS[0]);
    expect(um.original).toEqual({ texto: TEXTO, segmentos: FALAS });
    const dois = aplicarOperacao({ texto: um.texto, segmentos: um.segmentos, originalTexto: TEXTO, originalSegmentos: FALAS }, { tipo: "restaurar", indice: 1 });
    expect(dois).toMatchObject({ mudou: true, texto: TEXTO, segmentos: FALAS, original: null });
    // O trecho que já é o da IA não muda nada.
    expect(aplicarOperacao({ texto: um.texto, segmentos: um.segmentos, originalTexto: TEXTO, originalSegmentos: FALAS }, { tipo: "restaurar", indice: 0 }).mudou).toBe(false);
  });

  it("editar de volta ao texto da IA, à mão, também deixa de estar editada", () => {
    const editada = aplicarOperacao(daIA(), { tipo: "texto", indice: 3, texto: "Certo." });
    if (!editada.mudou || !editada.original) throw new Error("devia ter editado");
    const volta = aplicarOperacao({ texto: editada.texto, segmentos: editada.segmentos, originalTexto: TEXTO, originalSegmentos: FALAS }, { tipo: "texto", indice: 3, texto: "Ok." });
    expect(volta).toMatchObject({ mudou: true, texto: TEXTO, original: null });
  });

  it("voltar tudo devolve o texto e as falas da IA exatamente; sem edição, não muda nada", () => {
    const versoes = { texto: "outro", segmentos: [{ ...FALAS[0], texto: "outro" }, FALAS[1], FALAS[2], FALAS[3]], originalTexto: TEXTO, originalSegmentos: FALAS };
    expect(aplicarOperacao(versoes, { tipo: "restaurarTudo" })).toMatchObject({ mudou: true, texto: TEXTO, segmentos: FALAS, original: null, trechos: 1 });
    expect(aplicarOperacao(daIA(), { tipo: "restaurarTudo" }).mudou).toBe(false);
  });

  it("a ordem das chaves que o MySQL devolve não faz a transcrição parecer editada", () => {
    const reordenadas = FALAS.map(f => Object.fromEntries(Object.entries(f).reverse()));
    const editada = aplicarOperacao({ texto: TEXTO, segmentos: reordenadas, originalTexto: null, originalSegmentos: null }, { tipo: "texto", indice: 0, texto: "x" });
    if (!editada.mudou || !editada.original) throw new Error("devia ter editado");
    const volta = aplicarOperacao({ texto: editada.texto, segmentos: editada.segmentos, originalTexto: TEXTO, originalSegmentos: FALAS }, { tipo: "texto", indice: 0, texto: FALAS[0].texto });
    expect(volta).toMatchObject({ mudou: true, original: null });
  });

  it("o trecho de volta exige a lista da IA do mesmo tamanho (a transcrição refeita não tem o trecho de antes)", () => {
    const versoes = { texto: "x", segmentos: [{ ...FALAS[0], texto: "x" }, FALAS[1], FALAS[2], FALAS[3]], originalTexto: TEXTO, originalSegmentos: FALAS.slice(0, 2) };
    expect(recusa(() => aplicarOperacao(versoes, { tipo: "restaurar", indice: 0 }))).toBe(RECUSAS_DA_EDICAO.trecho);
  });

  it("a transcrição de texto corrido (sem falas) muda como um texto só; o trecho e a voz não servem a ela", () => {
    const corrida = { texto: "Reunião com a Glenta sobre a feira.", segmentos: [], originalTexto: null, originalSegmentos: null };
    expect(aplicarOperacao(corrida, { tipo: "textoCorrido", texto: " Reunião com a Glenda sobre a feira. " })).toMatchObject({
      mudou: true, texto: "Reunião com a Glenda sobre a feira.", original: { texto: corrida.texto, segmentos: [] }, trechos: 1,
    });
    expect(aplicarOperacao(corrida, { tipo: "substituir", localizar: "Glenta", substituirPor: "Glenda" })).toMatchObject({ mudou: true, substituicoes: 1 });
    expect(recusa(() => aplicarOperacao(corrida, { tipo: "texto", indice: 0, texto: "x" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(corrida, { tipo: "voz", indice: 0, falante: "F1" }))).toBe(RECUSAS_DA_EDICAO.trecho);
    expect(recusa(() => aplicarOperacao(corrida, { tipo: "textoCorrido", texto: "  " }))).toBe(RECUSAS_DA_EDICAO.vazio);
    expect(recusa(() => aplicarOperacao(corrida, { tipo: "substituir", localizar: "Reunião com a Glenta sobre a feira.", substituirPor: " " }))).toBe(RECUSAS_DA_EDICAO.vazio);
    // A transcrição em falas não aceita o texto corrido: ele é refeito das falas.
    expect(recusa(() => aplicarOperacao(daIA(), { tipo: "textoCorrido", texto: "x" }))).toBe(RECUSAS_DA_EDICAO.trecho);
  });
});

describe("o que a tela da dona recebe (edicaoDaTranscricao)", () => {
  it("de cada trecho mudado, o que a IA escreveu, pela posição entre as falas; sem edição, nada", () => {
    const atuais = [{ ...FALAS[0], texto: "Glenda" }, { ...FALAS[1], falante: "F3" }, FALAS[2], FALAS[3]];
    expect(edicaoDaTranscricao({ segments: atuais, originalSegments: FALAS, editada: true, editedAt: 123, revision: 2 })).toEqual({
      revisao: 2, editada: true, editadaEm: 123,
      originais: [{ indice: 0, texto: FALAS[0].texto, falante: "F1" }, { indice: 1, texto: FALAS[1].texto, falante: "F2" }],
    });
    expect(edicaoDaTranscricao({ segments: FALAS, originalSegments: null, editada: false, editedAt: null, revision: 0 })).toEqual({ revisao: 0, editada: false, editadaEm: null, originais: [] });
  });
});

describe("o mapa mental de outra versão (fila do resumo)", () => {
  it("gravado antes da última edição é de outra versão; depois dela, ou sem edição, é da versão de agora", () => {
    expect(mapaDeOutraVersao(1000, null)).toBe(false);
    expect(mapaDeOutraVersao(1000, 2000)).toBe(true);
    expect(mapaDeOutraVersao(3000, 2000)).toBe(false);
    expect(mapaDeOutraVersao(null, 2000)).toBe(true);
  });
});
