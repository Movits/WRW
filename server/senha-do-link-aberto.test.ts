import { describe, expect, it } from "vitest";
import { FORMATO_DA_SENHA_DO_LINK, normalizarSenhaDoLink } from "@shared/senha-do-link";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

const {
  comCookiesDoPedido,
  comMaisUmaFalha,
  comMaisUmaFalhaDoLink,
  cookieDaEntrada,
  cookiesDoPedido,
  criarFreioPorRede,
  DURACAO_DA_ENTRADA_MS,
  entradaValida,
  ESPERA_INICIAL_MS,
  ESPERA_MAXIMA_MS,
  esperaDepoisDe,
  esperaDoLinkDepoisDe,
  esperaRestante,
  ESQUECER_UMA_FALHA_DO_LINK_MS,
  FALHAS_LIVRES_DO_LINK,
  falhasDoLinkQueContam,
  FREIO_ZERADO,
  gerarSenhaDoLink,
  hashDaSenhaDoLink,
  nomeDoCookieDoLink,
  segundosDeEspera,
  senhaConfere,
  senhaObvia,
  TENTATIVAS_LIVRES,
} = await import("./senha-do-link-aberto");

/**
 * A senha de 6 dígitos do link aberto (H23) no que não fala com o banco: o
 * sorteio, o hash, o cookie de quem acertou, o contexto do pedido e o freio da
 * força bruta. As consultas estão em link-com-senha.integracao.test.ts, contra
 * um MariaDB de verdade.
 */

describe("a senha que o servidor sorteia", () => {
  it("tem sempre 6 algarismos, com os zeros à esquerda", () => {
    expect(gerarSenhaDoLink(() => 42)).toBe("000042");
    for (let i = 0; i < 500; i++) expect(gerarSenhaDoLink()).toMatch(FORMATO_DA_SENHA_DO_LINK);
  });

  it("nunca sai uma sequência que parece de propósito: sorteia de novo", () => {
    const sorteios = [123456, 0, 987654, 555555, 901234, 482913];
    expect(gerarSenhaDoLink(() => sorteios.shift()!)).toBe("482913");
    expect(sorteios).toEqual([]);
  });

  it.each(["000000", "999999", "123456", "234567", "890123", "012345", "987654", "654321", "210987"])("%s é óbvia", senha => {
    expect(senhaObvia(senha)).toBe(true);
  });

  it.each(["123465", "482913", "112233", "135791", "102030"])("%s não é óbvia", senha => {
    expect(senhaObvia(senha)).toBe(false);
  });

  it("sorteia do crypto, espalhada: em 2000 sorteios, quase nenhuma repete e todos os algarismos aparecem em cada posição", () => {
    const senhas = Array.from({ length: 2000 }, () => gerarSenhaDoLink());
    expect(new Set(senhas).size).toBeGreaterThan(1990);
    for (let posicao = 0; posicao < 6; posicao++) expect(new Set(senhas.map(s => s[posicao])).size).toBe(10);
  });
});

describe("o hash guardado (scrypt com sal)", () => {
  it("confere a senha certa, recusa a errada, e a mesma senha dá hashes diferentes (o sal)", async () => {
    const hash = await hashDaSenhaDoLink("482913");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain("482913");
    expect(await senhaConfere("482913", hash)).toBe(true);
    expect(await senhaConfere("482914", hash)).toBe(false);
    expect(await senhaConfere("", hash)).toBe(false);
    expect(await hashDaSenhaDoLink("482913")).not.toBe(hash);
  });

  it("hash fora do formato, ou com parâmetros que não são de um scrypt nosso, não confere e não lança", async () => {
    const hash = await hashDaSenhaDoLink("482913");
    const [, , , , sal, valor] = hash.split("$");
    for (const ruim of [
      "", "482913", "bcrypt$16384$8$1$" + sal + "$" + valor,
      `scrypt$16384$8$1$${sal}`,
      // N enorme pediria memória de sobra ao servidor; N que não é potência de 2, r e p fora da faixa.
      `scrypt$${2 ** 20}$8$1$${sal}$${valor}`, `scrypt$1000$8$1$${sal}$${valor}`, `scrypt$16384$64$1$${sal}$${valor}`, `scrypt$16384$8$9$${sal}$${valor}`,
      // Sal e hash curtos demais.
      `scrypt$16384$8$1$AAAA$${valor}`, `scrypt$16384$8$1$${sal}$AAAA`,
    ]) {
      await expect(senhaConfere("482913", ruim), ruim).resolves.toBe(false);
    }
  });
});

describe("o cookie de quem acertou a senha", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const HASH = "scrypt$16384$8$1$sal$hash";
  const AGORA = 1_800_000_000_000;
  const cabecalho = (entrada: { nome: string; valor: string }) => `wrw_sessao=abc; ${entrada.nome}=${entrada.valor}; outro=x`;

  it("vale para este token e esta senha, e o nome não leva o token", () => {
    const entrada = cookieDaEntrada(TOKEN, HASH, AGORA);
    expect(entrada.nome).toBe(nomeDoCookieDoLink(TOKEN));
    expect(entrada.nome).toMatch(/^wrw_link_[0-9a-f]{24}$/);
    expect(entrada.nome).not.toContain(TOKEN);
    expect(entrada.valor).not.toContain(TOKEN);
    expect(entrada.maxAgeMs).toBe(DURACAO_DA_ENTRADA_MS);
    expect(entradaValida(TOKEN, HASH, cabecalho(entrada), AGORA)).toBe(true);
  });

  it("dois links, dois cookies: cada um com o seu nome", () => {
    expect(nomeDoCookieDoLink(TOKEN)).not.toBe(nomeDoCookieDoLink(`${TOKEN.slice(0, 31)}6`));
  });

  it("trocar a senha (outro hash) derruba a entrada de antes; outro link também não abre com ela", () => {
    const entrada = cookieDaEntrada(TOKEN, HASH, AGORA);
    expect(entradaValida(TOKEN, `${HASH}-nova`, cabecalho(entrada), AGORA)).toBe(false);
    const outro = `${TOKEN.slice(0, 31)}6`;
    expect(entradaValida(outro, HASH, `${nomeDoCookieDoLink(outro)}=${entrada.valor}`, AGORA)).toBe(false);
  });

  it("vence em 12 horas; vencimento mais longe que o prazo não foi o servidor que escreveu", () => {
    const entrada = cookieDaEntrada(TOKEN, HASH, AGORA);
    expect(entradaValida(TOKEN, HASH, cabecalho(entrada), AGORA + DURACAO_DA_ENTRADA_MS - 1000)).toBe(true);
    expect(entradaValida(TOKEN, HASH, cabecalho(entrada), AGORA + DURACAO_DA_ENTRADA_MS)).toBe(false);
    // Assinado de verdade, mas para daqui a um ano: recusado pelo prazo.
    const longe = cookieDaEntrada(TOKEN, HASH, AGORA + 365 * 86_400_000);
    expect(entradaValida(TOKEN, HASH, cabecalho(longe), AGORA)).toBe(false);
  });

  it("assinatura mexida, formato errado, sem cookie ou cabeçalho quebrado: não vale", () => {
    const entrada = cookieDaEntrada(TOKEN, HASH, AGORA);
    const [vence, assinatura] = entrada.valor.split(".");
    const trocada = (assinatura[0] === "A" ? "B" : "A") + assinatura.slice(1);
    for (const valor of [`${vence}.${trocada}`, `${Number(vence) + 1}.${assinatura}`, vence, `${vence}.`, "", "x.y"]) {
      expect(entradaValida(TOKEN, HASH, `${entrada.nome}=${valor}`, AGORA), valor).toBe(false);
    }
    expect(entradaValida(TOKEN, HASH, undefined, AGORA)).toBe(false);
    expect(entradaValida(TOKEN, HASH, "", AGORA)).toBe(false);
    expect(entradaValida(TOKEN, HASH, "wrw_sessao=abc", AGORA)).toBe(false);
    expect(entradaValida(TOKEN, HASH, `${entrada.nome}=%E0%A4%A`, AGORA)).toBe(false);
  });
});

describe("os cookies no contexto do pedido", () => {
  it("dentro do pedido, quem lê acha os cookies, também depois de um await; fora, nada", async () => {
    expect(cookiesDoPedido()).toBeUndefined();
    const lido = await comCookiesDoPedido("a=1", async () => {
      await new Promise(resolver => setTimeout(resolver, 1));
      return cookiesDoPedido();
    });
    expect(lido).toBe("a=1");
    expect(cookiesDoPedido()).toBeUndefined();
  });

  it("dois pedidos ao mesmo tempo não se misturam", async () => {
    const ler = (cookies: string, espera: number) => comCookiesDoPedido(cookies, async () => {
      await new Promise(resolver => setTimeout(resolver, espera));
      return cookiesDoPedido();
    });
    await expect(Promise.all([ler("a=1", 5), ler("b=2", 1)])).resolves.toEqual(["a=1", "b=2"]);
  });
});

describe("o freio da força bruta", () => {
  const AGORA = 1_800_000_000_000;

  it(`${TENTATIVAS_LIVRES} falhas livres; da ${TENTATIVAS_LIVRES}ª em diante, 1 minuto que dobra, até 60 minutos`, () => {
    for (let falhas = 0; falhas < TENTATIVAS_LIVRES; falhas++) expect(esperaDepoisDe(falhas)).toBe(0);
    expect(esperaDepoisDe(TENTATIVAS_LIVRES)).toBe(ESPERA_INICIAL_MS);
    expect(esperaDepoisDe(TENTATIVAS_LIVRES + 1)).toBe(2 * ESPERA_INICIAL_MS);
    expect(esperaDepoisDe(TENTATIVAS_LIVRES + 5)).toBe(32 * ESPERA_INICIAL_MS);
    expect(esperaDepoisDe(TENTATIVAS_LIVRES + 6)).toBe(ESPERA_MAXIMA_MS);
    expect(esperaDepoisDe(1_000_000)).toBe(ESPERA_MAXIMA_MS);
  });

  it("cada falha conta a partir da última; depois de 24 horas sem nenhuma, a conta recomeça", () => {
    let estado = FREIO_ZERADO;
    for (let i = 0; i < TENTATIVAS_LIVRES - 1; i++) estado = comMaisUmaFalha(estado, AGORA);
    expect(estado).toEqual({ falhas: TENTATIVAS_LIVRES - 1, ultimaFalhaEm: AGORA, bloqueadoAte: null });
    estado = comMaisUmaFalha(estado, AGORA);
    expect(estado.bloqueadoAte).toBe(AGORA + ESPERA_INICIAL_MS);
    expect(esperaRestante(estado, AGORA + 1000)).toBe(ESPERA_INICIAL_MS - 1000);
    expect(esperaRestante(estado, AGORA + ESPERA_INICIAL_MS)).toBe(0);
    // Um dia inteiro depois, a falha nova é a primeira.
    expect(comMaisUmaFalha(estado, AGORA + 24 * 60 * 60_000)).toEqual({ falhas: 1, ultimaFalhaEm: AGORA + 24 * 60 * 60_000, bloqueadoAte: null });
  });

  it("os segundos da tela: arredondados para cima, nunca 0 enquanto há espera", () => {
    expect(segundosDeEspera(1)).toBe(1);
    expect(segundosDeEspera(59_001)).toBe(60);
    expect(segundosDeEspera(0)).toBe(1);
  });

  it("por rede: a 6ª tentativa seguida espera, sem ser cobrada; passada a espera, entra e a espera dobra", () => {
    const freio = criarFreioPorRede();
    for (let i = 0; i < TENTATIVAS_LIVRES; i++) expect(freio.cobrar("203.0.113.7", AGORA).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA + 1000)).toEqual({ aceita: false, esperaMs: ESPERA_INICIAL_MS - 1000 });
    // Outra rede segue livre.
    expect(freio.cobrar("198.51.100.1", AGORA).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA + ESPERA_INICIAL_MS).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA + ESPERA_INICIAL_MS + 1)).toEqual({ aceita: false, esperaMs: 2 * ESPERA_INICIAL_MS - 1 });
  });

  it("por rede: a senha certa devolve só a falha que ela cobrou, uma vez só; não zera a rede", () => {
    const freio = criarFreioPorRede();
    for (let i = 0; i < TENTATIVAS_LIVRES - 1; i++) freio.cobrar("203.0.113.7", AGORA);
    const quinta = freio.cobrar("203.0.113.7", AGORA);
    if (!quinta.aceita) throw new Error("a 5ª era livre");
    // A 5ª abriu a espera; a senha certa a desfaz, e devolver de novo não muda nada.
    quinta.devolver();
    quinta.devolver();
    expect(freio.cobrar("203.0.113.7", AGORA).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA).aceita).toBe(false);
  });

  it("por rede: a senha certa numa rede acima do limite não deixa espera nova para a pessoa seguinte da mesma rede", () => {
    const freio = criarFreioPorRede();
    for (let i = 0; i < TENTATIVAS_LIVRES; i++) freio.cobrar("203.0.113.7", AGORA);
    // Passada a espera de 1 minuto, a senha certa (cobrar e devolver).
    const certa = freio.cobrar("203.0.113.7", AGORA + 61_000);
    if (!certa.aceita) throw new Error("a espera tinha vencido");
    certa.devolver();
    // 30 s depois, a próxima pessoa do escritório, também com a senha certa: entra.
    expect(freio.cobrar("203.0.113.7", AGORA + 91_000).aceita).toBe(true);
  });

  it("por rede: o acerto não renova a hora da última falha; as falhas antigas se esquecem 24 horas depois da última", () => {
    const freio = criarFreioPorRede();
    for (let i = 0; i < TENTATIVAS_LIVRES - 1; i++) freio.cobrar("203.0.113.7", AGORA);
    const certa = freio.cobrar("203.0.113.7", AGORA + 23 * 60 * 60_000);
    if (!certa.aceita) throw new Error("4 falhas não esperam");
    certa.devolver();
    // 25 horas depois das 4 falhas, a errada é a 1ª: mais 4 seguidas ainda não esperam.
    for (let i = 0; i < TENTATIVAS_LIVRES - 1; i++) expect(freio.cobrar("203.0.113.7", AGORA + 25 * 60 * 60_000).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA + 25 * 60 * 60_000).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA + 25 * 60 * 60_000).aceita).toBe(false);
  });

  it("por rede: com outra tentativa no meio, a senha certa devolve só a falha dela", () => {
    const freio = criarFreioPorRede();
    for (let i = 0; i < 2; i++) freio.cobrar("203.0.113.7", AGORA);
    const certa = freio.cobrar("203.0.113.7", AGORA);
    if (!certa.aceita) throw new Error("3 falhas não esperam");
    freio.cobrar("203.0.113.7", AGORA);
    certa.devolver();
    // Ficaram 3 (as 2 de antes e a do meio): mais 2 livres, e a seguinte espera.
    expect(freio.cobrar("203.0.113.7", AGORA).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA).aceita).toBe(true);
    expect(freio.cobrar("203.0.113.7", AGORA).aceita).toBe(false);
  });

  it(`o link: ${FALHAS_LIVRES_DO_LINK} falhas antes da espera, que dobra como a da rede, até 60 minutos`, () => {
    expect(FALHAS_LIVRES_DO_LINK).toBeGreaterThan(10 * TENTATIVAS_LIVRES - 1);
    for (const falhas of [0, TENTATIVAS_LIVRES, FALHAS_LIVRES_DO_LINK - 1]) expect(esperaDoLinkDepoisDe(falhas)).toBe(0);
    expect(esperaDoLinkDepoisDe(FALHAS_LIVRES_DO_LINK)).toBe(ESPERA_INICIAL_MS);
    expect(esperaDoLinkDepoisDe(FALHAS_LIVRES_DO_LINK + 1)).toBe(2 * ESPERA_INICIAL_MS);
    expect(esperaDoLinkDepoisDe(FALHAS_LIVRES_DO_LINK + 6)).toBe(ESPERA_MAXIMA_MS);
    expect(esperaDoLinkDepoisDe(1_000_000)).toBe(ESPERA_MAXIMA_MS);
  });

  it("o link esquece uma falha a cada 30 minutos desde a última, e nunca fica abaixo de zero", () => {
    let estado = FREIO_ZERADO;
    for (let i = 0; i < 10; i++) estado = comMaisUmaFalhaDoLink(estado, AGORA);
    expect(estado).toEqual({ falhas: 10, ultimaFalhaEm: AGORA, bloqueadoAte: null });
    expect(falhasDoLinkQueContam(estado, AGORA + ESQUECER_UMA_FALHA_DO_LINK_MS - 1)).toBe(10);
    expect(falhasDoLinkQueContam(estado, AGORA + 3 * ESQUECER_UMA_FALHA_DO_LINK_MS)).toBe(7);
    expect(falhasDoLinkQueContam(estado, AGORA + 24 * 60 * 60_000)).toBe(0);
    expect(comMaisUmaFalhaDoLink(estado, AGORA + 2 * ESQUECER_UMA_FALHA_DO_LINK_MS)).toEqual({ falhas: 9, ultimaFalhaEm: AGORA + 2 * ESQUECER_UMA_FALHA_DO_LINK_MS, bloqueadoAte: null });
    let cheio = FREIO_ZERADO;
    for (let i = 0; i < FALHAS_LIVRES_DO_LINK; i++) cheio = comMaisUmaFalhaDoLink(cheio, AGORA);
    expect(cheio.bloqueadoAte).toBe(AGORA + ESPERA_INICIAL_MS);
  });

  it("uma rede sozinha, presa ao freio dela, não tranca o link nem em 3 dias de tentativas", () => {
    const freio = criarFreioPorRede();
    let link = FREIO_ZERADO;
    let maior = 0;
    let tentativas = 0;
    let agora = AGORA;
    while (agora < AGORA + 3 * 24 * 60 * 60_000) {
      const cobranca = freio.cobrar("203.0.113.7", agora);
      if (!cobranca.aceita) {
        agora += cobranca.esperaMs;
        continue;
      }
      tentativas += 1;
      expect(esperaRestante(link, agora)).toBe(0);
      link = comMaisUmaFalhaDoLink(link, agora);
      maior = Math.max(maior, link.falhas);
    }
    expect(tentativas).toBeGreaterThan(FALHAS_LIVRES_DO_LINK);
    expect(maior).toBeLessThan(FALHAS_LIVRES_DO_LINK);
  });

  it("por rede: guarda no máximo as redes do limite, e sai a parada há mais tempo", () => {
    const freio = criarFreioPorRede(2);
    for (let i = 0; i < TENTATIVAS_LIVRES; i++) freio.cobrar("a", AGORA);
    freio.cobrar("b", AGORA);
    freio.cobrar("c", AGORA);
    // "a" saiu, e volta zerada.
    expect(freio.cobrar("a", AGORA).aceita).toBe(true);
  });
});

describe("a senha como o servidor a confere (normalizarSenhaDoLink)", () => {
  it.each([
    ["123456", "123456"],
    ["123 456", "123456"],
    ["123-456", "123456"],
    ["123.456", "123456"],
    [" 12 34 56 ", "123456"],
    // Os teclados dos 10 idiomas da tela: árabe, persa, hindi e o de largura cheia.
    ["١٢٣٤٥٦", "123456"],
    ["۱۲۳۴۵۶", "123456"],
    ["१२३४५६", "123456"],
    ["１２３４５６", "123456"],
  ])("%j vira %j", (digitado, esperado) => {
    expect(normalizarSenhaDoLink(digitado)).toBe(esperado);
    expect(normalizarSenhaDoLink(digitado)).toMatch(FORMATO_DA_SENHA_DO_LINK);
  });

  it.each(["12a456", "12345", "1234567", "abcdef", "12345６7"])("%j não passa no formato", digitado => {
    expect(normalizarSenhaDoLink(digitado)).not.toMatch(FORMATO_DA_SENHA_DO_LINK);
  });
});
