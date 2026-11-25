/**
 * A base das associações (N1, desenho em docs/arquitetura/entidades.md): a
 * planilha que a entidade (federação, associação, confederação, sindicato)
 * manda, lida igual na tela e no servidor. A tela lê o arquivo, mostra o
 * relatório e manda as linhas em blocos; o servidor NÃO confia na tela e
 * valida cada linha de novo com as mesmas funções daqui.
 *
 * Regras que valem para toda linha:
 * - o documento é genérico (país + tipo): o Brasil usa o CNPJ, inclusive o
 *   alfanumérico que a Receita passou a emitir em 2026; Moçambique (a CTA), o
 *   NUIT. CPF nunca entra (pendência h do Dr. Ronei): a coluna recusa o
 *   arquivo, e o número com cara de CPF recusa a linha;
 * - a CNAE é guardada (o código, para refazer as ofertas) e, no servidor, vira
 *   "o que tem" pela tabela do IBGE (N4, server/cnae.ts). Ela NUNCA vira
 *   necessidade. Atividade é oferta; necessidade é só a declarada;
 * - o "o que tem" e o "o que precisa" são texto livre da entidade: contato
 *   escrito no meio (e-mail, telefone) é mascarado, e o item que repete o
 *   nome da empresa sai, para o cruzamento não expor quem é a empresa.
 */
import { encontrarContatosEmTexto, mascararContatosEmTexto } from "./contato-em-texto";

/** Linhas de uma planilha (a meta da reunião de 11/11 é de ~30 mil cadastros por convênio). */
export const LINHAS_POR_ARQUIVO_MAX = 50_000;
/** Linhas por bloco: cada bloco é uma chamada e uma transação no servidor. */
export const LINHAS_POR_BLOCO = 500;
/** Itens por lado ("o que tem" e "o que precisa") de cada empresa. */
export const ITENS_POR_LADO_MAX = 20;
/** O tamanho de um item; a coluna tag_label é varchar(200). */
export const ITEM_MAX = 200;
/** Os problemas que o relatório guarda com o número da linha; o resto só conta. */
export const PROBLEMAS_LISTADOS_MAX = 500;
/** Membros por página no painel da entidade. */
export const MEMBROS_POR_PAGINA = 50;

export const TIPOS_DE_ENTIDADE = ["federacao", "associacao", "confederacao", "sindicato", "outra"] as const;
export type TipoDeEntidade = (typeof TIPOS_DE_ENTIDADE)[number];

export const ESTADOS_DO_CONVENIO = ["em_negociacao", "ativo", "encerrado"] as const;
export type EstadoDoConvenio = (typeof ESTADOS_DO_CONVENIO)[number];

export const ESTADOS_DO_MEMBRO = ["importado", "ativado", "removido"] as const;
export type EstadoDoMembro = (typeof ESTADOS_DO_MEMBRO)[number];

/** Os campos canônicos que a tela manda ao servidor; nenhum outro passa. */
export const CAMPOS_DA_PLANILHA = [
  "documento", "nome", "cnae_principal", "cnaes_secundarios", "uf", "telefone", "email",
  "referencia_da_entidade", "o_que_tem", "o_que_precisa", "data_da_declaracao",
] as const;
export type CampoDaPlanilha = (typeof CAMPOS_DA_PLANILHA)[number];
export type LinhaBruta = Partial<Record<CampoDaPlanilha, string>>;

/**
 * Os nomes de coluna que cada campo aceita, já normalizados (`normalizarCabecalho`).
 * A entidade não precisa renomear a planilha que já tem.
 */
const SINONIMOS: Record<CampoDaPlanilha, string[]> = {
  documento: ["cnpj", "documento", "cnpj_da_empresa", "nuit", "numero_do_documento"],
  nome: ["nome", "razao_social", "nome_da_empresa", "empresa", "nome_empresarial", "nome_fantasia"],
  cnae_principal: ["cnae", "cnae_principal", "atividade_principal", "cnae_fiscal"],
  cnaes_secundarios: ["cnaes_secundarios", "cnae_secundario", "cnae_secundaria", "cnaes_secundarias", "atividades_secundarias"],
  uf: ["uf", "estado", "provincia"],
  telefone: ["telefone", "fone", "celular", "whatsapp", "telefone_da_empresa"],
  email: ["email", "e_mail", "email_da_empresa"],
  referencia_da_entidade: ["referencia", "referencia_da_entidade", "codigo_na_entidade", "matricula", "codigo_do_associado"],
  o_que_tem: ["o_que_tem", "o_que_oferece", "oferta", "ofertas", "produtos_e_servicos", "tenho"],
  o_que_precisa: ["o_que_precisa", "necessidade", "necessidades", "demanda", "demandas", "preciso"],
  data_da_declaracao: ["data_da_declaracao", "data_da_necessidade", "declarado_em"],
};

/** Colunas que recusam o ARQUIVO inteiro: dado que a WRW não recebe (senha, CPF, nascimento). */
const COLUNAS_PROIBIDAS = ["senha", "password", "cpf", "data_de_nascimento", "nascimento", "rg", "cpf_do_socio"];

export function normalizarCabecalho(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type MapaDoCabecalho =
  | { ok: true; colunas: Partial<Record<CampoDaPlanilha, number>>; ignoradas: string[] }
  | { ok: false; codigo: "COLUNA_PROIBIDA"; coluna: string }
  | { ok: false; codigo: "FALTA_COLUNA"; coluna: CampoDaPlanilha };

/** Liga cada coluna do arquivo a um campo. A primeira coluna que casar vence. */
export function mapearCabecalho(cabecalho: string[]): MapaDoCabecalho {
  const colunas: Partial<Record<CampoDaPlanilha, number>> = {};
  const ignoradas: string[] = [];
  for (let i = 0; i < cabecalho.length; i += 1) {
    const original = String(cabecalho[i] ?? "").trim();
    const nome = normalizarCabecalho(original);
    if (!nome) continue;
    if (COLUNAS_PROIBIDAS.includes(nome)) return { ok: false, codigo: "COLUNA_PROIBIDA", coluna: original };
    const campo = (Object.keys(SINONIMOS) as CampoDaPlanilha[]).find(c => SINONIMOS[c].includes(nome));
    if (!campo) { ignoradas.push(original); continue; }
    if (colunas[campo] === undefined) colunas[campo] = i;
  }
  for (const obrigatoria of ["documento", "nome"] as const) {
    if (colunas[obrigatoria] === undefined) return { ok: false, codigo: "FALTA_COLUNA", coluna: obrigatoria };
  }
  return { ok: true, colunas, ignoradas };
}

/** Uma linha do arquivo vira o objeto que vai ao servidor, só com os campos conhecidos. */
export function linhaDaPlanilha(celulas: string[], colunas: Partial<Record<CampoDaPlanilha, number>>): LinhaBruta {
  const linha: LinhaBruta = {};
  for (const campo of CAMPOS_DA_PLANILHA) {
    const indice = colunas[campo];
    if (indice === undefined) continue;
    const valor = String(celulas[indice] ?? "").trim();
    if (valor) linha[campo] = valor;
  }
  return linha;
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Lê CSV com `;`, `,` ou tabulação (o separador é o que mais aparece na
 * primeira linha fora de aspas), aspas duplas com "" dentro, CRLF e BOM.
 * Devolve as linhas como listas de células; linha toda vazia sai.
 */
export function lerCsv(texto: string): string[][] {
  const fonte = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const separador = detectarSeparador(fonte);
  const linhas: string[][] = [];
  let celula = "";
  let linha: string[] = [];
  let entreAspas = false;
  for (let i = 0; i < fonte.length; i += 1) {
    const c = fonte[i];
    if (entreAspas) {
      if (c === '"') {
        if (fonte[i + 1] === '"') { celula += '"'; i += 1; } else entreAspas = false;
      } else celula += c;
      continue;
    }
    if (c === '"') entreAspas = true;
    else if (c === separador) { linha.push(celula); celula = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && fonte[i + 1] === "\n") i += 1;
      linha.push(celula); celula = "";
      if (linha.some(v => v.trim())) linhas.push(linha);
      linha = [];
    } else celula += c;
  }
  linha.push(celula);
  if (linha.some(v => v.trim())) linhas.push(linha);
  return linhas;
}

function detectarSeparador(texto: string): string {
  const contagem: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  let entreAspas = false;
  for (const c of texto) {
    if (c === '"') entreAspas = !entreAspas;
    else if (!entreAspas && (c === "\n" || c === "\r")) break;
    else if (!entreAspas && c in contagem) contagem[c] += 1;
  }
  const [maisVisto, vezes] = Object.entries(contagem).sort((x, y) => y[1] - x[1])[0];
  return vezes > 0 ? maisVisto : ";";
}

// ─── Documento ───────────────────────────────────────────────────────────────

export type TipoDeDocumento = "cnpj" | "nuit";
/** O documento de cada país. País novo (a ACDF, outro convênio) entra aqui, com teste. */
export const DOCUMENTO_DO_PAIS: Record<string, TipoDeDocumento> = { BR: "cnpj", MZ: "nuit" };
export const PAISES_DE_ENTIDADE = Object.keys(DOCUMENTO_DO_PAIS);

/** Tira pontuação e espaço; letras em maiúscula (o CNPJ alfanumérico). */
export function normalizarDocumento(valor: string): string {
  return valor.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digitoVerificador(base: string, pesos: number[]): number {
  let soma = 0;
  for (let i = 0; i < pesos.length; i += 1) soma += (base.charCodeAt(i) - 48) * pesos[i];
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/**
 * CNPJ numérico ou alfanumérico (IN RFB 2.229/2024: as 12 primeiras posições
 * aceitam letras, cada caractere vale o código ASCII menos 48, e os dois
 * verificadores continuam numéricos, no mesmo módulo 11). Recebe já normalizado.
 */
export function cnpjValido(cnpj: string): boolean {
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;
  const dv1 = digitoVerificador(cnpj.slice(0, 12), PESOS_DV1);
  if (dv1 !== Number(cnpj[12])) return false;
  return digitoVerificador(cnpj.slice(0, 13), PESOS_DV2) === Number(cnpj[13]);
}

/**
 * NUIT de Moçambique: 9 dígitos. O dígito de controle NÃO é conferido (o
 * algoritmo não foi achado em fonte oficial; decisão vetável, ver o desenho).
 */
export function nuitValido(nuit: string): boolean {
  return /^\d{9}$/.test(nuit);
}

export function formatarDocumento(tipo: TipoDeDocumento, valor: string): string {
  if (tipo === "cnpj" && valor.length === 14) {
    return `${valor.slice(0, 2)}.${valor.slice(2, 5)}.${valor.slice(5, 8)}/${valor.slice(8, 12)}-${valor.slice(12)}`;
  }
  return valor;
}

// ─── CNAE, UF, data, contato ─────────────────────────────────────────────────

/**
 * Subclasse da CNAE 2.3 (7 dígitos: "4711-3/02" ou "4711302"). Só a forma: se o
 * código existe, quem diz é a tabela do IBGE, que fica no servidor (server/cnae.ts),
 * para não pesar na tela.
 */
export function normalizarCnae(valor: string): string | null {
  const digitos = valor.replace(/[^0-9]/g, "");
  return /^\d{7}$/.test(digitos) ? digitos : null;
}

export const UFS_DO_BRASIL = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
];

/** A data da declaração: dd/mm/aaaa, aaaa-mm-dd ou o número de série do Excel. Meia-noite UTC. */
export function lerData(valor: string, agora = Date.now()): number | null {
  const texto = valor.trim();
  let ano: number, mes: number, dia: number;
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(texto);
  if (m) { dia = Number(m[1]); mes = Number(m[2]); ano = Number(m[3]); }
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(texto))) { ano = Number(m[1]); mes = Number(m[2]); dia = Number(m[3]); }
  else if (/^\d{5}(\.\d+)?$/.test(texto)) {
    // Série do Excel: dias desde 30/12/1899.
    const ms = Date.UTC(1899, 11, 30) + Math.floor(Number(texto)) * 86_400_000;
    return ms > agora ? null : ms;
  } else return null;
  const ms = Date.UTC(ano, mes - 1, dia);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  if (ano < 1990 || ms > agora) return null;
  return ms;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function normalizarTelefone(valor: string): string | null {
  const limpo = valor.replace(/[^\d+]/g, "");
  const digitos = limpo.replace(/\D/g, "");
  if (digitos.length < 8 || digitos.length > 15) return null;
  return limpo.startsWith("+") ? `+${digitos}` : digitos;
}

/** Comparação sem acento nem caixa, só letras e dígitos. */
export function chaveDeTexto(valor: string): string {
  return valor.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ─── Validação da linha ──────────────────────────────────────────────────────

/** O que recusa a linha (nada dela é gravado). */
export const RECUSAS_DA_LINHA = [
  "DOCUMENTO_AUSENTE", "DOCUMENTO_INVALIDO", "DOCUMENTO_E_CPF", "NOME_AUSENTE", "REPETIDO_NO_ARQUIVO", "MEMBRO_REMOVIDO",
] as const;
/** O que só avisa (a linha entra, sem o pedaço com problema). */
export const AVISOS_DA_LINHA = [
  "CNAE_INVALIDO", "CNAE_INEXISTENTE", "CNAE_FORA_DO_BRASIL", "UF_INVALIDA", "TELEFONE_INVALIDO", "EMAIL_INVALIDO", "CONTATO_NO_TEXTO",
  "ITEM_COM_NOME", "ITENS_DEMAIS", "DATA_INVALIDA", "NECESSIDADE_SEM_DATA", "SEM_OFERTA_NEM_NECESSIDADE",
  "MEMBRO_ATIVADO_NAO_ALTERADO",
] as const;
export type RecusaDaLinha = (typeof RECUSAS_DA_LINHA)[number];
export type AvisoDaLinha = (typeof AVISOS_DA_LINHA)[number];
export type ProblemaDaLinha = { linha: number; codigo: RecusaDaLinha | AvisoDaLinha; primeira?: number };

export type LinhaValida = {
  linha: number;
  documento: { pais: string; tipo: TipoDeDocumento; valor: string };
  nome: string;
  cnaePrincipal: string | null;
  cnaesSecundarios: string[];
  uf: string | null;
  telefone: string | null;
  email: string | null;
  referencia: string | null;
  tenho: string[];
  preciso: string[];
  /** Quando a empresa declarou a necessidade à entidade (ou, sem a coluna, o dia da carga). */
  declaradoEm: number | null;
};

export type ResultadoDaLinha =
  | { ok: true; valida: LinhaValida; avisos: AvisoDaLinha[] }
  | { ok: false; recusa: RecusaDaLinha };

function itensDoTexto(texto: string | undefined, nomeDaEmpresa: string, avisos: Set<AvisoDaLinha>): string[] {
  if (!texto) return [];
  const nome = chaveDeTexto(nomeDaEmpresa);
  const vistos = new Set<string>();
  const itens: string[] = [];
  for (const bruto of texto.split(/[;\n|]+/)) {
    let item = bruto.replace(/\s+/g, " ").trim();
    if (!item) continue;
    if (encontrarContatosEmTexto(item).length) {
      avisos.add("CONTATO_NO_TEXTO");
      item = mascararContatosEmTexto(item);
    }
    if (nome.length >= 4 && chaveDeTexto(item).includes(nome)) { avisos.add("ITEM_COM_NOME"); continue; }
    item = item.slice(0, ITEM_MAX);
    const chave = chaveDeTexto(item);
    if (!chave || vistos.has(chave)) continue;
    vistos.add(chave);
    if (itens.length >= ITENS_POR_LADO_MAX) { avisos.add("ITENS_DEMAIS"); break; }
    itens.push(item);
  }
  return itens;
}

/**
 * Valida e normaliza uma linha para a entidade do país `pais`. `agora` é o dia
 * da carga: a necessidade sem data leva esse dia e um aviso.
 */
export function validarLinha(
  bruta: LinhaBruta, numero: number, pais: string, agora = Date.now(),
  opcoes: { cnaeExiste?: (codigo: string) => boolean } = {},
): ResultadoDaLinha {
  const tipo = DOCUMENTO_DO_PAIS[pais];
  const documento = normalizarDocumento(bruta.documento ?? "");
  if (!documento) return { ok: false, recusa: "DOCUMENTO_AUSENTE" };
  if (tipo === "cnpj" && /^\d{11}$/.test(documento)) return { ok: false, recusa: "DOCUMENTO_E_CPF" };
  const valido = tipo === "cnpj" ? cnpjValido(documento) : tipo === "nuit" ? nuitValido(documento) : false;
  if (!valido) return { ok: false, recusa: "DOCUMENTO_INVALIDO" };
  const nome = (bruta.nome ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!nome) return { ok: false, recusa: "NOME_AUSENTE" };

  const avisos = new Set<AvisoDaLinha>();
  let cnaePrincipal: string | null = null;
  const cnaesSecundarios: string[] = [];
  if (bruta.cnae_principal || bruta.cnaes_secundarios) {
    if (pais !== "BR") avisos.add("CNAE_FORA_DO_BRASIL");
    else {
      if (bruta.cnae_principal) {
        cnaePrincipal = normalizarCnae(bruta.cnae_principal);
        if (!cnaePrincipal) avisos.add("CNAE_INVALIDO");
        else if (opcoes.cnaeExiste && !opcoes.cnaeExiste(cnaePrincipal)) { avisos.add("CNAE_INEXISTENTE"); cnaePrincipal = null; }
      }
      for (const pedaco of (bruta.cnaes_secundarios ?? "").split(/[;,|\s]+/).filter(Boolean)) {
        const cnae = normalizarCnae(pedaco);
        if (!cnae) { avisos.add("CNAE_INVALIDO"); continue; }
        if (opcoes.cnaeExiste && !opcoes.cnaeExiste(cnae)) { avisos.add("CNAE_INEXISTENTE"); continue; }
        if (cnae !== cnaePrincipal && !cnaesSecundarios.includes(cnae) && cnaesSecundarios.length < 99) cnaesSecundarios.push(cnae);
      }
    }
  }

  let uf: string | null = null;
  if (bruta.uf) {
    const valor = bruta.uf.trim().toUpperCase();
    if (pais === "BR") {
      if (UFS_DO_BRASIL.includes(valor)) uf = valor; else avisos.add("UF_INVALIDA");
    } else uf = bruta.uf.trim().slice(0, 100);
  }

  let telefone: string | null = null;
  if (bruta.telefone) {
    telefone = normalizarTelefone(bruta.telefone);
    if (!telefone) avisos.add("TELEFONE_INVALIDO");
  }
  let email: string | null = null;
  if (bruta.email) {
    const valor = bruta.email.trim().toLowerCase();
    if (EMAIL.test(valor) && valor.length <= 254) email = valor; else avisos.add("EMAIL_INVALIDO");
  }

  const tenho = itensDoTexto(bruta.o_que_tem, nome, avisos);
  const preciso = itensDoTexto(bruta.o_que_precisa, nome, avisos);
  let declaradoEm: number | null = null;
  if (preciso.length) {
    if (bruta.data_da_declaracao) {
      declaradoEm = lerData(bruta.data_da_declaracao, agora);
      if (declaradoEm === null) avisos.add("DATA_INVALIDA");
    } else avisos.add("NECESSIDADE_SEM_DATA");
    if (declaradoEm === null) {
      const hoje = new Date(agora);
      declaradoEm = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());
    }
  }
  // "Não conecta": sem oferta nem necessidade (nem CNAE, que vira oferta no servidor) a empresa entra, mas não cruza.
  if (!tenho.length && !preciso.length && !cnaePrincipal && !cnaesSecundarios.length) avisos.add("SEM_OFERTA_NEM_NECESSIDADE");

  const referencia = (bruta.referencia_da_entidade ?? "").trim().slice(0, 100) || null;
  return {
    ok: true,
    avisos: Array.from(avisos),
    valida: {
      linha: numero, documento: { pais, tipo, valor: documento }, nome, cnaePrincipal, cnaesSecundarios, uf,
      telefone, email, referencia, tenho, preciso, declaradoEm,
    },
  };
}

// ─── Códigos de erro (a tela traduz) ─────────────────────────────────────────

export const ERROS_DA_ENTIDADE = {
  naoEhEntidade: "ENTIDADE_NAO_ENCONTRADA",
  convenioInativo: "CONVENIO_INATIVO",
  chavesAusentes: "ENTIDADES_CHAVES_AUSENTES",
  importacaoNaoEncontrada: "IMPORTACAO_NAO_ENCONTRADA",
  importacaoEncerrada: "IMPORTACAO_ENCERRADA",
  blocoForaDeOrdem: "BLOCO_FORA_DE_ORDEM",
  membroNaoEncontrado: "MEMBRO_NAO_ENCONTRADO",
  conviteNaoEncontrado: "CONVITE_NAO_ENCONTRADO",
  soPrivado: "ENTIDADE_SO_PRIVADO",
  contaNaoEncontrada: "CONTA_NAO_ENCONTRADA",
  contaDaEquipe: "CONTA_DA_EQUIPE",
  contaJaEhEntidade: "CONTA_JA_EH_ENTIDADE",
  paisSemDocumento: "PAIS_SEM_DOCUMENTO",
  // O pedido de contato pela entidade (N2, shared/pedidos-pela-entidade.ts).
  pedidoNaoEncontrado: "PEDIDO_NAO_ENCONTRADO",
  pedidoJaDecidido: "PEDIDO_JA_DECIDIDO",
  pedidoJaExiste: "PEDIDO_JA_EXISTE",
  pedidoIndisponivel: "PEDIDO_INDISPONIVEL",
  pedidosDemais: "PEDIDOS_DEMAIS",
  canalIndisponivel: "CANAL_INDISPONIVEL",
  // A ativação do cadastro importado (N3).
  ativacaoNaoEncontrada: "ATIVACAO_NAO_ENCONTRADA",
  ativacaoEmailJaCadastrado: "ATIVACAO_EMAIL_JA_CADASTRADO",
} as const;
export type CodigoDeErroDaEntidade = (typeof ERROS_DA_ENTIDADE)[keyof typeof ERROS_DA_ENTIDADE];
const CODIGOS = new Set<string>(Object.values(ERROS_DA_ENTIDADE));
export function ehErroDaEntidade(mensagem: unknown): mensagem is CodigoDeErroDaEntidade {
  return typeof mensagem === "string" && CODIGOS.has(mensagem);
}

/** O convênio vale hoje: ativo e, se tiver fim, o fim não passou (o dia do fim ainda vale). */
export function convenioVigente(convenio: { estado: string; fim: number | null }, agora = Date.now()): boolean {
  if (convenio.estado !== "ativo") return false;
  return convenio.fim === null || convenio.fim + 86_400_000 > agora;
}

// ─── A ativação do cadastro importado (N3) ───────────────────────────────────

/** O caminho do link de ativação que a entidade distribui: `/ativar/<token>`. */
export const ROTA_DA_ATIVACAO = "/ativar";

/** Quanto tempo o link de ativação vale depois de gerado (decisão vetável: 30 dias). */
export const VALIDADE_DA_ATIVACAO_MS = 30 * 86_400_000;

/** Quantos links uma chamada gera (o painel gera em lotes e monta a planilha no aparelho). */
export const LINKS_DE_ATIVACAO_POR_CHAMADA = 500;

/** O formato do token (24 bytes em base64url, como o convite); o resto nem chega ao banco. */
export const FORMATO_DO_TOKEN_DE_ATIVACAO = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * O que a pessoa CONFIRMOU do que a entidade mandou: só os itens que estavam
 * na importação (o texto idêntico), sem repetir e na ordem da importação. O que
 * ela quiser acrescentar entra depois, no cadastro, como qualquer item dela.
 */
export function itensConfirmados(importados: string[], escolhidos: string[]): string[] {
  const escolhido = new Set(escolhidos.map(e => e.trim()));
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const item of importados) {
    const chave = item.trim();
    if (!chave || !escolhido.has(chave) || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(chave);
  }
  return saida;
}

/** A planilha dos links que a entidade baixa: código, nome, referência, link e validade. CSV com ";" e aspas. */
export function planilhaDeLinks(
  linhas: Array<{ codigo: string | null; nome: string; referencia: string | null; link: string; validoAte: string }>,
  cabecalho: [string, string, string, string, string],
): string {
  const celula = (valor: string | null) => {
    const texto = (valor ?? "").replace(/\r?\n/g, " ");
    // Fórmula no começo vira texto: a planilha abre no Excel da entidade.
    const seguro = /^[=+\-@]/.test(texto) ? `'${texto}` : texto;
    return `"${seguro.replace(/"/g, '""')}"`;
  };
  return [cabecalho, ...linhas.map(l => [l.codigo, l.nome, l.referencia, l.link, l.validoAte])]
    .map(colunas => colunas.map(celula).join(";")).join("\r\n") + "\r\n";
}

