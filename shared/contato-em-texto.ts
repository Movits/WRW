/**
 * A13 — detecção de e-mail e telefone em texto livre.
 *
 * Decisão D3 (Glenda, 31/08): os contatos das partes aparecem somente para o
 * consultor de negócios, jamais entre as partes. Este módulo é a barreira
 * extra nos canais de texto livre — e é PRECISÃO em primeiro lugar: conversa
 * de negócio é cheia de números legítimos (preços, faixas, safras "2025-2026",
 * CNPJ, CPF, CEP, boletos), e bloquear uma proposta por causa deles seria
 * pior que deixar um telefone passar. O bloqueio técnico não substitui a
 * cláusula contratual da etapa 13; ele torna o caminho oficial mais fácil e
 * gera o registro que a sustenta (nota do cartão A13).
 *
 * O que casa:
 *  - e-mail literal (com @);
 *  - telefone com DDI (+55 11 99999-8888 e variações com espaço/ponto);
 *  - DDD entre parênteses ((11) 98888-7777, (11)3456 7890);
 *  - DDD colado ao número por espaço/ponto (11 99999 8888 · 11.99999.8888 ·
 *    11 9 9999 8888 · 11 3456-7890) — a forma mais comum de digitar no Brasil;
 *  - celular hifenizado mesmo sem DDD (99999-8888 — o 9 na frente denuncia);
 *  - sequência crua de 10-11 dígitos COM CARA de telefone: DDD válido (sem
 *    zero) seguido de 9+8 dígitos (celular) ou [2-5]+7 (fixo). "12345678901"
 *    (CPF sem pontos) e "84670000001" (linha de boleto) não têm essa forma.
 *
 * Telefone DITADO POR EXTENSO também casa: uma corrente de palavras-dígito
 * ("nove meia meia cinco quatro três dois um zero" — "meia" é 6 no ditado
 * brasileiro) com pelo menos 8 dígitos somados e 4 palavras. "Dois mil e
 * quinhentos sacos" e "opção um, dois ou três" não chegam nem perto: "mil",
 * "e" e qualquer palavra fora do vocabulário quebram a corrente.
 *
 * O que NÃO casa, de propósito: intervalos de anos e faixas ("2025-2026",
 * "1000-5000"), CNPJ/CPF (pontuados ou crus), CEP (5-3), valores, datas — e
 * o fixo hifenizado SEM DDD ("3456-7890"), que é indistinguível de faixa
 * numérica; sem DDD ele tampouco serve como contato entre cidades. Burlar
 * O separador DUPLO vale só para o celular (o 9 na frente dos quatro dígitos):
 * quem
 * digita no celular escreve "11  99999  8888" sem querer, e `.trim()` não
 * colapsa espaço interno — com um separador só, esse telefone saía inteiro. Com
 * o separador duplo solto, "lote 14  1500  2000" virava telefone e o portão A13
 * recusava a proposta: falso positivo aqui é pior do que telefone que escapa.
 * Burlar ainda dá (soletrar com erros de grafia, trocar por emoji) — o objetivo é o
 * caminho honesto e o registro, não uma fortaleza.
 */

const PADROES: Array<{ tipo: "email" | "telefone"; regex: RegExp }> = [
  { tipo: "email", regex: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  // +DDI com grupos: +55 11 99999-8888 · +55 (11) 99999 8888 · +351 912 345 678
  { tipo: "telefone", regex: /\+\d{1,3}[\s.-]{0,2}\(?\d{1,4}\)?(?:[\s.-]{0,2}\d{2,5}){2,4}/g },
  // DDD entre parênteses: (11) 99999-8888 · (11)3456-7890 · (11) 9 9999 8888
  { tipo: "telefone", regex: /\(\d{2,3}\)\s{0,2}9?[\s.]{0,2}\d{4}[\s.-]{0,2}\d{4}\b/g },
  // DDD + separador: 11 99999 8888 · 11.99999.8888 · 11 9 9999 8888 · 11 3456-7890
  { tipo: "telefone", regex: /\b[1-9][1-9][\s.]9?[\s.]?\d{4}[\s.-]\d{4}\b/g },
  // Com separador duplo, so o celular: o 9 na frente de quatro digitos separa
  // "11  99999  8888" de "lote 14  1500  2000".
  { tipo: "telefone", regex: /\b[1-9][1-9][\s.]{1,2}9[\s.]?\d{4}[\s.-]{1,2}\d{4}\b/g },
  // Celular hifenizado sem DDD: o 9 obrigatório na frente separa "99999-8888"
  // de faixas e anos; o fixo 4-4 sem DDD fica de fora (ver o cabeçalho).
  { tipo: "telefone", regex: /\b9\d{4}-\d{4}\b/g },
  // Sequência crua com forma de telefone: DDD sem zero + celular (9........)
  // ou fixo ([2-5].......). CPF de 11 dígitos raramente sobrevive às duas
  // exigências; valores redondos (10 dígitos começando em 10...) nunca.
  { tipo: "telefone", regex: /\b[1-9][1-9](?:9\d{8}|[2-5]\d{7})\b/g },
];

export type ContatoEncontrado = { tipo: "email" | "telefone"; trecho: string };

// Quantos DÍGITOS cada palavra do ditado representa. "meia" é 6 ("nove meia
// meia..."); "onze" cobre o DDD falado como palavra única. "mil", "cem",
// "vinte" etc. ficam FORA de propósito: são as palavras de quantidade e
// preço, e entrar com elas aqui bloquearia proposta comercial.
const PALAVRAS_DE_DIGITO: Record<string, number> = {
  zero: 1, um: 1, uma: 1, dois: 1, duas: 1, tres: 1, quatro: 1,
  cinco: 1, seis: 1, meia: 1, sete: 1, oito: 1, nove: 1, onze: 2,
};
const MINIMO_DE_DIGITOS_DITADOS = 8;
const MINIMO_DE_PALAVRAS_NA_CORRENTE = 4;

/**
 * Telefone ditado por extenso: corrente de palavras-dígito (e grupos soltos
 * de 1-2 algarismos no meio, como em "onze 9 nove nove...") somando 8+
 * dígitos. Exigir 4+ PALAVRAS na corrente impede que listas numéricas
 * legítimas ("tamanhos 36 38 40 42") caiam aqui — dígito puro tem os padrões
 * próprios, com cara de telefone.
 */
function encontrarDitados(texto: string): ContatoEncontrado[] {
  // Sem acentos, mantendo os índices: cada caractere pré-composto ("é")
  // vira exatamente um caractere base ("e") depois de remover as marcas.
  const semAcento = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const achados: ContatoEncontrado[] = [];
  let inicio = -1, fim = -1, digitos = 0, palavras = 0;
  const fechar = () => {
    if (inicio >= 0 && digitos >= MINIMO_DE_DIGITOS_DITADOS && palavras >= MINIMO_DE_PALAVRAS_NA_CORRENTE) {
      achados.push({ tipo: "telefone", trecho: texto.slice(inicio, fim) });
    }
    inicio = -1; digitos = 0; palavras = 0;
  };
  for (const casamento of Array.from(semAcento.matchAll(/[a-z]+|\d+/g))) {
    const token = casamento[0];
    const posicao = casamento.index ?? 0;
    const ehPalavra = PALAVRAS_DE_DIGITO[token] !== undefined;
    const valor = ehPalavra ? PALAVRAS_DE_DIGITO[token] : (/^\d{1,2}$/.test(token) ? token.length : undefined);
    // A corrente só continua atravessando separadores curtos e neutros;
    // qualquer palavra fora do vocabulário ("mil", "toneladas", "e") quebra.
    const emenda = inicio >= 0 && posicao - fim <= 3 && /^[\s.,;-]*$/.test(semAcento.slice(fim, posicao));
    if (valor === undefined || (inicio >= 0 && !emenda)) fechar();
    if (valor !== undefined) {
      if (inicio < 0) inicio = posicao;
      digitos += valor;
      if (ehPalavra) palavras += 1;
      fim = posicao + token.length;
    }
  }
  fechar();
  return achados;
}

export function encontrarContatosEmTexto(texto: string): ContatoEncontrado[] {
  const achados: ContatoEncontrado[] = [];
  const vistos = new Set<string>();
  const candidatos: ContatoEncontrado[] = [];
  for (const { tipo, regex } of PADROES) {
    for (const casamento of Array.from(texto.matchAll(regex))) {
      candidatos.push({ tipo, trecho: casamento[0] });
    }
  }
  candidatos.push(...encontrarDitados(texto));
  for (const candidato of candidatos) {
    // Um telefone dentro de um e-mail já reportado (ou o mesmo trecho por
    // dois padrões) não vira um segundo achado.
    if (vistos.has(candidato.trecho) || achados.some(a => a.trecho.includes(candidato.trecho))) continue;
    vistos.add(candidato.trecho);
    achados.push(candidato);
  }
  return achados;
}

/**
 * Versão mascarada de um trecho, para o REGISTRO da tentativa: o log precisa
 * provar que houve contato no texto sem se tornar, ele mesmo, um repositório
 * do dado que o bloqueio existe para não espalhar.
 */
export function mascararTrecho(trecho: string): string {
  if (trecho.length <= 4) return "*".repeat(trecho.length);
  return trecho.slice(0, 2) + "*".repeat(Math.min(trecho.length - 4, 12)) + trecho.slice(-2);
}

/**
 * Texto com os contatos substituídos pela máscara — para campos que JÁ estão
 * gravados e precisam circular para outras usuárias (ex.: a bio do perfil no
 * payload dos matches). A dona continua vendo o próprio texto inteiro; a
 * contraparte recebe a versão sem o contato.
 */
export function mascararContatosEmTexto(texto: string): string {
  let resultado = texto;
  for (const { trecho } of encontrarContatosEmTexto(texto)) {
    resultado = resultado.split(trecho).join(mascararTrecho(trecho));
  }
  return resultado;
}

/** O marcador que toma o lugar do contato inteiro (sem idioma: a mensagem circula entre línguas). */
export const MARCADOR_DE_CONTATO_OCULTO = "[•••]";

/**
 * Texto com cada contato trocado INTEIRO por um marcador, para mensagens que
 * outra pessoa lê (o pedido pela entidade). A máscara do registro
 * (`mascararTrecho`) deixa as pontas: "(61) 98888-7777" virava "(6***********77",
 * com o parêntese aberto e três dígitos à mostra, o que na tela parece defeito.
 */
export function ocultarContatosEmTexto(texto: string, marcador = MARCADOR_DE_CONTATO_OCULTO): string {
  // Os trechos maiores primeiro: um trecho contido em outro não deixa sobra.
  const trechos = encontrarContatosEmTexto(texto).map(c => c.trecho).sort((a, b) => b.length - a.length);
  let resultado = texto;
  for (const trecho of trechos) resultado = resultado.split(trecho).join(marcador);
  return resultado;
}
