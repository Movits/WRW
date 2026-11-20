import { describe, expect, it } from "vitest";
import { IDIOMAS_DA_REUNIAO } from "@shared/idioma-da-reuniao";
import {
  linhaLimpa,
  montarEmailDoResumo,
  NOME_DA_DONA_NO_EMAIL_MAX,
  preencher,
  TEXTOS_DO_EMAIL_DO_RESUMO,
  TITULO_NO_EMAIL_MAX,
} from "./email-do-resumo";

/**
 * O texto do e-mail do resumo (H22): fixo, das chaves emailDoResumo.* dos 10
 * idiomas, com só o título da reunião e o nome da conta da dona por dentro. O
 * que vai a quem recebe é isto e o link; nada de campo livre.
 */

const ABERTO = "https://wrw.teste/r/AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const NA_CONTA = "https://wrw.teste/meetings/8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const base = { idioma: "pt-BR" as const, titulo: "Reunião com a Apex", dona: "Glenda", endereco: ABERTO };

describe("os textos nos 10 idiomas", () => {
  it("todo idioma da reunião tem o e-mail inteiro, sem chave vazia, e com as mesmas marcas do português", () => {
    const marcas = (texto: string) => (texto.match(/\{\{\w+\}\}/g) ?? []).sort().join(",");
    const referencia = TEXTOS_DO_EMAIL_DO_RESUMO["pt-BR"];
    for (const idioma of IDIOMAS_DA_REUNIAO) {
      const textos = TEXTOS_DO_EMAIL_DO_RESUMO[idioma];
      expect(Object.keys(textos)).toEqual(Object.keys(referencia));
      for (const [chave, texto] of Object.entries(textos)) {
        expect(texto.trim(), `${idioma}.${chave}`).not.toBe("");
        expect(marcas(texto), `${idioma}.${chave}`).toBe(marcas(referencia[chave as keyof typeof referencia]));
      }
    }
  });

  it("os idiomas que não são o português foram traduzidos (o texto principal não é cópia do pt-BR)", () => {
    for (const idioma of IDIOMAS_DA_REUNIAO.filter(i => i !== "pt-BR")) {
      expect(TEXTOS_DO_EMAIL_DO_RESUMO[idioma].oQueAbre, idioma).not.toBe(TEXTOS_DO_EMAIL_DO_RESUMO["pt-BR"].oQueAbre);
    }
  });
});

describe("montarEmailDoResumo", () => {
  it("às participantes: o nome da dona no assunto e na abertura, o título só no corpo, o link aberto no botão e no texto", () => {
    const email = montarEmailDoResumo({ ...base, modelo: "participante" });
    expect(email.assunto).toBe("Glenda compartilhou com você o resumo de uma reunião");
    expect(email.html).toContain("Glenda compartilhou com você o resumo da reunião “Reunião com a Apex”, gravada na WRW.");
    expect(email.html).toContain(`href="${ABERTO}"`);
    expect(email.text).toContain(`Abrir o resumo: ${ABERTO}`);
    expect(email.html).toContain("Quem tiver este link abre a reunião.");
    expect(email.text).toContain("Você recebeu este e-mail porque Glenda o mandou a você pela WRW.");
    expect(email.html).toContain('<html lang="pt-BR" dir="ltr">');
  });

  it("conta sem nome: o texto que não fala de ninguém, e não uma marca vazia", () => {
    const email = montarEmailDoResumo({ ...base, dona: "   ", modelo: "participante" });
    expect(email.assunto).toBe("O resumo de uma reunião foi compartilhado com você");
    expect(email.text).toContain("Você recebeu o resumo da reunião “Reunião com a Apex”, gravada na WRW.");
    expect(email.text).not.toMatch(/\{\{|\}\}/);
  });

  it("à própria dona: o link aberto, para guardar ou encaminhar, sem o texto de quem recebe de outra pessoa", () => {
    const email = montarEmailDoResumo({ ...base, modelo: "dona" });
    expect(email.assunto).toBe("O link aberto da sua reunião “Reunião com a Apex”");
    expect(email.text).toContain("Você recebeu este e-mail porque pediu à WRW que o mandasse a você.");
    expect(email.text).not.toContain("Glenda o mandou");
  });

  it("o automático: o link da reunião na conta, o aviso de que pede entrar, e sem o aviso do link aberto", () => {
    const email = montarEmailDoResumo({ ...base, endereco: NA_CONTA, modelo: "pronto" });
    expect(email.assunto).toBe("O resumo da reunião “Reunião com a Apex” está pronto");
    expect(email.html).toContain(`href="${NA_CONTA}"`);
    expect(email.text).toContain("é preciso entrar com o seu e-mail e a sua senha");
    expect(email.text).not.toContain("Quem tiver este link abre a reunião.");
  });

  it("no idioma da reunião, e em árabe da direita para a esquerda, com o endereço sempre da esquerda para a direita", () => {
    const ingles = montarEmailDoResumo({ ...base, idioma: "en", modelo: "participante" });
    expect(ingles.assunto).toBe("Glenda shared a meeting summary with you");
    const arabe = montarEmailDoResumo({ ...base, idioma: "ar", modelo: "participante" });
    expect(arabe.assunto).toBe("شاركت Glenda معك ملخص اجتماع");
    expect(arabe.html).toContain('<html lang="ar" dir="rtl">');
    expect(arabe.html).toContain('<body dir="rtl"');
    expect(arabe.html).toContain(`<p dir="ltr" style="margin:0 0 24px;font-size:12px;line-height:1.5;word-break:break-all;text-align:left;"><a href="${ABERTO}"`);
    const japones = montarEmailDoResumo({ ...base, idioma: "ja", modelo: "pronto", endereco: NA_CONTA });
    expect(japones.assunto).toBe("ミーティング「Reunião com a Apex」の要約ができました");
  });

  it("o título e o nome vêm escapados: HTML de quem escreveu não vira HTML do e-mail", () => {
    const email = montarEmailDoResumo({ ...base, titulo: `<script>alert("x")</script> & "aspas"`, dona: "<b>Glenda</b>", modelo: "participante" });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<b>Glenda</b>");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;aspas&quot;");
    expect(email.html).toContain("&lt;b&gt;Glenda&lt;/b&gt;");
  });

  it("o assunto é uma linha só: quebra e caractere de controle do título ou do nome não entram no cabeçalho", () => {
    const email = montarEmailDoResumo({ ...base, titulo: "Linha 1\r\nBcc: alguem@x.invalid", dona: "Glen\nda\u0007", modelo: "dona" });
    expect(email.assunto).not.toMatch(/[\r\n\u0000-\u001F]/);
    expect(email.assunto).toBe("O link aberto da sua reunião “Linha 1 Bcc: alguem@x.invalid”");
    const participante = montarEmailDoResumo({ ...base, dona: "Glen\nda\u0007", modelo: "participante" });
    expect(participante.assunto).toBe("Glen da compartilhou com você o resumo de uma reunião");
  });

  it("endereço web no título ou no nome não chega ao e-mail: o único link é o da WRW", () => {
    const email = montarEmailDoResumo({ ...base, titulo: "Oferta em https://golpe.example/x e WWW.golpe.example", dona: "Glenda http://golpe.example", modelo: "participante" });
    for (const parte of [email.assunto, email.html, email.text]) {
      expect(parte).not.toMatch(/golpe\.example/i);
    }
    expect(email.text).toContain("“Oferta em … e …”");
    expect(email.assunto).toBe("Glenda … compartilhou com você o resumo de uma reunião");
    expect(email.html.match(/href="/g)).toHaveLength(2);
  });

  it("título e nome longos são cortados", () => {
    const email = montarEmailDoResumo({ ...base, titulo: "t".repeat(500), dona: "n".repeat(500), modelo: "participante" });
    expect(email.text).toContain(`“${"t".repeat(TITULO_NO_EMAIL_MAX)}”`);
    expect(email.text).not.toContain("t".repeat(TITULO_NO_EMAIL_MAX + 1));
    expect(email.text).not.toContain("n".repeat(NOME_DA_DONA_NO_EMAIL_MAX + 1));
  });
});

describe("as peças", () => {
  it("preencher troca só as marcas que vieram, e o valor com {{ não é lido de novo", () => {
    expect(preencher("{{a}} e {{b}}", { a: "{{b}}" })).toBe("{{b}} e {{b}}");
    expect(preencher("{{titulo}}", { titulo: "$& $1" })).toBe("$& $1");
  });

  it("linhaLimpa: sem controle, sem espaço repetido, cortada sem partir emoji ao meio", () => {
    expect(linhaLimpa("  a\tb\n\nc  ", 50)).toBe("a b c");
    expect(linhaLimpa(null, 10)).toBe("");
    expect(linhaLimpa("😀😀😀", 2)).toBe("😀😀");
  });
});
