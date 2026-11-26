/**
 * O portão da demanda expressa na camada de IA (pedido do Nicolas, 12/09/2026).
 *
 * Os dois motores por LLM de routers/matching.ts — recomendação de
 * oportunidades para o perfil e alerta de oportunidade nova para os perfis —
 * pediam ao modelo que considerasse "necessidades implícitas". Era a origem
 * exata do defeito: quem tinha "Advocacia tributária" em "O que tenho" casava
 * com toda oportunidade de empresa que "poderia precisar" de um tributarista.
 *
 * A regra vai no prompt (é a IA que interpreta "o que tenho" e "o que
 * preciso"), mas prompt é pedido, não garantia. Por isso o modelo passa a
 * responder, em cada match, o TIPO do item de "o que tenho" em que se apoiou
 * e, quando é serviço, o trecho LITERAL do outro lado que declara a
 * necessidade — e o código confere que esse trecho está mesmo no texto que a
 * pessoa escreveu na oportunidade. Serviço sem citação conferida não sai da
 * tela, seja qual for a nota.
 *
 * E o rótulo do modelo não é a única trava (revisões adversariais de 12/09):
 * o classificador determinístico (shared/tipo-da-oferta.ts) é o PISO. Perfil
 * que só tem serviço a oferecer — em "O que tenho" ou, sem nada ali, na área
 * de atuação e na especialidade que o prompt também recebe — e nada declarado
 * em "preciso"/"busca" exige citação seja qual for o tipo que o modelo
 * escreveu; tipo irreconhecível com serviço no perfil também exige. E a regra
 * vale nos dois sentidos: oportunidade que OFERECE um serviço só casa com
 * perfil que declarou algo que possa ser aquele serviço (até 14/09 bastava
 * declarar qualquer coisa). Para produtos, ativos, investimento,
 * conexões, tecnologia e imóveis nada muda: o portão só atua no tipo
 * "servico".
 */
import { nomeiamAMesmaCoisa, normalizar, slugDoTermo, tokensDoTermo } from "@shared/direcao-do-termo";
import { CHAVE_OUTRA_NECESSIDADE, CHAVE_QUERO_MENTORAR, opcaoDaBusca } from "@shared/o-que-busca";
import {
  CATEGORIAS_CUJA_DESCRICAO_E_OFERTA, chavesQueValemComoNecessidade, demandaValida, lerDemandas, necessidadesDasDemandas, qualificadoresDaDemanda,
  rotuloDoQuePreciso,
} from "@shared/o-que-preciso";
import {
  citacaoPedeServicoOferecido, classificarOferta, ehServico, ehServicoDeAssessoria, especialidadeDoServico, familiaDoServico, mesmaFamiliaEEspecialidade,
  necessidadeGenericaNomeiaOServico, necessidadeNomeiaOServico, textoPedeOServico,
  necessidadeDeclaraOAssuntoDoServico, necessidadePedeImovel, PALAVRAS_DE_SERVICO, regraNaoLeOPar, PALAVRAS_VAZIAS_DA_CITACAO, PAPEIS_DE_COMERCIO, servicoDoTermo, TIPOS_DA_OFERTA, trechoNomeiaServicoAtendido, type TipoDaOferta,
} from "@shared/tipo-da-oferta";

/** Os nove tipos mais "nenhuma": o match que se apoia no que a pessoa PRECISA, não no que tem. */
export const TIPOS_PARA_A_IA = [...TIPOS_DA_OFERTA.map(item => item.tipo), "nenhuma"] as const;
export type TipoParaAIA = TipoDaOferta | "nenhuma";

/** As duas propriedades que todo item de resposta do LLM passa a carregar (schema JSON estrito). */
export const PROPRIEDADES_DO_PORTAO = {
  tipoDaOferta: { type: "string", enum: [...TIPOS_PARA_A_IA] },
  necessidadeExpressa: { type: "string" },
} as const;

/**
 * Quanto da descrição de cada oportunidade vai à recomendação (o prompt
 * carrega até 50 delas). Eram 200 caracteres: com o portão, a necessidade
 * declarada precisa CABER no que o modelo vê, senão o serviço legítimo nunca
 * casa. O alerta, que é de uma oportunidade só, manda a descrição inteira.
 */
export const DESCRICAO_NA_RECOMENDACAO = 800;

/** Corta em fronteira de palavra, com reticência, para o modelo não "completar" uma frase partida. */
export function cortarEmPalavra(texto: string, maximo: number): string {
  if (texto.length <= maximo) return texto;
  const corte = texto.lastIndexOf(" ", maximo);
  return `${texto.slice(0, corte > maximo / 2 ? corte : maximo).trimEnd()}…`;
}

/**
 * O texto que a PESSOA escreveu na oportunidade — título, tags e descrição.
 * É contra isto que a citação é conferida. Setor, tipo e id ficam de fora de
 * propósito: setor é exatamente o que o pedido diz que NÃO é necessidade, e a
 * linha inteira do prompt (com "Setor:") fazia uma "citação" do setor conferir.
 */
export function textoEscritoPelaPessoa(titulo: string | null | undefined, tags: unknown, descricao: string | null | undefined): string {
  const lista = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  return [titulo ?? "", ...lista, descricao ?? ""].join(" | ");
}

/**
 * O texto da regra, igual nos dois prompts. Fala de "tenho" (é como os
 * perfis chegam ao modelo: `tenho:[...] preciso:[...]`) e de "o outro lado"
 * (a oportunidade, na recomendação; a oportunidade de novo, no alerta).
 */
export const REGRA_DA_DEMANDA_EXPRESSA = `REGRA DA DEMANDA EXPRESSA (obrigatória; vale para SERVIÇOS):
1. Antes de pontuar, classifique cada item de "tenho" / "O que tenho" em um destes tipos: servico, produto, ativo, oportunidade, investimento, conexao, tecnologia, imovel, outros.
2. Um item do tipo SERVIÇO (advocacia, consultoria, assessoria, contabilidade, marketing, treinamento...) só sustenta compatibilidade quando o outro lado DECLARA, com todas as letras, que precisa desse serviço ou de uma solução semanticamente equivalente. As palavras podem ser outras: "advocacia tributária" atende "precisamos revisar nossos tributos e identificar créditos fiscais"; "consultoria para registro de medicamentos" atende "suporte para obter autorização regulatória do nosso medicamento".
3. NÃO conta como necessidade: setor ou atividade econômica, porte, localização, cargo, problemas típicos do segmento, obrigações legais que normalmente se aplicam, serviços que "seriam úteis", necessidades prováveis ou oportunidades comerciais genéricas. Uma indústria farmacêutica que procura "distribuidor para a África" NÃO é match para um serviço tributário, ainda que toda indústria tenha impostos. Essas informações só podem aumentar a nota de um match que JÁ passou por esta regra; nunca criá-lo.
4. Sem necessidade expressa compatível, o serviço não gera match: não o liste. Vale nos dois sentidos: uma OPORTUNIDADE que oferece um serviço só é compatível com quem DECLAROU precisar dele em "preciso" — nunca com quem "poderia precisar" por causa do setor. Quem procura distribuidor, comprador, fornecedor ou investidor pede a contraparte, não um serviço; e a frase que só descreve a empresa ("empresa com operações internacionais") não é necessidade.
5. "Buscando" são as opções marcadas em "O que você busca?". "Serviço Especializado" é genérica: não declara necessidade de nenhum serviço e nunca sustenta sozinha um match de serviço. As demais opções (investimento, parceiro, clientes, fornecedores, talentos, conexões, visibilidade, expandir o negócio, internacionalização, tecnologia) não pedem serviço. O texto de "Outra necessidade" é necessidade declarada, como "preciso". Em "Demandas detalhadas" (a segunda camada de "O que preciso"), vale a DESCRIÇÃO de cada demanda, que já vai em "preciso" (a de "Compradores / Clientes" não: descreve o que a pessoa vende, não é necessidade, e por isso nem aparece ali): a categoria sozinha não declara necessidade ("Especialistas / Serviços" sem descrição é genérica, como "Serviço Especializado"), e setor, país, região, cidade, valor e prazo só qualificam uma demanda — nunca a criam.
6.Em cada resultado informe "tipoDaOferta": o tipo do item de "tenho" em que o match se apoia — ou "nenhuma" quando o match se apoia no que a pessoa PRECISA (o outro lado oferece o que ela declarou procurar). Quando "tipoDaOferta" for "servico", copie em "necessidadeExpressa" o trecho LITERAL do título, das tags ou da descrição do outro lado que declara a necessidade (as mesmas palavras, sem parafrasear, pelo menos duas palavras; setor e tipo não são necessidade); nos demais casos deixe "necessidadeExpressa" vazio.
Princípio: não fazemos match porque alguém poderia precisar; fazemos match porque alguém declarou que precisa.`;

const SINONIMOS_DE_TIPO: Record<string, TipoParaAIA> = {
  servico: "servico", servicos: "servico", service: "servico", services: "servico", servicio: "servico", servicios: "servico",
  produto: "produto", produtos: "produto", product: "produto", products: "produto", producto: "produto",
  ativo: "ativo", ativos: "ativo", asset: "ativo", assets: "ativo", activo: "ativo",
  oportunidade: "oportunidade", oportunidades: "oportunidade", opportunity: "oportunidade",
  investimento: "investimento", investimentos: "investimento", investment: "investimento", capital: "investimento",
  conexao: "conexao", conexoes: "conexao", connection: "conexao", network: "conexao", networking: "conexao",
  tecnologia: "tecnologia", technology: "tecnologia", tech: "tecnologia",
  imovel: "imovel", imoveis: "imovel", infraestrutura: "imovel", infrastructure: "imovel",
  outros: "outros", outro: "outros", other: "outros", others: "outros",
  nenhuma: "nenhuma", nenhum: "nenhuma", none: "nenhuma",
};

/**
 * O tipo como o modelo o escreveu, trazido ao vocabulário do enum — ou null
 * quando nenhuma palavra é reconhecida. Num valor misto ("produto/servico") o
 * tipo restritivo vence: é o portão que existe para o serviço, e a mistura
 * não pode desligá-lo.
 */
export function reconhecerTipo(valor: unknown): TipoParaAIA | null {
  if (typeof valor !== "string") return null;
  let primeiro: TipoParaAIA | null = null;
  for (const palavra of tokensDoTermo(valor)) {
    const tipo = SINONIMOS_DE_TIPO[palavra];
    if (tipo === "servico") return "servico";
    if (tipo && !primeiro) primeiro = tipo;
  }
  return primeiro;
}

/**
 * `reconhecerTipo` com "outros" para o que não se reconhece (e um aviso no
 * log): o schema pede o enum exato; esta tradução é para "Serviço", "SERVICO"
 * ou "investimento/capital" não escaparem do portão por grafia.
 */
export function normalizarTipo(valor: unknown): TipoParaAIA {
  const tipo = reconhecerTipo(valor);
  if (tipo) return tipo;
  console.warn(`[Match] Tipo de oferta fora do vocabulário na resposta da IA: ${JSON.stringify(valor)}`);
  return "outros";
}

// Palavras que não provam nada numa citação: ligação, artigo, preposição (a mesma lista da localização da citação).
const PALAVRAS_VAZIAS = PALAVRAS_VAZIAS_DA_CITACAO;

/**
 * A citação está no texto-fonte? Conferência por palavras, não por texto
 * exato: a normalização apaga acento e caixa, e o modelo às vezes corta uma
 * palavra de ligação ou corrige um plural. Exige pelo menos DUAS palavras de
 * conteúdo (uma tag solta é palavra-chave, não declaração) e, entre elas, no
 * máximo UMA ausente da fonte — com até três, nenhuma; e a ausente nunca pode
 * ser palavra de serviço, porque "frase real + serviço presumido emendado no
 * fim" é justamente como o modelo presume. Tolerância fixa, não proporção:
 * 70% deixava passar duas palavras inventadas a partir de sete (revisões
 * adversariais de 12/09). Uma citação inventada não passa, porque as palavras
 * dela não estão na fonte.
 *
 * E as palavras presentes precisam aparecer NA ORDEM da citação, numa frase só
 * da fonte, com até duas palavras de conteúdo entre cada par (item 2 da lista
 * do Nicolas na #135, 15/09): a conferência por conjunto deixava "revisar
 * tributos" passar montada de "Indústria com alta carga de tributos. Queremos
 * revisar nossa estratégia de distribuição" — o exemplo 2 da spec da Glenda de
 * novo. Frase termina em ponto, exclamação, interrogação, ponto e vírgula,
 * reticência ou quebra de linha; a barra que separa título, tags e descrição
 * não termina frase, porque o título é muitas vezes a cabeça da frase que a
 * descrição continua. Palavra citada que ESTÁ na fonte mas fora da janela é
 * montagem, não tolerância: só a palavra que não está em lugar nenhum conta
 * como ausente.
 *
 * Chinês e japonês não separam palavras, e a citação inteira chegava como UMA
 * palavra: "我们需要税务咨询服务" nunca conferia, e o serviço não passava nesses
 * idiomas nem com a necessidade declarada (9e866b9 da #127, revisão de 14/09).
 * Ali a conferência é literal: cada pedaço citado precisa estar inteiro dentro de
 * um pedaço da fonte, sem tolerância (não há palavra para contar), com ao menos
 * quatro caracteres — duas palavras de dois —, e as palavras latinas da mesma
 * citação também precisam estar todas na fonte.
 *
 * A conferência literal só vale quando a citação é, de fato, chinesa ou
 * japonesa: com duas palavras latinas de conteúdo ou mais, é uma frase latina
 * com um nome no meio ("Precisamos de consultoria tributária para a filial de
 * 東京"). Ali as palavras seguem a regra de sempre, com a tolerância, e o nome
 * só precisa estar na fonte — antes o nome curto (menos de quatro caracteres)
 * derrubava a citação inteira, e o portão barrava o match (0d6643d da #127,
 * revisão de 15/09).
 */
const ESCRITA_SEM_ESPACO = new RegExp("[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]", "u");
const MINIMO_DE_CARACTERES_SEM_ESPACO = 4;
/** Fim de frase na fonte, latina ou do chinês e do japonês (。！？；). Sem a barra de `textoEscritoPelaPessoa` e sem dois-pontos, de propósito (ver `citacaoConfere`). */
const FIM_DE_FRASE = new RegExp("[.!?;\\u2026\\n\\u3002\\uFF01\\uFF1F\\uFF1B]+");
/** Quantas palavras de conteúdo da fonte podem ficar entre duas palavras consecutivas da citação. */
const INTERCALADAS_NA_CITACAO = 2;

/** Pedaço que conta na conferência: escrita sem espaço, ou palavra latina de conteúdo (três letras ou mais, fora as vazias). */
const ehConteudo = (pedaco: string) => ESCRITA_SEM_ESPACO.test(pedaco) || (pedaco.length >= 3 && !PALAVRAS_VAZIAS.has(pedaco));

/** Os pedaços de conteúdo da citação na ordem escrita, os de escrita sem espaço, as palavras latinas e se ela vai à conferência literal. */
function lerCitacao(citacao: string): { conteudo: string[]; semEspaco: string[]; palavras: string[]; literal: boolean } {
  const conteudo = tokensDoTermo(citacao).filter(ehConteudo);
  const semEspaco = conteudo.filter(pedaco => ESCRITA_SEM_ESPACO.test(pedaco));
  const palavras = conteudo.filter(palavra => !ESCRITA_SEM_ESPACO.test(palavra));
  return { conteudo, semEspaco, palavras, literal: semEspaco.length > 0 && palavras.length < 2 };
}

/** As frases da fonte, cada uma reduzida aos pedaços de conteúdo (os mesmos que a citação conserva). */
function frasesDaFonte(fonte: string): string[][] {
  return fonte.split(FIM_DE_FRASE).map(frase => tokensDoTermo(frase).filter(ehConteudo)).filter(frase => frase.length > 0);
}

/** O pedaço citado casa com o da fonte: igual, ou contido nele quando é escrita sem espaço ("東京" em "東京の支店"). */
const casaComAFonte = (pedaco: string, daFonte: string) => (ESCRITA_SEM_ESPACO.test(pedaco) ? daFonte.includes(pedaco) : daFonte === pedaco);

/** Negação ANTES do termo em chinês: "不需要", "不再需要", "不太需要", "没有". */
const NEGACOES_ANTES_SEM_ESPACO = new Set(Array.from("不沒没"));
/** Quantos caracteres antes do termo a negação ainda o alcança ("不再", "不太", "暂时不"). */
const ALCANCE_DA_NEGACAO_ANTES = 3;
/** Negação DEPOIS do termo, que é como o japonês nega: "必要ありません", "必要ではない". */
const NEGACOES_DEPOIS_SEM_ESPACO = ["ありません", "ございません", "ません", "ない", "不要", "無用", "无需"];
/**
 * A negação depois só vale COLADA no termo (com uma partícula no meio, como em
 * "必要ではありません"). Mais longe que isso ela é de outra oração: em
 * "必要だが急ぎではない" o ない nega a pressa, não a necessidade.
 */
const INICIO_DA_NEGACAO_DEPOIS = 3;
const ALCANCE_DA_NEGACAO_DEPOIS = 12;
/**
 * Fim de frase PARA ESTA CONFERÊNCIA: o fim de frase de sempre mais a barra
 * com que `textoEscritoPelaPessoa` junta título, tags e descrição — dois
 * pedaços de CAMPOS diferentes não são uma citação.
 *
 * A vírgula ideográfica (、) fica FORA: em chinês e japonês ela separa itens de
 * uma lista dentro da mesma frase ("会计、税务咨询服务"), e cortar ali recusava a
 * citação que é substring contígua da fonte — o trecho literal que o prompt
 * manda copiar. Quem segura a montagem dentro da frase é a DISTÂNCIA.
 */
const FIM_DE_ORACAO_NO_TEXTO = new RegExp("[.!?;\\u2026\\n\\u3002\\uFF01\\uFF1F\\uFF1B|\\uFF5C]+");
/**
 * Quantos caracteres cabem entre um pedaço citado e o próximo. É o equivalente
 * em texto do `INTERCALADAS_NA_CITACAO` do ramo latino (2 pedaços de conteúdo):
 * em escrita sem espaço uma palavra tem 2 a 4 caracteres.
 */
const DISTANCIA_ENTRE_PEDACOS = 12;

/** O termo está negado na oração: negação encostada antes (zh) ou logo depois (ja)? */
function estaNegado(frase: string, inicio: number, tamanho: number): boolean {
  const antes = frase.slice(Math.max(0, inicio - ALCANCE_DA_NEGACAO_ANTES), inicio);
  if (Array.from(antes).some(caractere => NEGACOES_ANTES_SEM_ESPACO.has(caractere))) return true;
  const depois = frase.slice(inicio + tamanho, inicio + tamanho + ALCANCE_DA_NEGACAO_DEPOIS);
  return NEGACOES_DEPOIS_SEM_ESPACO.some(negacao => {
    const onde = depois.indexOf(negacao);
    return onde >= 0 && onde <= INICIO_DA_NEGACAO_DEPOIS;
  });
}

/**
 * A ordem conferida por POSIÇÃO NO TEXTO da oração, que é o que faz sentido em
 * escrita sem espaço: ali a oração inteira é um token só, e dois pedaços
 * citados da mesma oração nunca se encontram na janela de tokens de
 * `emOrdemNumaFrase` — ela só olha tokens posteriores ao que casou.
 *
 * O pedaço NEGADO não conta como citado: era essa a montagem do relato
 * ("需要 税务咨询" tirado de "我们不需要税务咨询", que diz o contrário, e
 * "弁護士 必要" de "弁護士は必要ありません"). Ordem sozinha não vê negação, e foi
 * por isso que a primeira correção recusou junto a citação honesta.
 *
 * A busca é no texto NORMALIZADO, porque os pedaços vêm de `tokensDoTermo`, que
 * baixa a caixa e tira o diacrítico: procurar no texto cru fazia a citação
 * exata "SAP 税务咨询" não se achar na própria fonte.
 */
function emOrdemNoTextoDaFrase(pedacos: readonly string[], fonte: string): boolean {
  if (pedacos.length === 0) return false;
  // A negação só desqualifica o pedaço numa citação MONTADA (dois pedaços ou
  // mais). Citar UM trecho que está literalmente na fonte continua valendo,
  // como já valia antes desta regra — ali quem confere se o trecho pede o
  // serviço do perfil é `citacaoAmarradaAoPerfil`.
  const conferirNegacao = pedacos.length > 1;
  return normalizar(fonte).split(FIM_DE_ORACAO_NO_TEXTO).some(frase => {
    let posicao = 0;
    for (const pedaco of pedacos) {
      let achou = frase.indexOf(pedaco, posicao);
      while (achou >= 0 && conferirNegacao && estaNegado(frase, achou, pedaco.length)) achou = frase.indexOf(pedaco, achou + 1);
      if (achou < 0) return false;
      // Longe demais do pedaço anterior é montagem, não citação — o mesmo que a
      // janela de tokens faz no ramo latino.
      if (posicao > 0 && achou - posicao > DISTANCIA_ENTRE_PEDACOS) return false;
      posicao = achou + pedaco.length;
    }
    return true;
  });
}

/** Os pedaços aparecem nesta ordem numa frase só, com até INTERCALADAS_NA_CITACAO pedaços de conteúdo entre cada par? */
function emOrdemNumaFrase(pedacos: readonly string[], frases: readonly (readonly string[])[]): boolean {
  if (pedacos.length === 0) return false;
  return frases.some(frase => frase.some((primeira, inicio) => {
    if (!casaComAFonte(pedacos[0], primeira)) return false;
    let posicao = inicio;
    for (const pedaco of pedacos.slice(1)) {
      const janela = frase.slice(posicao + 1, posicao + 2 + INTERCALADAS_NA_CITACAO);
      const achou = janela.findIndex(daFonte => casaComAFonte(pedaco, daFonte));
      if (achou < 0) return false;
      posicao += achou + 1;
    }
    return true;
  }));
}

export function citacaoConfere(citacao: unknown, fonte: string): boolean {
  if (typeof citacao !== "string") return false;
  const pedacosDaFonte = tokensDoTermo(fonte);
  const { conteudo, semEspaco, palavras, literal } = lerCitacao(citacao);
  if (semEspaco.length > 0) {
    if (!semEspaco.every(pedaco => pedacosDaFonte.some(daFonte => daFonte.includes(pedaco)))) return false;
    if (literal) {
      const caracteres = semEspaco.reduce((total, pedaco) => total + Array.from(pedaco).length, 0);
      if (caracteres < MINIMO_DE_CARACTERES_SEM_ESPACO) return false;
      const latinasDaFonte = new Set(pedacosDaFonte);
      if (!palavras.every(pedaco => latinasDaFonte.has(pedaco))) return false;
      // A ordem vale aqui também: este ramo devolvia antes da conferência e
      // aceitava montagem em chinês e japonês ("需要 税务咨询" sobre uma fonte que
      // diz o contrário), enquanto o equivalente latino era barrado — validação
      // de 16/09 na #135. A conferência é pelo TEXTO da frase, não pela janela
      // de tokens: nesta escrita a oração é um token só, e a janela recusava
      // toda citação de dois pedaços, honesta inclusive.
      return emOrdemNoTextoDaFrase(conteudo, fonte);
    }
  }
  if (palavras.length < 2) return false;
  const daFonte = new Set(pedacosDaFonte);
  const ausentes = new Set(palavras.filter(palavra => !daFonte.has(palavra)));
  if (Array.from(ausentes).some(palavra => PALAVRAS_DE_SERVICO.has(palavra))) return false;
  if (ausentes.size > (palavras.length <= 3 ? 0 : 1)) return false;
  // O que está na fonte precisa estar nela NA ORDEM, numa frase só: senão é montagem.
  return emOrdemNumaFrase(conteudo.filter(pedaco => !ausentes.has(pedaco)), frasesDaFonte(fonte));
}

export type ItemComPortao = { tipoDaOferta?: unknown; necessidadeExpressa?: unknown };

/** O que o portão lê do perfil de quem oferece — só o que decide se há base expressa fora do serviço. */
export type PerfilNoPortao = {
  whatIHave?: unknown;
  whatINeed?: unknown;
  /** As demandas detalhadas de "O que preciso" (shared/o-que-preciso.ts): a descrição é necessidade DECLARADA. */
  whatINeedDetails?: unknown;
  seekingTypes?: unknown;
  /** O texto de "Outra necessidade" em "O que você busca?" — necessidade DECLARADA, como "O que preciso". */
  seekingOtherNeed?: unknown;
  lookingForInvestment?: unknown;
  activityArea?: unknown;
  primarySpecialty?: unknown;
};

/** O que o portão lê da oportunidade do outro lado. */
export type OportunidadeNoPortao = { type?: unknown; title?: unknown };

const lista = (valor: unknown): string[] =>
  Array.isArray(valor) ? valor.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
const texto = (valor: unknown): string[] => (typeof valor === "string" && valor.trim() !== "" ? [valor] : []);

// ─── "O que você busca?" (12 opções desde 14/09, pedido do Lucas no grupo) ────
//
// A regra da Glenda vale para as opções marcadas também. "Serviço Especializado
// (Jurídico, tributário, regulatório, marketing etc.)" é GENÉRICA: marcá-la não
// é necessidade expressa de serviço nenhum, e abrir o portão por ela recriaria o
// falso positivo que a spec proíbe. As outras dez não pedem serviço
// (investimento, parceiro, clientes, fornecedores, talentos, conexões
// institucionais, visibilidade, expandir o negócio, internacionalização,
// tecnologia): nunca liberam serviço sozinhas. Só o TEXTO de "Outra
// necessidade" é necessidade declarada, e vale como "O que preciso". As chaves
// antigas seguem no banco: "mentor" pede só mentoria; "investor",
// "strategic_partner", "team" e "job" não pedem serviço; "be_mentor" ("Quero
// também mentorar") é oferta, não busca.

/** A opção genérica de serviço: não declara necessidade de serviço nenhum. */
export const BUSCA_GENERICA_DE_SERVICO = "servico_especializado";
/** Buscas que não dão ao perfil base nenhuma fora do serviço: a genérica, a oferta de mentorar e "Outra" sem texto. */
const BUSCAS_SEM_BASE = new Set<string>([BUSCA_GENERICA_DE_SERVICO, CHAVE_QUERO_MENTORAR, CHAVE_OUTRA_NECESSIDADE]);
const ROTULO_DAS_BUSCAS_SEM_EQUIVALENTE: Readonly<Record<string, string>> = {
  job: "Emprego/Projeto", mentor: "Mentora", be_mentor: "Quer também mentorar",
};

/** O rótulo pt-BR de uma busca, para os prompts; a genérica de serviço vai marcada como genérica. */
export function rotuloDaBusca(valor: string): string {
  const opcao = opcaoDaBusca(valor);
  if (!opcao) return ROTULO_DAS_BUSCAS_SEM_EQUIVALENTE[valor] ?? valor;
  return opcao.chave === BUSCA_GENERICA_DE_SERVICO ? `${opcao.titulo} (genérica: não declara necessidade de um serviço específico)` : opcao.titulo;
}

/** As buscas de um perfil, rotuladas e separadas por vírgula (vazio quando não há). */
export function rotularBuscas(seekingTypes: unknown): string {
  return lista(seekingTypes).map(rotuloDaBusca).join(", ");
}

/**
 * As necessidades que o perfil ESCREVEU: "O que preciso", a descrição das demandas detalhadas e o texto de
 * "Outra necessidade" — este só com a opção marcada, porque desmarcá-la apaga o texto
 * (`textoDaOutraNecessidade` em shared/o-que-busca.ts).
 *
 * Das chaves de "O que preciso" (14/09, Rosber), as nove categorias novas NÃO entram: a seleção sozinha não
 * gera conexão, e lida como texto "expansao_internacionalizacao" casava com "Consultoria em
 * internacionalização" e "especialistas_servicos" era classificada como serviço — abririam o portão sem
 * necessidade declarada. Delas vale só a descrição de cada demanda (`necessidadesDasDemandas`), e só da
 * categoria marcada — e nunca a descrição, nem o texto de "Outra necessidade", que nomeia o serviço que o
 * próprio perfil oferece (`descricaoNomeiaOQueOPerfilOferece`). As oito chaves antigas reaproveitadas e
 * "consultoria" seguem como antes: perfil antigo sem detalhamento segue com a regra de hoje.
 */
export function necessidadesEscritasDoPerfil(perfil: PerfilNoPortao): string[] {
  // A guarda de concorrência vale para os dois textos livres: a descrição da demanda e "Outra necessidade".
  const naoEAPropriaOferta = (necessidade: string) => !descricaoNomeiaOQueOPerfilOferece(perfil, necessidade);
  const outra = (lista(perfil.seekingTypes).includes(CHAVE_OUTRA_NECESSIDADE) ? texto(perfil.seekingOtherNeed).map(item => item.trim()) : []).filter(naoEAPropriaOferta);
  const dasDemandas = necessidadesDasDemandas(perfil.whatINeed, perfil.whatINeedDetails).filter(naoEAPropriaOferta);
  return [...chavesQueValemComoNecessidade(perfil.whatINeed), ...dasDemandas, ...outra];
}

/**
 * A guarda de concorrência (item 1 da revisão do Nicolas na PR #135): a descrição de uma demanda que NOMEIA o
 * serviço que o próprio perfil oferece não é necessidade — é a oferta contada de novo. A consultora tributária
 * que escreve em "Expansão / Internacionalização" "Consultoria tributária para indústrias do Nordeste" não
 * precisa de consultoria tributária: ela a presta; lida como "preciso", a frase conectava duas prestadoras do
 * mesmo serviço sem nenhuma declarar precisar dele. O critério é `ofertaAtenderiaOTexto`: o texto nomeia o
 * serviço COM a especialidade, ou declara o assunto dele. Um palpite de FAMÍLIA não basta — quem declara a área
 * "Advocacia" e escreve que precisa de "Advogado para causas do trabalho" não está repetindo a oferta: pela
 * regra da casa, oferecer a família não prova a especialidade (vale 60, um bom palpite), e palpite não pode
 * apagar necessidade declarada. As ofertas são TUDO o que o perfil declara: "O que
 * tenho" E a área de atuação E a especialidade (`tudoOQueOPerfilOferece`), não o "um ou outro" de
 * `ofertasDoPerfil`: a tela grava ids fixos em "O que tenho" (nenhum é serviço), então com "canais_comerciais"
 * ali o serviço mora na área, e o fallback deixava a guarda cega. A chave da categoria segue valendo como necessidade;
 * descrição que pede OUTRO serviço ("Preciso de um contador") segue necessidade; "Compradores" segue fora por
 * inteiro (`CATEGORIAS_CUJA_DESCRICAO_E_OFERTA`), porque ali a pergunta já é o que ela vende. O texto de "Outra
 * necessidade" passa pela mesma guarda: é texto livre como a descrição, e a mesma consultora escrevendo ali
 * "Consultoria tributária para indústrias" tinha o texto lido como necessidade. Quem chama precisa trazer
 * `activityArea` e `primarySpecialty` no perfil (a rede global não trazia, e a guarda ficava inerte lá).
 */
function descricaoNomeiaOQueOPerfilOferece(perfil: PerfilNoPortao, descricao: string): boolean {
  return tudoOQueOPerfilOferece(perfil).some(oferta => ofertaAtenderiaOTexto(oferta, descricao));
}

/**
 * O texto é a própria oferta contada de novo. Duas maneiras, as duas de `satisfaz` (server/matching.ts):
 * o texto nomeia o serviço com a MESMA especialidade, ou declara o ASSUNTO dele sem nomear. A guarda usava só
 * a primeira, e bastava trocar a redação para escapar dela: "Advocacia tributária para indústrias" era barrado,
 * mas "Planejamento tributário para investidores estrangeiros" passava e voltava a valer 50 no motor de perfis
 * (validação de 16/09 na #135).
 *
 * NÃO é paridade com `satisfaz`, e não pode ser: `satisfaz` responde "este par casa?" e esta guarda responde
 * "este texto É a oferta?". Casar não prova ser. O palpite de família (`necessidadeGenericaNomeiaOServico`, 60)
 * conta, salvo num caso: a oferta é a FAMÍLIA PURA e o texto PEDE o serviço (`textoPedeOServico`) —
 * "Preciso de advogado para causas do trabalho", "Preciso de advogado marítimo" (que vale a nota da família desde a
 * decisão de 16/09). Sem o pedido, o texto da prestadora da família é a oferta contada de novo e continua apagado:
 * "Consultoria para indústrias do Nordeste", "Advocacia para empresas do agronegócio", "Contabilidade para o
 * agronegócio" e "Logística para exportação de café", escritos em "Outra necessidade" por quem tem a área, voltavam
 * a valer 41 diante de outra prestadora da mesma família no delta da validação (revisão cética de 16/09); na main
 * eram apagados. "Advogado para causas do trabalho" sem o pedido fica apagado, como na main. Com a oferta
 * especializada o palpite conta sempre: "Consultoria tributária" diante do texto "Consultoria" é a própria oferta
 * contada de novo, e é o caso que originou a guarda. A OPÇÃO fixa "Consultoria" da tela continua valendo como
 * necessidade por decisão de produto (`chavesQueValemComoNecessidade`): ali a pessoa escolheu de uma lista, não
 * descreveu a própria oferta.
 * O `regraNaoLeOPar` acompanha `satisfaz`: par que a regra não lê num idioma novo não conta de nenhum lado.
 */
function ofertaAtenderiaOTexto(oferta: string, texto: string): boolean {
  if (mesmaFamiliaEEspecialidade(oferta, null, texto)) return true;
  // O palpite de família conta: quem presta "Consultoria tributária" e escreve
  // "Consultoria" no texto livre está contando a própria oferta de novo — é o
  // caso que originou a guarda. A exceção é a oferta genérica diante do texto
  // que PEDE o serviço ("Preciso de advogado para causas do trabalho"): ali o
  // palpite apagaria necessidade declarada. Sem o pedido, a prestadora da
  // família escrevendo "Consultoria para indústrias do Nordeste" é a oferta.
  // A pureza tem de ser lida como o MOTOR lê, e ele parte o rótulo coordenado:
  // "Advocacia e contabilidade" são duas famílias puras, não uma família com a
  // outra de especialidade. `especialidadeDoServico` é o acessor que faz isso.
  const ofertaEhFamiliaPura = servicoDoTermo(oferta) !== null && especialidadeDoServico(oferta).length === 0;
  if (necessidadeGenericaNomeiaOServico(oferta, null, texto) && !(ofertaEhFamiliaPura && textoPedeOServico(texto))) return true;
  // O último ramo de `satisfaz` (server/matching.ts): a palavra genérica "Consultoria"
  // diante de quem presta assessoria. É o que fazia o par casar sem a guarda ver,
  // e a oferta contada de novo voltava a valer como necessidade declarada.
  if (slugDoTermo(texto) === "consultoria" && ehServicoDeAssessoria(oferta)) return true;
  return necessidadeDeclaraOAssuntoDoServico(oferta, null, texto) && !regraNaoLeOPar(oferta, null, texto);
}

/** "O que tenho", área de atuação e especialidade, juntos: o que a guarda de concorrência confronta com o texto. */
function tudoOQueOPerfilOferece(perfil: PerfilNoPortao): string[] {
  return [...lista(perfil.whatIHave), ...texto(perfil.activityArea), ...texto(perfil.primarySpecialty)];
}

/**
 * As demandas detalhadas para o prompt: uma por linha, com a categoria, a descrição (a necessidade) e os
 * dados estruturados rotulados como qualificadores. Vazio quando não há demanda válida de categoria marcada.
 */
export function descreverDemandasParaIA(perfil: PerfilNoPortao): string {
  const marcadas = lista(perfil.whatINeed);
  return lerDemandas(perfil.whatINeedDetails)
    // Compradores descreve o que ela vende: a mesma exclusão de necessidadesDasDemandas, senão o prompt
    // diria ao modelo que é necessidade. E a descrição que nomeia o serviço que o perfil oferece (a guarda de
    // concorrência) também fica de fora, pela mesma razão.
    .filter(demanda => marcadas.includes(demanda.category) && !CATEGORIAS_CUJA_DESCRICAO_E_OFERTA.has(demanda.category) && demandaValida(demanda)
      && !descricaoNomeiaOQueOPerfilOferece(perfil, demanda.description as string))
    .map((demanda, indice) => {
      const qualificadores = qualificadoresDaDemanda(demanda);
      // JSON.stringify: o texto é da membra; aspas e quebras de linha não podem desmontar a linha do prompt.
      return `${indice + 1}. ${rotuloDoQuePreciso(demanda.category)}: ${JSON.stringify(demanda.description)}${qualificadores.length ? ` qualificadores: ${JSON.stringify(qualificadores)}` : ""}`;
    })
    .join("\n");
}

/**
 * O que o perfil OFERECE aos olhos do portão: "O que tenho" e, quando está
 * vazio, a área de atuação e a especialidade — que o prompt também recebe e
 * das quais o modelo deduz o serviço ("Área de atuação: advocacia
 * tributária"). Sem isto o piso nunca disparava com a UI de hoje, que só
 * grava ids fixos em "O que tenho".
 */
function ofertasDoPerfil(perfil: PerfilNoPortao): string[] {
  const declaradas = lista(perfil.whatIHave);
  return declaradas.length ? declaradas : [...texto(perfil.activityArea), ...texto(perfil.primarySpecialty)];
}

/**
 * O perfil declarou precisar de alguma coisa (necessidade escrita, busca ou "busco investimento")? A busca
 * genérica de serviço, "Quero também mentorar" e "Outra necessidade" sem texto não contam: não dão ao modelo
 * base nenhuma fora do serviço do perfil.
 */
export function temNecessidadeDeclarada(perfil: PerfilNoPortao): boolean {
  if (necessidadesEscritasDoPerfil(perfil).length > 0 || perfil.lookingForInvestment === true) return true;
  return lista(perfil.seekingTypes).some(busca => !BUSCAS_SEM_BASE.has(busca));
}

/** A oportunidade OFERECE um serviço (tipo "offer" com título de serviço)? */
export function oportunidadeOfereceServico(oportunidade: OportunidadeNoPortao): boolean {
  return oportunidade.type === "offer" && typeof oportunidade.title === "string" && ehServico(oportunidade.title);
}

// ─── Oportunidade que oferece serviço × o que o perfil declarou (14/09) ───────
//
// Até 14/09 bastava o perfil ter declarado QUALQUER coisa: "Consultoria
// tributária" oferecida passava para quem só procurava distribuidores, desde que
// o modelo casasse. Agora ao menos uma declaração tem de poder pedir aquele
// serviço. O critério é o da IA, não o dos motores determinísticos: só barra o
// que o texto ENTENDE e que claramente não é o serviço — contraparte comercial,
// capital, produto, imóvel, ou outro serviço nomeado. O que o texto não entende
// ("aprovação na Anvisa", "tecnologia para rastreabilidade") fica com o modelo,
// que recebeu a regra da demanda expressa no prompt.

/** Ids fixos de "O que preciso" que pedem quem TEM a mercadoria, o canal ou o capital: serviço nenhum os entrega. */
const NECESSIDADES_QUE_SERVICO_NAO_ENTREGA = new Set(["fornecedores", "compradores", "distribuidores", "investidores", "financiamento", "parceiros"]);
/** Os mesmos que a opção "Logística" atende no motor de perfis (HAVE_SATISFIES_NEED em matching.ts). */
const NECESSIDADES_DA_LOGISTICA = new Set(["distribuidores", "fornecedores"]);
const FAMILIAS_DA_LOGISTICA = new Set(["logistica", "transporte", "frete", "armazenagem"]);
// Em texto livre, quem procura distribuidor, comprador ou fornecedor procura quem tem a mercadoria ou o canal
// (PAPEIS_DE_COMERCIO mora em shared/tipo-da-oferta.ts desde 14/09: a conferência da citação usa a mesma lista).
/** O que um serviço não entrega, pelo tipo que o classificador dá à necessidade: "Galpão em Santos", "Capital de giro". */
const TIPOS_QUE_SERVICO_NAO_ENTREGA = new Set<TipoDaOferta>(["produto", "investimento", "imovel"]);
/** "Busca" do onboarding: só "mentor" pede um serviço, e só o de mentoria. */
const FAMILIAS_DO_MENTOR = new Set(["mentoria", "coaching"]);

type PedeOServico = "pede" | "talvez" | "nao";

function necessidadePedeOServico(servico: string, necessidade: string): PedeOServico {
  const chave = tokensDoTermo(necessidade).join(" ");
  if (chave === "consultoria") return ehServicoDeAssessoria(servico) ? "pede" : "nao";
  if (NECESSIDADES_QUE_SERVICO_NAO_ENTREGA.has(chave)) {
    const logistica = FAMILIAS_DA_LOGISTICA.has(familiaDoServico(servico) ?? "");
    return logistica && NECESSIDADES_DA_LOGISTICA.has(chave) ? "talvez" : "nao";
  }
  if (slugDoTermo(necessidade) === slugDoTermo(servico) || nomeiamAMesmaCoisa(servico, necessidade)) return "pede";
  if (necessidadeNomeiaOServico(servico, null, necessidade)) return "pede";
  // A necessidade nomeia OUTRO serviço que o texto entende ("consultoria em marketing" para "Consultoria jurídica").
  // Serviço oferecido sem família lida ("Planejamento tributário") não tem com o que comparar: fica com o modelo.
  if (servicoDoTermo(servico) !== null && trechoNomeiaServicoAtendido(necessidade, [servico]) === "nao-atende") return "nao";
  if (ehServico(necessidade)) return "talvez";
  if (tokensDoTermo(necessidade).some(palavra => PAPEIS_DE_COMERCIO.has(palavra))) return "nao";
  // Imóvel pedido pela cabeça ("Loja de rua no centro", "Sala comercial", "Casa para montar escritório"): a lista IMOVEL,
  // que classifica a OFERTA, ficou curta de propósito (d7fac93), e do lado do pedido faltar palavra soltava o portão.
  if (necessidadePedeImovel(necessidade)) return "nao";
  return TIPOS_QUE_SERVICO_NAO_ENTREGA.has(classificarOferta(necessidade)) ? "nao" : "talvez";
}

/**
 * O perfil declarou algo que pode ser ESTE serviço? Uma declaração ESCRITA basta
 * ("O que preciso" ou o texto de "Outra necessidade"). Das opções de "O que você
 * busca?", nenhuma das 12 libera serviço sozinha — nem "Serviço Especializado",
 * que é genérica —, e das antigas só "mentor" pede um serviço: a mentoria. Até
 * 14/09 toda busca fora de uma lista curta passava pela leitura de texto livre, e
 * "be_mentor" (uma oferta) liberava qualquer serviço.
 */
export function perfilDeclarouPrecisarDoServico(perfil: PerfilNoPortao, servico: string): boolean {
  if (necessidadesEscritasDoPerfil(perfil).some(necessidade => necessidadePedeOServico(servico, necessidade) !== "nao")) return true;
  return lista(perfil.seekingTypes).some(busca => busca === "mentor" && FAMILIAS_DO_MENTOR.has(familiaDoServico(servico) ?? ""));
}

/**
 * Rótulos que, na área de atuação (ou sozinhos em "O que tenho"), nomeiam a área de um serviço — o
 * classificador os lê como "outros" porque em texto livre são ambíguos ("lado direito", "Direito de família").
 * Ali o campo é dedicado: quem escreve "Direito" na área está dizendo de que serviço vive, e tratar isso como
 * outra base soltava a exigência de citação de quem só presta serviço (item 3 da validação de 16/09 na #135).
 *
 * Decisão do Roberto de 16/09 (D3), consequência aceita: quem escreveu só "Direito" ou "Jurídico" na área, sem
 * necessidade declarada e sem item que não seja serviço, para de receber pela IA sugestão de imóvel, capital,
 * conexão e tecnologia — o portão exige a citação, e a regra 6 do prompt a proíbe fora de serviço. Uma
 * necessidade declarada reabre. "Agronegócio" continua sendo outra base.
 */
const AREAS_QUE_NOMEIAM_SERVICO = new Set(["direito", "juridico", "juridica", "advocacia", "contabilidade", "consultoria", "assessoria", "auditoria"]);
const nomeiaServicoNaArea = (oferta: string) => {
  const palavras = tokensDoTermo(oferta);
  return palavras.length > 0 && palavras.every(palavra => AREAS_QUE_NOMEIAM_SERVICO.has(palavra));
};

/**
 * Este match exige a citação da necessidade expressa? Sim quando o modelo
 * disse que se apoia em serviço — e também, pelo piso determinístico, quando
 * o perfil só tem serviço a oferecer e nada declarado em "preciso"/"busca"/
 * "busco investimento" (não há outra base possível), ou quando o tipo veio
 * irreconhecível e há serviço no perfil (na dúvida, fecha).
 */
export function exigeCitacao(item: ItemComPortao, perfil?: PerfilNoPortao): boolean {
  const tipo = reconhecerTipo(item.tipoDaOferta);
  if (tipo === "servico") return true;
  if (!perfil) return false;
  const ofertas = ofertasDoPerfil(perfil);
  if (ofertas.length === 0) return false;
  const servicos = ofertas.filter(oferta => ehServico(oferta) || nomeiaServicoNaArea(oferta));
  if (tipo === null && servicos.length > 0) return true;
  // Outra base possível é QUALQUER oferta que não seja serviço — inclusive a que
  // o classificador não sabe ler ("outros"). O piso existe para quem não tem
  // mais nada a oferecer; com outra base, exigir citação não deixa o portão mais
  // rigoroso, deixa-o IMPASSÁVEL: a regra 6 do prompt PROÍBE citação fora do
  // tipo "servico", então a citação vem vazia e o par nunca passa.
  //
  // Foi medido: apertar isto para "só o que a pessoa DECLAROU em O que tenho"
  // conta como outra base derrubou 24 combinações reais de área × especialidade
  // — "Agronegócio" (lido como "outros") com "Marketing & Vendas" (lido como
  // serviço) parava de passar em oportunidade de imóvel, capital, conexão e
  // tecnologia, que passavam antes da PR.
  //
  // O item 3 da validação de 16/09 fecha pela ÁREA, não por este piso: "Direito"
  // e "Jurídico" na área contam como serviço (`nomeiaServicoNaArea`, decisão do
  // Roberto de 16/09), e "Agronegócio" continua sendo outra base.
  const ofereceOutraBase = ofertas.some(oferta => !ehServico(oferta) && !nomeiaServicoNaArea(oferta));
  return servicos.length > 0 && !ofereceOutraBase && !temNecessidadeDeclarada(perfil);
}


/**
 * A citação conferida precisa se apoiar num serviço que o perfil OFERECE
 * (defeito relatado em 13/09): o portão conferia que o trecho estava na
 * oportunidade, mas não que ele pedia o serviço da pessoa — "consultoria em
 * marketing" passava para quem oferece "Consultoria jurídica". Quando o trecho
 * citado nomeia um serviço, algum serviço do perfil tem de atendê-lo
 * (`citacaoPedeServicoOferecido`, que localiza a citação na fonte e completa a
 * especialidade). Trecho sem palavra de serviço é paráfrase e fica com a IA,
 * como antes; perfil sem serviço classificável também.
 *
 * Salvo em chinês e japonês (a citação que vai à conferência literal, ver
 * `citacaoConfere`): ali o resto do portão não lê a escrita — contraparte
 * ("我们需要分销商", distribuidores), capital, imóvel, autodescrição e outro
 * serviço caíam em "não nomeia serviço" e passavam, e o invariante que barra
 * essas citações em português deixava de valer nesses idiomas (revisão de 15/09
 * do porte da 9e866b9). O portão fecha por padrão: só passa quando um pedaço
 * citado NOMEIA um serviço que o perfil oferece, pela leitura do chinês e do
 * japonês pelo fim do termo ("我们需要税务咨询服务" para "税务咨询" ou para
 * "Consultoria tributária"). Até o porte a citação sem espaço nem conferia, e o
 * portão fechava sempre.
 */
export function citacaoAmarradaAoPerfil(citacao: unknown, fonte: string, perfil?: PerfilNoPortao): boolean {
  if (typeof citacao !== "string") return true;
  const { semEspaco, literal } = lerCitacao(citacao);
  if (!perfil) return !literal;
  // Os serviços do perfil vêm de "O que tenho" E da área e da especialidade: a UI só grava
  // ids fixos em "O que tenho", e a advogada que marcou "Canais comerciais" continua advogada.
  const declaradas = lista(perfil.whatIHave);
  const candidatas = [...declaradas, ...texto(perfil.activityArea), ...texto(perfil.primarySpecialty)];
  const servicos = candidatas.filter(oferta => servicoDoTermo(oferta) !== null);
  if (literal) return semEspaco.some(pedaco => servicos.some(servico => necessidadeNomeiaOServico(servico, null, pedaco)));
  if (servicos.length === 0) return true;
  const temOutraBase = declaradas.some(oferta => servicoDoTermo(oferta) === null);
  return citacaoPedeServicoOferecido(citacao, fonte, servicos, temOutraBase);
}

/**
 * O portão: match apoiado em SERVIÇO só passa com a necessidade expressa
 * citada e conferida no texto que a pessoa escreveu, e apoiada num serviço que
 * o perfil oferece; e oportunidade que oferece um serviço só passa para quem
 * declarou algo que pode ser aquele serviço (`perfilDeclarouPrecisarDoServico`).
 * Qualquer outro tipo passa como antes.
 */
export function passaNoPortao(item: ItemComPortao, fonte: string, perfil?: PerfilNoPortao, oportunidade?: OportunidadeNoPortao): boolean {
  if (perfil && oportunidade && oportunidadeOfereceServico(oportunidade) && !perfilDeclarouPrecisarDoServico(perfil, oportunidade.title as string)) return false;
  if (!exigeCitacao(item, perfil)) return true;
  return citacaoConfere(item.necessidadeExpressa, fonte) && citacaoAmarradaAoPerfil(item.necessidadeExpressa, fonte, perfil);
}
