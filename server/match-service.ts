import crypto from "node:crypto";
import { and, eq, gte, inArray } from "drizzle-orm";
import { aiMatchSuggestions, contactAssets, contactNeeds, privateContacts } from "../drizzle/schema";
import { cosineSimilarity, normalizeVector } from "./memory-service";
import { exigirDb } from "./db";
import { sendEmail } from "./_core/email";
import { embedWithGemini } from "./gemini";
import { direcaoEfetiva, nomeiamAMesmaCoisa, palavrasDeConteudo, saoConcorrentes, slugDoTermo } from "@shared/direcao-do-termo";
import { classificarOferta, mesmaFamiliaEEspecialidade, necessidadeEhOferta, necessidadeDeclaraOAssuntoDoServico, necessidadeGenericaNomeiaOServico, regraNaoLeOPar } from "@shared/tipo-da-oferta";

const SAVE_THRESHOLD = 50;
const EMAIL_THRESHOLD = 70;

/**
 * A nota da necessidade que declara o ASSUNTO do serviço sem nomeá-lo (vocabulário curado de
 * shared/tipo-da-oferta.ts). Acima do corte, para o par existir; abaixo do e-mail, porque é equivalência
 * pelo assunto e não o mesmo serviço escrito de outro jeito — a mesma cautela dos 60 da família.
 */
const NOTA_DO_ASSUNTO = 60;

/**
 * N7 — o critério semântico ESTREITO: só para paráfrase ("Vendo vinhos" × "Procuro fornecedor de bebidas", "Coffee
 * beans for export" × "Grãos de café"), nunca para palavra solta, concorrente ou serviço sem demanda declarada.
 *
 * Até o N7 ele valia 45, abaixo do corte de 50, desligado por construção: com o limiar em 0,7 ele casava tudo com
 * tudo (31/08: os 45 pares de uma rede de 10 contatos, "Armazenagem refrigerada" com "Terrenos com outorga"). Agora
 * ele só vale quando TODAS as guardas de `semanticoEstreitoPodeValer` passam e a similaridade chega ao
 * LIMIAR_SEMANTICO_ESTREITO; a nota fica entre o corte (50) e a categoria (60), abaixo do e-mail (70).
 *
 * E continua DESLIGADO por padrão: só liga com MATCH_SEMANTICO_ESTREITO=1 no ambiente. Dois motivos:
 *   1. o limiar ainda não foi calibrado com os vetores do gabarito (scripts/rede-de-teste/gerar-embeddings-da-rede.mjs
 *      gera a fixture; server/rede-com-armadilhas.test.ts mede e imprime a calibração quando ela existe);
 *   2. o termo do Smart Match (docs/termos/termo-smart-match.md) afirma que, com o critério desligado, nenhum dado
 *      da agenda sai da plataforma. Ligar em produção exige publicar a versão nova do termo ANTES (texto jurídico,
 *      com a Cris), e republicar revoga os aceites.
 * Desligado, o texto do que cada contato possui e procura NÃO sai daqui para o provedor de embeddings.
 */
export const LIMIAR_SEMANTICO_ESTREITO = 0.9;
const NOTA_SEMANTICA_ESTREITA = 55;

/** O critério semântico estreito está ligado neste processo? Lido a cada chamada, como as outras chaves de IA. */
export function criterioSemanticoLigado() {
  return process.env.MATCH_SEMANTICO_ESTREITO === "1";
}

/**
 * As guardas do critério semântico estreito, que não dependem da similaridade. Só depois de todas passarem o texto
 * pode ir ao provedor de embeddings:
 *   - direções OPOSTAS: a oferta é oferta e a procura é procura, também pelas palavras ("Procuro exportar vinho" no
 *     campo de procura é oferta e não passa). Concorrentes já zeraram antes, em scoreMatch;
 *   - nada de SERVIÇO: o portão da demanda expressa continua mandando, e quem decide se a necessidade nomeia o
 *     serviço são as regras determinísticas de cima (shared/tipo-da-oferta.ts), nunca a parecença;
 *   - nada de palavra em comum: se as duas pontas dividem uma palavra de conteúdo e as regras de cima não casaram
 *     o par, a parecença viria dessa palavra ("Banco de sementes" × "Banco de investimento"). Paráfrase de verdade
 *     diz a mesma coisa com OUTRAS palavras. O custo é a paráfrase que repete uma palavra (P19 da rede: "Terrenos
 *     com outorga de água" × "Área rural com água liberada para irrigação"), que fica de fora;
 *   - as duas pontas têm conteúdo (um termo só de marcador ou de verbo não é comparável).
 */
export function semanticoEstreitoPodeValer(asset: MatchReason, need: MatchReason): boolean {
  if (saoConcorrentes(asset.label, need.label)) return false;
  if (direcaoEfetiva(asset.label, "oferta") !== "oferta" || direcaoEfetiva(need.label, "demanda") !== "demanda") return false;
  if (classificarOferta(asset.label, asset.category) === "servico") return false;
  const deA = palavrasDeConteudo(asset.label);
  const deB = new Set(palavrasDeConteudo(need.label));
  if (!deA.length || !deB.size) return false;
  return !deA.some(palavra => deB.has(palavra));
}

export type MatchReason = { slug: string; label: string; category?: string | null };
export type MatchType = "mutual" | "exact" | "category" | "semantic";

/** Um encontro entre o que alguém possui e o que outra pessoa procura. */
type Encontro = { deId: number; paraId: number; asset: MatchReason; need: MatchReason; score: number; type: MatchType };

/**
 * Tudo que liga dois contatos. Guardar por par, e não por encontro, é o que
 * permite ver "três coisas em comum" e, principalmente, reconhecer quando cada
 * um tem o que o outro procura.
 */
type Par = { lowId: number; highId: number; encontros: Encontro[] };

export function slugifyMatchTag(value: string) {
  // A MESMA normalização do analisador de termo: o slug é o objeto inteiro, e
  // os dois precisam enxergar as mesmas letras (antes, [a-z0-9] aqui e lá
  // apagava qualquer tag fora do alfabeto latino). A implementação mora em
  // shared/direcao-do-termo.ts (slugDoTermo) porque o motor de perfis também
  // compara texto livre por slug desde a regra da demanda expressa; o nome
  // fica aqui pelos importadores e pelos vi.mock que o conhecem.
  return slugDoTermo(value);
}

/**
 * `semanticScore` é a similaridade de cosseno dos dois rótulos (0 quando não foi medida). Ela só conta com o critério
 * semântico estreito ligado (`criterioSemanticoLigado`) e depois de todas as regras determinísticas.
 */
export function scoreMatch(asset: MatchReason, need: MatchReason, semanticScore = 0) {
  // Etapa 11: o cruzamento não pode ser feito por palavra parecida. "Exportar
  // vinho" e "importar vinho" são quase o mesmo texto e são o negócio; duas
  // pontas que querem exportar são concorrentes. A regra vem antes de tudo:
  // nenhum outro critério pode reapresentar quem foi barrado aqui.
  //
  // E ela exige verbo explícito NOS DOIS lados, de propósito: com uma ponta
  // neutra não há evidência de conflito na palavra. "Café" possuído diante de
  // "Exportar café" procurado não é concorrência — é quem tem o produto diante
  // de quem precisa dele para exportar. Uma tentativa de barrar pela direção
  // efetiva de um lado só zerava pares legítimos como "Terras raras" ×
  // "Fornecimento de terras raras" (a lista de verbos tem substantivos de ação
  // que, no campo de procura, nomeiam o serviço de que a pessoa precisa).
  if (saoConcorrentes(asset.label, need.label)) {
    return { score: 0, type: "semantic" as const, bloqueio: "concorrentes" as const };
  }

  // N7 (validação da #154): a prestadora que escreve a própria OFERTA no campo
  // de necessidade ("Ofereço contabilidade para MEI", "Advogado disponível para
  // empresas") não declarou precisar do serviço; diante de quem presta o mesmo
  // serviço ela é a concorrente. Antes do slug e do mesmo objeto, que a liam
  // como "contabilidade" e davam 100, com e-mail.
  if (classificarOferta(asset.label, asset.category) === "servico" && necessidadeEhOferta(need.label)) {
    return { score: 0, type: "semantic" as const, bloqueio: "servico-sem-demanda-expressa" as const };
  }

  if (asset.slug && asset.slug === need.slug) return { score: 100, type: "exact" as const };

  // O outro lado da mesma regra. Tirado o verbo, sobra o objeto — e é o objeto
  // que as duas pontas têm em comum. "Exportar vinho" e "importar vinho" viram
  // as duas "vinho": mesmo objeto, direções opostas, negócio. Sem isto a regra
  // só saberia barrar, e o par que ela existe para encontrar continuaria valendo
  // os 60 da categoria.
  //
  // Mas lugar não é mercadoria de quem DECLAROU direção: "Importação da China"
  // × "Exportação da China" reduziam os dois lados a "china", e 100 é a nota
  // de quem tem a MESMA coisa, acima do corte de e-mail. A guarda vale para o
  // objeto E para o núcleo — só num deles, o outro ainda dava 100 — e só
  // quando ao menos uma ponta trouxe verbo ou substantivo de ação: sem
  // direção nas palavras, "China" × "Procura China" é a mesma coisa dita de
  // dois jeitos, como "Terras raras" × "Procura terras raras" (revisão
  // adversarial de 05/09). Tag idêntica ("China" × "China") casa pelo slug.
  //
  // E o núcleo atravessa a cabeça transparente: "mina DE terras raras" e
  // "fornecedor DE terras raras" falam ambos de terras raras — o exemplo de
  // aceite da etapa 7, que sem isto pontuava 0 e não virava sugestão. Objeto,
  // núcleo e a guarda de lugar moram juntos em `nomeiamAMesmaCoisa`
  // (shared/direcao-do-termo.ts), porque o motor de perfis passou a precisar
  // da mesma equivalência.
  if (nomeiamAMesmaCoisa(asset.label, need.label)) return { score: 100, type: "exact" as const };

  // Regra da demanda expressa (pedido do Nicolas, 12/09/2026): SERVIÇO só casa
  // com necessidade que o NOMEIA — e os três critérios acima (tag, objeto,
  // núcleo) são exatamente isso: alguém declarou precisar do serviço. A
  // categoria não é evidência: "Advocacia tributária" e "Distribuidor para a
  // África", ambos em "Serviços", saíam em 60 — o match presumido que o pedido
  // veta ("quase toda empresa poderia precisar de um tributarista"). Para
  // produtos, ativos, investimento, conexões etc. a categoria segue valendo
  // 60, como sempre: a restrição é específica do tipo serviço.
  const ofertaEhServico = classificarOferta(asset.label, asset.category) === "servico";

  // A necessidade que NOMEIA o serviço também é demanda expressa, e passa de
  // dois jeitos — que valem notas DIFERENTES, porque não são a mesma coisa.
  //
  // 100: mesma família E mesma especialidade. "Advogado tributarista"
  // procurado diante de "Advocacia tributária" possuído é o serviço pedido,
  // escrito com outra flexão. A #101 fazia esse par cair de 60 para 0 e sumir
  // do banco (defeito relatado em 13/09).
  if (ofertaEhServico && mesmaFamiliaEEspecialidade(asset.label, asset.category, need.label)) return { score: 100, type: "exact" as const };

  // 60: a necessidade nomeia só a FAMÍLIA. "Consultoria" procurado declara
  // precisar de consultoria, e por isso o par existe (revisão adversarial de
  // 12/09: sem esta regra ele caía de 60 para 0) — mas quem escreveu
  // "Consultoria" não pediu consultoria tributária, nem de marketing, nem de
  // segurança do trabalho, e valia 100 para as três. 100 é a nota de quem tem
  // a MESMA coisa; isto é um bom palpite, que é o que 60 já significa aqui
  // (defeito relatado em 13/09). Continua acima do corte de 50, então o par
  // segue no banco — derrubar para 0 seria repetir o defeito que a regra da
  // especialidade acabou de consertar.
  if (ofertaEhServico && necessidadeGenericaNomeiaOServico(asset.label, asset.category, need.label)) return { score: 60, type: "category" as const };

  // 60, com o selo de significados parecidos: a necessidade não nomeia o
  // serviço, mas DECLARA o assunto dele — "Precisamos revisar nossos tributos
  // e identificar créditos fiscais" diante de "Advocacia tributária", "Apoio
  // para estruturar a entrada da minha empresa no Paraguai" diante de
  // "Consultoria em internacionalização" (spec da Glenda, 14/09: necessidade
  // EXPRESSA, equivalência SEMÂNTICA). Não é o critério semântico lá embaixo,
  // que segue desligado: é vocabulário curado, e a necessidade tem de pedir
  // ajuda ou uma ação — "Distribuidor para expansão na África" não passa.
  //
  // Salvo o que a regra NÃO LÊ num idioma novo (e6ddfa4 da #127, revisão de
  // 14/09): "Steuerberatung für Erbschaften" × "Steuerberater für
  // Erbschaftsteuer" só não casa por palavras que as listas não conhecem. O
  // portão não bloqueia por falta de regra: o par vale a categoria em comum,
  // como na main, ou zero sem bloqueio. Em português, inglês e espanhol a regra
  // segue estrita. E o assunto curado não decide antes dela: "Conseil en
  // fiscalité" × "Conseil en fiscalité des entreprises" valia 60 mesmo sem
  // categoria, e gravava a sugestão, enquanto o mesmo par em português
  // ("Consultoria tributária" × "Consultoria tributária de empresas") segue
  // barrado (revisão de 15/09 do porte).
  const regraNaoLe = ofertaEhServico && regraNaoLeOPar(asset.label, asset.category, need.label);
  if (ofertaEhServico && !regraNaoLe && necessidadeDeclaraOAssuntoDoServico(asset.label, asset.category, need.label)) return { score: NOTA_DO_ASSUNTO, type: "semantic" as const };

  // Segue barrado o que o pedido veta: outra família (salvo consultoria e
  // assessoria com a mesma especialidade, e o apoio que nomeia a profissão —
  // ver `comoAtende`), outra especialidade na mesma família, e a categoria em
  // comum — nada acima olha para a categoria, salvo a exceção do que a regra
  // não lê.

  const categoriaAsset = slugifyMatchTag(asset.category ?? "");
  const categoriaNeed = slugifyMatchTag(need.category ?? "");
  if ((!ofertaEhServico || regraNaoLe) && categoriaAsset && categoriaNeed && categoriaAsset === categoriaNeed) return { score: 60, type: "category" as const };
  // N7: o critério semântico ESTREITO, por último, e só para paráfrase. Com o
  // limiar em 0,7 e sem guardas ele casava tudo com tudo (31/08/2026: os 45
  // pares de uma rede de 10 contatos, incluindo "Armazenagem refrigerada" com
  // "Terrenos com outorga"); a regra da etapa 11 mostra por quê — parecença de
  // texto é o que confunde "exportar" com "importar". Agora ele exige o
  // critério ligado, o limiar alto e as guardas de semanticoEstreitoPodeValer
  // (direções opostas, nada de serviço, nada de palavra em comum).
  if (criterioSemanticoLigado() && semanticScore >= LIMIAR_SEMANTICO_ESTREITO && semanticoEstreitoPodeValer(asset, need)) {
    return { score: NOTA_SEMANTICA_ESTREITA, type: "semantic" as const };
  }
  // O bloqueio nomeado deixa a decisão visível a quem depura: a oferta é um
  // serviço e nenhuma necessidade o nomeia (a categoria em comum, se havia,
  // não contou).
  if (ofertaEhServico && !regraNaoLe) return { score: 0, type: "semantic" as const, bloqueio: "servico-sem-demanda-expressa" as const };
  return { score: 0, type: "semantic" as const };
}

async function embed(text: string) {
  return normalizeVector(await embedWithGemini(text, "SEMANTIC_SIMILARITY"));
}

/**
 * Embeddings de uma rodada. O laço compara cada ativo com cada necessidade,
 * então sem cache o mesmo texto seria enviado ao Gemini uma vez por par —
 * dezenas de chamadas idênticas por recálculo.
 */
type SemanticContext = { cache: Map<string, number[]>; disponivel: boolean };

async function embedCached(texto: string, contexto: SemanticContext) {
  const emCache = contexto.cache.get(texto);
  if (emCache) return emCache;
  const vetor = await embed(texto);
  contexto.cache.set(texto, vetor);
  return vetor;
}

/**
 * Similaridade semântica é o último critério, usado só quando nenhuma regra
 * casou e as guardas do critério estreito passaram. Compara só os RÓTULOS, como
 * a calibração do gabarito (a descrição livre alarga a parecença e não entra).
 * Se o provedor de embeddings estiver fora do ar ou sem cota, o recálculo
 * continua sem ele: os matches por tag exata e por categoria não dependem de IA
 * e não podem ser perdidos junto. Uma falha desliga o critério para o resto da
 * rodada, em vez de repetir a chamada a cada par.
 */
async function semanticScore(rotuloDoAtivo: string, rotuloDaNecessidade: string, contexto: SemanticContext) {
  if (!contexto.disponivel) return 0;
  try {
    const [assetEmbedding, needEmbedding] = await Promise.all([
      embedCached(rotuloDoAtivo, contexto),
      embedCached(rotuloDaNecessidade, contexto),
    ]);
    return cosineSimilarity(assetEmbedding, needEmbedding);
  } catch (erro) {
    contexto.disponivel = false;
    console.warn("[Match] Similaridade semântica indisponível nesta rodada:", erro instanceof Error ? erro.message : erro);
    return 0;
  }
}

/**
 * Quantas linhas o UPDATE alcançou. O mysql2 devolve o cabeçalho do resultado na
 * primeira posição e liga CLIENT_FOUND_ROWS por padrão, então `affectedRows`
 * conta a linha que o WHERE ENCONTROU (não a que mudou de valor) — é justamente
 * o que se quer de uma trava otimista: 1 significa "a linha ainda estava como eu
 * li". Conferido contra MariaDB 12.3. Sem cabeçalho reconhecível, zero: quem não
 * consegue provar que escreveu não anuncia nada para a dona.
 *
 * O mesmo número NÃO serve para o insert: num `on duplicate key update`, o
 * CLIENT_FOUND_ROWS faz a duplicata que grava os mesmos valores voltar 1, igual
 * a um insert de verdade. Lá a decisão é pelo erro (ver `ehChaveDuplicada`).
 */
function linhasAfetadas(resultado: unknown) {
  const cabecalho = Array.isArray(resultado) ? resultado[0] : resultado;
  return (cabecalho as { affectedRows?: number } | null | undefined)?.affectedRows ?? 0;
}

/**
 * Chave duplicada (ER_DUP_ENTRY, errno 1062) em qualquer ponto da cadeia de
 * `cause`: o drizzle embrulha o erro do driver num `DrizzleQueryError`, como em
 * `ehErroDeBancoIndisponivel`. O limite de saltos é contra cadeia circular.
 */
function ehChaveDuplicada(erro: unknown) {
  let atual: unknown = erro;
  for (let salto = 0; atual && salto < 10; salto += 1) {
    const { code, errno } = atual as { code?: unknown; errno?: unknown };
    if (code === "ER_DUP_ENTRY" || errno === 1062) return true;
    atual = (atual as { cause?: unknown }).cause;
  }
  return false;
}

// O registro das conexões (network-registro.ts) importa db.ts, que importa este
// arquivo: import dinâmico, uma promessa só para recálculos simultâneos.
let registroDeConexoes: Promise<typeof import("./network-registro")> | null = null;
const carregarRegistro = () => (registroDeConexoes ??= import("./network-registro").catch(erro => {
  registroDeConexoes = null;
  throw erro;
}));

export async function recalculatePrivateMatches(ownerId: string, ownerEmail?: string | null) {
  const db = await exigirDb();
  const [assets, needs, contacts, existing] = await Promise.all([
    db.select().from(contactAssets).where(eq(contactAssets.ownerId, ownerId)),
    db.select().from(contactNeeds).where(eq(contactNeeds.ownerId, ownerId)),
    db.select().from(privateContacts).where(eq(privateContacts.ownerId, ownerId)),
    db.select().from(aiMatchSuggestions).where(eq(aiMatchSuggestions.ownerId, ownerId)),
  ]);
  // Sem ativos OU sem necessidades não nasce par nenhum — mas a rodada segue
  // até o fim mesmo assim: a limpeza de órfãos lá embaixo é que apaga a
  // sugestão cuja razão acabou de sumir. Um retorno antecipado aqui deixava a
  // última remoção com uma sugestão fantasma que nenhum recálculo alcançava.

  const contactName = new Map(contacts.map(contact => [contact.id, contact.fullName]));
  const semantico: SemanticContext = { cache: new Map(), disponivel: true };

  // Junta por PAR de contatos, não por encontro. É o que permite acumular todas
  // as razões e enxergar quando os dois lados se completam.
  const pares = new Map<string, Par>();
  for (const asset of assets) {
    for (const need of needs) {
      if (asset.contactId === need.contactId) continue;
      // Linha gravada antes do conserto da escrita não latina tem tag_slug ""
      // (o slug antigo apagava tudo fora de [a-z0-9]). O rótulo continua lá:
      // recalcular o slug aqui evita migração de dados e impede que "unicos"
      // — que dedupe por slug — junte todas essas razões numa só.
      const baseAsset: MatchReason = { slug: asset.tagSlug || slugifyMatchTag(asset.tagLabel), label: asset.tagLabel, category: asset.category };
      const baseNeed: MatchReason = { slug: need.tagSlug || slugifyMatchTag(need.tagLabel), label: need.tagLabel, category: need.category };
      let result = scoreMatch(baseAsset, baseNeed);
      // Só chama o provedor de embeddings se a resposta puder mudar alguma
      // coisa: com o critério desligado, ou num par que as guardas já recusam
      // (concorrente, serviço, palavra em comum), não pode, e mandar o texto
      // para fora seria transferência de dado sem finalidade.
      if (!result.score && criterioSemanticoLigado() && semanticoEstreitoPodeValer(baseAsset, baseNeed)) {
        result = scoreMatch(baseAsset, baseNeed, await semanticScore(asset.tagLabel, need.tagLabel, semantico));
      }
      if (result.score < SAVE_THRESHOLD) continue;

      const lowId = Math.min(asset.contactId, need.contactId);
      const highId = Math.max(asset.contactId, need.contactId);
      const chave = `${lowId}:${highId}`;
      const par = pares.get(chave) ?? { lowId, highId, encontros: [] };
      par.encontros.push({ deId: asset.contactId, paraId: need.contactId, asset: baseAsset, need: baseNeed, score: result.score, type: result.type });
      pares.set(chave, par);
    }
  }

  const unicos = (itens: MatchReason[]) => {
    const vistos = new Map<string, MatchReason>();
    for (const item of itens) if (!vistos.has(item.slug)) vistos.set(item.slug, item);
    return Array.from(vistos.values());
  };
  const listar = (rotulos: string[]) =>
    rotulos.length === 1 ? rotulos[0] : `${rotulos.slice(0, -1).join(", ")} e ${rotulos[rotulos.length - 1]}`;

  const existingByPair = new Map(existing.map(match => [`${match.pairLowContactId}:${match.pairHighContactId}`, match]));
  const timestamp = Date.now(); let created = 0; let updated = 0; let newHighScore = 0;

  for (const par of Array.from(pares.values())) {
    // Direção é quem possui. Havendo encontros nos dois sentidos, cada contato
    // tem o que o outro procura — a conexão mais forte que existe aqui.
    const direcoes = new Map<number, Encontro[]>();
    for (const encontro of par.encontros) {
      const lista = direcoes.get(encontro.deId) ?? [];
      lista.push(encontro);
      direcoes.set(encontro.deId, lista);
    }
    const mutuo = direcoes.size > 1;
    const melhor = par.encontros.reduce((a, b) => (b.score > a.score ? b : a));

    const reasonText = mutuo
      ? Array.from(direcoes.entries())
          .map(([deId, lista]) => {
            const quem = contactName.get(deId) ?? "Este contato";
            const outro = contactName.get(lista[0].paraId) ?? "o outro contato";
            return `${quem} possui ${listar(unicos(lista.map(e => e.asset)).map(a => a.label))}, que ${outro} procura`;
          })
          .join("; ") + "."
      : (() => {
          const quem = contactName.get(melhor.deId) ?? "Este contato";
          const outro = contactName.get(melhor.paraId) ?? "outro contato";
          const rotulos = unicos(par.encontros.map(e => e.asset)).map(a => a.label);
          return `${quem} possui ${listar(rotulos)}, que ${outro} procura.`;
        })();

    const values = {
      contactAId: melhor.deId,
      contactBId: melhor.paraId,
      matchScore: melhor.score,
      matchType: (mutuo ? "mutual" : melhor.type) as MatchType,
      matchedAssets: unicos(par.encontros.map(e => e.asset)),
      matchedNeeds: unicos(par.encontros.map(e => e.need)),
      reasonText,
      updatedAt: timestamp,
    };

    const chave = `${par.lowId}:${par.highId}`;
    const previous = existingByPair.get(chave);
    if (previous) {
      // A linha é do PAR (índice único por dona e par), e a decisão da usuária
      // — aceita ou dispensada — foi tomada sobre a razão que ela viu. Quando
      // essa razão some e nasce outra sem NADA em comum com a antiga, é outra
      // oportunidade: o par volta a pendente para ela decidir de novo (decisão
      // do Nicolas, 04/09). Com qualquer razão em comum, a decisão permanece.
      // O par só VISTO segue a mesma regra: o que ela viu foi a razão antiga,
      // e a nova ainda não foi vista nem anunciada (revisão adversarial de
      // 05/09). dismissedAt/acceptedAt ficam como histórico da decisão
      // anterior. O slug antigo pode estar vazio (linha anterior ao conserto
      // da escrita não latina): recalcula-se do rótulo, como no laço lá em cima.
      const listaDeRazoes = (guardado: unknown) => (Array.isArray(guardado) ? guardado as MatchReason[] : []);
      const slugsAntigos = new Set([...listaDeRazoes(previous.matchedAssets), ...listaDeRazoes(previous.matchedNeeds)]
        .map(razao => razao?.slug || slugifyMatchTag(razao?.label ?? ""))
        .filter(Boolean));
      // Reabrir exige PROVA de que a razão mudou, e a prova é a razão antiga.
      // Sem nenhum slug antigo registrado (linha guardada com `null` ou lista
      // vazia no JSON, de antes de a coluna ser preenchida) a interseção é
      // vazia por falta de dado, não por troca de razão — e o par dispensado
      // voltava a pendente, com e-mail de "nova oportunidade", sem nada ter
      // mudado. Na dúvida a decisão da dona é que vale: fica como está.
      const razaoTotalmenteNova = slugsAntigos.size > 0
        && ![...values.matchedAssets, ...values.matchedNeeds].some(razao => slugsAntigos.has(razao.slug));
      const reabrir = razaoTotalmenteNova && (previous.status === "dismissed" || previous.status === "accepted" || previous.status === "viewed");
      // Caso que fica de fora, de propósito: corrigir a escrita de uma tag
      // ressuscita o par. Não existe edição de tag no produto — `contact_assets`
      // e `contact_needs` só recebem INSERT e DELETE (`addAsset`/`addNeed` e
      // `removeAsset`/`removeNeed` em `routers/matches.ts`, mais o insert do
      // enriquecimento em `db.ts`) e a tela só oferece "adicionar" e o X. Trocar
      // "Vinho" por "Vinhos" é remover e adicionar: nasce LINHA NOVA, com id
      // novo e slug novo. Por isso o "caminho limpo" que se costuma propor —
      // guardar na linha do match os ids de contact_assets/contact_needs em vez
      // dos slugs — NÃO resolveria este caso: o id também muda. Ele só serviria
      // se antes existisse uma edição de tag que preservasse a linha. Enquanto
      // não existir, correção de escrita é razão nova para o cruzamento e um par
      // dispensado volta a pendente por causa dela: é o preço de reabrir por
      // troca de razão, e a decisão (Nicolas, 04/09) é pagar esse preço.

      // Reabrir é uma decisão tomada sobre o status que ACABAMOS de ler. Dois
      // recálculos simultâneos (duas abas, ou "Reanalisar" clicado duas vezes)
      // liam a mesma linha dispensada, os dois reabriam e saíam DOIS e-mails
      // "1 nova(s) oportunidade(s)" para o mesmo par. Por isso a reabertura é
      // condicional no banco — o status entra no WHERE, como em
      // `advanceEnrichmentSession` — e só quem achou a linha ainda como a leu
      // (affectedRows === 1) conta para o e-mail.
      let reabriuDeFato = false;
      if (reabrir) {
        const resultado = await db.update(aiMatchSuggestions)
          .set({ ...values, status: "pending" as const, viewedAt: null, notifiedAt: null })
          .where(and(
            eq(aiMatchSuggestions.id, previous.id),
            eq(aiMatchSuggestions.ownerId, ownerId),
            eq(aiMatchSuggestions.status, previous.status),
          ));
        reabriuDeFato = linhasAfetadas(resultado) === 1;
      }
      let gravouANota = false;
      if (reabriuDeFato) {
        const decisao = previous.status === "accepted" ? "aceitado" : previous.status === "dismissed" ? "dispensado" : "visto";
        console.info(`[Match] Par ${chave} reaberto: a razão que a usuária tinha ${decisao} sumiu e nasceu outra.`);
      } else if (reabrir) {
        // A reabertura casou zero linhas: o status mudou entre a leitura e a
        // escrita. Pode ter sido a outra rodada (que já gravou esta mesma razão)
        // ou a própria dona, que ACEITOU o par na tela. A gravação de consolo
        // repete a MESMA guarda de status, senão a linha ficaria "aceita" com o
        // texto e as razões que a dona nunca viu — e o par ficaria PRESO, porque
        // no recálculo seguinte a razão nova já seria a "antiga" e a interseção
        // nunca mais seria vazia. Sem escrever nada, a rodada seguinte encontra
        // o retrato de verdade e reabre o par como deve.
        await db.update(aiMatchSuggestions).set(values).where(and(
          eq(aiMatchSuggestions.id, previous.id),
          eq(aiMatchSuggestions.ownerId, ownerId),
          eq(aiMatchSuggestions.status, previous.status),
        ));
      } else {
        // Caminho comum: a razão mudou de peso, não de identidade. A nota lida
        // entra no WHERE porque o e-mail depende de ter sido ESTA rodada a
        // cruzar o limiar: sem isso, um par pendente que sobe de 60 para 100 em
        // duas abas contava duas vezes e a dona recebia dois e-mails "1 nova(s)
        // oportunidade(s)". Quem escreve a nota é quem anuncia.
        //
        // Sub-caso conhecido e em aberto: se duas rodadas calcularem a MESMA
        // nota a partir de retratos diferentes, a que chegar depois ainda
        // sobrescreve o texto da que tinha o retrato mais novo. Só uma trava
        // otimista por `updated_at` fecharia isso, e ela custaria a escrita do
        // texto no caminho normal.
        const resultado = await db.update(aiMatchSuggestions).set(values).where(and(
          eq(aiMatchSuggestions.id, previous.id),
          eq(aiMatchSuggestions.ownerId, ownerId),
          eq(aiMatchSuggestions.matchScore, previous.matchScore),
        ));
        gravouANota = linhasAfetadas(resultado) === 1;
      }
      updated += 1;
      // Só conta para o e-mail o que a usuária ainda vai ver. Par aceito ou
      // dispensado que sobe de nota pela mesma razão não é oportunidade nova
      // para ela — antes o e-mail saía e na tela não havia nada novo.
      const aindaPorDecidir = previous.status === "pending" || previous.status === "viewed";
      const cruzouOLimiar = gravouANota && previous.matchScore < EMAIL_THRESHOLD;
      if (values.matchScore >= EMAIL_THRESHOLD && (reabriuDeFato || (aindaPorDecidir && cruzouOLimiar))) newHighScore += 1;
    } else {
      // O par é novo para ESTA rodada, mas o índice único (dona, par) é a
      // verdade: em dois recálculos simultâneos os dois leem "não existe" e os
      // dois inserem. O segundo levava ER_DUP_ENTRY e, como `matches.addAsset`
      // RETORNA este recálculo, o erro virava falha da mutação na tela ("Erro ao
      // consultar o banco de dados") com a tag já gravada — e os pares seguintes
      // da rodada ficavam sem calcular. Gatilhos: salvar contato
      // (`routers/network.ts`), o chat de enriquecimento e "Reanalisar" noutra
      // aba.
      //
      // Quem perde reprocessa o par pelo caminho de `previous`: grava só
      // `values`. Status, notifiedAt, viewedAt, acceptedAt e dismissedAt ficam
      // de fora de propósito — o insert perdedor não pode rebaixar nem
      // desmarcar um par que a dona já decidiu na tela.
      //
      // É o ERRO que decide quem criou, e não `affectedRows`: com
      // `on duplicate key update` e o CLIENT_FOUND_ROWS que o mysql2 liga por
      // padrão, a duplicata que grava os mesmos valores também volta 1 — e as
      // duas rodadas se achariam a criadora, com dois e-mails "1 nova(s)
      // oportunidade(s)". Duas rodadas no mesmo milissegundo gravam exatamente
      // os mesmos valores, então esse era o caso comum, não o raro.
      try {
        await db.insert(aiMatchSuggestions).values({ id: crypto.randomUUID(), ownerId, pairLowContactId: par.lowId, pairHighContactId: par.highId, status: "pending", notifiedAt: null, viewedAt: null, acceptedAt: null, dismissedAt: null, createdAt: timestamp, ...values });
        created += 1;
        if (values.matchScore >= EMAIL_THRESHOLD) newHighScore += 1;
      } catch (erro) {
        if (!ehChaveDuplicada(erro)) throw erro;
        console.info(`[Match] Par ${chave} nasceu em outro recálculo ao mesmo tempo: aqui só a razão foi atualizada.`);
        await db.update(aiMatchSuggestions).set(values).where(and(
          eq(aiMatchSuggestions.ownerId, ownerId),
          eq(aiMatchSuggestions.pairLowContactId, par.lowId),
          eq(aiMatchSuggestions.pairHighContactId, par.highId),
        ));
        updated += 1;
      }
    }
  }

  // Match órfão: o ativo ou a necessidade que o justificava foi apagado, e o
  // motivo exibido virou mentira. Só some o que ainda é sugestão — decisão da
  // usuária, aceita ou dispensada, permanece como histórico.
  let removed = 0;
  for (const antigo of existing) {
    if (pares.has(`${antigo.pairLowContactId}:${antigo.pairHighContactId}`)) continue;
    if (antigo.status !== "pending" && antigo.status !== "viewed") continue;
    await db.delete(aiMatchSuggestions).where(and(eq(aiMatchSuggestions.id, antigo.id), eq(aiMatchSuggestions.ownerId, ownerId)));
    removed += 1;
  }

  if (newHighScore && ownerEmail) {
    const sent = await sendEmail({ to: ownerEmail, subject: `${newHighScore} nova(s) oportunidade(s) de conexão na Marquesa Global Match`, text: `Encontramos ${newHighScore} oportunidade(s) de conexão privada(s) com score de 70 ou mais na sua rede. Abra o painel de Conexões Inteligentes para revisar.`, html: `<p>Encontramos <strong>${newHighScore}</strong> oportunidade(s) de conexão privada(s) com score de 70 ou mais na sua rede Marquesa Global Match.</p><p>Abra o painel de Conexões Inteligentes para revisar.</p>` });
    // O carimbo só alcança o que a usuária ainda vai decidir: linha aceita ou
    // dispensada não foi anunciada neste e-mail, e carimbá-la apagaria o rastro
    // de quando (e se) ela foi notificada de verdade.
    if (sent) await db.update(aiMatchSuggestions).set({ notifiedAt: timestamp }).where(and(eq(aiMatchSuggestions.ownerId, ownerId), gte(aiMatchSuggestions.matchScore, EMAIL_THRESHOLD), inArray(aiMatchSuggestions.status, ["pending", "viewed"])));
  }

  // Meu Network Inteligente, item 16 ("match entre contatos do próprio network
  // = match registrado pela plataforma"): a sugestão que acabou de nascer entra
  // no registro aqui, no motor, e não nos routers que lembravam de chamar — o
  // recálculo da remoção de contato e o do "desfazer" do enriquecimento não
  // registravam. Por último, depois do e-mail: o anúncio depende de ter sido
  // ESTA rodada a gravar a nota e não se repete; o registro é idempotente pela
  // chave do par e a rodada seguinte alcança. Falha do registro só vira log;
  // banco fora do ar sobe como erro.
  const { registrarConexoesInternasDepoisDoRecalculo } = await carregarRegistro();
  await registrarConexoesInternasDepoisDoRecalculo(ownerId);
  return { created, updated, removed, total: pares.size };
}
