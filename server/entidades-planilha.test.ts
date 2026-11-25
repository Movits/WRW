import { describe, expect, it } from "vitest";
import {
  cnpjValido, convenioVigente, lerCsv, lerData, linhaDaPlanilha, mapearCabecalho, normalizarCnae, normalizarDocumento,
  nuitValido, validarLinha, ITENS_POR_LADO_MAX,
} from "../shared/entidades";

/**
 * A planilha da entidade (N1), lida igual na tela e no servidor
 * (shared/entidades.ts): documento, cabeçalho, CSV e a validação da linha.
 */
const HOJE = Date.UTC(2026, 10, 24);
const CNPJ = "11.222.333/0001-81";

describe("documento", () => {
  it("CNPJ numérico: confere os dois verificadores e recusa a sequência repetida", () => {
    expect(cnpjValido(normalizarDocumento(CNPJ))).toBe(true);
    expect(cnpjValido(normalizarDocumento("11.222.333/0001-80"))).toBe(false);
    expect(cnpjValido("00000000000000")).toBe(false);
    expect(cnpjValido("1122233300018")).toBe(false);
  });

  it("CNPJ alfanumérico (IN RFB 2.229/2024): o exemplo da Receita passa, e a letra errada não", () => {
    expect(cnpjValido(normalizarDocumento("12.ABC.345/01DE-35"))).toBe(true);
    expect(cnpjValido(normalizarDocumento("12.ABD.345/01DE-35"))).toBe(false);
    expect(normalizarDocumento("12.abc.345/01de-35")).toBe("12ABC34501DE35");
  });

  it("NUIT de Moçambique: 9 dígitos", () => {
    expect(nuitValido("400123456")).toBe(true);
    expect(nuitValido("40012345")).toBe(false);
  });
});

describe("cabeçalho", () => {
  it("aceita os sinônimos, sem acento nem caixa, e ignora coluna desconhecida", () => {
    const mapa = mapearCabecalho(["Razão Social", "CNPJ", "CNAE Principal", "Observação", "O que precisa"]);
    expect(mapa).toEqual({ ok: true, colunas: { nome: 0, documento: 1, cnae_principal: 2, o_que_precisa: 4 }, ignoradas: ["Observação"] });
  });

  it("coluna de senha, CPF ou nascimento recusa o arquivo inteiro", () => {
    expect(mapearCabecalho(["cnpj", "nome", "CPF"])).toEqual({ ok: false, codigo: "COLUNA_PROIBIDA", coluna: "CPF" });
    expect(mapearCabecalho(["cnpj", "nome", "Data de nascimento"])).toMatchObject({ ok: false, codigo: "COLUNA_PROIBIDA" });
    expect(mapearCabecalho(["cnpj", "nome", "senha"])).toMatchObject({ ok: false, codigo: "COLUNA_PROIBIDA" });
  });

  it("sem documento ou sem nome, falta coluna", () => {
    expect(mapearCabecalho(["nome", "uf"])).toEqual({ ok: false, codigo: "FALTA_COLUNA", coluna: "documento" });
    expect(mapearCabecalho(["cnpj", "uf"])).toEqual({ ok: false, codigo: "FALTA_COLUNA", coluna: "nome" });
  });

  it("a linha só leva os campos mapeados, sem célula vazia", () => {
    const mapa = mapearCabecalho(["cnpj", "nome", "uf"]);
    if (!mapa.ok) throw new Error("mapa");
    expect(linhaDaPlanilha([CNPJ, " Empresa A ", ""], mapa.colunas)).toEqual({ documento: CNPJ, nome: "Empresa A" });
  });
});

describe("CSV", () => {
  it("ponto e vírgula, aspas com aspas dentro, CRLF e BOM", () => {
    const texto = "﻿cnpj;nome;o_que_tem\r\n11.222.333/0001-81;\"Empresa \"\"A\"\"\";\"Pães; bolos\"\r\n\r\n";
    expect(lerCsv(texto)).toEqual([["cnpj", "nome", "o_que_tem"], ["11.222.333/0001-81", "Empresa \"A\"", "Pães; bolos"]]);
  });

  it("vírgula e tabulação, pelo separador que mais aparece no cabeçalho", () => {
    expect(lerCsv("cnpj,nome\n1,A")).toEqual([["cnpj", "nome"], ["1", "A"]]);
    expect(lerCsv("cnpj\tnome\n1\tA, B")).toEqual([["cnpj", "nome"], ["1", "A, B"]]);
  });

  it("quebra de linha dentro de aspas fica na célula", () => {
    expect(lerCsv("cnpj;nome\n1;\"Linha 1\nLinha 2\"")).toEqual([["cnpj", "nome"], ["1", "Linha 1\nLinha 2"]]);
  });
});

describe("validação da linha", () => {
  it("recusa documento ausente, inválido, CPF e nome ausente", () => {
    expect(validarLinha({ nome: "A" }, 2, "BR", HOJE)).toEqual({ ok: false, recusa: "DOCUMENTO_AUSENTE" });
    expect(validarLinha({ documento: "11.222.333/0001-80", nome: "A" }, 2, "BR", HOJE)).toEqual({ ok: false, recusa: "DOCUMENTO_INVALIDO" });
    expect(validarLinha({ documento: "529.982.247-25", nome: "A" }, 2, "BR", HOJE)).toEqual({ ok: false, recusa: "DOCUMENTO_E_CPF" });
    expect(validarLinha({ documento: CNPJ }, 2, "BR", HOJE)).toEqual({ ok: false, recusa: "NOME_AUSENTE" });
  });

  it("a CNAE é só guardada: nunca vira necessidade nem oferta escrita", () => {
    const r = validarLinha({ documento: CNPJ, nome: "Padaria Boa", cnae_principal: "1091-1/02", cnaes_secundarios: "4721-1/02; 1091102; xx" }, 2, "BR", HOJE);
    if (!r.ok) throw new Error("recusou");
    expect(r.valida.cnaePrincipal).toBe("1091102");
    expect(r.valida.cnaesSecundarios).toEqual(["4721102"]);
    expect(r.valida.preciso).toEqual([]);
    expect(r.valida.tenho).toEqual([]);
    expect(r.avisos).toContain("CNAE_INVALIDO");
    expect(r.avisos).not.toContain("SEM_OFERTA_NEM_NECESSIDADE");
  });

  it("com a tabela do IBGE (no servidor), o código que não existe sai com aviso próprio", () => {
    const existe = (c: string) => c === "1091102";
    const r = validarLinha({ documento: CNPJ, nome: "Padaria Boa", cnae_principal: "1091102", cnaes_secundarios: "9999999" }, 2, "BR", HOJE, { cnaeExiste: existe });
    if (!r.ok) throw new Error("recusou");
    expect(r.valida.cnaePrincipal).toBe("1091102");
    expect(r.valida.cnaesSecundarios).toEqual([]);
    expect(r.avisos).toEqual(["CNAE_INEXISTENTE"]);
    // Só código inexistente: a empresa entra sem oferta nem necessidade, e o aviso de "não conecta" volta.
    const so = validarLinha({ documento: CNPJ, nome: "Padaria Boa", cnae_principal: "9999999" }, 2, "BR", HOJE, { cnaeExiste: existe });
    expect(so).toMatchObject({ ok: true, avisos: ["CNAE_INEXISTENTE", "SEM_OFERTA_NEM_NECESSIDADE"], valida: { cnaePrincipal: null, preciso: [] } });
  });

  it("fora do Brasil a CNAE não vale, e o NUIT é o documento", () => {
    const r = validarLinha({ documento: "400123456", nome: "Empresa MZ", cnae_principal: "1091102", uf: "Maputo" }, 2, "MZ", HOJE);
    expect(r).toMatchObject({ ok: true, avisos: ["CNAE_FORA_DO_BRASIL", "SEM_OFERTA_NEM_NECESSIDADE"], valida: { cnaePrincipal: null, uf: "Maputo", documento: { tipo: "nuit" } } });
  });

  it("contato no texto livre é mascarado, e o item que repete o nome da empresa sai", () => {
    const r = validarLinha({ documento: CNPJ, nome: "Padaria Pão Bom", o_que_tem: "Pães artesanais; ligue (11) 98888-7777; Padaria Pão Bom delivery" }, 2, "BR", HOJE);
    if (!r.ok) throw new Error("recusou");
    expect(r.valida.tenho[0]).toBe("Pães artesanais");
    expect(r.valida.tenho).toHaveLength(2);
    expect(r.valida.tenho[1]).not.toContain("98888-7777");
    expect(r.valida.tenho.join(" ")).not.toMatch(/Padaria/);
    expect(r.avisos).toEqual(expect.arrayContaining(["CONTATO_NO_TEXTO", "ITEM_COM_NOME"]));
  });

  it("a necessidade leva a data da declaração; sem ela, o dia da carga e um aviso", () => {
    const comData = validarLinha({ documento: CNPJ, nome: "A", o_que_precisa: "Farinha", data_da_declaracao: "10/11/2026" }, 2, "BR", HOJE);
    expect(comData).toMatchObject({ ok: true, valida: { preciso: ["Farinha"], declaradoEm: Date.UTC(2026, 10, 10) } });
    const semData = validarLinha({ documento: CNPJ, nome: "A", o_que_precisa: "Farinha" }, 2, "BR", HOJE);
    expect(semData).toMatchObject({ ok: true, avisos: ["NECESSIDADE_SEM_DATA"], valida: { declaradoEm: HOJE } });
    const futura = validarLinha({ documento: CNPJ, nome: "A", o_que_precisa: "Farinha", data_da_declaracao: "01/01/2027" }, 2, "BR", HOJE);
    expect(futura).toMatchObject({ ok: true, avisos: ["DATA_INVALIDA"], valida: { declaradoEm: HOJE } });
  });

  it("itens repetidos saem, e o teto por lado avisa", () => {
    const muitos = Array.from({ length: ITENS_POR_LADO_MAX + 3 }, (_, i) => `Produto ${i}`).join(";");
    const r = validarLinha({ documento: CNPJ, nome: "A", o_que_tem: `Café; café ; ${muitos}` }, 2, "BR", HOJE);
    if (!r.ok) throw new Error("recusou");
    expect(r.valida.tenho).toHaveLength(ITENS_POR_LADO_MAX);
    expect(r.valida.tenho.filter(t => t.toLowerCase() === "café")).toHaveLength(1);
    expect(r.avisos).toContain("ITENS_DEMAIS");
  });

  it("UF, telefone e e-mail: o inválido sai com aviso", () => {
    const r = validarLinha({ documento: CNPJ, nome: "A", uf: "sp", telefone: "(11) 3456-7890", email: "Contato@Empresa.com.br", o_que_tem: "x1" }, 2, "BR", HOJE);
    expect(r).toMatchObject({ ok: true, avisos: [], valida: { uf: "SP", telefone: "1134567890", email: "contato@empresa.com.br" } });
    const ruim = validarLinha({ documento: CNPJ, nome: "A", uf: "XX", telefone: "12", email: "sem-arroba", o_que_tem: "x1" }, 2, "BR", HOJE);
    expect(ruim).toMatchObject({ ok: true, avisos: ["UF_INVALIDA", "TELEFONE_INVALIDO", "EMAIL_INVALIDO"], valida: { uf: null, telefone: null, email: null } });
  });
});

describe("datas e convênio", () => {
  it("lê dd/mm/aaaa, aaaa-mm-dd e a série do Excel; recusa data impossível", () => {
    expect(lerData("31/12/2025", HOJE)).toBe(Date.UTC(2025, 11, 31));
    expect(lerData("2025-01-05", HOJE)).toBe(Date.UTC(2025, 0, 5));
    expect(lerData("45658", HOJE)).toBe(Date.UTC(2025, 0, 1));
    expect(lerData("31/02/2025", HOJE)).toBeNull();
  });

  it("o convênio vale ativo e até o fim do dia do fim", () => {
    expect(convenioVigente({ estado: "ativo", fim: null }, HOJE)).toBe(true);
    expect(convenioVigente({ estado: "ativo", fim: HOJE }, HOJE + 3_600_000)).toBe(true);
    expect(convenioVigente({ estado: "ativo", fim: HOJE - 86_400_000 }, HOJE + 1)).toBe(false);
    expect(convenioVigente({ estado: "encerrado", fim: null }, HOJE)).toBe(false);
    expect(convenioVigente({ estado: "em_negociacao", fim: null }, HOJE)).toBe(false);
  });

  it("CNAE: só a forma de 7 dígitos", () => {
    expect(normalizarCnae("4711-3/02")).toBe("4711302");
    expect(normalizarCnae("47113")).toBeNull();
  });
});
