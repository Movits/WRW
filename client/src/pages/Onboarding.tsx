import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { BrainCircuit, CheckCircle, Loader2 } from "lucide-react";
import { BrandLogo, BrandMark } from "@/components/BrandLogo";
import { LIMITE_DA_BIO_GRAVADA } from "@shared/apresentacao";
import { normalizePrimarySpecialties, togglePrimarySpecialty } from "@shared/specialties";
import { exigeCadastroEmpresarial, normalizarCadastroEmpresarial } from "@shared/business-registration";
import { sortOptionsAlphabetically, sortTextAlphabetically } from "@shared/option-sorting";
import { interesseEhDoSetor, setoresTraduzidos, type TradutorDeSetor } from "@shared/setores";
import {
  CHAVE_OUTRA_NECESSIDADE,
  CHAVE_QUERO_MENTORAR,
  LIMITE_OUTRA_NECESSIDADE,
  OPCOES_O_QUE_BUSCA,
  outraNecessidadeValida,
} from "@shared/o-que-busca";
import { AssistenteDeTexto } from "@/components/AssistenteDeTexto";
import { EtapaTermoGeralDeUso } from "@/components/TermoGeralDeUso";
import { rotuloDaBusca } from "@/lib/interesses";
import { EditorDoQuePreciso } from "@/components/OQuePreciso";
import { categoriasPendentes, demandasParaGravar, type DemandaDetalhada } from "@shared/o-que-preciso";
import { PREFIXO_DO_RASCUNHO_DO_CADASTRO } from "@/_core/hooks/useAuth";
import { MENSAGEM_MAIORIDADE_NAO_DECLARADA } from "@shared/maioridade";
import PaisEstadoCidade from "@/components/PaisEstadoCidade";
import { rotuloDoPais } from "@/lib/cascata-de-local";

// Tetos do servidor (routers/profile.ts) para os campos livres: o ditado pode
// passar deles, e sem contador o erro só aparecia no último passo.
const LIMITE_META = 2000;

/**
 * Última etapa: o Termo Geral de Uso (components/TermoGeralDeUso.tsx). É a
 * ÚNICA etapa de termos do cadastro: substituiu a antiga "Termos e Condições"
 * (contrato de comissão), porque o termo do Dr. Ronei já cobre intermediação e
 * remuneração nas cláusulas 12 a 15 (Rosber, 14/09 21:34).
 *
 * São 8 etapas desde 15/09: a etapa "Quem sou" existia só para a Rede
 * Institucional, e o Rosber a suprimiu no vídeo de 14/09 (21:15).
 */
const ETAPA_TERMO_GERAL = 8;
const TIPO_TERMO_GERAL = "termo_geral_de_uso" as const;


// ─── Tags "O que tenho" ───────────────────────────────────────────────────────
// `id` é o que vai GRAVADO (e o que já está no banco); `chave` é só o rótulo da
// tela. Os rótulos eram texto fixo em português aqui e no Perfil — a mesma
// lista, duplicada —, então o passo 6 do cadastro saía em português nos dez
// idiomas. As chaves ficam em `oQueTenho.*` para as duas telas lerem o mesmo
// rótulo, como já acontece com "O que preciso" (shared/o-que-preciso.ts).
const WHAT_I_HAVE_OPTIONS = [
  { id: "industria", chave: "oQueTenho.industria", icon: "🏭" },
  { id: "fazenda", chave: "oQueTenho.fazenda", icon: "🌾" },
  { id: "laboratorio", chave: "oQueTenho.laboratorio", icon: "🔬" },
  { id: "tecnologia", chave: "oQueTenho.tecnologia", icon: "💻" },
  { id: "investidores", chave: "oQueTenho.investidores", icon: "💰" },
  { id: "acesso_governamental", chave: "oQueTenho.acesso_governamental", icon: "🏛️" },
  { id: "commodities", chave: "oQueTenho.commodities", icon: "📦" },
  { id: "licencas", chave: "oQueTenho.licencas", icon: "📋" },
  { id: "imoveis", chave: "oQueTenho.imoveis", icon: "🏢" },
  { id: "logistica", chave: "oQueTenho.logistica", icon: "🚚" },
  { id: "canais_comerciais", chave: "oQueTenho.canais_comerciais", icon: "🤝" },
];

/**
 * "Outros" em "O que tenho" (Rosber, 14/09 21:17: "a gente precisa inserir nesse
 * 'o que tenho' um botão 'outros', para a pessoa poder digitar"). Mesmo padrão
 * do "Outra necessidade" de "O que você busca": marcar abre um campo de texto
 * obrigatório, e o que a pessoa digitar vira UM ITEM de `whatIHave` — os motores
 * leem os itens como texto, então o ativo escrito à mão chega a eles como os
 * outros. A chave "outros" é só a porta do campo e NUNCA é gravada: ela não é
 * um ativo, e gravá-la faria o motor cruzar a palavra "outros".
 */
const CHAVE_OUTRO_ATIVO = "outros";
const MINIMO_DO_OUTRO_ATIVO = 3;
const LIMITE_DO_OUTRO_ATIVO = 200;

function outroAtivoValido(marcados: readonly string[], texto: string): boolean {
  if (!marcados.includes(CHAVE_OUTRO_ATIVO)) return true;
  const aparado = texto.trim();
  return aparado.length >= MINIMO_DO_OUTRO_ATIVO && aparado.length <= LIMITE_DO_OUTRO_ATIVO;
}

/** Os ativos que vão ao servidor: os marcados, sem a porta "outros", mais o texto livre. */
function ativosParaGravar(marcados: readonly string[], texto: string): string[] {
  const ativos = marcados.filter(id => id !== CHAVE_OUTRO_ATIVO);
  const aparado = texto.trim();
  if (marcados.includes(CHAVE_OUTRO_ATIVO) && aparado) ativos.push(aparado);
  return ativos;
}

// ─── Porte preferido da empresa ───────────────────────────────────────────────
// Rosber, 14/09 21:13: "ele dá a opção de qualquer tamanho, mas não deixa eu
// selecionar dois tamanhos específicos. Eu quero fazer só com média e pequena".
// A coluna `preferredCompanySize` é um varchar(50) que já guardava UM valor
// ("medium", "any"), então a lista é gravada no mesmo campo, separada por
// vírgula e na ordem canônica abaixo ("small,medium" cabe de sobra). Nenhum
// porte marcado é o "qualquer tamanho" de sempre, e continua sendo gravado como
// "any": é o vocabulário que o dado já tem.
const PORTES_DA_EMPRESA = ["micro", "small", "medium", "large"] as const;
const PORTE_QUALQUER = "any";

/** Leitura: aceita o formato antigo (um porte só, ou "any") e o novo (lista). */
function lerPortes(gravado: string | null | undefined): string[] {
  if (!gravado) return [];
  const escolhidos = gravado.split(",").map(p => p.trim()).filter(p => p && p !== PORTE_QUALQUER);
  return PORTES_DA_EMPRESA.filter(porte => escolhidos.includes(porte));
}

/** Escrita: a lista na ordem canônica, ou "any" quando nada foi marcado. */
function portesParaGravar(escolhidos: readonly string[]): string {
  const lista = PORTES_DA_EMPRESA.filter(porte => escolhidos.includes(porte));
  return lista.length > 0 ? lista.join(",") : PORTE_QUALQUER;
}

// ─── "O que preciso" ──────────────────────────────────────────────────────────
// As 17 categorias e a segunda camada de detalhamento (Rosber, 14/09 21:24) vivem
// em shared/o-que-preciso.ts e components/OQuePreciso.tsx, que o Perfil reusa.
// "Consultoria" saiu: genérica demais; "Especialistas / Serviços" no lugar.

interface FormData {
  // Campos SUPRIMIDOS do cadastro, com a mesma regra da idade (Rosber, 14/09
  // 20:31) — a coluna e o dado antigo continuam no banco, o servidor segue
  // aceitando cada um deles, e a tela só deixou de pedir:
  //   - idade (20:31);
  //   - estilo de trabalho, valores principais e idiomas (21:08: "não está
  //     dentro do escopo do projeto");
  //   - aberto a remoto e disponível para viagens (21:10: "está mais voltado
  //     para busca de empregos");
  //   - rede institucional, e com ela a etapa "Quem sou", que só tinha esse
  //     campo (21:15).
  displayName: string; city: string; country: string; bio: string;
  primarySpecialty: string; primarySpecialties: string[]; customSpecialty: string; secondarySpecialties: string[]; experienceYears: number | null;
  educationLevel: string;
  seekingTypes: string[]; seekingOtherNeed: string; shortTermGoal: string; longTermGoal: string;
  sector: string; businessInterests: string[];
  /** Vários portes ao mesmo tempo; vazio é "qualquer tamanho" (ver PORTES_DA_EMPRESA). */
  preferredCompanySizes: string[];
  incomeRange: string; investmentCapacity: string; lookingForInvestment: boolean;
  gender: "" | "male" | "female" | "prefer_not_to_say";
  personType: "" | "individual" | "legal_entity" | "mei" | "nonprofit";
  companySize: "" | "mei" | "micro" | "small" | "medium" | "large";
  companyCnpj: string;
  customSector: string;
  currentResources: string;
  // Novos campos v2
  company: string; jobTitle: string; activityArea: string;
  interestSectors: string[];
  /** As opções marcadas em "O que tenho"; "outros" é a porta do texto abaixo. */
  whatIHave: string[];
  /** O ativo escrito à mão em "Outros" (ver CHAVE_OUTRO_ATIVO). */
  whatIHaveOther: string;
  whatINeed: string[];
  /** As demandas detalhadas de "O que preciso", cada uma separada (whatINeedDetails). */
  whatINeedDetails: DemandaDetalhada[];
  // Termo Geral de Uso (única etapa de termos do cadastro): o id da VERSÃO que
  // estava na tela quando a caixa foi marcada, não um booleano. Se o
  // consent.status trocar a versão exibida (refetch ao voltar à etapa, ao
  // reconectar), a caixa aparece desmarcada e o envio trava: o aceite nunca vai
  // para uma versão que a pessoa não marcou.
  termoGeralAceitoId: string | null;
}

const INITIAL: FormData = {
  displayName: "", city: "", country: "BR", bio: "",
  primarySpecialty: "", primarySpecialties: [], customSpecialty: "", secondarySpecialties: [], experienceYears: null,
  educationLevel: "",
  seekingTypes: [], seekingOtherNeed: "", shortTermGoal: "", longTermGoal: "",
  sector: "", businessInterests: [], preferredCompanySizes: [],
  // Capacidade de investimento começa VAZIA ("Selecione..."): abrir em "none"
  // gravava "Sem capital disponível" em quem só passou pelo campo (reteste v4,
  // item 5). Segue opcional para avançar, e só vai no envio quando escolhida.
  incomeRange: "", investmentCapacity: "", lookingForInvestment: false,
  gender: "",
  personType: "", companySize: "", companyCnpj: "",
  customSector: "",
  currentResources: "",
  // Novos campos v2
  company: "", jobTitle: "", activityArea: "",
  interestSectors: [],
  whatIHave: [], whatIHaveOther: "", whatINeed: [], whatINeedDetails: [],
  termoGeralAceitoId: null,
};

// ─── Rascunho do cadastro ─────────────────────────────────────────────────────
// Sem versão publicada do Termo Geral o botão final trava (ver ETAPA_TERMO_GERAL)
// e fechar a aba perdia as 8 etapas preenchidas (lista do Nicolas na PR #135,
// janela C). O formulário fica em localStorage, numa chave por usuária, a cada
// mudança; volta ao abrir de novo e é apagado ao concluir com sucesso. Sem
// usuária conhecida nada é gravado: uma chave sem dona mostraria o cadastro de
// uma conta para outra no mesmo navegador. A caixa do Termo Geral fica de fora:
// o aceite é ato da sessão que conclui (e a versão exibida pode ter mudado). A
// declaração de maioridade, pela mesma razão, nem está no FormData: é um estado
// à parte (`declarouMaioridade`), que nenhum dos dois rascunhos lê nem grava.
//
// Privacidade (mesma razão da nota V-03 em _core/hooks/useAuth.ts, que tirou
// dado de usuária do localStorage): faixa de renda, capacidade de investimento
// e Número de Cadastro Empresarial NÃO entram no rascunho, a pessoa redigita;
// o rascunho leva `salvoEm` e vale 7 dias (sem data, ou vencido, é ignorado);
// sair da conta apaga todos os rascunhos (apagarRascunhosDoCadastro, no logout).
const CAMPOS_FORA_DO_RASCUNHO: ReadonlySet<keyof FormData> = new Set<keyof FormData>([
  "termoGeralAceitoId", "incomeRange", "investmentCapacity", "companyCnpj",
]);
const VALIDADE_DO_RASCUNHO_MS = 7 * 24 * 60 * 60 * 1000;

function chaveDoRascunhoDa(idDaUsuaria: number | string): string {
  return PREFIXO_DO_RASCUNHO_DO_CADASTRO + String(idDaUsuaria);
}

/** Quando o rascunho foi gravado. Fica FORA de `lerRascunho`, que só devolve campos do formulário. */
function salvoEmDoRascunho(chave: string): number {
  try {
    const bruto = window.localStorage.getItem(chave);
    const dados: unknown = bruto ? JSON.parse(bruto) : null;
    const salvoEm = (dados as { salvoEm?: unknown } | null)?.salvoEm;
    return typeof salvoEm === "number" && Number.isFinite(salvoEm) ? salvoEm : 0;
  } catch {
    return 0;
  }
}

/** Lê o rascunho gravado; só entram os campos com a forma que o formulário
 *  espera, para um rascunho de versão antiga (ou adulterado) não quebrar a tela. */
function lerRascunho(chave: string): Partial<FormData> | null {
  try {
    const bruto = window.localStorage.getItem(chave);
    if (!bruto) return null;
    const dados: unknown = JSON.parse(bruto);
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) return null;
    const { salvoEm } = dados as { salvoEm?: unknown };
    if (typeof salvoEm !== "number" || Date.now() - salvoEm > VALIDADE_DO_RASCUNHO_MS) return null;
    const rascunho: Partial<FormData> = {};
    for (const campo of Object.keys(INITIAL) as (keyof FormData)[]) {
      if (CAMPOS_FORA_DO_RASCUNHO.has(campo)) continue;
      const valor = (dados as Record<string, unknown>)[campo];
      const padrao = INITIAL[campo];
      const compativel = Array.isArray(padrao) ? Array.isArray(valor)
        : padrao === null ? valor === null || typeof valor === "number"
        : typeof valor === typeof padrao;
      if (compativel) (rascunho as Record<string, unknown>)[campo] = valor;
    }
    return rascunho;
  } catch {
    return null;
  }
}

function gravarRascunho(chave: string, form: FormData) {
  try {
    const rascunho: Record<string, unknown> = { salvoEm: Date.now() };
    for (const [campo, valor] of Object.entries(form)) {
      if (!CAMPOS_FORA_DO_RASCUNHO.has(campo as keyof FormData)) rascunho[campo] = valor;
    }
    window.localStorage.setItem(chave, JSON.stringify(rascunho));
  } catch {
    // Sem armazenamento (modo privado, cota cheia): o cadastro segue sem rascunho.
  }
}

function apagarRascunho(chave: string) {
  try {
    window.localStorage.removeItem(chave);
  } catch {
    // Idem: nada a fazer sem armazenamento.
  }
  try {
    window.sessionStorage.removeItem(chave);
  } catch {
    // Idem.
  }
}

// ─── Rascunho da aba: a etapa e o que o localStorage não guarda ───────────────
// Rosber, 16/09: puxar a tela para baixo no celular recarregava a página, e o
// cadastro voltava para a primeira etapa com várias escolhas desmarcadas. O
// rascunho acima já devolvia a maior parte das respostas, mas não a ETAPA, e a
// faixa de renda (obrigatória na etapa 3) ficava de fora por privacidade — sem
// ela a pessoa nunca passaria da etapa 3 ao recarregar.
//
// Decisão: a etapa e os três campos fora do localStorage (renda, capacidade de
// investimento e Número de Cadastro Empresarial) ficam no sessionStorage, com a
// MESMA chave por usuária. O sessionStorage vive só naquela aba — some ao
// fechá-la, e outra aba ou outra pessoa no mesmo computador não o lê —, então
// cobre o recarregar sem reabrir a questão da V-03. Some também ao concluir
// (apagarRascunho) e ao sair da conta (apagarRascunhosDoCadastro, que só alcança
// a aba em que a pessoa saiu: o sessionStorage de OUTRA aba aberta do app não é
// visível dali). Aba de celular pode durar semanas, então ele leva `salvoEm` e
// vale os mesmos 7 dias do rascunho acima; vencido, é ignorado. O aceite do
// Termo Geral continua fora dos dois.
const CAMPOS_SO_DA_ABA = ["incomeRange", "investmentCapacity", "companyCnpj"] as const;

type RascunhoDaAba = { etapa: number | null; campos: Partial<FormData> };

function etapaValida(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 1 && valor <= ETAPA_TERMO_GERAL ? valor : null;
}

function lerRascunhoDaAba(chave: string): RascunhoDaAba | null {
  try {
    const bruto = window.sessionStorage.getItem(chave);
    if (!bruto) return null;
    const dados: unknown = JSON.parse(bruto);
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) return null;
    const registro = dados as Record<string, unknown>;
    const { salvoEm } = registro;
    if (typeof salvoEm !== "number" || Date.now() - salvoEm > VALIDADE_DO_RASCUNHO_MS) return null;
    const campos: Partial<FormData> = {};
    for (const campo of CAMPOS_SO_DA_ABA) {
      const valor = registro[campo];
      if (typeof valor === "string") campos[campo] = valor as never;
    }
    return { etapa: etapaValida(registro.etapa), campos };
  } catch {
    return null;
  }
}

function gravarRascunhoDaAba(chave: string, form: FormData, etapa: number) {
  try {
    const rascunho: Record<string, unknown> = { salvoEm: Date.now(), etapa };
    for (const campo of CAMPOS_SO_DA_ABA) rascunho[campo] = form[campo];
    window.sessionStorage.setItem(chave, JSON.stringify(rascunho));
  } catch {
    // Sem sessionStorage: recarregar volta à primeira etapa, como antes.
  }
}

// ─── Uma entrada do histórico por etapa ───────────────────────────────────────
// Rosber, 16/09: o "voltar" do navegador (e o do celular) saía do cadastro em
// vez de voltar uma etapa — a rota anterior mandava de novo a /onboarding, que
// abria na etapa 1. Cada etapa agora empilha uma entrada no histórico, na
// MESMA URL (o wouter não vê troca de rota e o ProtectedRoute não é chamado de
// novo), com a etapa guardada no `history.state`. Invariante: a entrada de
// posição i da pilha do cadastro é a etapa i — é o que deixa `history.go` levar
// a uma etapa exata.
const CHAVE_DA_ETAPA_NO_HISTORICO = "etapaDoCadastro";

function etapaDoEstado(estado: unknown): number | null {
  if (!estado || typeof estado !== "object") return null;
  return etapaValida((estado as Record<string, unknown>)[CHAVE_DA_ETAPA_NO_HISTORICO]);
}

function etapaNoHistorico(): number | null {
  try {
    return etapaDoEstado(window.history.state);
  } catch {
    return null;
  }
}

function marcarEtapaNoHistorico(etapa: number, modo: "push" | "replace") {
  try {
    const atual: unknown = window.history.state;
    const estado = { ...(atual && typeof atual === "object" ? atual : {}), [CHAVE_DA_ETAPA_NO_HISTORICO]: etapa };
    if (modo === "push") window.history.pushState(estado, "");
    else window.history.replaceState(estado, "");
  } catch {
    // Histórico indisponível: o cadastro segue, só sem o "voltar" do navegador por etapa.
  }
}

/** Classe no <html> que desliga o "puxar para atualizar" enquanto o cadastro está aberto (index.css). */
const CLASSE_SEM_PUXAR_PARA_ATUALIZAR = "cadastro-sem-puxar-para-atualizar";

/**
 * Leva a página ao topo NA HORA. Relato do Rosber de 16/09: a etapa nova
 * continuava abrindo no meio ou no fim, mesmo com o scrollTo que já existia.
 * Provável causa: o index.css põe `scroll-behavior: smooth` no html, e tanto
 * `scrollTo({ behavior: "auto" })` quanto `scrollTop = 0` herdam esse "suave";
 * a rolagem animada começava junto com a troca do conteúdo e o navegador do
 * celular a interrompia no caminho. Aqui o html recebe `auto` inline só durante
 * a chamada, e o pedido vai como "instant".
 */
function levarAoTopo(painel: HTMLElement | null) {
  const raiz = document.documentElement;
  const comportamentoAntes = raiz.style.scrollBehavior;
  raiz.style.scrollBehavior = "auto";
  try {
    if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  } catch {
    // Navegador que não aceita "instant": o scrollTop abaixo resolve.
  }
  (document.scrollingElement ?? raiz).scrollTop = 0;
  // No desktop o formulário pode rolar dentro do painel da direita.
  if (painel) painel.scrollTop = 0;
  raiz.style.scrollBehavior = comportamentoAntes;
}

/**
 * O que libera o "Continuar" de cada etapa. Saiu de dentro do componente para
 * valer também fora da etapa visível: restaurar a etapa depois de recarregar,
 * ou o "avançar" do navegador, só leva a uma etapa se todas as anteriores
 * estiverem completas (ver etapaAlcancavel).
 */
function etapaCompleta(etapa: number, form: FormData, ultimaEtapaMarcada: boolean): boolean {
  // O teto do passo é o que a plataforma GRAVA: a bio da carga passa do teto
  // do cadastro e travava o "Continuar" da etapa 1 — a conta não concluía.
  if (etapa === 1) return form.displayName.trim().length >= 2 && form.city.trim().length >= 2 && form.bio.length <= LIMITE_DA_BIO_GRAVADA;
  if (etapa === 2) {
    const temEspecialidade = form.primarySpecialties.length > 0 || form.customSpecialty.trim().length > 0;
    // Quem se declara MEI, pessoa juridica ou sem fins lucrativos tem cadastro empresarial por definicao (A7).
    const cadastroOk = !exigeCadastroEmpresarial(form.personType) || normalizarCadastroEmpresarial(form.companyCnpj).length > 0;
    return temEspecialidade && cadastroOk;
  }
  if (etapa === 3) {
    const textosCabem = form.shortTermGoal.length <= LIMITE_META && form.longTermGoal.length <= LIMITE_META
      && form.currentResources.length <= LIMITE_META;
    // Estilo de trabalho era exigido aqui e saiu do cadastro (21:08).
    return form.seekingTypes.length > 0 && form.incomeRange.length > 0
      && outraNecessidadeValida(form.seekingTypes, form.seekingOtherNeed) && textosCabem;
  }
  if (etapa === 4) return form.sector.length > 0;
  // "O que tenho": marcar nada continua valendo, mas "Outros" marcado exige o texto.
  if (etapa === 5) return outroAtivoValido(form.whatIHave, form.whatIHaveOther);
  // "O que preciso": marcar nada continua valendo, mas categoria marcada precisa
  // de ao menos uma demanda detalhada e válida — a seleção sozinha não gera conexão.
  if (etapa === 6) return categoriasPendentes(form.whatINeed, form.whatINeedDetails).length === 0;
  // Última etapa: o aceite do Termo Geral E a declaração de maioridade (quem chama junta as duas).
  if (etapa === ETAPA_TERMO_GERAL) return ultimaEtapaMarcada;
  // Etapas profissionais e de ativos são opcionais — sempre pode avançar
  return true;
}

/** A etapa pedida, ou a primeira ANTERIOR a ela que ainda não está completa. */
function etapaAlcancavel(pedida: number, form: FormData): number {
  for (let etapa = 1; etapa < pedida; etapa++) {
    // O Termo Geral é a última etapa: nunca é "anterior" a outra, e o aceite não conta aqui.
    if (!etapaCompleta(etapa, form, false)) return etapa;
  }
  return pedida;
}

// ─── Componentes reutilizáveis ────────────────────────────────────────────────
// CAIXA ALTA, onde vale (revisão de 15/09): o Rosber mandou em caixa alta os
// títulos das categorias das DUAS listas de seleção — "O que tenho" (TagButton
// abaixo) e "O que preciso" (components/OQuePreciso.tsx) —, e é só ali que ela
// fica, nas mesmas duas listas no cadastro e no Perfil. Na rodada anterior a
// caixa alta havia escorrido para os demais cartões (especialidade, tipo de
// pessoa, o que busca, renda, porte) e para o Perfil, e ficava inconsistente
// dentro da própria tela; estes voltaram à caixa normal.
//
// Onde ela existe, é por CSS (`uppercase`) e nunca reescrevendo o texto dos 10
// JSONs: árabe, chinês e japonês não têm caixa, `text-transform` simplesmente
// não os toca, e um rótulo gravado em maiúsculas estragaria os idiomas latinos
// sem fazer nada por esses três.
function CardOption({ selected, onClick, icon, label, desc }: {
  selected: boolean; onClick: () => void; icon: string; label: string; desc?: string;
}) {
  // `h-full` no cartão e `break-words` no rótulo: rótulo comprido
  // ("Microempreendedor Individual (MEI)") quebra DENTRO do cartão em vez de
  // transbordar para o vizinho, e a fileira fica com a mesma altura mesmo com
  // um cartão de duas linhas (reteste v4, item 10).
  return (
    <button type="button" onClick={onClick}
      className={`group relative h-full p-4 rounded-xl border text-left transition-all duration-200 active:scale-95 ${selected
        ? "bg-[#c98f70]/15 border-[#c98f70] shadow-lg shadow-[#c98f70]/10"
        : "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/30"}`}>
      {selected && (
        <div className="absolute top-2 right-2 w-5 h-5 bg-[#c98f70] rounded-full flex items-center justify-center">
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path d="M1 4L3.5 6.5L9 1" stroke="#151312" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      )}
      <div className="text-2xl mb-2">{icon}</div>
      <div className={`font-semibold text-sm break-words ${selected ? "text-[#c98f70]" : "text-white"}`}>{label}</div>
      {desc && <div className="text-xs text-white/40 mt-0.5">{desc}</div>}
    </button>
  );
}

function TagOption({ selected, onClick, label }: { selected: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-2 rounded-full text-sm font-medium border transition-all duration-200 active:scale-95 ${selected
        ? "bg-[#c98f70] border-[#c98f70] text-[#151312] font-bold"
        : "bg-white/5 border-white/20 text-white/70 hover:border-white/40 hover:text-white"}`}>
      {label}
    </button>
  );
}

function TagButton({ icon, label, selected, onClick }: {
  icon: string; label: string; selected: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-95 ${
        selected
          ? "bg-[#c98f70]/15 border-[#c98f70]/60 text-[#c98f70] shadow-sm shadow-[#c98f70]/10"
          : "bg-white/3 border-white/10 text-white/50 hover:border-white/25 hover:text-white/75 hover:bg-white/6"
      }`}>
      <span className="text-base leading-none">{icon}</span>
      <span className="uppercase">{label}</span>
      {selected && <CheckCircle size={13} className="text-[#c98f70] ml-auto" />}
    </button>
  );
}

function TextInput({ label, value, onChange, placeholder, type = "text", hint, min, max, list, required }: {
  // `compondo`: o IME (japonês, chinês) ainda está montando o texto; quem
  // transforma o valor deve esperar o fim da composição, que chama de novo.
  label: string; value: string | number; onChange: (v: string, compondo?: boolean) => void;
  placeholder?: string; type?: string; hint?: string; min?: number; max?: number; list?: string; required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-white/70 mb-2">{label}{required && <span className="text-[#c98f70]"> *</span>}</label>
      <input type={type} value={value ?? ""} min={min} max={max} list={list}
        inputMode={type === "number" ? "numeric" : undefined}
        onChange={e => onChange(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
        onCompositionEnd={e => onChange(e.currentTarget.value, false)} placeholder={placeholder}
        className="w-full bg-white/5 border border-white/15 rounded-xl px-4 py-3 text-white placeholder-white/25 focus:outline-none focus:border-[#c98f70]/60 focus:bg-white/8 transition-all duration-200 text-sm"/>
      {hint && <p className="text-xs text-white/30 mt-1">{hint}</p>}
    </div>
  );
}

function TextareaInput({ label, value, onChange, placeholder, hint, required, limite, assistente }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string;
  required?: boolean;
  /** Teto do servidor: mostra o contador e avisa quando o texto (digitado ou ditado) passa dele. */
  limite?: number;
  /** "Gravar áudio" e "Revisar texto" embaixo do campo. */
  assistente?: boolean;
}) {
  const { t } = useTranslation();
  const passou = limite !== undefined && value.length > limite;
  return (
    <div>
      <label className="block text-sm font-medium text-white/70 mb-2">{label}{required && <span className="text-[#c98f70]"> *</span>}</label>
      <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3}
        aria-invalid={passou || undefined}
        className={`w-full bg-white/5 border rounded-xl px-4 py-3 text-white placeholder-white/25 focus:outline-none focus:bg-white/8 transition-all duration-200 text-sm resize-none ${passou ? "border-red-400/60 focus:border-red-400/80" : "border-white/15 focus:border-[#c98f70]/60"}`}/>
      {assistente && <AssistenteDeTexto valor={value} onChange={onChange}/>}
      {(hint || limite !== undefined) && (
        <div className="flex items-start justify-between gap-3 mt-1">
          {hint ? <p className="text-xs text-white/30">{hint}</p> : <span/>}
          {limite !== undefined && (
            <span className={`text-[11px] tabular-nums shrink-0 ${passou ? "text-red-400" : "text-white/25"}`}>
              {t("assistenteTexto.contador", { atual: value.length, maximo: limite })}
            </span>
          )}
        </div>
      )}
      {passou && <p className="text-xs text-red-400/80 mt-1">{t("assistenteTexto.textoLongo", { maximo: limite })}</p>}
    </div>
  );
}

function SelectInput({ label, value, onChange, options, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[]; placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-white/70 mb-2">{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-[#211e1b] border border-white/15 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-[#c98f70]/60 transition-all duration-200 text-sm">
        <option className="bg-white text-[#322C26]" value="">{placeholder || "..."}</option>
        {options.map(o => <option className="bg-white text-[#322C26]" key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────
/**
 * As listas do perfil chegam do banco como array ou como JSON em texto (a
 * coluna é `json` e o driver às vezes entrega a string). Só entram chaves: item
 * escrito à mão não volta para as caixinhas, que são de vocabulário fechado.
 */
/**
 * O rótulo de setor gravado no perfil, se ele ainda existir na lista de hoje.
 * `setoresTraduzidos` é a fonte única (shared/setores.ts), a mesma que desenha o
 * seletor da etapa 4.
 */
function setorConhecido(t: TradutorDeSetor, gravado: unknown): string | null {
  if (typeof gravado !== "string" || !gravado.trim()) return null;
  const alvo = gravado.trim().toLowerCase();
  const achado = setoresTraduzidos(t).find(setor => setor.rotulo.trim().toLowerCase() === alvo);
  return achado ? achado.rotulo : null;
}

function listaDeChaves(valor: unknown): string[] {
  const bruto = typeof valor === "string" ? (() => { try { return JSON.parse(valor); } catch { return []; } })() : valor;
  return Array.isArray(bruto) ? bruto.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export default function Onboarding() {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [animDir, setAnimDir] = useState<"forward" | "back">("forward");
  const [visible, setVisible] = useState(true);
  const [form, setForm] = useState<FormData>(INITIAL);
  // "Declaro que tenho 18 anos ou mais." (cláusula 3.4 do Termo Geral), na última
  // etapa. Fora do FormData de propósito: o rascunho grava o formulário inteiro
  // menos CAMPOS_FORA_DO_RASCUNHO, e uma declaração não pode voltar marcada de
  // um rascunho — recarregou, marca de novo.
  const [declarouMaioridade, setDeclarouMaioridade] = useState(false);
  const prefilled = useRef(false);
  // Chave do rascunho em localStorage: existe só depois de saber quem é a
  // usuária e de restaurar o que ela já tinha (ver "Rascunho do cadastro").
  const [chaveDoRascunho, setChaveDoRascunho] = useState<string | null>(null);

  // ─── Navegação entre etapas (histórico, topo, foco) ───
  // `etapaAlvo` é para onde a tela ESTÁ INDO: muda na hora do clique ou do
  // "voltar" do navegador, antes dos 220 ms da animação, e é o que o popstate
  // compara para não trocar duas vezes para a mesma etapa.
  const etapaAlvo = useRef(1);
  const trocaPendente = useRef<ReturnType<typeof setTimeout> | null>(null);
  // O "Voltar" da tela vai pelo histórico e espera o popstate: sem esta trava,
  // dois toques rápidos voltariam duas etapas.
  const esperandoOHistorico = useRef(false);
  const focarTituloNaTroca = useRef(false);
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const painelRef = useRef<HTMLDivElement>(null);
  const formRef = useRef(form);
  formRef.current = form;
  // Para o popstate (registrado uma vez) gravar a etapa no rascunho da aba.
  const chaveDoRascunhoRef = useRef(chaveDoRascunho);
  chaveDoRascunhoRef.current = chaveDoRascunho;
  // A etapa gravada na entrada do histórico em que a tela ABRIU (recarregar
  // mantém o `history.state`); null é entrada nova. Lida uma vez, antes de a
  // própria tela marcar a entrada. É também a primeira entrada que ESTE
  // documento criou: depois de recarregar, as entradas abaixo dela são do
  // documento anterior, e ir a elas recarrega a página.
  const etapaAoAbrir = useRef<number | null | undefined>(undefined);
  if (etapaAoAbrir.current === undefined) etapaAoAbrir.current = etapaNoHistorico();
  // Etapa a restaurar depois que o formulário restaurado estiver no estado.
  const [etapaARestaurar, setEtapaARestaurar] = useState<number | null>(null);
  // Depois de concluir, a ida ao Dashboard espera o popstate do history.go que
  // tira as etapas do caminho do "voltar" (ver irAoDashboardSemAsEtapas).
  const saidaAposConcluir = useRef<(() => void) | null>(null);
  // Entrada de um cadastro já concluído (ver o pré-preenchimento): a tela vai ao
  // Dashboard em vez de reabrir as etapas.
  const [indoAoDashboard, setIndoAoDashboard] = useState(false);

  // Pre-preenche com o que ja existe: o nome dado no cadastro (users.name) e,
  // num re-onboarding, o perfil salvo. Antes o formulario abria vazio e pedia
  // o nome de novo. O rascunho da usuária entra ANTES: campo que ela já
  // preencheu vence o perfil salvo.
  // A bio da carga vai até LIMITE_DA_BIO_GRAVADA (scripts/importacao/planilha.mjs)
  // e entra INTEIRA no campo: mostrar só o começo fazia concluir o cadastro (ou
  // qualquer edição) destruir o resto, em silêncio e sem volta (validação de
  // 16/09 na #135, item 10).
  const profileQuery = trpc.profile.get.useQuery(undefined, { staleTime: 60_000 });
  useEffect(() => {
    if (prefilled.current || !profileQuery.data) return;
    const { user, profile } = profileQuery.data as { user?: { id?: number; name?: string | null } | null; profile?: Partial<FormData> & {
      displayName?: string | null; city?: string | null; country?: string | null; bio?: string | null; preferredCompanySize?: string | null;
      company?: string | null; jobTitle?: string | null; sector?: string | null; currentResources?: string | null;
      whatIHave?: unknown; whatINeed?: unknown; sectors?: unknown;
    } | null };
    prefilled.current = true;
    const chave = user?.id != null ? chaveDoRascunhoDa(user.id) : null;
    const rascunhoGuardado = chave ? lerRascunho(chave) : null;
    // O rascunho da aba só existe se esta aba recarregou no meio do cadastro:
    // traz a etapa e os campos que não ficam no localStorage. Os três campos
    // dele não vêm do perfil salvo (o pré-preenchimento abaixo não os lê), então
    // não há o que decidir entre ele e o perfil — e a conta com cadastro
    // incompleto não consegue gravar o perfil por outra tela enquanto isso.
    const rascunhoDaAba = chave ? lerRascunhoDaAba(chave) : null;
    // Entrada de ETAPA de um cadastro que já foi concluído, sem rascunho da aba
    // (concluir o apaga): é o "voltar" do Dashboard caindo numa etapa que ficou
    // na pilha — depois de recarregar no meio do cadastro, ou pelo "avançar" do
    // navegador. Reabrir aqui mostraria o formulário pela metade e convidaria a
    // refazer tudo (revisão de 16/09). Quem usa "Refazer cadastro" chega numa
    // entrada NOVA (sem etapa), e quem recarrega no meio dele tem o rascunho da aba.
    const jaConcluiu = (user as { onboardingCompleted?: boolean | null } | null | undefined)?.onboardingCompleted === true;
    if (jaConcluiu && etapaAoAbrir.current != null && !rascunhoDaAba) {
      setIndoAoDashboard(true);
      navigate("/dashboard", { replace: true });
      return;
    }
    const rascunho = rascunhoGuardado || rascunhoDaAba
      ? { ...(rascunhoGuardado ?? {}), ...(rascunhoDaAba?.campos ?? {}) }
      : null;
    // Qual etapa reabrir: a da entrada do histórico (recarregar) ou, numa entrada
    // nova, a do rascunho da aba. Quem decide se dá para chegar nela é o efeito
    // de restauração, já com o formulário restaurado.
    const etapaPedida = etapaAoAbrir.current ?? rascunhoDaAba?.etapa ?? 1;
    if (etapaPedida > 1) setEtapaARestaurar(etapaPedida);
    // Chave e formulário mudam juntos (mesmo lote): o efeito que grava só roda
    // com o formulário já restaurado, nunca com o vazio do primeiro render.
    setChaveDoRascunho(chave);
    // O que aparece na apresentação fica decidido aqui, fora do atualizador: lá
    // dentro a segunda passagem do StrictMode recebe o estado já preenchido.
    const bioSalva = profile?.bio ?? "";
    const bioDoRascunho = (rascunho as { bio?: string } | null)?.bio ?? "";
    // O rascunho nasce sozinho: abrir a tela uma vez já grava o que ela
    // pré-preencheu. Se depois a pessoa editar a apresentação no Perfil, o
    // rascunho velho voltaria por cima do texto novo sem ninguém tocar no campo.
    // Ele só vale enquanto for mais NOVO do que o perfil salvo.
    const salvoEm = chave ? salvoEmDoRascunho(chave) : 0;
    const perfilSalvoEm = new Date((profile as { updatedAt?: string | number | Date } | null)?.updatedAt ?? 0).getTime();
    const rascunhoEhMaisNovo = salvoEm >= (Number.isFinite(perfilSalvoEm) ? perfilSalvoEm : 0);
    // A apresentação entra INTEIRA no campo, mesmo acima do teto do cadastro:
    // a carga da planilha grava até LIMITE_DA_BIO_GRAVADA, e mostrar só o
    // começo fazia qualquer edição destruir, em silêncio, o resto que a pessoa
    // nunca viu (validação de 16/09 na #135, item 10).
    const bioMostrada = (rascunhoEhMaisNovo && bioDoRascunho) || bioSalva;
    setForm(prev => {
      const base = rascunho ? { ...prev, ...rascunho } : prev;
      return {
        ...base,
        displayName: base.displayName || profile?.displayName || user?.name || "",
        city: base.city || profile?.city || "",
        country: rascunho?.country || profile?.country || base.country,
        // A bio já salva (contas da carga de scripts/importar-participantes.mjs)
        // não vinha para o formulário e saía vazia ao concluir, apagando-a no
        // servidor (lista do Nicolas na PR #135, item 10). Vem inteira, e o que
        // a pessoa já DIGITOU vence — `prev`, não `base`: `base` já traz o
        // rascunho, e o rascunho velho voltaria por cima do texto novo.
        bio: prev.bio || bioMostrada,
        // O porte já gravado volta marcado, venha no formato antigo (um porte só)
        // ou no novo (lista separada por vírgula) — ver lerPortes.
        preferredCompanySizes: base.preferredCompanySizes.length > 0
          ? base.preferredCompanySizes
          : lerPortes(profile?.preferredCompanySize),
        // O RESTO do que a carga de participantes já gravou
        // (scripts/importar-participantes.mjs): empresa, cargo, setor, o que
        // possui, o que procura e o texto livre. Sem isto, a participante
        // importada — que entra com `onboardingCompleted = 0` e por isso é
        // mandada ao cadastro — via um formulário vazio e tinha de digitar de
        // novo o que a planilha já trouxe, ou concluía apagando tudo. Com isto,
        // o cadastro dela vira conferir e aceitar.
        company: base.company || profile?.company || "",
        jobTitle: base.jobTitle || profile?.jobTitle || "",
        // O setor só volta se for UM DOS RÓTULOS da lista. A carga de
        // participantes grava o que veio na coluna da planilha ("Tecnologia",
        // "Saúde e bem-estar"), e a lista de hoje tem outros rótulos
        // ("Tecnologia & Software", "Saúde"): pré-preencher com o que não casa
        // deixa o seletor VAZIO na tela com o "Continuar" liberado, e a revisão
        // mostrando um setor que ninguém escolheu. Sem casar, ela escolhe.
        sector: base.sector || (setorConhecido(t, profile?.sector) ?? ""),
        currentResources: base.currentResources || profile?.currentResources || "",
        whatIHave: base.whatIHave.length > 0 ? base.whatIHave : listaDeChaves(profile?.whatIHave),
        whatINeed: base.whatINeed.length > 0 ? base.whatINeed : listaDeChaves(profile?.whatINeed),
        // `sectors` do perfil NÃO entra em `interestSectors`: a carga grava ali o
        // RÓTULO do setor que veio na planilha ("Agronegócio"), e esta lista é de
        // chaves. Pré-preencher com rótulo devolveria o rótulo ao servidor na
        // conclusão, que é justamente o defeito que a entrega consertou em
        // businessInterests. O campo não aparece no cadastro; quem edita é o Perfil.
      };
    });
  }, [profileQuery.data]);

  // Grava o rascunho a cada mudança (objeto pequeno; síncrono).
  useEffect(() => {
    if (chaveDoRascunho) gravarRascunho(chaveDoRascunho, form);
  }, [form, chaveDoRascunho]);

  // O rascunho da aba leva a etapa junto. Enquanto há etapa a restaurar ele
  // espera: gravar agora escreveria a etapa 1 por cima da que vai ser reaberta.
  // A etapa gravada é a de DESTINO (`etapaAlvo`), não a da tela: `step` só muda
  // 220 ms depois do toque, e três "voltar" rápidos deixavam gravada a etapa de
  // onde a pessoa saiu (trocarEtapa também grava na hora).
  useEffect(() => {
    if (chaveDoRascunho && etapaARestaurar === null) gravarRascunhoDaAba(chaveDoRascunho, form, etapaAlvo.current);
  }, [form, step, chaveDoRascunho, etapaARestaurar]);

  // Abrir o cadastro: a entrada atual do histórico passa a ser a etapa 1 (se já
  // não for de uma etapa) e o "puxar para atualizar" fica desligado.
  useEffect(() => {
    if (etapaAoAbrir.current === null) marcarEtapaNoHistorico(1, "replace");
    const raiz = document.documentElement;
    raiz.classList.add(CLASSE_SEM_PUXAR_PARA_ATUALIZAR);
    // Sem isto, no "voltar" o navegador devolve na hora a rolagem guardada da
    // entrada (o fim da etapa) com a etapa anterior ainda na tela, e 220 ms
    // depois a página pula ao topo. Quem leva ao topo é levarAoTopo.
    let restauracaoAntes: ScrollRestoration | null = null;
    try {
      restauracaoAntes = window.history.scrollRestoration ?? null;
      window.history.scrollRestoration = "manual";
    } catch {
      // Navegador sem a propriedade: fica o salto, só visual.
    }
    return () => {
      raiz.classList.remove(CLASSE_SEM_PUXAR_PARA_ATUALIZAR);
      if (trocaPendente.current) clearTimeout(trocaPendente.current);
      try {
        if (restauracaoAntes) window.history.scrollRestoration = restauracaoAntes;
      } catch {
        // Idem.
      }
    };
  }, []);

  // Reabre a etapa em que a pessoa estava, com o formulário já restaurado (o
  // estado deste render). Só até onde as respostas deixam chegar: se faltar algo
  // numa etapa anterior, abre nela. Se a pessoa já andou antes de o perfil
  // chegar, o que ela fez vale e nada é restaurado.
  useEffect(() => {
    if (etapaARestaurar === null) return;
    setEtapaARestaurar(null);
    if (etapaAlvo.current !== 1) return;
    const alvo = etapaAlcancavel(etapaARestaurar, form);
    const naEntrada = etapaAoAbrir.current;
    if (naEntrada != null) {
      // Recarregou: a pilha 1..naEntrada já existe. Etapa que não dá para abrir
      // volta pela própria pilha, para a entrada i continuar sendo a etapa i.
      if (alvo < naEntrada) window.history.go(alvo - naEntrada);
    } else {
      // Entrada nova (a aba voltou ao cadastro por outra rota): refaz a pilha
      // para o "voltar" do navegador passar por cada etapa até a 1.
      for (let etapa = 2; etapa <= alvo; etapa++) marcarEtapaNoHistorico(etapa, "push");
    }
    etapaAlvo.current = alvo;
    setStep(alvo);
  }, [etapaARestaurar, form]);

  // "Voltar" e "avançar" do navegador ou do celular: vai à etapa da entrada.
  useEffect(() => {
    const aoNavegarNoHistorico = (evento: PopStateEvent) => {
      // Cadastro concluído: este popstate é o do recolhimento das etapas.
      if (saidaAposConcluir.current) {
        saidaAposConcluir.current();
        return;
      }
      esperandoOHistorico.current = false;
      const pedida = etapaDoEstado(evento.state);
      if (pedida === null || pedida === etapaAlvo.current) return;
      const permitida = etapaAlcancavel(pedida, formRef.current);
      if (permitida < pedida) {
        // "Avançar" para uma etapa que as respostas de hoje não liberam: volta
        // pela pilha até a etapa que falta completar.
        window.history.go(permitida - pedida);
        if (permitida === etapaAlvo.current) return;
      }
      trocarEtapa(permitida);
    };
    window.addEventListener("popstate", aoNavegarNoHistorico);
    return () => window.removeEventListener("popstate", aoNavegarNoHistorico);
    // trocarEtapa só usa setters e refs, estáveis entre renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Etapa nova: topo da página e foco no título (quem usa leitor de tela ouve em
  // que etapa está, e o teclado continua dali). Roda depois de o conteúdo novo
  // estar no DOM, antes da pintura; não roda na primeira exibição da tela.
  const primeiraExibicao = useRef(true);
  useLayoutEffect(() => {
    if (primeiraExibicao.current) {
      primeiraExibicao.current = false;
      return;
    }
    levarAoTopo(painelRef.current);
    if (focarTituloNaTroca.current) {
      focarTituloNaTroca.current = false;
      tituloRef.current?.focus({ preventScroll: true });
    }
  }, [step]);

  // O banco guarda a CHAVE (estavel entre idiomas); o rotulo e so exibicao.
  // Antes era gravado o texto traduzido, e usuarias de idiomas diferentes
  // nunca davam match entre si.
  const SPECIALTIES = [
    { key: "tech", icon: "💻" }, { key: "finance", icon: "📈" },
    { key: "design", icon: "🎨" }, { key: "marketing", icon: "📣" },
    { key: "legal", icon: "⚖️" }, { key: "engineering", icon: "🏗️" },
    { key: "health", icon: "🏥" }, { key: "education", icon: "🎓" },
    { key: "sustainability", icon: "🌱" }, { key: "retail", icon: "🏪" },
    { key: "gastronomy", icon: "🍽️" }, { key: "startups", icon: "🚀" },
  ].map(o => ({ ...o, label: t("onboarding.specialties." + o.key) }));

  // "O que você busca?": as 12 opções do Lucas (grupo, 14/09 20:58), na ordem
  // dele e com "Outra necessidade" por último — não em ordem alfabética. As
  // chaves, os emojis e o legado (investor, team, job...) vivem em
  // shared/o-que-busca.ts. "Quero também mentorar" é oferta, não busca, e
  // continua como o botão próprio logo abaixo.
  const SEEKING_TYPES = OPCOES_O_QUE_BUSCA.map(o => ({
    key: o.chave, icon: o.emoji,
    label: t(`oQueBusca.opcoes.${o.chave}.titulo`),
    desc: t(`oQueBusca.opcoes.${o.chave}.descricao`),
  }));

  // Setores: fonte ÚNICA em shared/setores.ts, a mesma do Perfil ("Setores de
  // interesse") e de "Nova Oportunidade" — antes eram três listas diferentes e
  // quem se cadastrava em "Tecnologia & Software" não achava o próprio setor na
  // lista de interesses (reteste v4, item 7). O cadastro continua gravando o
  // RÓTULO traduzido, não a chave: é o que server/matching.ts normaliza em
  // `chaveDoSetor`, e os rótulos dos setores que já existiam aqui não mudaram.
  const SECTORS = setoresTraduzidos(t).map(s => ({ key: s.chave, label: s.rotulo }));
  // "Outro" não é setor: é a saída para texto livre, e por isso fica fora da
  // fonte única e sempre no fim da lista.
  const OTHER_SECTOR_LABEL = t("onboarding.sectors.other");

  // "Qualquer tamanho" continua na tela, agora como o cartão que LIMPA a
  // seleção: marcado quando nenhum porte específico está, e clicá-lo desmarca
  // todos. É o mesmo significado de sempre, sem virar um porte da lista.
  const COMPANY_SIZES = [
    { value: "micro", label: t("onboarding.companySize.micro"), icon: "🌱" },
    { value: "small", label: t("onboarding.companySize.small"), icon: "🏠" },
    { value: "medium", label: t("onboarding.companySize.medium"), icon: "🏢" },
    { value: "large", label: t("onboarding.companySize.large"), icon: "🏙️" },
  ];

  const INCOME_RANGES = [
    { value: "under_3k", label: t("onboarding.income.under_3k"), icon: "🌱" },
    { value: "3k_7k", label: t("onboarding.income.3k_7k"), icon: "📈" },
    { value: "7k_15k", label: t("onboarding.income.7k_15k"), icon: "💼" },
    { value: "15k_30k", label: t("onboarding.income.15k_30k"), icon: "🏆" },
    { value: "30k_plus", label: t("onboarding.income.30k_plus"), icon: "👑" },
  ];

  const INVESTMENT_CAPACITIES = [
    { value: "none", label: t("onboarding.investment.none") },
    { value: "under_10k", label: t("onboarding.investment.under_10k") },
    { value: "10k_50k", label: t("onboarding.investment.10k_50k") },
    { value: "50k_200k", label: t("onboarding.investment.50k_200k") },
    { value: "200k_plus", label: t("onboarding.investment.200k_plus") },
  ];

  // Estilo de trabalho, valores principais e idiomas saíram do cadastro (Rosber,
  // 14/09 21:08). Os rótulos seguem nos 10 JSONs porque o Dashboard traduz por
  // eles o que já está gravado (onboarding.workStyle/values/languages).

  const EDUCATION_LEVELS = [
    { value: "high_school", label: t("onboarding.education.high_school") },
    { value: "technical", label: t("onboarding.education.technical") },
    { value: "bachelor", label: t("onboarding.education.bachelor") },
    { value: "postgrad", label: t("onboarding.education.postgrad") },
    { value: "master", label: t("onboarding.education.master") },
    { value: "phd", label: t("onboarding.education.phd") },
    { value: "mba", label: t("onboarding.education.mba") },
  ];

  // "Seus valores" saiu da lista junto com o campo (21:08): a etapa de revisão
  // não pode prometer uma análise do que o cadastro não pergunta mais.
  const AI_ANALYSIS_ITEMS = [
    t("onboarding.aiAnalysis.specialty"), t("onboarding.aiAnalysis.goals"),
    t("onboarding.aiAnalysis.income"), t("onboarding.aiAnalysis.location"),
    t("onboarding.aiAnalysis.sectors"),
  ];

  // 8 etapas: "Vida & Valores" foi integrada a "O que você busca", "Quem sou"
  // saiu com a Rede Institucional (21:15), e o Termo Geral de Uso (última)
  // substituiu a antiga "Termos e Condições".
  const STEPS = [
    { id: 1, title: t("onboarding.steps.s1_title"), subtitle: t("onboarding.steps.s1_sub"), icon: "👤" },
    { id: 2, title: t("onboarding.steps.s2_title"), subtitle: t("onboarding.steps.s2_sub"), icon: "⚡" },
    { id: 3, title: t("onboarding.steps.s3_title"), subtitle: t("onboarding.steps.s3_sub"), icon: "🎯" },
    { id: 4, title: t("onboarding.steps.s4_title"), subtitle: t("onboarding.steps.s4_sub"), icon: "🌐" },
    { id: 5, title: t("onboarding.steps.s8_title"), subtitle: t("onboarding.steps.s8_sub"), icon: "✦" },
    { id: 6, title: t("onboarding.steps.s9_title"), subtitle: t("onboarding.steps.s9_sub"), icon: "◈" },
    { id: 7, title: t("onboarding.steps.s6_title"), subtitle: t("onboarding.steps.s6_sub"), icon: "🚀" },
    // Termo Geral de Uso do Dr. Ronei: "última etapa do processo de
    // cadastramento", e a única de termos. A etapa "Termos e Condições" (contrato
    // de comissão) saiu do cadastro; o tipo `contrato_comissao` e os aceites já
    // gravados continuam no servidor.
    { id: ETAPA_TERMO_GERAL, title: t("termoGeral.etapaTitulo"), subtitle: t("termoGeral.etapaSubtitulo"), icon: "📜" },
  ];

  // Termo Geral de Uso: o texto é o da versão PUBLICADA, lido quando a pessoa
  // chega à última etapa. Sem versão publicada, `document` vem null (e
  // `accepted: true`, a regra dos outros termos) — aqui isso NÃO libera: a
  // etapa mostra que o termo não está disponível e o botão final fica travado.
  const termoGeralQuery = trpc.consent.status.useQuery(
    { type: TIPO_TERMO_GERAL },
    { enabled: step === ETAPA_TERMO_GERAL, refetchOnWindowFocus: false },
  );
  const documentoTermoGeral = termoGeralQuery.data?.document ?? null;
  const aceitouTermoGeral = documentoTermoGeral !== null && form.termoGeralAceitoId === documentoTermoGeral.id;
  const aceitarTermoGeral = trpc.consent.accept.useMutation();

  const utils = trpc.useUtils();
  const concluir = () => {
    // Cadastro gravado: o rascunho não tem mais razão de existir.
    if (chaveDoRascunho) apagarRascunho(chaveDoRascunho);
    // O servidor acabou de gravar onboardingCompleted = true, mas o auth.me em
    // cache ainda diz false: sem isto o ProtectedRoute do /dashboard mandaria a
    // pessoa de volta a /onboarding (cadastro incompleto vai para lá).
    utils.auth.me.setData(undefined, atual => (atual ? { ...atual, onboardingCompleted: true } : atual));
    void utils.auth.me.invalidate();
    toast.success(t("onboarding.successMsg"));
    irAoDashboardSemAsEtapas();
  };

  // Revisão de 16/09: com uma entrada por etapa, ir ao Dashboard por cima delas
  // deixava as 8 no caminho do "voltar" (gesto comum no Android). A pessoa caía
  // numa etapa do cadastro que acabou de concluir, com o formulário pela metade,
  // e o "avançar" ficava preso nas travas das etapas. Aqui a pilha volta à
  // primeira entrada que esta página criou e o Dashboard toma o lugar dela.
  // Abaixo dessa entrada (só existe se a página recarregou no meio do cadastro)
  // quem cuida é o pré-preenchimento, que manda ao Dashboard a entrada de etapa
  // de um cadastro já concluído.
  const irAoDashboardSemAsEtapas = () => {
    let foi = false;
    const irAoDashboard = () => {
      if (foi) return;
      foi = true;
      saidaAposConcluir.current = null;
      navigate("/dashboard", { replace: true });
    };
    const etapaDaEntrada = etapaNoHistorico();
    const primeiraDestaPagina = etapaAoAbrir.current ?? 1;
    if (etapaDaEntrada === null || etapaDaEntrada <= primeiraDestaPagina) {
      irAoDashboard();
      return;
    }
    saidaAposConcluir.current = irAoDashboard;
    try {
      window.history.go(primeiraDestaPagina - etapaDaEntrada);
    } catch {
      irAoDashboard();
      return;
    }
    // Rede de segurança: se o popstate não chegar, vai assim mesmo.
    setTimeout(irAoDashboard, 1000);
  };

  // O aceite que deixa rastro no servidor (IP, user-agent, hash do texto) é o do
  // Termo Geral, registrado em handleSubmit ANTES de salvar o perfil. O cadastro
  // não registra mais o contrato_comissao: a etapa dele saiu (Rosber, 14/09 21:34).
  // A declaração de maioridade é conferida no servidor (server/maioridade.ts). Se
  // ele recusar, a mensagem dele é em português: a tela reconhece a recusa pelo
  // texto, mostra a versão traduzida e desmarca a caixa para a pessoa marcar de novo.
  const saveOnboarding = trpc.profile.completeOnboarding.useMutation({
    onSuccess: concluir,
    onError: (err: { message: string }) => {
      if (err.message === MENSAGEM_MAIORIDADE_NAO_DECLARADA) {
        setDeclarouMaioridade(false);
        toast.error(t("termoGeral.maioridadeRecusada"));
        return;
      }
      toast.error(t("onboarding.errorMsg") + " " + (err.message || ""));
    },
  });

  const set = (key: keyof FormData, value: unknown) => setForm(prev => ({ ...prev, [key]: value }));

  // O que "O que tenho" vale de fato: as opções marcadas (sem a porta "outros")
  // mais o ativo escrito à mão. É o que a contagem mostra e o que vai gravado.
  const ativosDoQueTenho = ativosParaGravar(form.whatIHave, form.whatIHaveOther);

  const toggleArray = (key: keyof FormData, value: string) => {
    const arr = (form[key] as string[]) || [];
    set(key, arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]);
  };

  // Anima e troca a etapa. O histórico é de quem chama: o "Continuar" empilha
  // uma entrada, o "voltar" do navegador já andou nele. A rolagem ao topo e o
  // foco no título ficam no useLayoutEffect de `step`, depois do conteúdo novo
  // estar na tela (relato do Rosber de 09/09 e de novo em 16/09: "quando você
  // passa para a próxima tela, ela não vai para o topo").
  const trocarEtapa = (next: number) => {
    const dir = next > etapaAlvo.current ? "forward" : "back";
    etapaAlvo.current = next;
    // Na hora, e não quando `step` mudar: ver o efeito que grava o rascunho da aba.
    if (chaveDoRascunhoRef.current) gravarRascunhoDaAba(chaveDoRascunhoRef.current, formRef.current, next);
    focarTituloNaTroca.current = true;
    setAnimDir(dir);
    setVisible(false);
    if (trocaPendente.current) clearTimeout(trocaPendente.current);
    trocaPendente.current = setTimeout(() => {
      trocaPendente.current = null;
      setStep(next);
      setVisible(true);
    }, 220);
  };

  const avancar = () => {
    // Toque duplo durante a animação não empilha a mesma etapa duas vezes.
    if (!canProceed() || trocaPendente.current) return;
    marcarEtapaNoHistorico(step + 1, "push");
    trocarEtapa(step + 1);
  };

  const voltar = () => {
    if (step <= 1) { navigate("/"); return; }
    if (trocaPendente.current || esperandoOHistorico.current) return;
    // A entrada anterior do histórico é a etapa anterior: o "Voltar" da tela
    // anda nele como o do navegador, e o "avançar" do navegador continua certo.
    if (etapaNoHistorico() === step) {
      esperandoOHistorico.current = true;
      window.history.back();
      return;
    }
    marcarEtapaNoHistorico(step - 1, "replace");
    trocarEtapa(step - 1);
  };

  // Na última etapa, o botão final só habilita com as duas caixas marcadas.
  const canProceed = () => etapaCompleta(step, form, aceitouTermoGeral && declarouMaioridade);

  // Ordem: primeiro o aceite do Termo Geral (com a versão que a tela mostrou),
  // depois o perfil. Ao contrário, o perfil ficaria salvo e o cadastro marcado
  // como concluído sem o termo — e o servidor também recusa concluir sem ele.
  const handleSubmit = () => {
    if (!canProceed() || !documentoTermoGeral) return;
    aceitarTermoGeral.mutate(
      { type: TIPO_TERMO_GERAL, documentVersionId: documentoTermoGeral.id },
      {
        onSuccess: salvarPerfil,
        onError: (erro: { data?: { code?: string } | null }) => {
          if (erro.data?.code === "CONFLICT") {
            // Publicaram versão nova enquanto ela lia: o aceite não cobre o
            // texto novo. Recarrega, desmarca e pede para ler de novo.
            set("termoGeralAceitoId", null);
            void termoGeralQuery.refetch();
            toast.error(t("termoGeral.versaoMudou"));
            return;
          }
          toast.error(t("termoGeral.erroAceite"));
        },
      },
    );
  };

  const salvarPerfil = () => {
    const selectedSpecialties = normalizePrimarySpecialties(form.primarySpecialties, form.customSpecialty);
    saveOnboarding.mutate({
      // A caixa "Declaro que tenho 18 anos ou mais.": sem `true` o servidor não
      // conclui o cadastro (cláusula 3.4 do Termo Geral).
      declaraMaioridade: declarouMaioridade,
      displayName: form.displayName, city: form.city, country: form.country,
      // Em branco, o campo não vai: `bio: ""` apagava a bio importada, e o
      // servidor (upsertUserProfile → UPDATE do Drizzle) não toca na coluna
      // quando o valor está ausente.
      // Campo intocado cujo conteúdo é o texto CORTADO do que já está salvo: não vai.
      // Ausente, o servidor não mexe na coluna e a bio longa da carga sobrevive.
      // O campo mostra a apresentação inteira, então o que volta é o que está
      // gravado (ou o que a pessoa escreveu). Sem corte, não há o que perder.
      bio: form.bio.trim() || undefined,
      primarySpecialty: selectedSpecialties[0], secondarySpecialties: selectedSpecialties.slice(1),
      experienceYears: form.experienceYears ?? undefined,
      educationLevel: form.educationLevel as "high_school" | "bachelor" | "master" | "phd" | "other" | undefined,
      // seekingTypes nunca era enviado: o campo alimenta a dimensao "objetivos",
      // que vale 30% do score de match, e ficava vazio para todo mundo.
      seekingTypes: form.seekingTypes,
      // Necessidade declarada de "Outra necessidade"; sem a opção, o servidor grava null.
      seekingOtherNeed: form.seekingTypes.includes(CHAVE_OUTRA_NECESSIDADE) ? form.seekingOtherNeed.trim() : undefined,
      shortTermGoal: form.shortTermGoal.trim() || undefined,
      longTermGoal: form.longTermGoal.trim() || undefined,
      sector: form.sector === OTHER_SECTOR_LABEL && form.customSector.trim() ? form.customSector.trim() : form.sector,
      businessInterests: form.businessInterests,
      // Vários portes num campo só, ou "any" sem nenhum (ver portesParaGravar).
      preferredCompanySize: portesParaGravar(form.preferredCompanySizes),
      incomeRange: form.incomeRange as "under_3k" | "3k_7k" | "7k_15k" | "15k_30k" | "30k_plus",
      // Sem escolha o campo não vai: o zod do servidor é optional() e recusaria "".
      investmentCapacity: (form.investmentCapacity || undefined) as "none" | "under_10k" | "10k_50k" | "50k_200k" | "200k_plus" | undefined,
      lookingForInvestment: form.lookingForInvestment,
      gender: form.gender || undefined,
      personType: form.personType || undefined,
      companySize: form.personType === "mei" ? "mei" : form.companySize || undefined,
      companyCnpj: form.personType !== "individual" ? normalizarCadastroEmpresarial(form.companyCnpj) || undefined : undefined,
      currentResources: form.currentResources || undefined,
      // workStyle, values, languages, openToRemote, availableForTravel e
      // institutionalNetwork saíram do cadastro (21:08, 21:10 e 21:15): o campo
      // não vai no envio, e o que já está gravado no banco fica onde está — o
      // servidor não escreve coluna que não recebeu.
      // Novos campos v2
      company: form.company || undefined,
      jobTitle: form.jobTitle || undefined,
      activityArea: form.activityArea || undefined,
      interestSectors: form.interestSectors.length > 0 ? form.interestSectors : undefined,
      whatIHave: ativosDoQueTenho.length > 0 ? ativosDoQueTenho : undefined,
      whatINeed: form.whatINeed.length > 0 ? form.whatINeed : undefined,
      // Cada demanda separada, sem as em branco; o servidor valida de novo.
      whatINeedDetails: form.whatINeed.length > 0 ? demandasParaGravar(form.whatINeed, form.whatINeedDetails) : undefined,
    });
  };

  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  // Revisão de 16/09: sem esperar o perfil, recarregar na etapa 5 pintava a
  // etapa 1 VAZIA e só depois pulava para a 5 — o "volta para a primeira tela e
  // desmarca" do relato, e o que ela digitasse nesse intervalo o rascunho
  // sobrescrevia. Enquanto o perfil não chega (a primeira busca; com erro, a
  // tela abre como antes), enquanto o formulário não foi restaurado com ele e
  // enquanto a etapa restaurada não é aplicada, a tela mostra só o carregando.
  const preparando = profileQuery.isLoading === true
    || (profileQuery.data != null && !prefilled.current)
    || etapaARestaurar !== null
    || indoAoDashboard;
  if (preparando) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-4">
          <Loader2 aria-hidden className="w-8 h-8 text-[#c98f70] animate-spin" />
          <p className="text-sm text-white/60">{t("onboarding.nav.carregando")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent flex">
      {/* LEFT PANEL */}
      <div className="hidden lg:flex flex-col w-80 xl:w-96 bg-[#211e1b] border-r border-white/5 p-8 relative overflow-hidden">
        {/* Os assets do CloudFront do Manus expiraram (403); o painel usa um
            gradiente local no lugar da imagem de fundo. */}
        <div className="absolute inset-0 opacity-40" style={{ background: "radial-gradient(ellipse at 20% 15%, rgba(201,143,112,0.18), transparent 55%), radial-gradient(ellipse at 85% 80%, rgba(59,130,246,0.14), transparent 50%)" }}/>
        <div className="relative z-10 mb-12">
          <BrandLogo variante="lockup" className="w-40" />
        </div>
        <div className="relative z-10 flex-1 overflow-y-auto">
          {STEPS.map((s) => {
            const isActive = s.id === step;
            const isDone = s.id < step;
            return (
              <div key={s.id} className="flex items-start gap-4 mb-5">
                <div className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 ${isDone ? "bg-[#c98f70] text-[#151312]" : isActive ? "bg-[#c98f70]/20 border-2 border-[#c98f70] text-[#c98f70]" : "bg-white/5 border border-white/15 text-white/30"}`}>
                  {isDone ? "✓" : s.icon}
                </div>
                <div className={`transition-all duration-300 ${isActive ? "opacity-100" : isDone ? "opacity-70" : "opacity-30"}`}>
                  <div className={`font-semibold text-sm ${isActive ? "text-white" : "text-white/60"}`}>{s.title}</div>
                  <div className="text-xs text-white/40">{s.subtitle}</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="relative z-10 mt-8 flex justify-center">
          <BrainCircuit aria-hidden className="w-24 h-24 text-[#c98f70] opacity-60"
            style={{ filter: "drop-shadow(0 0 20px rgba(201,143,112,0.3))", animation: "pulse-glow 3s ease-in-out infinite" }}/>
        </div>
        <p className="relative z-10 text-center text-xs text-white/30 mt-4">
          {t("onboarding.subtitle")}
        </p>
      </div>

      {/* RIGHT PANEL */}
      <div className="flex-1 flex flex-col">
        <div className="h-1 bg-white/5">
          <div className="h-full bg-gradient-to-r from-[#c98f70] to-[#efcba8] transition-all duration-500 ease-out" style={{ width: `${progress}%` }}/>
        </div>
        <div className="lg:hidden flex items-center justify-between px-6 py-4 border-b border-white/5">
          <BrandMark />
          <span className="text-sm text-white/40">{step} / {STEPS.length}</span>
        </div>

        <div ref={painelRef} className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-6 py-10"
            style={{
              opacity: visible ? 1 : 0,
              transform: visible ? "translateX(0)" : animDir === "forward" ? "translateX(30px)" : "translateX(-30px)",
              transition: "opacity 0.22s ease, transform 0.22s cubic-bezier(0.23,1,0.32,1)",
            }}>

            <div className="mb-8">
              <div className="text-4xl mb-3">{STEPS[step - 1].icon}</div>
              {/* tabIndex -1: recebe o foco ao trocar de etapa (ver o useLayoutEffect de `step`). */}
              <h1 ref={tituloRef} tabIndex={-1} className="text-3xl font-black text-white outline-none">{STEPS[step - 1].title}</h1>
              <p className="text-white/50 mt-1">{STEPS[step - 1].subtitle}</p>
            </div>

            {/* STEP 1 — Dados pessoais */}
            {step === 1 && (
              <div className="flex flex-col gap-5">
                {(() => {
                  // "Sua idade" saiu (Rosber, 14/09 20:31). O servidor ainda aceita
                  // `age` opcional, e o dado de quem já informou continua no banco.
                  return <>
                    <div>
                      <TextareaInput label={t("onboarding.fields.bio")} value={form.bio} onChange={v => set("bio", v)}
                        placeholder={t("onboarding.fields.bioPlaceholder")} hint={t("onboarding.fields.bioHint")}
                        limite={LIMITE_DA_BIO_GRAVADA} assistente/>
                    </div>
                    <div>
                      {/* País → estado → cidade em cascata (decisão de 26/11): o
                          país primeiro, o estado quando o país tem, e a cidade
                          daquele estado. Ver PaisEstadoCidade. */}
                      <PaisEstadoCidade pais={form.country} cidade={form.city}
                        onChange={local => setForm(prev => ({ ...prev, country: local.pais, city: local.cidade }))}
                        rotuloDoPais={t("onboarding.fields.country")} rotuloDaCidade={t("onboarding.fields.city")}
                        placeholderDaCidade={t("onboarding.fields.cityPlaceholder")}/>
                    </div>
                    <div>
                      <SelectInput label={t("profile.gender.label")} value={form.gender} onChange={v => set("gender", v as FormData["gender"])}
                        options={sortOptionsAlphabetically([
                          { value: "male", label: t("profile.gender.male") },
                          { value: "female", label: t("profile.gender.female") },
                          { value: "prefer_not_to_say", label: t("profile.gender.preferNotToSay") },
                        ], i18n.language)} placeholder={t("profile.gender.placeholder")}/>
                    </div>
                    <div>
                      <TextInput label={t("onboarding.fields.displayName")} value={form.displayName} onChange={v => set("displayName", v)}
                        placeholder={t("onboarding.fields.displayNamePlaceholder")} hint={t("onboarding.fields.displayNameHint")}/>
                    </div>
                  </>;
                })()}
              </div>
            )}

            {/* STEP 2 — Especialidade */}
            {step === 2 && (
              <div className="flex flex-col gap-6">
                <div >
                  <label className="block text-sm font-medium text-white/70 mb-3">
                    {t("onboarding.fields.primarySpecialty")} <span className="text-white/30 font-normal">{t("onboarding.fields.specialtySelectionCount", { count: form.primarySpecialties.length + (form.customSpecialty.trim() ? 1 : 0) })}</span>
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {sortOptionsAlphabetically(SPECIALTIES, i18n.language).map(s => (
                      <CardOption key={s.key} selected={form.primarySpecialties.includes(s.key)}
                        onClick={() => {
                          if (form.primarySpecialties.includes(s.key) || form.primarySpecialties.length < 5) {
                            set("primarySpecialties", togglePrimarySpecialty(form.primarySpecialties, s.key));
                          } else {
                            toast.error(t("onboarding.maxSpecialties"));
                          }
                        }}
                        icon={s.icon} label={s.label}/>
                    ))}
                  </div>
                </div>
                <div >
                  <TextInput label={t("onboarding.fields.customSpecialty")} value={form.customSpecialty}
                    onChange={value => set("customSpecialty", value)}
                    placeholder={t("onboarding.fields.customSpecialtyPlaceholder")}
                    hint={t("onboarding.fields.customSpecialtyHint")}/>
                </div>
                <div className="rounded-2xl border border-[#c98f70]/25 bg-[#c98f70]/5 p-5 space-y-4">
                  <div>
                    <h2 className="text-white font-semibold text-base">{t("profile.business.personType")}</h2>
                    {/* O texto de apoio fica SÓ aqui: repetido como dica do campo de
                        Número de Cadastro Empresarial, aparecia duas vezes no mesmo
                        bloco (reteste v4, item 10). Como subtítulo ele é visível antes
                        de escolher o tipo, que é quando ajuda. */}
                    <p className="text-xs text-white/45 mt-1">{t("profile.business.registrationNumberHint")}</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {sortOptionsAlphabetically([
                      { value: "individual", label: t("profile.business.individual"), icon: "👤" },
                      { value: "legal_entity", label: t("profile.business.legalEntity"), icon: "🏢" },
                      { value: "mei", label: t("profile.business.mei"), icon: "🌱" },
                      { value: "nonprofit", label: t("profile.business.nonprofit"), icon: "🤝" },
                    ], i18n.language).map(option => (
                      <CardOption key={option.value} selected={form.personType === option.value}
                        onClick={() => {
                          set("personType", option.value);
                          set("companySize", option.value === "mei" ? "mei" : "");
                          if (option.value === "individual") set("companyCnpj", "");
                        }} icon={option.icon} label={option.label}/>
                    ))}
                  </div>
                  {exigeCadastroEmpresarial(form.personType) && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
                      <SelectInput label={t("profile.business.companySize")} value={form.companySize}
                        onChange={value => set("companySize", value as FormData["companySize"])}
                        options={form.personType === "mei"
                          ? [{ value: "mei", label: t("profile.business.sizeMei") }]
                          : sortOptionsAlphabetically([
                              { value: "micro", label: t("profile.business.sizeMicro") },
                              { value: "small", label: t("profile.business.sizeSmall") },
                              { value: "medium", label: t("profile.business.sizeMedium") },
                              { value: "large", label: t("profile.business.sizeLarge") },
                            ], i18n.language)} placeholder={t("onboarding.fields.selectPlaceholder")}/>
                      <TextInput label={t("profile.business.registrationNumber")} required value={form.companyCnpj}
                        onChange={(value, compondo) => set("companyCnpj", compondo ? value : normalizarCadastroEmpresarial(value))}
                        placeholder={t("profile.business.registrationNumberPlaceholder")}/>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  {/* Cargo e empresa gravam em jobTitle/company, os mesmos campos da
                      tela de Perfil (consolidação das colunas duplicadas). */}
                  <TextInput label={t("onboarding.fields.currentRole")} value={form.jobTitle} onChange={v => set("jobTitle", v)}
                    placeholder={t("onboarding.fields.currentRolePlaceholder")}/>
                  <TextInput label={t("onboarding.fields.currentCompany")} value={form.company} onChange={v => set("company", v)}
                    placeholder={t("onboarding.fields.currentCompanyPlaceholder")}/>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <TextInput label={t("onboarding.fields.experienceYears")} value={form.experienceYears ?? ""} type="number" min={0} max={60}
                    onChange={v => set("experienceYears", v ? Math.max(0, parseInt(v)) : null)} placeholder={t("onboarding.fields.experienceYearsPlaceholder")}/>
                  <SelectInput label={t("onboarding.fields.educationLevel")} value={form.educationLevel}
                    onChange={v => set("educationLevel", v)} options={EDUCATION_LEVELS}
                    placeholder={t("onboarding.fields.selectPlaceholder")}/>
                </div>
              </div>
            )}

            {/* STEP 3 — O que busca */}
            {step === 3 && (
              <div className="flex flex-col gap-6">
                <div >
                  <label className="block text-sm font-medium text-white/70 mb-3">
                    {t("onboarding.fields.seekingTypes")} <span className="text-white/30 font-normal">{t("onboarding.fields.selectAll")}</span>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {SEEKING_TYPES.map(s => (
                      <CardOption key={s.key} selected={form.seekingTypes.includes(s.key)}
                        onClick={() => toggleArray("seekingTypes", s.key)} icon={s.icon} label={s.label} desc={s.desc}/>
                    ))}
                  </div>
                  {form.seekingTypes.includes(CHAVE_OUTRA_NECESSIDADE) && (
                    <div className="mt-3">
                      <TextareaInput label={t("oQueBusca.outraNecessidadeRotulo")} required
                        value={form.seekingOtherNeed} onChange={v => set("seekingOtherNeed", v)}
                        placeholder={t("oQueBusca.outraNecessidadePlaceholder")}
                        hint={form.seekingOtherNeed.trim().length < 3 ? t("oQueBusca.outraNecessidadeObrigatoria") : undefined}
                        limite={LIMITE_OUTRA_NECESSIDADE} assistente/>
                    </div>
                  )}
                  <button type="button" onClick={() => toggleArray("seekingTypes", CHAVE_QUERO_MENTORAR)}
                    className={"mt-3 w-full p-4 rounded-xl border text-left transition-all duration-200 " + (form.seekingTypes.includes(CHAVE_QUERO_MENTORAR) ? "bg-[#c98f70]/15 border-[#c98f70]" : "bg-white/5 border-white/10")}>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">🤲</span>
                      <div>
                        <div className={"font-semibold text-sm " + (form.seekingTypes.includes(CHAVE_QUERO_MENTORAR) ? "text-[#c98f70]" : "text-white")}>{t("onboarding.seeking.be_mentor")}</div>
                        <div className="text-xs text-white/40">{t("onboarding.seeking.be_mentor_desc")}</div>
                      </div>
                    </div>
                  </button>
                </div>
                <TextareaInput label={t("onboarding.fields.shortTermGoal")} value={form.shortTermGoal} onChange={v => set("shortTermGoal", v)}
                  placeholder={t("onboarding.fields.shortTermGoalPlaceholder")} hint={t("onboarding.fields.shortTermGoalHint")}
                  limite={LIMITE_META} assistente/>
                <TextareaInput label={t("onboarding.fields.longTermGoal")} value={form.longTermGoal} onChange={v => set("longTermGoal", v)}
                  placeholder={t("onboarding.fields.longTermGoalPlaceholder")} hint={t("onboarding.fields.longTermGoalHint")}
                  limite={LIMITE_META} assistente/>
                <div>
                  <TextareaInput label={t("onboarding.fields.currentResources")} value={form.currentResources} onChange={v => set("currentResources", v)}
                    placeholder={t("onboarding.fields.currentResourcesPlaceholder")} hint={t("onboarding.fields.currentResourcesHint")}
                    limite={LIMITE_META} assistente/>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 flex flex-col gap-6">
                  <div>
                    <h2 className="text-white font-semibold">{t("onboarding.steps.s5_title")}</h2>
                    <p className="text-xs text-white/40 mt-1">{t("onboarding.steps.s5_sub")}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-white/70 mb-3">{t("onboarding.fields.incomeRange")}</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {INCOME_RANGES.map(r => (
                        <CardOption key={r.value} selected={form.incomeRange === r.value}
                          onClick={() => set("incomeRange", r.value)} icon={r.icon} label={r.label}/>
                      ))}
                    </div>
                    <p className="text-xs text-white/25 mt-2">🔒 {t("onboarding.fields.incomePrivacy")}</p>
                  </div>
                  <SelectInput label={t("onboarding.fields.investmentCapacity")} value={form.investmentCapacity}
                    onChange={v => set("investmentCapacity", v)} options={INVESTMENT_CAPACITIES}
                    placeholder={t("onboarding.fields.selectPlaceholder")}/>
                  <button type="button" onClick={() => set("lookingForInvestment", !form.lookingForInvestment)}
                    className={`w-full p-4 rounded-xl border text-left transition-all duration-200 ${form.lookingForInvestment ? "bg-[#c98f70]/15 border-[#c98f70]" : "bg-white/5 border-white/10"}`}>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">💰</span>
                      <div>
                        <div className={`font-semibold text-sm ${form.lookingForInvestment ? "text-[#c98f70]" : "text-white"}`}>{t("onboarding.fields.lookingForInvestment")}</div>
                        <div className="text-xs text-white/40">{t("onboarding.fields.lookingForInvestmentDesc")}</div>
                      </div>
                    </div>
                  </button>
                  {/* Estilo de trabalho preferido, valores principais e idiomas
                      ficavam aqui e saíram do cadastro (Rosber, 14/09 21:08). */}
                </div>
              </div>
            )}

            {/* STEP 4 — Setor e mercado */}
            {step === 4 && (
              <div className="flex flex-col gap-6">
                <div>
                  {/* Opção "outro" sempre no final, não alfabética: consistência com demais dropdowns (validação de testes) */}
                  <SelectInput label={t("onboarding.fields.sector")} value={form.sector} onChange={v => set("sector", v)}
                    options={[...sortOptionsAlphabetically(SECTORS.map(s => ({ value: s.label, label: s.label })), i18n.language), { value: OTHER_SECTOR_LABEL, label: t("onboarding.sectors.other") }]} placeholder={t("onboarding.fields.selectPlaceholder")}/>
                  {form.sector === OTHER_SECTOR_LABEL && (
                    <div className="mt-3">
                      <TextInput label={t("onboarding.fields.customSector")} value={form.customSector}
                        onChange={v => set("customSector", v)}
                        placeholder={t("onboarding.fields.customSpecialtyPlaceholder")}/>
                    </div>
                  )}
                </div>
                <div >
                  <label className="block text-sm font-medium text-white/70 mb-3">
                    {/* O teto de 4 saiu (Rosber, 14/09 21:09: "retirar essa
                        limitação de até quatro, Setores de interesse"). */}
                    {t("onboarding.fields.businessInterests")} <span className="text-white/30 font-normal">{t("onboarding.misc.selectAllApply")}</span>
                  </label>
                  {/* Mesma lista do campo "Setor" acima, inclusive o setor da
                      própria usuária: ela era descartada por `s.label !== form.sector`
                      e quem é de tecnologia não conseguia declarar interesse no
                      próprio setor (reteste v4, item 7) — que é justamente onde
                      mais se procura parceria.
                      Grava a CHAVE ("construcao"), não o rótulo traduzido: o valor
                      precisa ser o mesmo em qualquer idioma, senão duas usuárias
                      com o mesmo interesse em línguas diferentes nunca se cruzam.
                      A tela mostra o rótulo, e `interesseEhDoSetor` mantém marcado
                      o que foi gravado com o rótulo antes desta correção. */}
                  <div className="flex flex-wrap gap-2">
                    {sortOptionsAlphabetically(SECTORS, i18n.language).map(s => {
                      const setor = { chave: s.key, rotulo: s.label };
                      const marcado = form.businessInterests.some(gravado => interesseEhDoSetor(gravado, setor));
                      return (
                        <TagOption key={s.key} selected={marcado} label={s.label}
                          onClick={() => set("businessInterests", marcado
                            ? form.businessInterests.filter(gravado => !interesseEhDoSetor(gravado, setor))
                            : [...form.businessInterests, s.key])}/>
                      );
                    })}
                  </div>
                </div>
                <div >
                  <label className="block text-sm font-medium text-white/70 mb-3">
                    {t("onboarding.fields.preferredCompanySize")} <span className="text-white/30 font-normal">{t("onboarding.misc.selectAllApply")}</span>
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {COMPANY_SIZES.map(c => (
                      <CardOption key={c.value} selected={form.preferredCompanySizes.includes(c.value)}
                        onClick={() => toggleArray("preferredCompanySizes", c.value)} icon={c.icon} label={c.label}/>
                    ))}
                    {/* "Qualquer tamanho": marcado quando nenhum porte específico
                        está, e clicar nele limpa a seleção. */}
                    <CardOption selected={form.preferredCompanySizes.length === 0}
                      onClick={() => set("preferredCompanySizes", [])}
                      icon="🌍" label={t("onboarding.companySize.any")}/>
                  </div>
                </div>
                {/* "Aberto a remoto" e "Disponível para viagens" ficavam aqui e
                    saíram do cadastro (Rosber, 14/09 21:10: "está mais voltado
                    para busca de empregos"). */}
              </div>
            )}

            {/* A etapa "Quem sou" existia só para a Rede Institucional e saiu
                inteira com o campo (Rosber, 14/09 21:15). O que estava gravado
                em institutionalNetwork continua no banco e no Perfil. */}

            {/* STEP 5 — O QUE TENHO */}
            {step === 5 && (
              <div className="space-y-5">
                <p className="text-white/40 text-sm -mt-4 mb-2">
                  {t("onboarding.misc.step7_hint")} <span className="text-white/25">{t("onboarding.misc.optional")}</span>
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {sortOptionsAlphabetically(WHAT_I_HAVE_OPTIONS.map(o => ({ ...o, label: t(o.chave) })), i18n.language).map(opt => (
                    <TagButton
                      key={opt.id}
                      icon={opt.icon}
                      label={opt.label}
                      selected={form.whatIHave.includes(opt.id)}
                      onClick={() => toggleArray("whatIHave", opt.id)}
                    />
                  ))}
                  {/* "Outros" fica sempre no fim, fora da ordem alfabética: é a
                      porta do texto livre, não mais um ativo da lista. */}
                  <TagButton icon="✍️" label={t("onboarding.misc.outrosAtivo")}
                    selected={form.whatIHave.includes(CHAVE_OUTRO_ATIVO)}
                    onClick={() => toggleArray("whatIHave", CHAVE_OUTRO_ATIVO)}/>
                </div>
                {form.whatIHave.includes(CHAVE_OUTRO_ATIVO) && (
                  <TextareaInput label={t("onboarding.misc.outrosAtivoRotulo")} required
                    value={form.whatIHaveOther} onChange={v => set("whatIHaveOther", v)}
                    placeholder={t("onboarding.misc.outrosAtivoPlaceholder")}
                    hint={form.whatIHaveOther.trim().length < MINIMO_DO_OUTRO_ATIVO ? t("onboarding.misc.outrosAtivoObrigatorio") : undefined}
                    limite={LIMITE_DO_OUTRO_ATIVO} assistente/>
                )}
                {ativosDoQueTenho.length > 0 && (
                  <div className="mt-4 p-3 rounded-xl bg-[#c98f70]/8 border border-[#c98f70]/20">
                    <p className="text-xs text-[#c98f70]/70 font-medium">
                      ✦ {ativosDoQueTenho.length} {ativosDoQueTenho.length === 1 ? t("onboarding.misc.assetSelected") : t("onboarding.misc.assetsSelected")}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* STEP 6 — O QUE PRECISO */}
            {step === 6 && (
              <div className="space-y-5">
                {/* Texto explicativo e frase discreta do Rosber (14/09 21:24; "conexões", não "Match", 21:34). */}
                <div className="-mt-4 mb-2">
                  <p className="text-white/40 text-sm">{t("oQuePreciso.textoExplicativo")}</p>
                  <p className="text-white/25 text-xs mt-1">{t("oQuePreciso.fraseDiscreta")}</p>
                </div>
                {/* Cartões na ordem da mensagem (não alfabética), contador e segunda camada no componente. */}
                <EditorDoQuePreciso
                  valor={{ categorias: form.whatINeed, demandas: form.whatINeedDetails }}
                  onChange={({ categorias, demandas }) => setForm(prev => ({ ...prev, whatINeed: categorias, whatINeedDetails: demandas }))}
                />
              </div>
            )}

            {/* STEP 7 — Revisão final */}
            {step === 7 && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: t("onboarding.review.name"), value: form.displayName, icon: "👤" },
                    { label: t("onboarding.review.location"), value: [form.city, rotuloDoPais(form.country, i18n.language, t("onboarding.countries.other"))].filter(Boolean).join(", "), icon: "📍" },
                    ...(form.gender ? [{ label: t("profile.gender.label"), value: t(`profile.gender.${form.gender === "prefer_not_to_say" ? "preferNotToSay" : form.gender}`), icon: "⚥" }] : []),
                    { label: t("onboarding.review.specialty"), value: normalizePrimarySpecialties(form.primarySpecialties, form.customSpecialty).map(k => t("onboarding.specialties." + k, { defaultValue: k })).join(", "), icon: "⚡" },
                    { label: t("onboarding.misc.company"), value: form.company || "-", icon: "🏢" },
                    { label: t("onboarding.review.seeking"), value: form.seekingTypes.slice(0, 2).map(k => rotuloDaBusca(t, k) ?? k).join(", ") + (form.seekingTypes.length > 2 ? "..." : ""), icon: "🎯" },
                    ...(form.currentResources ? [{ label: t("onboarding.fields.currentResources"), value: form.currentResources, icon: "✦" }] : []),
                    { label: t("onboarding.review.sector"), value: form.sector, icon: "🌐" },
                    ...(form.personType ? [{ label: t("profile.business.personType"), value: t(`profile.business.${form.personType === "legal_entity" ? "legalEntity" : form.personType}`), icon: "🏢" }] : []),
                  ].map((item, i) => (
                    <div key={i} className="p-4 rounded-xl bg-white/5 border border-white/10">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-lg">{item.icon}</span>
                        <span className="text-xs text-white/40">{item.label}</span>
                      </div>
                      <div className="text-sm font-medium text-white truncate">{item.value || "-"}</div>
                    </div>
                  ))}
                </div>

                {/* Resumo O que tenho / O que preciso. O "outros" marcado não
                    conta como ativo; o texto que a pessoa escreveu conta. */}
                {(ativosDoQueTenho.length > 0 || form.whatINeed.length > 0) && (
                  <div className="grid grid-cols-2 gap-3">
                    {ativosDoQueTenho.length > 0 && (
                      <div className="p-3 rounded-xl bg-[#c98f70]/8 border border-[#c98f70]/20">
                        <p className="text-xs text-[#c98f70]/70 font-medium mb-1">✦ {t("onboarding.steps.s8_title")}</p>
                        <p className="text-xs text-white/50">{ativosDoQueTenho.length} {ativosDoQueTenho.length === 1 ? t("onboarding.misc.asset") : t("onboarding.misc.assets")} {ativosDoQueTenho.length === 1 ? t("onboarding.misc.selected") : t("onboarding.misc.selectedPlural")}</p>
                      </div>
                    )}
                    {form.whatINeed.length > 0 && (
                      <div className="p-3 rounded-xl bg-blue-500/8 border border-blue-500/20">
                        <p className="text-xs text-blue-400/70 font-medium mb-1">◈ {t("onboarding.steps.s9_title")}</p>
                        <p className="text-xs text-white/50">{form.whatINeed.length} {form.whatINeed.length === 1 ? t("onboarding.misc.demand") : t("onboarding.misc.demands")} {form.whatINeed.length === 1 ? t("onboarding.misc.selectedF") : t("onboarding.misc.selectedFPlural")}</p>
                      </div>
                    )}
                  </div>
                )}

                <div className="p-5 rounded-xl bg-[#c98f70]/10 border border-[#c98f70]/30">
                  <div className="flex items-center gap-3 mb-3">
                    <BrainCircuit aria-hidden className="w-8 h-8 text-[#c98f70]"/>
                    <span className="font-bold text-[#c98f70] text-sm">{t("onboarding.aiAnalysis.title")}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-white/60">
                    {AI_ANALYSIS_ITEMS.map(item => (
                      <div key={item} className="flex items-center gap-2"><span className="text-[#c98f70]">✓</span> {item}</div>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-white/30 text-center">🔒 {t("onboarding.dataPrivacy")}</p>
              </div>
            )}

            {/* ETAPA 9 — Termo Geral de Uso (última e única etapa de termos) */}
            {step === ETAPA_TERMO_GERAL && (
              <EtapaTermoGeralDeUso
                carregando={termoGeralQuery.isLoading}
                erro={termoGeralQuery.isError}
                documento={documentoTermoGeral}
                aceito={aceitouTermoGeral}
                onAceitoChange={aceito => set("termoGeralAceitoId", aceito && documentoTermoGeral ? documentoTermoGeral.id : null)}
                maioridadeDeclarada={declarouMaioridade}
                onMaioridadeChange={setDeclarouMaioridade}
                onTentarDeNovo={() => { void termoGeralQuery.refetch(); }}
              />
            )}

            {/* Navigation */}
            <div className="flex items-center justify-between mt-10 pt-6 border-t border-white/10">
              <button type="button" onClick={voltar}
                className="flex items-center gap-2 text-white/50 hover:text-white text-sm transition-colors duration-200">
                ← {step > 1 ? t("onboarding.nav.back") : t("onboarding.nav.home")}
              </button>
              {/* Com 9 etapas as bolinhas empurravam o botão para fora da tela no
                  celular; lá o topo já mostra "etapa / total". */}
              <div className="hidden sm:flex items-center gap-2">
                {STEPS.map((_, i) => (
                  <div key={i} className={`rounded-full transition-all duration-300 ${i + 1 === step ? "w-6 h-2 bg-[#c98f70]" : i + 1 < step ? "w-2 h-2 bg-[#c98f70]/60" : "w-2 h-2 bg-white/15"}`}/>
                ))}
              </div>
              {step < STEPS.length ? (
                <button type="button" onClick={avancar} disabled={!canProceed()}
                  className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm transition-all duration-200 active:scale-95 ${canProceed() ? "bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] shadow-lg shadow-[#c98f70]/20" : "bg-white/10 text-white/30 cursor-not-allowed"}`}>
                  {t("onboarding.nav.continue")} →
                </button>
              ) : (
                <button type="button" onClick={handleSubmit}
                  disabled={saveOnboarding.isPending || aceitarTermoGeral.isPending || !canProceed()}
                  className="flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-sm bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95 shadow-lg shadow-[#c98f70]/20 disabled:opacity-60 disabled:cursor-not-allowed">
                  {saveOnboarding.isPending || aceitarTermoGeral.isPending
                    ? <><span className="animate-spin">⏳</span> {t("onboarding.nav.analyzing")}</>
                    : <>🚀 {t("onboarding.nav.findMatches")}</>}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes pulse-glow {
          0%, 100% { filter: drop-shadow(0 0 20px rgba(201,143,112,0.3)); }
          50% { filter: drop-shadow(0 0 40px rgba(201,143,112,0.6)); }
        }
      `}</style>
    </div>
  );
}
