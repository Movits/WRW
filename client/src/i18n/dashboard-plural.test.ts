import { describe, expect, it } from "vitest";
import i18next from "i18next";
import { opcoesBase } from "./index";

/**
 * Plural do Dashboard (reverificação de 04/09, major 25): a saudação, o botão
 * de convites e o contador de salas eram plural feito à mão em português
 * ("novo{s} match{es}", "convite{s}", "sala(s)"); o toast de reanálise era
 * "novo(s) match(es)" nos 10 idiomas e os anos de experiência da aba Perfil
 * saíam "1 anos"/"1 years"/"1 лет". Agora são chaves com as 6 formas CLDR nos
 * 10 idiomas. O que este teste prova é a RESOLUÇÃO: russo põe
 * 5 em "many" e 2 em "few"; árabe tem dual (2) e "few" (3–10) e "many"
 * (11–99); o i18next NÃO cai de _many/_few para _other — cai para o idioma de
 * fallback. Uma forma faltando em ru.json devolveria o texto em português.
 *
 * Instância própria com os 10 JSONs e as opções do app (opcoesBase, mesmo
 * molde de deteccao-de-idioma.test.ts), MENOS o fallback: `fallbackLng: false`.
 * Com o fallback do app (pt-BR), uma forma faltando em ru.json devolvia o
 * texto em português — o teste só pegava porque o regex PORTUGUES reconhece
 * "novo"/"convite" — e `exists("…_many", { lng: "ru" })` respondia true
 * consultando o pt-BR, logo a paridade das 6 formas passava com ru.json
 * incompleto. Sem fallback, forma ausente vira a CHAVE crua
 * ("dashboard.greetingUnseen"), que nenhum `toBe` aceita, `exists` responde
 * false e a varredura abaixo rejeita explicitamente. O que se prova é o
 * plural, não a tela (a tela está em pages/Dashboard.i18n.test.tsx).
 */

async function instancia() {
  const i18n = i18next.createInstance();
  await i18n.init({ ...opcoesBase(), fallbackLng: false });
  return i18n;
}

const CHAVES = [
  "dashboard.greetingUnseen", "dashboard.greetingTotal", "dashboard.pendingInvites", "dashboard.roomsOnPlatform",
  "dashboard.newMatches", "dashboard.years",
] as const;
const CONTAGENS = [1, 2, 5, 21];
// Pedaços que só existem no texto em português: se aparecem em ru/ar, a
// chave caiu no fallback.
const PORTUGUES = /novo|nova|conexão|conexões|sugerida|convite|sala|oportunidade|encontrad|\bano/;

describe("plural do Dashboard — russo e árabe não caem no português", () => {
  it("sem fallback de idioma: forma ausente devolve a chave crua, não o pt-BR (premissa da varredura)", async () => {
    const i18n = await instancia();
    expect(i18n.options.fallbackLng).toBe(false);
    // Chave que não existe em idioma nenhum: volta como veio, sem "pt-BR" no caminho.
    expect(i18n.getFixedT("ru")("dashboard.chaveQueNaoExiste", { count: 5 })).toBe("dashboard.chaveQueNaoExiste");
    expect(i18n.exists("dashboard.chaveQueNaoExiste_many", { lng: "ru" })).toBe(false);
  });

  it("russo: 1/21 na forma one, 2 em few, 5 em many — nas seis chaves", async () => {
    const t = (await instancia()).getFixedT("ru");
    for (const chave of CHAVES) for (const count of CONTAGENS) {
      expect(t(chave, { count }), `${chave} count=${count}`).not.toMatch(PORTUGUES);
    }
    expect(t("dashboard.greetingUnseen", { count: 1 })).toBe("1 новая предложенная связь");
    expect(t("dashboard.greetingUnseen", { count: 2 })).toBe("2 новые предложенные связи");
    expect(t("dashboard.greetingUnseen", { count: 5 })).toBe("5 новых предложенных связей");
    expect(t("dashboard.greetingUnseen", { count: 21 })).toBe("21 новая предложенная связь");
    expect(t("dashboard.pendingInvites", { count: 1 })).toBe("1 приглашение ждёт ответа");
    expect(t("dashboard.pendingInvites", { count: 5 })).toBe("5 приглашений ждут ответа");
    expect(t("dashboard.roomsOnPlatform", { count: 2 })).toBe("2 комнаты на платформе");
    expect(t("dashboard.roomsOnPlatform", { count: 5 })).toBe("5 комнат на платформе");
    expect(t("dashboard.greetingTotal", { count: 1 })).toBe("Для вас найдена 1 совместимая возможность");
    expect(t("dashboard.greetingTotal", { count: 21 })).toBe("Для вас найдена 21 совместимая возможность");
    expect(t("dashboard.newMatches", { count: 1 })).toBe("✨ Найдена 1 новая предложенная связь!");
    expect(t("dashboard.newMatches", { count: 2 })).toBe("✨ Найдены 2 новые предложенные связи!");
    expect(t("dashboard.newMatches", { count: 5 })).toBe("✨ Найдено 5 новых предложенных связей!");
    expect(t("dashboard.newMatches", { count: 21 })).toBe("✨ Найдена 21 новая предложенная связь!");
    expect(t("dashboard.years", { count: 1 })).toBe("1 год");
    expect(t("dashboard.years", { count: 2 })).toBe("2 года");
    expect(t("dashboard.years", { count: 5 })).toBe("5 лет");
    expect(t("dashboard.years", { count: 21 })).toBe("21 год");
  });

  it("árabe: 1 em one, 2 no dual, 5 em few, 21 em many — nas seis chaves", async () => {
    const t = (await instancia()).getFixedT("ar");
    for (const chave of CHAVES) for (const count of CONTAGENS) {
      expect(t(chave, { count }), `${chave} count=${count}`).not.toMatch(PORTUGUES);
    }
    expect(t("dashboard.greetingUnseen", { count: 1 })).toBe("1 اتصال مقترح جديد");
    expect(t("dashboard.greetingUnseen", { count: 2 })).toBe("اتصالان مقترحان جديدان");
    expect(t("dashboard.greetingUnseen", { count: 5 })).toBe("5 اتصالات مقترحة جديدة");
    expect(t("dashboard.greetingUnseen", { count: 21 })).toBe("21 اتصالًا مقترحًا جديدًا");
    expect(t("dashboard.pendingInvites", { count: 2 })).toBe("دعوتان للرد عليهما");
    expect(t("dashboard.pendingInvites", { count: 21 })).toBe("21 دعوة للرد عليها");
    expect(t("dashboard.roomsOnPlatform", { count: 5 })).toBe("5 غرف في المنصة");
    expect(t("dashboard.greetingTotal", { count: 2 })).toBe("عُثر على فرصتين متوافقتين لك");
    expect(t("dashboard.newMatches", { count: 1 })).toBe("✨ تم العثور على اتصال مقترح جديد واحد!");
    expect(t("dashboard.newMatches", { count: 2 })).toBe("✨ تم العثور على اتصالين مقترحين جديدين!");
    expect(t("dashboard.newMatches", { count: 5 })).toBe("✨ تم العثور على 5 اتصالات مقترحة جديدة!");
    expect(t("dashboard.newMatches", { count: 21 })).toBe("✨ تم العثور على 21 اتصالًا مقترحًا جديدًا!");
    expect(t("dashboard.years", { count: 1 })).toBe("سنة واحدة");
    expect(t("dashboard.years", { count: 2 })).toBe("سنتان");
    expect(t("dashboard.years", { count: 5 })).toBe("5 سنوات");
    expect(t("dashboard.years", { count: 21 })).toBe("21 سنة");
  });

  it("português: singular só em 1; o plural que era feito à mão sai igual ao de antes", async () => {
    const t = (await instancia()).getFixedT("pt-BR");
    expect(t("dashboard.greetingUnseen", { count: 1 })).toBe("1 nova conexão sugerida");
    expect(t("dashboard.greetingUnseen", { count: 2 })).toBe("2 novas conexões sugeridas");
    expect(t("dashboard.greetingUnseen", { count: 5 })).toBe("5 novas conexões sugeridas");
    expect(t("dashboard.greetingUnseen", { count: 21 })).toBe("21 novas conexões sugeridas");
    expect(t("dashboard.greetingTotal", { count: 1 })).toBe("1 oportunidade compatível encontrada para você");
    expect(t("dashboard.greetingTotal", { count: 2 })).toBe("2 oportunidades compatíveis encontradas para você");
    expect(t("dashboard.pendingInvites", { count: 1 })).toBe("1 convite para responder");
    expect(t("dashboard.pendingInvites", { count: 5 })).toBe("5 convites para responder");
    expect(t("dashboard.roomsOnPlatform", { count: 1 })).toBe("1 sala na plataforma");
    expect(t("dashboard.roomsOnPlatform", { count: 21 })).toBe("21 salas na plataforma");
    // O toast e os anos não têm mais "(s)"/"(es)": singular de verdade em 1.
    expect(t("dashboard.newMatches", { count: 1 })).toBe("✨ 1 nova conexão sugerida!");
    expect(t("dashboard.newMatches", { count: 2 })).toBe("✨ 2 novas conexões sugeridas!");
    expect(t("dashboard.years", { count: 1 })).toBe("1 ano");
    expect(t("dashboard.years", { count: 2 })).toBe("2 anos");
  });

  it("inglês: singular só em 1, e nada em português", async () => {
    const t = (await instancia()).getFixedT("en");
    for (const chave of CHAVES) for (const count of CONTAGENS) {
      expect(t(chave, { count }), `${chave} count=${count}`).not.toMatch(PORTUGUES);
    }
    expect(t("dashboard.greetingUnseen", { count: 1 })).toBe("1 new suggested connection");
    expect(t("dashboard.greetingUnseen", { count: 2 })).toBe("2 new suggested connections");
    expect(t("dashboard.greetingUnseen", { count: 21 })).toBe("21 new suggested connections");
    expect(t("dashboard.greetingTotal", { count: 1 })).toBe("1 compatible opportunity found for you");
    expect(t("dashboard.greetingTotal", { count: 5 })).toBe("5 compatible opportunities found for you");
    expect(t("dashboard.pendingInvites", { count: 1 })).toBe("1 invitation to answer");
    expect(t("dashboard.pendingInvites", { count: 2 })).toBe("2 invitations to answer");
    expect(t("dashboard.roomsOnPlatform", { count: 1 })).toBe("1 room on the platform");
    expect(t("dashboard.roomsOnPlatform", { count: 5 })).toBe("5 rooms on the platform");
    expect(t("dashboard.newMatches", { count: 1 })).toBe("✨ 1 new suggested connection!");
    expect(t("dashboard.newMatches", { count: 3 })).toBe("✨ 3 new suggested connections!");
    expect(t("dashboard.years", { count: 1 })).toBe("1 year");
    expect(t("dashboard.years", { count: 2 })).toBe("2 years");
  });

  it("as 6 formas existem em cada um dos 10 idiomas para as seis chaves (paridade que o conferir-locales também exige)", async () => {
    const i18n = await instancia();
    const idiomas = Object.keys(opcoesBase().resources ?? {});
    expect(idiomas).toHaveLength(10);
    // Sem fallback, `exists` com { lng } só olha o próprio idioma — com o
    // fallback do app, uma forma ausente em ru.json era "encontrada" no pt-BR.
    for (const idioma of idiomas) for (const chave of CHAVES) for (const forma of ["one", "other", "zero", "two", "few", "many"]) {
      expect(i18n.exists(`${chave}_${forma}`, { lng: idioma }), `${idioma}: ${chave}_${forma}`).toBe(true);
    }
  });

  // Varredura: 10 idiomas × 6 chaves × {0, 1, 2, 5, 21}. Três defeitos que
  // passariam despercebidos numa asserção pontual: (1) forma ausente — sem
  // fallback, o texto vira a chave crua; (2) "{{count}}" sem interpolar
  // (chave digitada errada, "{{count}" com chave a menos); (3) idioma que
  // copiou o texto do pt-BR em vez de traduzir — comparado em 1 e 5, as duas
  // contagens que em todo idioma caem em formas distintas (one e other/few/
  // many). Nenhuma exceção foi necessária: as 6 chaves têm palavras próprias
  // em todos os idiomas (zh/ja/ar/hi/ru inclusive) — se um dia uma igualdade
  // for legítima (nome próprio, sigla), registre-a aqui com o porquê.
  it("varredura: 10 idiomas × 6 chaves × {0,1,2,5,21} — nunca a chave crua, nunca '{{', e fora do pt-BR nunca o texto do pt-BR em 1 e 5", async () => {
    const i18n = await instancia();
    const idiomas = Object.keys(opcoesBase().resources ?? {});
    expect(idiomas).toHaveLength(10);
    const ptBR = i18n.getFixedT("pt-BR");
    let conferidos = 0;
    for (const idioma of idiomas) {
      const t = i18n.getFixedT(idioma);
      for (const chave of CHAVES) for (const count of [0, 1, 2, 5, 21]) {
        const texto = t(chave, { count });
        const onde = `${idioma}: ${chave} count=${count} → ${JSON.stringify(texto)}`;
        expect(texto, `${onde} — forma ausente, voltou a chave crua`).not.toBe(chave);
        expect(texto, `${onde} — contém a chave crua`).not.toContain("dashboard.");
        expect(texto, `${onde} — interpolação não resolvida`).not.toContain("{{");
        expect(texto, `${onde} — texto vazio`).not.toBe("");
        if (idioma !== "pt-BR" && (count === 1 || count === 5)) {
          expect(texto, `${onde} — igual ao pt-BR`).not.toBe(ptBR(chave, { count }));
        }
        conferidos++;
      }
    }
    expect(conferidos).toBe(10 * CHAVES.length * 5);
  });
});
