import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodificarCsv, lerPlanilha, PlanilhaIlegivel, sha256DoArquivo } from "./ler-planilha";

/**
 * O leitor da planilha da entidade (N1) no aparelho: CSV em UTF-8 ou
 * Windows-1252 e XLSX (ZIP de XMLs) sem biblioteca nova. O ZIP de teste é
 * montado aqui, com os arquivos que o Excel grava.
 */
function zip(arquivos: Record<string, string>, comprimir = true): ArrayBuffer {
  const enc = new TextEncoder();
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let deslocamento = 0;
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const nomeB = enc.encode(nome);
    const cru = enc.encode(conteudo);
    const dados = comprimir ? new Uint8Array(deflateRawSync(cru)) : cru;
    const local = new Uint8Array(30 + nomeB.length);
    const dl = new DataView(local.buffer);
    dl.setUint32(0, 0x04034b50, true); dl.setUint16(8, comprimir ? 8 : 0, true);
    dl.setUint32(18, dados.length, true); dl.setUint32(22, cru.length, true); dl.setUint16(26, nomeB.length, true);
    local.set(nomeB, 30);
    const central = new Uint8Array(46 + nomeB.length);
    const dc = new DataView(central.buffer);
    dc.setUint32(0, 0x02014b50, true); dc.setUint16(10, comprimir ? 8 : 0, true);
    dc.setUint32(20, dados.length, true); dc.setUint32(24, cru.length, true); dc.setUint16(28, nomeB.length, true);
    dc.setUint32(42, deslocamento, true);
    central.set(nomeB, 46);
    locais.push(local, dados); centrais.push(central);
    deslocamento += local.length + dados.length;
  }
  const tamCentral = centrais.reduce((s, c) => s + c.length, 0);
  const fim = new Uint8Array(22);
  const df = new DataView(fim.buffer);
  df.setUint32(0, 0x06054b50, true); df.setUint16(8, centrais.length, true); df.setUint16(10, centrais.length, true);
  df.setUint32(12, tamCentral, true); df.setUint32(16, deslocamento, true);
  const partes = [...locais, ...centrais, fim];
  const total = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const parte of partes) { total.set(parte, p); p += parte.length; }
  return total.buffer;
}

const XLSX = {
  "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Associados" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/></Relationships>`,
  "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>cnpj</t></si><si><t>nome</t></si><si><r><t>Empresa </t></r><r><t>Ação</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>data</t></is></c></row>
    <row r="2"><c r="A2" t="str"><v>11.222.333/0001-81</v></c><c r="B2" t="s"><v>2</v></c><c r="D2"><v>45658</v></c></row>
    <row r="3"></row>
  </sheetData></worksheet>`,
};

describe("lerPlanilha", () => {
  it("XLSX: primeira aba, textos compartilhados (com trechos), texto em linha, número e coluna pulada", async () => {
    expect(await lerPlanilha("associados.xlsx", zip(XLSX))).toEqual([
      ["cnpj", "nome", "", "data"],
      ["11.222.333/0001-81", "Empresa Ação", "", "45658"],
    ]);
  });

  it("XLSX sem compressão também", async () => {
    expect((await lerPlanilha("a.xlsx", zip(XLSX, false)))[1][1]).toBe("Empresa Ação");
  });

  it("CSV em UTF-8 e em Windows-1252 (o Excel em português)", async () => {
    const utf8 = new TextEncoder().encode("cnpj;nome\n1;Ação").buffer;
    expect(await lerPlanilha("a.csv", utf8)).toEqual([["cnpj", "nome"], ["1", "Ação"]]);
    const latin1 = new Uint8Array([0x41, 0xe7, 0xe3, 0x6f]); // "Ação" em Windows-1252
    expect(decodificarCsv(latin1)).toBe("Ação");
  });

  it("formato desconhecido, zip quebrado e planilha só com cabeçalho recusam com código", async () => {
    const codigo = (p: Promise<unknown>) => p.then(() => null, e => (e instanceof PlanilhaIlegivel ? e.codigo : String(e)));
    expect(await codigo(lerPlanilha("a.pdf", new ArrayBuffer(4)))).toBe("FORMATO_DESCONHECIDO");
    expect(await codigo(lerPlanilha("a.xlsx", new Uint8Array([0x50, 0x4b, 1, 2]).buffer))).toBe("PLANILHA_ILEGIVEL");
    expect(await codigo(lerPlanilha("a.csv", new TextEncoder().encode("cnpj;nome\n").buffer))).toBe("PLANILHA_VAZIA");
  });

  it("o SHA-256 do arquivo", async () => {
    expect(await sha256DoArquivo(new TextEncoder().encode("abc").buffer))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
