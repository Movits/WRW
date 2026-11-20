import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROTA_DA_REUNIAO_ABERTA, ROTA_DAS_REUNIOES, ROTA_GRAVAR } from "@shared/rotas";
import { destinoDepoisDoLogin } from "@/lib/caminho-de-volta";

/**
 * O menu global em TODAS as telas autenticadas (vídeo do Rosber, 14/09/2026,
 * 22:12: "o ideal é que o menu fique sempre visível na página. Entra em
 * oportunidades: o menu some. Para acessar o menu de novo ele tem que voltar").
 *
 * Onze telas logadas — Oportunidades, Nova Oportunidade, Detalhe da
 * Oportunidade, Perfil, Conexões, Rede, Contextos, Deal Room, Painel Admin e
 * Painel Ouro — não montavam cabeçalho nenhum: quem entrava nelas só voltava a
 * navegar passando pelo Dashboard. Sete montavam o seu, com título e "voltar"
 * próprios.
 *
 * A guarda é de ROTA, não de tela: quem escrever a página 19 não precisa
 * lembrar do cabeçalho — mas se ela nascer fora do invólucro que o monta, este
 * teste cai. A regra, para cada rota autenticada do App.tsx: o cabeçalho é
 * montado UMA vez, ou pela rota (o padrão) ou pelo arquivo da página (quando
 * ela quer título, voltar ou ações próprias, e aí a rota se cala com
 * `cabecalhoProprio`). Nunca zero, nunca dois.
 *
 * E a rota isenta cobra da página a tela INTEIRA, não uma parte dela: casar o
 * texto do arquivo com /<AppHeader/ deixou passar a Reuniões, que montava o
 * cabeçalho só no ramo da LISTA e voltava a "sem menu" em "nova reunião" e no
 * detalhe — a isenção da rota valia para os três ramos, o cabeçalho para um. Por
 * isso, numa página isenta, este teste lê os RAMOS do componente (cada `return`
 * que desenha JSX) e exige o cabeçalho em todos.
 *
 * Limite conhecido, para ninguém confiar demais: a leitura é de texto, não do
 * React. Um `return` que escolhe a tela dentro da própria expressão
 * (`return a ? <X/> : <Y/>`) é lido como UM ramo — basta o cabeçalho aparecer
 * nele para passar. O que a guarda garante é que nenhum `return` de tela fique
 * sem cabeçalho, e que uma página isenta tenha ao menos um ramo legível.
 */

const RAIZ = join(process.cwd(), "client", "src");
const APP = readFileSync(join(RAIZ, "App.tsx"), "utf8");

/**
 * A única tela autenticada sem menu, de propósito: o cadastro ainda não foi
 * concluído, e toda outra rota protegida devolve quem está em /onboarding para
 * o /onboarding (ver ProtectedRoute). Um menu ali seria um beco sem saída.
 */
const SEM_MENU_DE_PROPOSITO = ["/onboarding"];

/**
 * Ramos que não são tela de conteúdo e, por isso, seguem sem cabeçalho. Cada um
 * é nomeado pela chave de tradução que o identifica dentro do arquivo, e vale
 * por um: RAMO NOVO SEM CABEÇALHO REPROVA, mesmo nestas páginas.
 *
 * - Dashboard/`dashboard.loading`: o spinner dos milissegundos entre a sessão e
 *   o perfil. Não há de onde ficar preso — o cabeçalho aparece logo em seguida.
 * - Dashboard/`dashboard.restricted`: a tela de "acesso restrito", que o
 *   ProtectedRoute nunca deixa aparecer (sem sessão ele manda para o /login);
 *   sobrou do tempo em que o Dashboard se guardava sozinho.
 */
const RAMOS_SEM_CABECALHO_DE_PROPOSITO = [
  { pagina: "Dashboard", marca: "dashboard.loading" },
  { pagina: "Dashboard", marca: "dashboard.restricted" },
];

/** Nome do componente → arquivo, lido dos `lazy(() => import("./pages/X"))`. */
function paginasImportadas(): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const [, nome, caminho] of APP.matchAll(
    /const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*"([^"]+)"/g,
  )) {
    mapa.set(nome, caminho);
  }
  return mapa;
}

type Rota = {
  caminho: string;
  /** O bloco da rota no App.tsx, do "<Route" ao "</Route>" (ou ao "/>"). */
  trecho: string;
  autenticada: boolean;
  rotaMontaCabecalho: boolean;
  paginas: string[];
};

/**
 * Cada `<Route …>` do App.tsx. O corte é simples porque a entrada é JSX já
 * formatado e sem rota aninhada: parte-se em "<Route" e cada pedaço termina no
 * "</Route>" (rota com filhos) ou no primeiro "/>" (rota de uma linha só).
 */
function rotas(): Rota[] {
  const pedacos = APP.split("<Route").slice(1);
  const importadas = paginasImportadas();
  return pedacos.map((pedaco) => {
    const fim = pedaco.includes("</Route>") ? pedaco.indexOf("</Route>") : pedaco.indexOf("/>");
    const trecho = pedaco.slice(0, fim === -1 ? pedaco.length : fim);
    const caminho = trecho.match(/path=\{?"([^"]+)"/)?.[1] ?? "(fallback)";
    const paginas = [...importadas.keys()].filter(
      (nome) => new RegExp(`<${nome}\\b|component=\\{${nome}\\}`).test(trecho),
    );
    return {
      caminho,
      trecho,
      autenticada: /ProtectedRoute|TelaAutenticada/.test(trecho),
      // O invólucro monta o cabeçalho, a menos que a rota diga que a página
      // monta o seu; um `<AppHeader` escrito à mão na rota também conta.
      rotaMontaCabecalho:
        /<AppHeader\b/.test(trecho) || /<TelaAutenticada(?![^>]*cabecalhoProprio)/.test(trecho),
      paginas,
    };
  });
}

// As rotas de Reuniões (30/10/2026) estão registradas com os mesmos caminhos de
// shared/rotas.ts: o App.tsx os escreve à mão, porque este teste lê
// `path="..."` literal. Mudou uma constante sem mudar a rota, este teste cai.
describe("as rotas de Reuniões estão no App.tsx com os caminhos de shared/rotas.ts", () => {
  it.each([ROTA_GRAVAR, `${ROTA_DAS_REUNIOES}/:id`, ROTA_DAS_REUNIOES])("%s é rota autenticada que monta a Meetings", (caminho) => {
    const rota = rotas().find((r) => r.caminho === caminho);
    expect(rota, caminho).toBeDefined();
    expect(rota!.autenticada).toBe(true);
    expect(rota!.paginas).toContain("Meetings");
  });

  it("as três montam a MESMA instância da Meetings: o mesmo invólucro, as mesmas props e nenhuma key", () => {
    // O Switch do wouter devolve uma Route só, sem key: o React reaproveita a
    // página entre as três rotas só se os blocos forem iguais. Meetings.tsx conta
    // com isso para, gravando, devolver a URL ao gravador em vez de desmontar a
    // página e perder o áudio.
    const blocos = [ROTA_GRAVAR, `${ROTA_DAS_REUNIOES}/:id`, ROTA_DAS_REUNIOES].map(
      (caminho) => rotas().find((r) => r.caminho === caminho)!.trecho.replace(/\s*path=\{?"[^"]+"\}?/, ""),
    );
    expect(blocos[0]).toContain("<Meetings");
    expect(new Set(blocos).size, "um invólucro diferente remonta a Meetings e descarta a gravação").toBe(1);
    expect(blocos[0]).not.toMatch(/\bkey=/);
  });

  it("o link aberto de uma reunião (12/11/2026) é rota PÚBLICA, no caminho de shared/rotas.ts", () => {
    // Quem abre o link não tem conta: atrás do ProtectedRoute, o link mandaria
    // ao login em vez de mostrar a reunião.
    const rota = rotas().find((r) => r.caminho === `${ROTA_DA_REUNIAO_ABERTA}/:token`);
    expect(rota).toBeDefined();
    expect(rota!.autenticada).toBe(false);
    expect(rota!.paginas).toEqual(["ReuniaoAberta"]);
  });

  it("o destino do login sem ?voltar= é uma rota registrada", () => {
    const destino = destinoDepoisDoLogin(true, "");
    expect(rotas().some((r) => r.caminho === destino)).toBe(true);
  });
});

/**
 * A página monta o próprio cabeçalho: o AppHeader inteiro (título, voltar e
 * ações dela) ou, no caso do Dashboard, a barra dele com o `<GlobalMenu />`
 * dentro — é o MENU que o vídeo cobra, não o invólucro.
 */
const MONTA_CABECALHO = /<(?:AppHeader|GlobalMenu)\b/;

function codigoDaPagina(nome: string): string {
  const caminho = paginasImportadas().get(nome);
  if (!caminho) throw new Error(`a página ${nome} não é importada no App.tsx`);
  return readFileSync(join(RAIZ, `${caminho.replace(/^\.\//, "")}.tsx`), "utf8");
}

function paginaMontaCabecalho(nome: string): boolean {
  return MONTA_CABECALHO.test(codigoDaPagina(nome));
}

function temCabecalho(rota: Rota): boolean {
  return rota.rotaMontaCabecalho || rota.paginas.some(paginaMontaCabecalho);
}

// ─── Leitura dos ramos de uma página ──────────────────────────────────────────
// Um mini-varredor de texto, não um compilador: o suficiente para achar os
// `return` do COMPONENTE (sem entrar nas funções aninhadas, cujos `return` são
// delas) e recortar o que cada um devolve.

/** Do delimitador de abertura em `abre` até o que o fecha, contando os pares. */
function fimDoGrupo(codigo: string, abre: number, abertura: string, fechamento: string): number {
  let profundidade = 0;
  for (let i = abre; i < codigo.length; i++) {
    if (codigo[i] === abertura) profundidade++;
    else if (codigo[i] === fechamento) {
      profundidade--;
      if (profundidade === 0) return i;
    }
  }
  throw new Error("delimitador não fechado");
}

/** O corpo do componente exportado com `export default function`. */
function corpoDoComponente(codigo: string): string {
  const assinatura = codigo.match(/export default function \w+\s*\(/);
  if (!assinatura) throw new Error("a página não tem `export default function`");
  const fechaParametros = fimDoGrupo(codigo, codigo.indexOf("(", assinatura.index), "(", ")");
  const abre = codigo.indexOf("{", fechaParametros);
  return codigo.slice(abre + 1, fimDoGrupo(codigo, abre, "{", "}"));
}

/** O que um `return` devolve: daqui até o `;` que fecha a expressão. */
function expressaoDoReturn(corpo: string, depoisDoReturn: number): { expressao: string; fim: number } {
  const pares: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const pendentes: string[] = [];
  for (let i = depoisDoReturn; i < corpo.length; i++) {
    const c = corpo[i];
    if (pares[c]) pendentes.push(pares[c]);
    else if (c === pendentes[pendentes.length - 1]) pendentes.pop();
    else if (pendentes.length === 0 && c === ";") {
      // `&nbsp;` e afins terminam em ";" dentro do texto do JSX, e não terminam
      // a expressão: o recorte pararia cedo e esconderia o resto do ramo.
      if (/&[a-zA-Z#0-9]+$/.test(corpo.slice(Math.max(0, i - 12), i))) continue;
      return { expressao: corpo.slice(depoisDoReturn, i), fim: i + 1 };
    } else if (pendentes.length === 0 && c === "}") {
      return { expressao: corpo.slice(depoisDoReturn, i), fim: i };
    }
  }
  return { expressao: corpo.slice(depoisDoReturn), fim: corpo.length };
}

/** Os `return` do próprio componente; os das funções aninhadas são pulados. */
function retornosDoComponente(corpo: string): string[] {
  const TOKENS = /\breturn\b|=>|\bfunction\b/g;
  const retornos: string[] = [];
  let i = 0;
  for (;;) {
    TOKENS.lastIndex = i;
    const achado = TOKENS.exec(corpo);
    if (!achado) return retornos;
    if (achado[0] === "return") {
      const { expressao, fim } = expressaoDoReturn(corpo, achado.index + "return".length);
      retornos.push(expressao.trim());
      i = fim;
    } else if (achado[0] === "function") {
      // Os parâmetros podem trazer chaves (desestruturação); o corpo é a chave
      // que vem DEPOIS do fecha-parênteses.
      const fechaParametros = fimDoGrupo(corpo, corpo.indexOf("(", achado.index), "(", ")");
      const abre = corpo.indexOf("{", fechaParametros);
      i = abre === -1 ? achado.index + 8 : fimDoGrupo(corpo, abre, "{", "}") + 1;
    } else {
      // Seta: com corpo em bloco, pula o bloco; sem bloco (`x => x.id`) não há
      // `return` para confundir e basta seguir adiante.
      const resto = corpo.slice(achado.index + 2);
      const abre = achado.index + 2 + (resto.length - resto.trimStart().length);
      i = corpo[abre] === "{" ? fimDoGrupo(corpo, abre, "{", "}") + 1 : achado.index + 2;
    }
  }
}

/** Os ramos que desenham tela: os `return` de JSX (um `return null` não é tela). */
export function ramosDeTela(codigo: string): string[] {
  return retornosDoComponente(corpoDoComponente(codigo)).filter((ramo) => /<[A-Za-z>]/.test(ramo));
}

function ramosSemCabecalho(nome: string): string[] {
  const dispensados = RAMOS_SEM_CABECALHO_DE_PROPOSITO.filter((r) => r.pagina === nome);
  return ramosDeTela(codigoDaPagina(nome))
    .filter((ramo) => !MONTA_CABECALHO.test(ramo))
    .filter((ramo) => !dispensados.some((r) => ramo.includes(r.marca)))
    .map((ramo) => `${nome}: ${ramo.replace(/\s+/g, " ").slice(0, 90)}…`);
}

/** As páginas de quem a ROTA não monta o cabeçalho: a tela inteira é com elas. */
function paginasIsentas(): string[] {
  const nomes = rotas()
    .filter((r) => r.autenticada && !r.rotaMontaCabecalho)
    .flatMap((r) => r.paginas)
    .filter(paginaMontaCabecalho);
  return [...new Set(nomes)];
}

describe("o menu global aparece em todas as telas autenticadas", () => {
  it("o App.tsx foi lido de verdade (senão o teste passaria vazio)", () => {
    const encontradas = rotas();
    expect(encontradas.length).toBeGreaterThan(15);
    const oportunidades = encontradas.find((r) => r.caminho === "/opportunities");
    expect(oportunidades?.autenticada, "/opportunities deveria ser rota protegida").toBe(true);
    expect(encontradas.filter((r) => r.autenticada).length).toBeGreaterThan(10);
  });

  it("nenhuma tela autenticada fica sem cabeçalho", () => {
    const semMenu = rotas()
      .filter((r) => r.autenticada && !SEM_MENU_DE_PROPOSITO.includes(r.caminho))
      .filter((r) => !temCabecalho(r))
      .map((r) => `${r.caminho} (${r.paginas.join(", ") || "sem página"})`);
    expect(semMenu, "estas telas logadas não têm o menu global").toEqual([]);
  });

  it("nenhuma tela autenticada monta o cabeçalho duas vezes", () => {
    const emDobro = rotas()
      .filter((r) => r.autenticada && r.rotaMontaCabecalho)
      .filter((r) => r.paginas.some(paginaMontaCabecalho))
      .map((r) => `${r.caminho}: a rota e a página montam o cabeçalho`);
    expect(emDobro, "some com um dos dois (a rota usa cabecalhoProprio)").toEqual([]);
  });

  it("as telas públicas continuam sem o cabeçalho da área logada", () => {
    const publicasComMenu = rotas()
      .filter((r) => !r.autenticada)
      .filter((r) => r.rotaMontaCabecalho)
      .map((r) => r.caminho);
    expect(publicasComMenu, "Home, login e cadastro não montam o menu logado").toEqual([]);
  });

  it("a exceção do /onboarding continua sendo rota protegida e sem menu", () => {
    const onboarding = rotas().find((r) => r.caminho === "/onboarding");
    expect(onboarding?.autenticada).toBe(true);
    expect(temCabecalho(onboarding!), "cadastro incompleto não navega para o resto").toBe(false);
  });
});

describe("na página isenta, o cabeçalho vale para a tela inteira", () => {
  it("as páginas isentas são as que a rota dispensa, e são várias", () => {
    const isentas = paginasIsentas();
    expect(isentas, "a Reuniões monta o próprio cabeçalho").toContain("Meetings");
    expect(isentas.length).toBeGreaterThan(4);
  });

  it("cada página isenta tem ramos legíveis (senão a conferência passaria vazia)", () => {
    const ilegiveis = paginasIsentas().filter((nome) => ramosDeTela(codigoDaPagina(nome)).length === 0);
    expect(ilegiveis, "não consegui ler os ramos destas páginas").toEqual([]);
  });

  it("todo ramo que desenha tela monta o cabeçalho", () => {
    const orfaos = paginasIsentas().flatMap(ramosSemCabecalho);
    expect(orfaos, "estes ramos deixam a pessoa sem menu").toEqual([]);
  });

  it("a Reuniões, que tinha o buraco, monta o cabeçalho acima dos três ramos", () => {
    // O erro de 15/09: o cabeçalho saía no `return` da LISTA, e "nova reunião" e
    // o detalhe voltavam para o `return` deles, sem menu. As três telas
    // continuam lá; o que mudou é que a escolha entre elas ficou DENTRO do ramo
    // único, com o cabeçalho fora dela.
    const codigo = codigoDaPagina("Meetings");
    for (const tela of [/<MeetingRecorder\b/, /<MeetingDetail\b/, /meetings\.heroTitle/]) {
      expect(codigo, "sumiu uma das três telas de Reuniões").toMatch(tela);
    }
    const ramos = ramosDeTela(codigo);
    expect(ramos, "a tela sai de um `return` só").toHaveLength(1);
    expect(MONTA_CABECALHO.test(ramos[0]), "o ramo único monta o cabeçalho").toBe(true);
    expect(codigo.match(/<AppHeader\b/g), "montado uma vez, nunca por ramo").toHaveLength(1);
    expect(ramosSemCabecalho("Meetings")).toEqual([]);
  });

  it("a conferência REPROVA um ramo sem cabeçalho (é o caso que passou batido)", () => {
    // O mesmo formato de antes do conserto: cabeçalho no último `return`, e os
    // ramos de cima saindo sem ele.
    const comoEra = `
      export default function Reunioes() {
        const [tela, setTela] = useState("lista");
        useEffect(() => { return () => parar(); }, []);
        function enviar(arquivo: File) { return toast.error("x"); }
        if (tela === "nova") {
          return <Gravador onBack={() => setTela("lista")} />;
        }
        if (tela === "detalhe") return <Detalhe />;
        return <><AppHeader title="Reuniões" /><main>lista</main></>;
      }
    `;
    const ramos = ramosDeTela(comoEra);
    expect(ramos, "os `return` das funções aninhadas não são ramos de tela").toHaveLength(3);
    expect(ramos.filter((ramo) => !MONTA_CABECALHO.test(ramo))).toHaveLength(2);
  });

  it("…e APROVA o formato do conserto: um cabeçalho acima dos três ramos", () => {
    const comoFicou = `
      export default function Reunioes() {
        const [tela, setTela] = useState("lista");
        const conteudo = tela === "nova" ? <Gravador /> : tela === "detalhe" ? <Detalhe /> : <main>lista</main>;
        return <><AppHeader title="Reuniões" />{conteudo}</>;
      }
    `;
    const ramos = ramosDeTela(comoFicou);
    expect(ramos).toHaveLength(1);
    expect(ramos.filter((ramo) => !MONTA_CABECALHO.test(ramo))).toEqual([]);
  });
});
