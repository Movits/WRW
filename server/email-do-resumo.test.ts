import { describe, expect, it } from "vitest";
import { IDIOMAS_DA_REUNIAO } from "@shared/idioma-da-reuniao";
import { valoresDoEmailDoResumo } from "@shared/resumo-por-email";
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
    expect(email.html).toContain("Glenda compartilhou com você o resumo da reunião “Reunião com a Apex”, gravada na Marquesa Global Match.");
    expect(email.html).toContain(`href="${ABERTO}"`);
    expect(email.text).toContain(`Abrir o resumo: ${ABERTO}`);
    expect(email.html).toContain("Quem tiver este link abre a reunião.");
    expect(email.text).toContain("Você recebeu este e-mail porque Glenda o mandou a você pela Marquesa Global Match.");
    expect(email.html).toContain('<html lang="pt-BR" dir="ltr">');
  });

  it("conta sem nome: o texto que não fala de ninguém, e não uma marca vazia", () => {
    const email = montarEmailDoResumo({ ...base, dona: "   ", modelo: "participante" });
    expect(email.assunto).toBe("O resumo de uma reunião foi compartilhado com você");
    expect(email.text).toContain("Você recebeu o resumo da reunião “Reunião com a Apex”, gravada na Marquesa Global Match.");
    expect(email.text).not.toMatch(/\{\{|\}\}/);
  });

  it("à própria dona: o link aberto, para guardar ou encaminhar, sem o texto de quem recebe de outra pessoa", () => {
    const email = montarEmailDoResumo({ ...base, modelo: "dona" });
    expect(email.assunto).toBe("O link aberto da sua reunião “Reunião com a Apex”");
    expect(email.text).toContain("Você recebeu este e-mail porque pediu à Marquesa Global Match que o mandasse a você.");
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
    // O endereço de e-mail do título também sai (o teste abaixo).
    expect(email.assunto).toBe("O link aberto da sua reunião “Linha 1 Bcc: …”");
    const participante = montarEmailDoResumo({ ...base, dona: "Glen\nda\u0007", modelo: "participante" });
    expect(participante.assunto).toBe("Glen da compartilhou com você o resumo de uma reunião");
  });

  it("endereço web no título ou no nome não chega ao e-mail: o único link é o da Marquesa Global Match", () => {
    const email = montarEmailDoResumo({ ...base, titulo: "Oferta em https://golpe.example/x e WWW.golpe.example", dona: "Glenda http://golpe.example", modelo: "participante" });
    for (const parte of [email.assunto, email.html, email.text]) {
      expect(parte).not.toMatch(/golpe\.example/i);
    }
    expect(email.text).toContain("“Oferta em … e …”");
    expect(email.assunto).toBe("Glenda … compartilhou com você o resumo de uma reunião");
    expect(email.html.match(/href="/g)).toHaveLength(2);
  });

  it("nem o domínio sem esquema, nem o endereço de e-mail, nem o esquema colado a uma palavra: o app de e-mail os faria link", () => {
    const golpes = [
      ["Pague a taxa em golpe.com.br/pix ou fale com contato@golpe.example", "Suporte bit.ly/wrw-premio"],
      ["Resgate seu Pix em premio-pix.com.br/resgate", "Glenda golpe.example"],
      ["Ganhehttps://golpe.example/x e bit.ly/3abc", "Ana a@golpe.example"],
      // O ponto japonês e o de largura cheia, que alguns clientes também aceitam.
      ["Acesse golpe。com/x já", "Glenda golpe．com"],
    ] as const;
    for (const [titulo, dona] of golpes) {
      const email = montarEmailDoResumo({ ...base, titulo, dona, modelo: "participante" });
      for (const parte of [email.assunto, email.html, email.text]) {
        expect(parte, titulo).not.toMatch(/golpe|bit\.ly|premio-pix/i);
      }
      // Os únicos links seguem os dois da Marquesa Global Match: o botão e o endereço por extenso.
      expect(email.html.match(/href="/g), titulo).toHaveLength(2);
    }
    const primeiro = montarEmailDoResumo({ ...base, titulo: golpes[0][0], dona: golpes[0][1], modelo: "participante" });
    expect(primeiro.assunto).toBe("Suporte … compartilhou com você o resumo de uma reunião");
    expect(primeiro.text).toContain("“Pague a taxa em … ou fale com …”");
    // A prévia da tela passa pela mesma função, e mostra o mesmo.
    expect(valoresDoEmailDoResumo(golpes[1][0], golpes[1][1])).toEqual({ titulo: "Resgate seu Pix em …", dona: "Glenda …" });
  });

  it("o que não é endereço fica: número com ponto, abreviação, o ponto que fecha frase em japonês", () => {
    for (const titulo of ["Reunião 1.2 com a Apex", "Proposta de R$ 1.500,00 (e.g. frete)", "Dra. Glenda e S.A.", "会議。次回の予定", "Planejamento Q3.2026 às 10:30"]) {
      expect(valoresDoEmailDoResumo(titulo, "Glenda").titulo).toBe(titulo);
    }
  });

  // Pacote 4d: o e-mail (H22) segue a senha e o áudio do link aberto (H23).
  const COM_AUDIO = "Pelo link, você lê o resumo e a transcrição, ouve a gravação enquanto ela estiver guardada e pode fazer perguntas à IA sobre a reunião.";
  const SEM_AUDIO = "Pelo link, você lê o resumo e a transcrição e pode fazer perguntas à IA sobre a reunião. Não precisa ter conta na Marquesa Global Match.";
  const SENHA = "Este link pede uma senha de 6 dígitos, que não vai neste e-mail: peça a senha a Glenda.";
  const SENHA_SEM_NOME = "Este link pede uma senha de 6 dígitos, que não vai neste e-mail: peça a senha a quem gravou a reunião.";
  const SENHA_DA_DONA = "Este link pede a senha de 6 dígitos que você criou, e ela não vai neste e-mail. Ao encaminhar o link, mande a senha à parte.";
  const AVISO = "Quem tiver este link abre a reunião. Não o encaminhe a quem não deve ver o que foi dito.";
  const AVISO_COM_SENHA = "Quem tiver este link e a senha abre a reunião. Não encaminhe o link nem a senha a quem não deve ver o que foi dito.";

  it("o link sem o áudio (H23): o texto não promete a gravação, às participantes e à dona", () => {
    for (const modelo of ["participante", "dona"] as const) {
      const email = montarEmailDoResumo({ ...base, modelo, link: { comSenha: false, comAudio: false } });
      expect(email.text, modelo).toContain(SEM_AUDIO);
      expect(email.html, modelo).toContain(SEM_AUDIO);
      expect(email.text, modelo).not.toContain("ouve a gravação");
      expect(email.text, modelo).not.toContain("senha");
    }
  });

  it("o link com a senha (H23): um parágrafo diz que ela não vai no e-mail e a quem pedi-la; à dona, que ela a manda à parte", () => {
    const comNome = montarEmailDoResumo({ ...base, modelo: "participante", link: { comSenha: true, comAudio: true } });
    expect(comNome.text).toContain(`${COM_AUDIO} Não precisa ter conta na Marquesa Global Match.\n\n${SENHA}\n\nAbrir o resumo: ${ABERTO}`);
    expect(comNome.html).toContain(SENHA);
    const semNome = montarEmailDoResumo({ ...base, dona: null, modelo: "participante", link: { comSenha: true, comAudio: false } });
    expect(semNome.text).toContain(`${SEM_AUDIO}\n\n${SENHA_SEM_NOME}`);
    const daDona = montarEmailDoResumo({ ...base, modelo: "dona", link: { comSenha: true, comAudio: true } });
    expect(daDona.text).toContain(SENHA_DA_DONA);
    expect(daDona.text).not.toContain(SENHA);
  });

  // Conferência de tela do Pacote 4d: com a senha, o aviso dizia "Quem tiver
  // este link abre a reunião", logo abaixo do parágrafo que pede a senha.
  it("o link com a senha (H23): o aviso de encaminhamento fala do link e da senha, e não diz que basta o link, às participantes e à dona", () => {
    for (const modelo of ["participante", "dona"] as const) {
      for (const comAudio of [true, false]) {
        const email = montarEmailDoResumo({ ...base, modelo, link: { comSenha: true, comAudio } });
        expect(email.text, modelo).toContain(`${AVISO_COM_SENHA}\n\n`);
        expect(email.html, modelo).toContain(AVISO_COM_SENHA);
        expect(email.text, modelo).not.toContain("Quem tiver este link abre a reunião.");
        expect(email.html, modelo).not.toContain("Quem tiver este link abre a reunião.");
      }
      // Sem a senha, e no link de antes da H23, o aviso de sempre.
      for (const link of [{ comSenha: false, comAudio: true }, { comSenha: false, comAudio: false }, undefined]) {
        const email = montarEmailDoResumo({ ...base, modelo, link });
        expect(email.text, modelo).toContain(AVISO);
        expect(email.text, modelo).not.toContain(AVISO_COM_SENHA);
      }
    }
    // O automático leva o link da conta: nenhum dos dois avisos.
    const pronto = montarEmailDoResumo({ ...base, endereco: NA_CONTA, modelo: "pronto", link: { comSenha: true, comAudio: true } });
    expect(pronto.text).not.toContain(AVISO_COM_SENHA);
    expect(pronto.text).not.toContain(AVISO);
  });

  it("o aviso com a senha nos 10 idiomas: sem marca, diferente do aviso sem senha, e é ele que vai no e-mail do link com senha", () => {
    for (const idioma of IDIOMAS_DA_REUNIAO) {
      const textos = TEXTOS_DO_EMAIL_DO_RESUMO[idioma];
      expect(textos.avisoComSenha, idioma).not.toMatch(/\{\{/);
      expect(textos.avisoComSenha, idioma).not.toBe(textos.aviso);
      for (const modelo of ["participante", "dona"] as const) {
        const comSenha = montarEmailDoResumo({ ...base, idioma, modelo, link: { comSenha: true, comAudio: true } });
        expect(comSenha.text, `${idioma} ${modelo}`).toContain(textos.avisoComSenha);
        expect(comSenha.text, `${idioma} ${modelo}`).not.toContain(textos.aviso);
        const semSenha = montarEmailDoResumo({ ...base, idioma, modelo, link: { comSenha: false, comAudio: true } });
        expect(semSenha.text, `${idioma} ${modelo}`).toContain(textos.aviso);
        expect(semSenha.text, `${idioma} ${modelo}`).not.toContain(textos.avisoComSenha);
      }
    }
  });

  it("sem o link, o de antes da H23 (com o áudio, sem senha); e o automático, que leva o link da conta, não muda com o link aberto", () => {
    const antes = montarEmailDoResumo({ ...base, modelo: "participante" });
    expect(antes.text).toContain(COM_AUDIO);
    expect(antes.text).not.toContain("senha");
    const nulo = montarEmailDoResumo({ ...base, modelo: "participante", link: null });
    expect(nulo.text).toBe(antes.text);
    const pronto = montarEmailDoResumo({ ...base, endereco: NA_CONTA, modelo: "pronto", link: { comSenha: true, comAudio: false } });
    expect(pronto.text).toBe(montarEmailDoResumo({ ...base, endereco: NA_CONTA, modelo: "pronto" }).text);
    expect(pronto.text).not.toContain("6 dígitos");
  });

  it("os textos da senha e do link sem o áudio nos 10 idiomas: a marca do nome só no da senha com nome", () => {
    for (const idioma of IDIOMAS_DA_REUNIAO) {
      const textos = TEXTOS_DO_EMAIL_DO_RESUMO[idioma];
      expect(textos.senha, idioma).toContain("{{dona}}");
      for (const chave of ["senhaSemNome", "senhaDona", "oQueAbreSemAudio"] as const) expect(textos[chave], `${idioma}.${chave}`).not.toMatch(/\{\{/);
      expect(textos.oQueAbreSemAudio, idioma).not.toBe(textos.oQueAbre);
      expect(textos.senha, idioma).toMatch(/6/);
      const email = montarEmailDoResumo({ ...base, idioma, modelo: "participante", link: { comSenha: true, comAudio: false } });
      expect(email.text, idioma).toContain(preencher(textos.senha, { dona: "Glenda" }));
      expect(email.text, idioma).toContain(textos.oQueAbreSemAudio);
      expect(email.text, idioma).not.toContain(textos.oQueAbre);
    }
  });

  // A junção do Pacote 4c com o 4d: a reunião de documento (H12 e H12b) e a de
  // vídeo do YouTube (H13) não têm gravação, e o e-mail dizia "gravada na Marquesa Global Match",
  // "ouve a gravação" (com o link ligado com o áudio) e "quem gravou a reunião".
  const GRAVACAO = /gravaç|gravad|gravou/i;
  const ABERTURA_SEM_GRAVACAO = "Glenda compartilhou com você o resumo de “Reunião com a Apex”, feito na Marquesa Global Match.";
  const ABERTURA_SEM_GRAVACAO_SEM_NOME = "Você recebeu o resumo de “Reunião com a Apex”, feito na Marquesa Global Match.";
  const SENHA_SEM_NOME_SEM_GRAVACAO = "Este link pede uma senha de 6 dígitos, que não vai neste e-mail: peça a senha a quem compartilhou o resumo com você.";
  const POR_QUE_SEM_NOME_SEM_GRAVACAO = "Você recebeu este e-mail porque quem compartilhou o resumo o mandou a você pela Marquesa Global Match. Se não esperava por ele, pode ignorá-lo.";

  it("a reunião sem gravação (documento e vídeo): nem a promessa da gravação, nem 'gravada', nem 'quem gravou', com o link como estiver", () => {
    const links = [{ comSenha: true, comAudio: true }, { comSenha: false, comAudio: true }, { comSenha: true, comAudio: false }, { comSenha: false, comAudio: false }, undefined];
    for (const modelo of ["participante", "dona"] as const) {
      for (const dona of ["Glenda", null]) {
        for (const link of links) {
          const email = montarEmailDoResumo({ ...base, dona, modelo, link, semGravacao: true });
          const caso = `${modelo}, ${dona ?? "sem nome"}, ${JSON.stringify(link)}`;
          for (const parte of [email.assunto, email.text, email.html]) expect(parte, caso).not.toMatch(GRAVACAO);
          expect(email.text, caso).toContain(SEM_AUDIO);
        }
      }
    }
    const comNome = montarEmailDoResumo({ ...base, modelo: "participante", link: { comSenha: true, comAudio: true }, semGravacao: true });
    expect(comNome.text).toContain(`${ABERTURA_SEM_GRAVACAO}\n\n${SEM_AUDIO}\n\n${SENHA}`);
    expect(comNome.html).toContain(ABERTURA_SEM_GRAVACAO);
    const semNome = montarEmailDoResumo({ ...base, dona: null, modelo: "participante", link: { comSenha: true, comAudio: true }, semGravacao: true });
    expect(semNome.text).toContain(`${ABERTURA_SEM_GRAVACAO_SEM_NOME}\n\n${SEM_AUDIO}\n\n${SENHA_SEM_NOME_SEM_GRAVACAO}`);
    expect(semNome.text).toContain(POR_QUE_SEM_NOME_SEM_GRAVACAO);
    expect(semNome.html).toContain(POR_QUE_SEM_NOME_SEM_GRAVACAO);
    // À dona, o texto dela, sem a promessa da gravação.
    const daDona = montarEmailDoResumo({ ...base, modelo: "dona", link: { comSenha: true, comAudio: true }, semGravacao: true });
    expect(daDona.text).toContain(SENHA_DA_DONA);
    expect(daDona.text).not.toContain(ABERTURA_SEM_GRAVACAO);
  });

  it("a reunião gravada segue com o texto da gravação: semGravacao falso é o e-mail de sempre", () => {
    for (const dona of ["Glenda", null]) {
      const link = { comSenha: true, comAudio: true };
      const gravada = montarEmailDoResumo({ ...base, dona, modelo: "participante", link, semGravacao: false });
      expect(gravada.text).toBe(montarEmailDoResumo({ ...base, dona, modelo: "participante", link }).text);
      expect(gravada.text).toContain(COM_AUDIO);
    }
    expect(montarEmailDoResumo({ ...base, dona: null, modelo: "participante", link: { comSenha: true, comAudio: true } }).text).toContain(SENHA_SEM_NOME);
  });

  it("os textos sem gravação nos 10 idiomas: as marcas certas, outros que os da gravação, e são eles que vão no e-mail", () => {
    const PARES = [
      ["aberturaSemGravacao", "abertura"],
      ["aberturaSemNomeSemGravacao", "aberturaSemNome"],
      ["senhaSemNomeSemGravacao", "senhaSemNome"],
      ["porQueSemNomeSemGravacao", "porQueSemNome"],
    ] as const;
    for (const idioma of IDIOMAS_DA_REUNIAO) {
      const textos = TEXTOS_DO_EMAIL_DO_RESUMO[idioma];
      expect(textos.aberturaSemGravacao, idioma).toContain("{{dona}}");
      expect(textos.aberturaSemGravacao, idioma).toContain("{{titulo}}");
      expect(textos.aberturaSemNomeSemGravacao, idioma).toContain("{{titulo}}");
      for (const chave of ["aberturaSemNomeSemGravacao", "senhaSemNomeSemGravacao", "porQueSemNomeSemGravacao"] as const) {
        expect(textos[chave], `${idioma}.${chave}`).not.toContain("{{dona}}");
      }
      for (const [semGravacao, daGravacao] of PARES) expect(textos[semGravacao], `${idioma}.${semGravacao}`).not.toBe(textos[daGravacao]);
      expect(textos.senhaSemNomeSemGravacao, idioma).toMatch(/6/);

      const valores = valoresDoEmailDoResumo(base.titulo, null);
      const semNome = montarEmailDoResumo({ ...base, idioma, dona: null, modelo: "participante", link: { comSenha: true, comAudio: true }, semGravacao: true });
      for (const chave of ["aberturaSemNomeSemGravacao", "oQueAbreSemAudio", "senhaSemNomeSemGravacao", "porQueSemNomeSemGravacao"] as const) {
        expect(semNome.text, `${idioma}.${chave}`).toContain(preencher(textos[chave], valores));
      }
      for (const chave of ["aberturaSemNome", "oQueAbre", "senhaSemNome", "porQueSemNome"] as const) {
        expect(semNome.text, `${idioma}.${chave}`).not.toContain(preencher(textos[chave], valores));
      }
      const comNome = montarEmailDoResumo({ ...base, idioma, modelo: "participante", semGravacao: true });
      expect(comNome.text, idioma).toContain(preencher(textos.aberturaSemGravacao, valoresDoEmailDoResumo(base.titulo, base.dona)));
      expect(comNome.text, idioma).not.toContain(preencher(textos.abertura, valoresDoEmailDoResumo(base.titulo, base.dona)));
    }
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
