import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { z } from "zod";

const AQUI_TESTE: string = (import.meta as { dirname?: string }).dirname ?? ".";

/**
 * A carga da base de participantes (scripts/importacao/planilha.mjs), que é o
 * primeiro item do escopo de 16/09: "carregar a base de gente no primeiro dia,
 * com as conexões funcionando".
 *
 * O teste mora aqui, e não em scripts/, pelo mesmo motivo de
 * server/exame-de-producao.test.ts: o módulo é PURO, então a regra pode ser
 * executada sem banco, sem arquivo e sem planilha de verdade.
 *
 * O que ele protege, em ordem de dano:
 *
 * 1. NINGUÉM SOME. E-mail repetido na planilha é recusa com o número das duas
 *    linhas, nunca "a última ganha" — escolher em silêncio perde uma pessoa.
 * 2. SENHA NÃO ENTRA POR PLANILHA. Coluna de senha recusa o arquivo inteiro.
 * 3. O QUE CARREGA TEM DE CONECTAR. Linha sem possui e sem procura entra, mas
 *    com aviso contado no resumo: "carregou mas não cruza" é o pior resultado
 *    possível e não pode passar calado.
 * 4. A TAG SOBREVIVE INTEIRA. "exportação de vinho" é UMA tag; quebrar em
 *    palavras destrói o cruzamento, que exige termo exato.
 */

import {
  achatar, lerCsv, mapearCabecalho, normalizarEmail, emailValido, normalizarPais,
  separarTags, completude, validarLinha, prepararImportacao, resumo, classificarTags,
  destinoDasOutrasLinhas, erroDeLinhasEngolidas, ERRO_DE_ASPAS_ABERTAS,
  COLUNAS, OBRIGATORIAS, PROIBIDAS, VOCABULARIO_POSSUI, VOCABULARIO_PROCURA,
} from "../scripts/importacao/planilha.mjs";

const CABECALHO = "nome;email;empresa;cargo;setor;pais;cidade;possui;procura";

function planilha(...linhas: string[]) {
  return [CABECALHO, ...linhas].join("\n");
}

// ═════════════════════════ 1. leitura do arquivo ═════════════════════════════
describe("lerCsv — o arquivo como ele chega do Excel", () => {
  it("detecta o ponto e vírgula, que é o separador do Excel em português", () => {
    const { separador, linhas } = lerCsv("a;b;c\n1;2;3");
    expect(separador).toBe(";");
    expect(linhas).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("detecta a vírgula quando é ela que separa", () => {
    expect(lerCsv("a,b,c\n1,2,3").separador).toBe(",");
  });

  it("campo entre aspas guarda o separador, a aspas dobrada e a quebra de linha", () => {
    const { linhas } = lerCsv('nome;bio\n"Silva; Maria";"disse ""oi"" e\nseguiu"');
    expect(linhas[1][0]).toBe("Silva; Maria");
    expect(linhas[1][1]).toBe('disse "oi" e\nseguiu');
  });

  it("engole o BOM do Windows e o CRLF", () => {
    const { linhas } = lerCsv("﻿nome;email\r\nMaria;maria@x.com\r\n");
    expect(linhas[0][0]).toBe("nome");
    expect(linhas[1]).toEqual(["Maria", "maria@x.com"]);
  });

  it("linha vazia no fim não vira participante", () => {
    expect(lerCsv("nome;email\nMaria;maria@x.com\n\n;\n").linhas).toHaveLength(2);
  });

  it("arquivo vazio não explode", () => {
    expect(lerCsv("").linhas).toEqual([]);
    expect(lerCsv("   ").linhas).toEqual([]);
  });
});

// ═════════════════════════ 2. cabeçalho ══════════════════════════════════════
describe("mapearCabecalho — o nome da coluna como a pessoa escreveu", () => {
  it("aceita acento, maiúscula e espaço a mais", () => {
    const { mapa, faltando } = mapearCabecalho(["  NOME Completo ", "E-Mail", "País", "Área de Atuação"]);
    expect(faltando).toEqual([]);
    expect(mapa.nome).toBe(0);
    expect(mapa.email).toBe(1);
    expect(mapa.pais).toBe(2);
    expect(mapa.setor).toBe(3);
  });

  it("diz quais colunas obrigatórias faltam, em vez de importar torto", () => {
    expect(mapearCabecalho(["empresa", "cidade"]).faltando).toEqual(OBRIGATORIAS);
  });

  it("coluna que não existe no cadastro é ignorada, e avisada", () => {
    const { mapa, desconhecidas } = mapearCabecalho(["nome", "email", "indicada por"]);
    expect(desconhecidas).toEqual(["indicada por"]);
    expect(Object.keys(mapa)).toHaveLength(2);
  });

  it("coluna de senha é sinalizada (o arquivo inteiro será recusado)", () => {
    expect(mapearCabecalho(["nome", "email", "Senha"]).proibidas).toEqual(["Senha"]);
    for (const proibida of PROIBIDAS) {
      expect(mapearCabecalho(["nome", "email", proibida]).proibidas).toHaveLength(1);
    }
  });

  it("coluna repetida usa a primeira, não a última", () => {
    expect(mapearCabecalho(["email", "nome", "e-mail"]).mapa.email).toBe(0);
  });
});

// ═════════════════════════ 3. normalizações ══════════════════════════════════
describe("as normalizações que decidem se a conexão acontece", () => {
  it("achatar compara sem acento e sem maiúscula, mas nunca é o que se grava", () => {
    expect(achatar(" Alimentação  E  Bebidas ")).toBe("alimentacao e bebidas");
  });

  it("e-mail vira minúsculo e sem espaço, porque users.email é único", () => {
    expect(normalizarEmail("  Maria@Exemplo.COM ")).toBe("maria@exemplo.com");
  });

  it.each([
    ["maria@exemplo.com", true],
    ["maria@exemplo.com.br", true],
    ["maria arroba exemplo", false],
    ["maria@exemplo", false],
    ["@exemplo.com", false],
    ["maria@exemplo.c", false],
    ["duas@vir,gulas.com", false],
    // A regra antiga aceitava estes, e o login, o cadastro e o "esqueci a senha"
    // (z.string().email() no servidor) recusam: a conta entrava sem saída.
    ["contato&vendas@exemplo.com.br", false],
    ["ana..costa@exemplo.com", false],
    [".ana@exemplo.com", false],
    ["ana.@exemplo.com", false],
    ["ana@-exemplo.com", false],
    ["joão@exemplo.com", false],
    ["ana+eventos@exemplo.com", true],
  ])("emailValido(%s) = %s", (email, esperado) => {
    expect(emailValido(email)).toBe(esperado);
  });

  it("emailValido aceita e recusa o mesmo que o servidor (z.string().email())", () => {
    const servidor = z.string().email();
    for (const email of [
      "maria@exemplo.com", "a.b-c_d+e@sub.exemplo.org", "o'neil@exemplo.com", "x@exemplo.io",
      "contato&vendas@exemplo.com.br", "ana..costa@exemplo.com", "ana@exemplo..com",
      "ana@exemplo.c0m", "ana@exemplo_um.com", "ana@[127.0.0.1]", "ação@exemplo.com",
    ]) {
      expect(emailValido(email), email).toBe(servidor.safeParse(email).success);
    }
  });

  it("país aceita nome, sigla e acento; o que não conhece vira null (não palpite)", () => {
    expect(normalizarPais("Brasil")).toBe("BR");
    expect(normalizarPais("brasil")).toBe("BR");
    expect(normalizarPais("br")).toBe("BR");
    expect(normalizarPais("Estados Unidos")).toBe("US");
    expect(normalizarPais("França")).toBe("FR");
    expect(normalizarPais("Moçambique")).toBe("MZ");
    expect(normalizarPais("Nárnia")).toBeNull();
    expect(normalizarPais("")).toBeNull();
  });

  it("sigla desconhecida de duas letras passa em maiúscula (é código ISO)", () => {
    expect(normalizarPais("nz")).toBe("NZ");
  });
});

// ═════════════════════════ 4. as tags ═══════════════════════════════════════
describe("separarTags — a tag sobrevive inteira", () => {
  it("ponto e vírgula separa, e o termo de três palavras continua UM termo", () => {
    expect(separarTags("exportação de vinho; rótulo próprio")).toEqual(["exportação de vinho", "rótulo próprio"]);
  });

  it("barra vertical e quebra de linha também separam", () => {
    expect(separarTags("vinho|azeite")).toEqual(["vinho", "azeite"]);
    expect(separarTags("vinho\nazeite")).toEqual(["vinho", "azeite"]);
  });

  it("a vírgula só separa quando não há ; nem | no campo", () => {
    expect(separarTags("vinho, azeite")).toEqual(["vinho", "azeite"]);
    // Com ponto e vírgula presente, a vírgula é parte do termo.
    expect(separarTags("exportação de vinho, azeite; logística")).toEqual(["exportação de vinho, azeite", "logística"]);
  });

  it("repetida com acento ou caixa diferente entra uma vez", () => {
    expect(separarTags("Vinho; vinho; VINHO; Vinhó")).toEqual(["Vinho"]);
  });

  it("campo vazio devolve lista vazia, não [\"\"]", () => {
    expect(separarTags("")).toEqual([]);
    expect(separarTags("  ;  ; ")).toEqual([]);
  });

  it("tem teto, para uma célula gigante não virar 500 tags", () => {
    const muitas = Array.from({ length: 90 }, (_, i) => `tag ${i}`).join(";");
    expect(separarTags(muitas)).toHaveLength(30);
  });
});

// ═════════════════════════ 5. linha a linha ═════════════════════════════════
describe("validarLinha", () => {
  const mapa = { nome: 0, email: 1, empresa: 2, cargo: 3, setor: 4, pais: 5, cidade: 6, possui: 7, procura: 8 };
  const linha = (...v: string[]) => v;

  it("linha completa vira participante com as tags separadas", () => {
    const r = validarLinha(
      linha("Maria Silva", "Maria@Exemplo.com", "Vinícola Serra", "Sócia", "Alimentação", "Brasil", "Bento Gonçalves", "exportação de vinho", "distribuidor na Europa"),
      mapa, 2, new Map(),
    );
    expect(r.ok).toBe(true);
    expect(r.participante).toMatchObject({
      nome: "Maria Silva", email: "maria@exemplo.com", pais: "BR",
      setor: "Alimentação", possui: ["exportação de vinho"], procura: ["distribuidor na Europa"],
    });
    expect(r.avisos).toEqual([]);
  });

  it("nome vazio e e-mail inválido são recusa com o motivo, não conta pela metade", () => {
    const r = validarLinha(linha("", "nao-e-email", "", "", "", "", "", "", ""), mapa, 7, new Map());
    expect(r.ok).toBe(false);
    expect(r.numero).toBe(7);
    expect(r.erros.join(" ")).toMatch(/nome vazio/);
    expect(r.erros.join(" ")).toMatch(/inválido/);
  });

  it("e-mail repetido cita a linha onde apareceu antes", () => {
    const vistos = new Map([["maria@exemplo.com", 2]]);
    const r = validarLinha(linha("Maria", "maria@exemplo.com", "", "", "", "", "", "", ""), mapa, 9, vistos);
    expect(r.ok).toBe(false);
    expect(r.erros[0]).toContain("linha 2");
  });

  it("sem possui e sem procura: entra, mas com o aviso de que não vai conectar", () => {
    const r = validarLinha(linha("Maria", "m@x.com", "", "", "Saúde", "BR", "", "", ""), mapa, 3, new Map());
    expect(r.ok).toBe(true);
    expect(r.avisos.join(" ")).toContain("nunca gera conexão");
  });

  it("país que não existe avisa e grava null, em vez de inventar o código", () => {
    const r = validarLinha(linha("Maria", "m@x.com", "", "", "", "Nárnia", "", "vinho", ""), mapa, 4, new Map());
    expect(r.ok).toBe(true);
    expect(r.participante!.pais).toBeNull();
    expect(r.avisos.join(" ")).toContain("Nárnia");
  });

  it("nome e cargo são cortados no tamanho da coluna do banco", () => {
    const r = validarLinha(linha("N".repeat(300), "m@x.com", "", "C".repeat(400), "", "", "", "x", ""), mapa, 5, new Map());
    expect(r.participante!.nome).toHaveLength(100);
    expect(r.participante!.cargo).toHaveLength(200);
  });
});

// ═════════════════════════ 6. completude ════════════════════════════════════
describe("completude — a carga não finge perfil completo", () => {
  it("só nome e e-mail é 15%", () => {
    expect(completude({ nome: "Maria", possui: [], procura: [] })).toBe(15);
  });

  it("planilha cheia passa de 90%", () => {
    expect(completude({
      nome: "Maria", empresa: "X", cargo: "Sócia", setor: "Saúde",
      pais: "BR", cidade: "Recife", possui: ["a"], procura: ["b"], bio: "oi",
    })).toBe(100);
  });

  it("possui e procura valem mais que cidade, porque são o que cruza", () => {
    const comTags = completude({ nome: "M", possui: ["a"], procura: ["b"] });
    const comCidade = completude({ nome: "M", cidade: "Recife", possui: [], procura: [] });
    expect(comTags).toBeGreaterThan(comCidade);
  });
});

// ═════════════════════════ 7. a planilha inteira ════════════════════════════
describe("prepararImportacao — o arquivo inteiro", () => {
  it("separa válidas, recusadas e avisos com o número da linha do arquivo", () => {
    const r = prepararImportacao(planilha(
      "Maria Silva;maria@exemplo.com;Vinícola;Sócia;Alimentação;Brasil;Bento;exportação de vinho;distribuidor",
      ";sem-nome@exemplo.com;;;;;;;",
      "Ana Costa;ana@exemplo.pt;Costa;Diretora;Logística;Portugal;Lisboa;;",
      "Repetida;MARIA@exemplo.com;;;;;;;",
    ));
    expect(r.erroFatal).toBeUndefined();
    expect(r.participantes.map(p => p.email)).toEqual(["maria@exemplo.com", "ana@exemplo.pt"]);
    expect(r.participantes[0].numero).toBe(2);
    expect(r.recusadas.map(x => x.numero)).toEqual([3, 5]);
    expect(r.recusadas[1].erros[0]).toContain("repetido");
    expect(r.avisos.find(a => a.email === "ana@exemplo.pt")!.aviso).toContain("nunca gera conexão");
  });

  it("planilha com coluna de senha é recusada inteira, e o motivo explica o que fazer", () => {
    const r = prepararImportacao("nome;email;senha\nMaria;m@x.com;123456");
    expect(r.erroFatal).toMatch(/senha/i);
    expect(r.erroFatal).toMatch(/Esqueci minha senha/);
    expect(r.participantes).toEqual([]);
  });

  it("sem a coluna de e-mail, recusa dizendo o cabeçalho que leu", () => {
    const r = prepararImportacao("nome;empresa\nMaria;Vinícola");
    expect(r.erroFatal).toContain("email");
    expect(r.erroFatal).toContain("nome | empresa");
  });

  it("planilha vazia recusa sem explodir", () => {
    expect(prepararImportacao("").erroFatal).toMatch(/vazia/);
  });

  it("planilha só com cabeçalho não importa ninguém e não é erro fatal", () => {
    const r = prepararImportacao(CABECALHO);
    expect(r.erroFatal).toBeUndefined();
    expect(r.participantes).toEqual([]);
  });

  it("500 linhas válidas passam, e a ordem é preservada", () => {
    const linhas = Array.from({ length: 500 }, (_, i) =>
      `Participante ${i};p${i}@exemplo.com;Empresa ${i};Sócia;Saúde;Brasil;Recife;tecnologia;investidores`);
    const r = prepararImportacao(planilha(...linhas));
    expect(r.participantes).toHaveLength(500);
    expect(r.recusadas).toEqual([]);
    expect(r.avisos).toEqual([]);
    expect(r.participantes[499].email).toBe("p499@exemplo.com");
    // Tag do vocabulário entra como id: é isso que o cruzamento lê.
    expect(r.participantes[0].idsPossui).toEqual(["tecnologia"]);
    expect(r.participantes[0].idsProcura).toEqual(["investidores"]);
  });
});

// ═════════════════════════ 8. o resumo ══════════════════════════════════════
describe("resumo", () => {
  it("conta as sem cruzamento à parte, porque é o risco silencioso", () => {
    const r = prepararImportacao(planilha(
      "Maria;maria@exemplo.com;;;;;;vinho;azeite",
      "Ana;ana@exemplo.com;;;;;;;",
    ));
    const texto = resumo({ ...r, novas: 2, existentes: 0 });
    expect(texto).toContain("2 linha(s) válida(s)");
    expect(texto).toContain("1 sem possui/procura");
    expect(texto).toContain("2 conta(s) nova(s)");
  });

  it("sem consulta ao banco, não inventa contagem de contas novas", () => {
    const texto = resumo({ participantes: [], recusadas: [], avisos: [] });
    expect(texto).not.toContain("nova(s)");
  });
});

// ═════════════════════════ 9. o formato documentado ════════════════════════
describe("o modelo que o script imprime casa com o que ele aceita", () => {
  it("as colunas do exemplo são todas reconhecidas", () => {
    const exemplo = "nome;email;empresa;cargo;setor;pais;cidade;possui;procura;linkedin;bio";
    const { faltando, desconhecidas } = mapearCabecalho(exemplo.split(";"));
    expect(faltando).toEqual([]);
    expect(desconhecidas).toEqual([]);
  });

  it("todo campo conhecido tem pelo menos um nome aceito, e nenhum nome se repete entre campos", () => {
    const todos: string[] = [];
    for (const [campo, nomes] of Object.entries(COLUNAS)) {
      expect(nomes.length, campo).toBeGreaterThan(0);
      todos.push(...nomes);
    }
    expect(new Set(todos).size).toBe(todos.length);
  });
});

// ════════ 10. o INSERT do script conferido contra o drizzle/schema.ts ════════
// Não dá para executar o INSERT aqui: esta máquina não tem MySQL local nem
// Docker, e o `.env` de trabalho aponta para a produção. O que dá para provar
// sem banco é o que mais quebra numa carga: coluna que não existe, contagem de
// `?` diferente da contagem de colunas, e coluna obrigatória esquecida — os
// três erros que o teste da exclusão pegou quando rodou contra o MySQL de
// verdade. Mesmo método do teste da limpeza do exame: ler o schema como texto.
describe("o INSERT da carga casa com o schema", () => {
  const AQUI = (import.meta as { dirname?: string }).dirname ?? ".";
  const raiz = pathResolve(AQUI, "..");
  const fonteScript = readFileSync(pathResolve(raiz, "scripts", "importar-participantes.mjs"), "utf8");
  const fonteSchema = readFileSync(pathResolve(raiz, "drizzle", "schema.ts"), "utf8");

  /** Recorte entre dois marcadores literais: sem regex montada em texto. */
  function entre(fonte: string, abre: string, fecha: string, de = 0) {
    const inicio = fonte.indexOf(abre, de);
    if (inicio < 0) return null;
    const fim = fonte.indexOf(fecha, inicio + abre.length);
    if (fim < 0) return null;
    return { texto: fonte.slice(inicio + abre.length, fim), fim };
  }

  function colunasDaTabela(nomeSql: string) {
    const bloco = entre(fonteSchema, 'mysqlTable("' + nomeSql + '", {', "\n}");
    expect(bloco, `tabela ${nomeSql} não encontrada no schema`).not.toBeNull();
    const colunas = new Map<string, string>();
    for (const m of bloco!.texto.matchAll(/^[ \t]+(\w+):[ \t]*([^\n]+)/gm)) {
      const nomeNoBanco = /\(\s*"([^"]+)"/.exec(m[2])?.[1] ?? m[1];
      colunas.set(nomeNoBanco, m[2]);
    }
    return colunas;
  }

  /** As colunas e os `?` do INSERT daquela tabela, como o script os escreve. */
  function insertDoScript(tabela: string) {
    const lista = entre(fonteScript, "INSERT INTO `" + tabela + "` (", ")");
    expect(lista, `INSERT em ${tabela} não encontrado no script`).not.toBeNull();
    const valoresCru = entre(fonteScript, "VALUES (", ")", lista!.fim);
    expect(valoresCru, `VALUES de ${tabela} não encontrado`).not.toBeNull();
    const colunas = [...lista!.texto.matchAll(/`([^`]+)`/g)].map(x => x[1]);
    const valores = valoresCru!.texto.split(",").map(v => v.trim()).filter(Boolean);
    return { colunas, valores };
  }

  it.each(["users", "user_profiles"])("todas as colunas do INSERT em %s existem no schema", (tabela) => {
    const doSchema = colunasDaTabela(tabela);
    const { colunas } = insertDoScript(tabela);
    expect(colunas.length).toBeGreaterThan(5);
    for (const coluna of colunas) {
      expect(doSchema.has(coluna), `${tabela}.${coluna} está no INSERT e não existe no schema`).toBe(true);
    }
  });

  it.each(["users", "user_profiles"])("em %s, a contagem de colunas é igual à de valores", (tabela) => {
    const { colunas, valores } = insertDoScript(tabela);
    expect(valores).toHaveLength(colunas.length);
  });

  it.each(["users", "user_profiles"])("nenhuma coluna obrigatória de %s fica de fora", (tabela) => {
    const doSchema = colunasDaTabela(tabela);
    const { colunas } = insertDoScript(tabela);
    const obrigatorias: string[] = [];
    for (const [nome, definicao] of doSchema) {
      if (!definicao.includes(".notNull()")) continue;
      if (/default|autoincrement|generatedAlwaysAs/.test(definicao)) continue;
      obrigatorias.push(nome);
    }
    for (const coluna of obrigatorias) {
      expect(colunas.includes(coluna), `${tabela}.${coluna} é obrigatória e não está no INSERT`).toBe(true);
    }
  });

  it("a conta nasce sem senha, Bronze e com onboarding pendente — igual ao registerUser", () => {
    const { colunas, valores } = insertDoScript("users");
    expect(colunas).toContain("passwordHash");
    expect(fonteScript).toMatch(/VALUES \(\?, \?, \?, NULL,/);   // passwordHash nulo
    expect(fonteScript).toContain('"email_" + crypto.randomBytes(16).toString("hex")');

    // O valor NA POSIÇÃO da coluna role, não um 'bronze' solto em qualquer
    // lugar do arquivo. Governança de 14/09: todo cadastro nasce Bronze e a
    // Prata vem da régua do perfil; a carga gravava 'silver' fixo e as contas
    // importadas nunca passavam por reavaliarNivelPeloPerfil, que só sobe Bronze.
    expect(valores[colunas.indexOf("role")]).toBe("'bronze'");
    expect(valores[colunas.indexOf("onboardingCompleted")]).toBe("0");
    expect(fonteScript).not.toContain("'silver'");

    // E o mesmo papel que o cadastro pela tela grava: se um dos dois mudar
    // sozinho, o comentário "igual ao registerUser" do script volta a mentir.
    const fonteAuth = readFileSync(pathResolve(raiz, "server", "auth.ts"), "utf8");
    // Até a função seguinte: "\n}" pararia no fim do tipo dos parâmetros.
    const registerUser = entre(fonteAuth, "export async function registerUser", "export async function loginUser");
    expect(registerUser, "registerUser não encontrado em server/auth.ts").not.toBeNull();
    const papelDaTela = /\brole:\s*"(\w+)"/.exec(registerUser!.texto)?.[1];
    expect(papelDaTela).toBe("bronze");
    expect(valores[colunas.indexOf("role")]).toBe(`'${papelDaTela}'`);
  });

  it("grava os dois nomes de cada campo duplicado, senão metade do produto fica cega", () => {
    const { colunas } = insertDoScript("user_profiles");
    for (const par of [["sector", "sectors"], ["company", "currentCompany"], ["jobTitle", "currentRole"]]) {
      for (const coluna of par) expect(colunas, `falta ${coluna}`).toContain(coluna);
    }
    // whatIHave e whatINeed são o que o cruzamento lê: sem eles a carga não conecta.
    expect(colunas).toContain("whatIHave");
    expect(colunas).toContain("whatINeed");
  });
});

// ══ 11. a instrução da carga é a MESMA que a tela de login dá ═══════════════
// A conta importada nasce sem senha, então a primeira coisa que a participante
// faz é "Esqueci minha senha". Se o script instruir uma coisa e o login
// responder outra, ela fica sem saída — foi o que acontecia com a mensagem
// antiga, que mandava tentar com Google num produto sem login por provedor.
describe("carga e login dizem a mesma coisa sobre a conta sem senha", () => {
  it("a mensagem do login cita Esqueci minha senha, e o script também", async () => {
    const { MENSAGEM_CONTA_SEM_SENHA } = await import("./auth");
    expect(MENSAGEM_CONTA_SEM_SENHA).toContain("Esqueci minha senha");
    expect(MENSAGEM_CONTA_SEM_SENHA).not.toMatch(/Google|provedor/);

    const AQUI = (import.meta as { dirname?: string }).dirname ?? ".";
    const fonte = readFileSync(pathResolve(AQUI, "..", "scripts", "importar-participantes.mjs"), "utf8");
    expect(fonte).toContain("Esqueci minha senha");
  });
});


// ══ 12. o vocabulário fechado do cruzamento ══════════════════════════════════
// Achado da revisão adversarial de 12/09, confirmado por dois verificadores:
// server/matching.ts cruza por ID, não por texto. Gravar texto livre em
// whatIHave/whatINeed fazia a complementaridade (30% do score) cair para 20 —
// PIOR que os 50 de um perfil vazio. Toda a base carregada ficaria abaixo de
// quem não preencheu nada, e o patamar mútuo seria inalcançável.
describe("as tags viram os ids que o cruzamento entende", () => {
  it("traduz o que a pessoa escreveu, casando no começo da palavra", () => {
    expect(classificarTags(["exportação de vinho"], VOCABULARIO_POSSUI).ids).toEqual(["commodities"]);
    expect(classificarTags(["distribuidor na Europa"], VOCABULARIO_PROCURA).ids).toEqual(["distribuidores"]);
    expect(classificarTags(["Armazém alfandegado"], VOCABULARIO_POSSUI).ids).toEqual(["logistica"]);
  });

  // ── A REGRESSÃO QUE ESTE BLOCO EXISTE PARA IMPEDIR ────────────────────────
  // A primeira versão de classificarTags casava por `includes` solto. O termo
  // "ti" (de tecnologia) mora DENTRO de logística, certificação, têxtil,
  // alimentício, ativos e "rede de investidores": as seis viravam `tecnologia`
  // em silêncio, porque tag que "casa" não gera aviso nenhum no ensaio. Cada
  // linha abaixo é um caso que o verificador rodou e viu sair errado.
  it.each([
    ["logística própria", "logistica"],
    ["certificação ISO 9001", "licencas"],
    ["certificado de origem", "licencas"],
    ["rede de investidores", "investidores"],
    ["plantação de soja", "fazenda"],
    ["plantio de café", "fazenda"],
    ["planta industrial", "industria"],
    ["fábrica de embalagens", "industria"],
    ["TI", "tecnologia"],
    ["app próprio", "tecnologia"],
  ])("'%s' vira '%s', e não tecnologia por causa das letras 'ti'", (tag, id) => {
    expect(classificarTags([tag], VOCABULARIO_POSSUI).ids).toEqual([id]);
  });

  it.each([["têxtil"], ["alimentício"], ["artigos de vestuário"], ["atividade rural"], ["ativos imobiliários"]])(
    "'%s' não casa com nada e volta como não reconhecida, em vez de virar tecnologia",
    tag => {
      const r = classificarTags([tag], VOCABULARIO_POSSUI);
      expect(r.ids).toEqual([]);
      expect(r.naoReconhecidas).toEqual([tag]);
    },
  );

  it("ganha o termo mais longo, então a ordem das chaves do vocabulário não decide", () => {
    // "planta" (industria) é prefixo de "plantacao" (fazenda), e industria vem
    // antes no objeto. Com o primeiro-que-casa, a plantação virava indústria.
    expect(classificarTags(["plantação de soja"], VOCABULARIO_POSSUI).ids).toEqual(["fazenda"]);
  });

  it("empate entre ids diferentes não vira chute: sai como ambígua", () => {
    const vocabulario = { primeiro: ["alfa"], segundo: ["beta"] };
    const r = classificarTags(["alfa e beta"], vocabulario);
    expect(r.ids).toEqual([]);
    expect(r.ambiguas).toEqual(["alfa e beta"]);
    expect(r.naoReconhecidas).toEqual([]);
  });

  it("importação e exportação são direção do negócio, não ativo: não roubam a tag do objeto", () => {
    // A regra da cliente é cruzar pelo OBJETO ("exportar vinho" × "importar
    // vinho"), então "exportacao" não pode vencer "vinho" por ser mais longa.
    expect(classificarTags(["exportação de vinho"], VOCABULARIO_POSSUI).ids).toEqual(["commodities"]);
    expect(classificarTags(["importação de azeite"], VOCABULARIO_POSSUI).ids).toEqual(["commodities"]);
  });

  it("o que não casa não é inventado nem jogado fora: volta como não reconhecida", () => {
    const r = classificarTags(["rótulo próprio", "tecnologia"], VOCABULARIO_POSSUI);
    expect(r.ids).toEqual(["tecnologia"]);
    expect(r.naoReconhecidas).toEqual(["rótulo próprio"]);
  });

  it("id repetido entra uma vez só", () => {
    expect(classificarTags(["software", "sistema", "plataforma"], VOCABULARIO_POSSUI).ids).toEqual(["tecnologia"]);
  });

  it("todo id do vocabulário existe no motor de cruzamento", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(pathResolve(AQUI_TESTE, "matching.ts"), "utf8");
    const mapa = fonte.slice(fonte.indexOf("const HAVE_SATISFIES_NEED"), fonte.indexOf("/** Quantas necessidades"));
    for (const id of Object.keys(VOCABULARIO_POSSUI)) {
      expect(mapa, `possui '${id}' não existe em HAVE_SATISFIES_NEED`).toContain(`${id}:`);
    }
    for (const id of Object.keys(VOCABULARIO_PROCURA)) {
      expect(mapa, `procura '${id}' não é satisfeito por nada`).toContain(`"${id}"`);
    }
  });

  it("linha com tags fora do vocabulário entra NEUTRA, não penalizada", () => {
    const r = prepararImportacao(planilha(
      "Maria;maria@exemplo.com;;;;;;coisa que ninguém mapeou;outra coisa estranha",
    ));
    const p = r.participantes[0];
    expect(p.idsPossui).toEqual([]);
    expect(p.idsProcura).toEqual([]);
    // O texto não se perde: sai no aviso, e o script grava em currentResources.
    expect(p.possui).toEqual(["coisa que ninguém mapeou"]);
    expect(r.avisos.some(a => a.aviso.startsWith("nenhuma tag foi reconhecida"))).toBe(true);
  });

  it("a completude conta o que o cruzamento lê, não o que foi digitado", () => {
    const comIds = completude({ nome: "M", possui: ["tecnologia"], procura: ["investidores"], idsPossui: ["tecnologia"], idsProcura: ["investidores"] });
    const soTexto = completude({ nome: "M", possui: ["algo estranho"], procura: ["outro"], idsPossui: [], idsProcura: [] });
    expect(comIds).toBeGreaterThan(soTexto);
  });
});

// ══ 12b. a aspa solta no meio do campo (achado do Nicolas, 14/09) ════════════
// Uma bio com `50"` engolia o resto do arquivo: o parser tratava QUALQUER aspa
// como abertura de campo entre aspas, então a partir dali o separador e a quebra
// de linha viravam texto e as participantes seguintes desapareciam — não como
// recusa, com número de linha, mas em silêncio absoluto.
//
// A INVARIANTE, DITA COMO ELA É (revisão de 15/09). "Válidas + recusadas = total
// de linhas de dados" não valia em todo caminho, e o contraexemplo é o bloco 12d:
// um campo entre aspas pode atravessar a quebra de linha e engolir as linhas do
// meio, e aí a conta fecha justamente porque as engolidas sumiram. A invariante
// verdadeira é condicional, e o código agora a sustenta:
//
//   em toda planilha que NÃO é recusada inteira (erroFatal), válidas + recusadas
//   = o total de linhas de dados com conteúdo.
//
// O caso em que ela não poderia valer — linha que engole as seguintes — deixou de
// passar em silêncio: é detectado e recusa o ARQUIVO, com o número da linha que
// abre e da que fecha (bloco 12d).
describe("aspa solta no meio do campo não engole o resto da planilha", () => {
  const CABECALHO_COM_BIO = "nome;email;setor;possui;procura;bio";
  const CASO_DO_NICOLAS = [
    CABECALHO_COM_BIO,
    'Maria;maria@exemplo.com;Alimentação;vinho;distribuidor;vende tela de 50" na loja',
    "Ana;ana@exemplo.com;Logística;logística;compradores;bio sem aspa nenhuma",
    "Bia;bia@exemplo.com;Saúde;tecnologia;investidores;outra bio comum",
  ].join("\n");

  it("as três linhas continuam existindo, e a aspa fica no texto como a pessoa escreveu", () => {
    const { linhas } = lerCsv(CASO_DO_NICOLAS);
    expect(linhas).toHaveLength(4);
    expect(linhas[1][5]).toBe('vende tela de 50" na loja');
    expect(linhas[2][0]).toBe("Ana");
    expect(linhas[3][0]).toBe("Bia");
  });

  it("válidas + recusadas = o total de linhas de dados", () => {
    const r = prepararImportacao(CASO_DO_NICOLAS);
    expect(r.erroFatal).toBeUndefined();
    expect(r.participantes.length + r.recusadas.length).toBe(3);
    expect(r.participantes.map(p => p.email)).toEqual([
      "maria@exemplo.com", "ana@exemplo.com", "bia@exemplo.com",
    ]);
    expect(r.participantes[0].bio).toBe('vende tela de 50" na loja');
  });

  it("o campo que usa aspas DE VERDADE continua funcionando", () => {
    const { linhas } = lerCsv('nome;bio\n"Silva; Maria";"ela disse ""sim"" e assinou"\nAna;fim');
    expect(linhas[1][0]).toBe("Silva; Maria");
    expect(linhas[1][1]).toBe('ela disse "sim" e assinou');
    expect(linhas[2]).toEqual(["Ana", "fim"]);
  });

  it("dentro de um campo entre aspas, a aspa solta é literal e a do fim é que fecha", () => {
    const { linhas } = lerCsv('nome;bio;cidade\nMaria;"tela de 50" na loja";Recife');
    expect(linhas[1]).toEqual(["Maria", 'tela de 50" na loja', "Recife"]);
  });

  it("aspa em toda célula da linha não desalinha as colunas", () => {
    const { linhas } = lerCsv('nome;bio\n5" de altura;3" de largura\nAna;fim');
    expect(linhas[1]).toEqual(['5" de altura', '3" de largura']);
    expect(linhas[2]).toEqual(["Ana", "fim"]);
  });

});

// ══ 12c. os três destinos de uma aspa (revisão de 15/09) ═════════════════════
// A correção da aspa solta trocou um buraco por outro: passou a tratar a aspa do
// COMEÇO do campo como sintaxe que só fecha antes do separador, e com isso uma
// bio que começa com aspas — `"Transformar" é o verbo dela`, escrita sem as
// aspas de campo — abria um campo que nunca fechava e DERRUBAVA O ARQUIVO
// INTEIRO, que antes entrava. Uma planilha de 600 participantes recusada por
// causa de uma aspa é o mesmo dano de antes, com outra roupa.
//
// Os três destinos possíveis de uma aspa, e o que cada um faz:
//
// 1. no INÍCIO do campo: abre campo entre aspas (CSV normal) — o separador, a
//    quebra de linha e a aspa dobrada ficam sendo texto até a aspa de fecho.
// 2. NO MEIO do campo: caractere literal — `tela de 50"` é polegada.
// 3. aberta e NUNCA fechada: para SÓ naquela linha. A leitura volta ao ponto da
//    abertura, rebaixa aquela aspa a caractere e relê dali; a linha sai como
//    RECUSADA, com o número e o motivo, e as outras entram.
//
// A invariante continua a mesma dos dois achados, na forma condicional do bloco
// 12b: em planilha que não é recusada inteira, válidas + recusadas = linhas de
// dados com conteúdo. Ninguém some, nem por engolimento silencioso, nem por
// recusa em bloco.
describe("os três destinos de uma aspa", () => {
  const CABECALHO_COM_BIO = "nome;email;setor;possui;procura;bio";

  it("1. aspa no INÍCIO do campo abre campo entre aspas, como em qualquer CSV", () => {
    const { linhas, linhasComAspasAbertas } = lerCsv(
      'nome;bio\nMaria;"vinho; azeite e ""rótulo próprio"""\nAna;fim',
    );
    expect(linhas[1]).toEqual(["Maria", 'vinho; azeite e "rótulo próprio"']);
    expect(linhas[2]).toEqual(["Ana", "fim"]);
    expect(linhasComAspasAbertas).toEqual([]);
  });

  it("2. aspa NO MEIO do campo é caractere literal, e não desalinha a linha", () => {
    const { linhas, linhasComAspasAbertas } = lerCsv(
      'nome;bio;cidade\nMaria;vende tela de 50" na loja;Recife\nAna;fim;SP',
    );
    expect(linhas[1]).toEqual(["Maria", 'vende tela de 50" na loja', "Recife"]);
    expect(linhas[2]).toEqual(["Ana", "fim", "SP"]);
    expect(linhasComAspasAbertas).toEqual([]);
  });

  it("3. aspa aberta e nunca fechada para SÓ na linha dela", () => {
    const CASO = [
      CABECALHO_COM_BIO,
      'Maria;maria@exemplo.com;Saúde;vinho;compradores;"Transformar" é o verbo dela',
      "Ana;ana@exemplo.com;Logística;logística;compradores;bio comum",
      "Bia;bia@exemplo.com;Saúde;tecnologia;investidores;outra bio",
    ].join("\n");

    const { linhas, linhasComAspasAbertas } = lerCsv(CASO);
    expect(linhasComAspasAbertas).toEqual([2]);
    expect(linhas).toHaveLength(4);
    expect(linhas[1][5]).toBe('"Transformar" é o verbo dela');
    expect(linhas[2][0]).toBe("Ana");
    expect(linhas[3][0]).toBe("Bia");

    const r = prepararImportacao(CASO);
    expect(r.erroFatal).toBeUndefined();
    expect(r.participantes.map(p => p.email)).toEqual(["ana@exemplo.com", "bia@exemplo.com"]);
    expect(r.recusadas).toHaveLength(1);
    expect(r.recusadas[0].numero).toBe(2);
    expect(r.recusadas[0].email).toBe("maria@exemplo.com");
    expect(r.recusadas[0].erros.join(" ")).toMatch(/aspas/i);
    // A invariante: ninguém some.
    expect(r.participantes.length + r.recusadas.length).toBe(3);
  });

  it("aspa aberta na ÚLTIMA linha não leva as anteriores junto", () => {
    const r = prepararImportacao([
      CABECALHO_COM_BIO,
      "Ana;ana@exemplo.com;Logística;logística;compradores;bio comum",
      'Maria;maria@exemplo.com;Saúde;vinho;compradores;"bio que abre aspas e nunca fecha',
    ].join("\n"));
    expect(r.erroFatal).toBeUndefined();
    expect(r.participantes.map(p => p.email)).toEqual(["ana@exemplo.com"]);
    expect(r.recusadas.map(l => l.numero)).toEqual([3]);
    expect(r.participantes.length + r.recusadas.length).toBe(2);
  });

  it("aspa aberta no CABEÇALHO é fatal: sem ele não se sabe qual coluna é qual", () => {
    const r = prepararImportacao('nome;"email;bio\nMaria;maria@exemplo.com;bio comum');
    expect(r.erroFatal).toMatch(/aspas/i);
    expect(r.erroFatal).toContain("linha 1");
    expect(r.participantes).toEqual([]);
  });

  it("campo entre aspas que atravessa a quebra de linha continua sendo um campo só", () => {
    const { linhas, linhasComAspasAbertas, linhasQueEngolemOutras } = lerCsv(
      'nome;bio\nMaria;"primeira linha\nsegunda linha"\nAna;fim',
    );
    expect(linhas[1]).toEqual(["Maria", "primeira linha\nsegunda linha"]);
    expect(linhas[2]).toEqual(["Ana", "fim"]);
    expect(linhasComAspasAbertas).toEqual([]);
    // A leitura lê como manda o CSV, E CONTA o que fez: o registro 2 começou na
    // linha 2 do arquivo e terminou na 3. Quem decide o que fazer com isso é o
    // prepararImportacao (bloco 12d).
    expect(linhasQueEngolemOutras).toEqual([{ numero: 2, de: 2, ate: 3 }]);
  });
});

// ══ 12d. a linha que ENGOLE as seguintes (contraexemplo do revisor, 15/09) ═══
// A invariante anunciada nos blocos 12b/12c — válidas + recusadas = linhas de
// dados — não valia em todo caminho, e o furo era o oposto do destino 3: uma
// aspa que ABRE numa linha e FECHA muitas linhas depois. Tudo o que está no meio
// entra dentro de um campo, e a conta fecha exatamente porque as linhas do meio
// deixaram de existir. Na leitura antiga, a planilha abaixo virava 2 registros
// para 4 linhas de dados, sem marca nenhuma: Ana e Bia sumiam em silêncio.
//
// Campo entre aspas atravessando a quebra de linha é CSV legítimo, então não dá
// para "consertar" a leitura. O que dá, e é o que o código faz agora, é DETECTAR
// e recusar o arquivo com o número da linha que abre e o da que fecha. Com isso a
// invariante passa a valer de verdade na forma condicional: em toda planilha que
// não é recusada inteira, válidas + recusadas = linhas de dados com conteúdo.
describe("linha que engole as seguintes recusa o arquivo, em vez de sumir com gente", () => {
  const CONTRAEXEMPLO = [
    "nome;email;setor;possui;procura;bio",
    'Maria;maria@exemplo.com;Saúde;vinho;compradores;"Transformar" é o verbo dela',
    "Ana;ana@exemplo.com;Logística;logística;compradores;bio comum",
    "Bia;bia@exemplo.com;Saúde;tecnologia;investidores;outra bio",
    'Carla;carla@exemplo.com;Moda;tecnologia;compradores;e aqui fecha"',
  ].join("\n");

  it("a leitura enxerga o engolimento e diz de que linha a que linha", () => {
    const { linhas, linhasQueEngolemOutras } = lerCsv(CONTRAEXEMPLO);
    // 4 linhas de dados viraram 1 registro: é isso que ninguém via.
    expect(linhas).toHaveLength(2);
    expect(linhasQueEngolemOutras).toEqual([{ numero: 2, de: 2, ate: 5 }]);
  });

  it("e o arquivo é recusado, com as duas linhas e o que fazer", () => {
    const r = prepararImportacao(CONTRAEXEMPLO);
    expect(r.erroFatal).toContain("linha 2");
    expect(r.erroFatal).toContain("linha 5");
    expect(r.erroFatal).toMatch(/aspas/i);
    expect(r.erroFatal).toMatch(/rode de novo/);
    expect(r.participantes).toEqual([]);
  });

  it("a bio com quebra de linha de propósito cai na mesma recusa, e não em silêncio", () => {
    // Não dá para distinguir uma da outra daqui: as duas são uma aspa que abre
    // numa linha e fecha em outra. Recusar as duas é o único jeito de nunca
    // engolir participante.
    const r = prepararImportacao([
      "nome;email;bio",
      'Maria;maria@exemplo.com;"primeira linha',
      'segunda linha"',
      "Ana;ana@exemplo.com;bio comum",
    ].join("\n"));
    expect(r.erroFatal).toContain("linha 2");
    expect(r.erroFatal).toContain("linha 3");
    expect(r.erroFatal).toMatch(/UMA linha/);
  });

  it("cabeçalho que engole a primeira participante também é fatal, e se identifica", () => {
    const r = prepararImportacao('nome;"email;bio\nMaria;maria@exemplo.com;bio comum"');
    expect(r.erroFatal).toContain("cabeçalho");
    expect(r.erroFatal).toContain("linha 2");
    expect(r.participantes).toEqual([]);
  });

  it("a mensagem concorda no singular e no plural", () => {
    expect(erroDeLinhasEngolidas({ numero: 3, de: 4, ate: 5 })).toContain("a linha 5 foi lida");
    expect(erroDeLinhasEngolidas({ numero: 3, de: 4, ate: 7 })).toContain("as linhas 5 a 7 foram lidas");
  });

  // A invariante em si, sobre os caminhos que existem: ou o arquivo é recusado
  // inteiro, e aí não há contagem, ou toda linha de dados com conteúdo saiu como
  // válida ou como recusada — nenhuma some no caminho.
  it.each([
    ["linha limpa", ["Ana;ana@exemplo.com;Logística;logística;compradores;bio comum"]],
    ["aspa no meio do campo", ['Maria;maria@exemplo.com;Saúde;vinho;compradores;tela de 50" na loja']],
    ["aspa aberta e nunca fechada", ['Maria;maria@exemplo.com;Saúde;vinho;compradores;"Transformar" é o verbo']],
    ["e-mail repetido e linha sem nome", [
      "Ana;ana@exemplo.com;Logística;logística;compradores;bio",
      ";sem-nome@exemplo.com;;;;",
      "Outra;ANA@exemplo.com;Saúde;vinho;compradores;bio",
    ]],
    ["linha que engole as seguintes", [
      'Maria;maria@exemplo.com;Saúde;vinho;compradores;"abre aqui',
      'Ana;ana@exemplo.com;Logística;logística;compradores;fecha aqui"',
    ]],
  ])("%s: ou recusa o arquivo, ou fecha a conta das linhas", (_caso, corpo) => {
    const texto = ["nome;email;setor;possui;procura;bio", ...corpo].join("\n");
    const r = prepararImportacao(texto);
    if (r.erroFatal) {
      expect(r.participantes).toEqual([]);
      expect(r.recusadas).toEqual([]);
      return;
    }
    const comConteudo = corpo.filter(l => l.replace(/[;\s]/g, "") !== "").length;
    expect(r.participantes.length + r.recusadas.length).toBe(comConteudo);
  });
});

// ══ 12e. o custo da leitura (revisão de 15/09) ═══════════════════════════════
// A leitura anterior descobria a aspa que nunca fecha só ao bater no fim do
// arquivo: voltava ao ponto da abertura e RELIA tudo dali para frente. Como a
// aspa decorativa no começo da bio (`"Transformar" é o verbo dela`) é justamente
// o que aparece repetido numa base inteira, cada linha dessas custava uma
// releitura do resto — custo quadrático. Medido nesta máquina (Node 24) com o
// mesmo texto: 100 linhas 24 ms, 200 linhas 71 ms, 400 linhas 247 ms (quadruplica
// a cada dobro), e 800 linhas de bio grande, 1,2 MB, 6,7 SEGUNDOS. Com a leitura
// de uma passada só, o mesmo 1,2 MB sai em 14 ms.
describe("o custo da leitura cresce com o tamanho, não com o quadrado", () => {
  function planilhaComAspaDecorativa(quantas: number, tamanhoDaBio: number) {
    const recheio = "x".repeat(tamanhoDaBio);
    const linhas = ["nome;email;setor;possui;procura;bio"];
    for (let i = 0; i < quantas; i++) {
      linhas.push(`Participante ${i};p${i}@exemplo.com;Saúde;tecnologia;investidores;"Transformar" é o verbo dela ${recheio}`);
    }
    return linhas.join("\n");
  }

  it("1,2 MB com 800 aspas decorativas são lidos numa passada só", () => {
    const texto = planilhaComAspaDecorativa(800, 1500);
    expect(texto.length).toBeGreaterThan(1_000_000);

    const comecou = Date.now();
    const { linhas, linhasComAspasAbertas } = lerCsv(texto);
    const levou = Date.now() - comecou;

    // Rápido E certo: as 800 linhas existem, cada uma marcada como aspa aberta,
    // e o texto da bio volta inteiro com a aspa que a pessoa digitou.
    expect(linhas).toHaveLength(801);
    expect(linhasComAspasAbertas).toHaveLength(800);
    expect(linhas[1][0]).toBe("Participante 0");
    expect(linhas[800][5]).toContain('"Transformar" é o verbo dela');
    // 6,7 s antes, 14 ms depois: o teto é folgado de propósito, para máquina
    // lenta de CI não virar falha inventada, e mesmo assim reprova o quadrático.
    expect(levou).toBeLessThan(2000);
  }, 60_000);
});

// ══ 12f. a mensagem que diz o que aconteceu de verdade ═══════════════════════
// A recusa por aspas terminava com "as outras linhas entraram normalmente" — e
// saía igualzinha no ENSAIO, que não grava nada. Quem sabe se houve gravação é o
// script (ele conhece o --aplicar), não o parser; o texto da linha recusada fala
// só do que é certo, e o destino das outras vem de destinoDasOutrasLinhas.
describe("a recusa por aspas não promete o que não aconteceu", () => {
  it("o texto da linha recusada fala só dela", () => {
    expect(ERRO_DE_ASPAS_ABERTAS).toMatch(/Feche as aspas/);
    expect(ERRO_DE_ASPAS_ABERTAS).not.toMatch(/entraram/i);
    expect(ERRO_DE_ASPAS_ABERTAS).not.toMatch(/outras linhas/i);
  });

  it("no ensaio, a frase diz que ninguém entrou; com --aplicar, que as outras seguem", () => {
    expect(destinoDasOutrasLinhas(false)).toMatch(/ENSAIO/);
    expect(destinoDasOutrasLinhas(false)).toMatch(/nada foi gravado/);
    expect(destinoDasOutrasLinhas(false)).not.toMatch(/entraram normalmente/);
    expect(destinoDasOutrasLinhas(true)).toMatch(/seguem para a carga/);
  });

  it("e é o script que escolhe a frase, pelo --aplicar", () => {
    const fonte = readFileSync(pathResolve(AQUI_TESTE, "..", "scripts", "importar-participantes.mjs"), "utf8");
    expect(fonte).toContain("destinoDasOutrasLinhas(aplicar)");
    expect(fonte).not.toContain("as outras linhas entraram normalmente");
  });
});

// ══ 13. o modelo que o script imprime é lido certo por ele mesmo ═════════════
// Achado da revisão: o exemplo tinha ';' dentro de campo num CSV de ';', sem
// aspas — e o próprio script lia a demanda da Maria como o LinkedIn dela, em
// silêncio, com completude de 100%. O teste antigo redigitava o cabeçalho num
// literal em vez de importar a constante, então não pegava nada disso.
describe("o MODELO de verdade, lido pelo próprio parser", () => {
  it("cada campo do exemplo cai na coluna certa", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync(pathResolve(AQUI_TESTE, "..", "scripts", "importar-participantes.mjs"), "utf8");
    const inicio = fonte.indexOf("const MODELO = `") + "const MODELO = `".length;
    const modelo = fonte.slice(inicio, fonte.indexOf("`;", inicio));

    const r = prepararImportacao(modelo);
    expect(r.erroFatal).toBeUndefined();
    expect(r.recusadas).toEqual([]);
    expect(r.participantes).toHaveLength(2);

    const maria = r.participantes[0];
    expect(maria.email).toBe("maria@exemplo.com.br");
    expect(maria.empresa).toBe("Vinícola Serra");
    expect(maria.cargo).toBe("Sócia-fundadora");
    expect(maria.cidade).toBe("Bento Gonçalves");
    expect(maria.possui).toEqual(["exportação de vinho", "rótulo próprio"]);
    expect(maria.procura).toEqual(["distribuidor na Europa", "logística refrigerada"]);
    expect(maria.linkedin).toBe("linkedin.com/in/exemplo");
    expect(maria.bio).toContain("vinho fino");
    expect(maria.idsPossui.length).toBeGreaterThan(0);
  });
});
