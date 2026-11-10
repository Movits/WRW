import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { opportunitySectorLabel } from "@/lib/opportunity-sectors";
import { rotuloDaBusca, rotuloDeInteresse } from "@/lib/interesses";
import { ehChaveDeSetor, rotuloDoSetor } from "@shared/setores";
import { ROTA_GRAVAR } from "@shared/rotas";
import { getLoginUrl } from "@/const";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { CODIGOS, LANGUAGES } from "@/i18n";
import type { i18n as I18n } from "i18next";
import { NotificationBell } from "@/components/NotificationBell";
import { SmartMatchConsent } from "@/components/SmartMatchConsent";
import { GlobalMenu } from "@/components/AppHeader";
import { BrandMark } from "@/components/BrandLogo";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Briefcase, ShieldCheck, Users, User, MapPin, Mic, Brain, Sparkles, Crown,
  Menu as MenuIcon, ChevronDown, LogOut, Network,
} from "lucide-react";
import { MOSTRAR_NUMEROS_DA_REDE } from "@/lib/numeros-da-rede";

// ─── Faixas de compatibilidade ───────────────────────────────────────────────
// Item 12 do reteste v4 (Gabriel): os anéis dos cartões pintavam em TRÊS cores
// (80+ verde, 60+ marrom, o resto azul) e o gráfico de distribuição da MESMA
// tela em CINCO — 65% saía marrom no anel e azul na barra 60–80, e a leitura
// "que cor é boa?" mudava de um componente para o outro. Daqui em diante há uma
// função só, pela mesma faixa de 20 em 20 com que o `statsQuery` monta o
// gráfico (`Math.min(4, Math.floor(score / 20))`).
export const CORES_DAS_FAIXAS = ["#ef4444", "#f97316", "#c98f70", "#3b82f6", "#10b981"] as const;
const ROTULOS_DAS_FAIXAS = [
  "dashboard.scoreBandVeryLow", "dashboard.scoreBandLow", "dashboard.scoreBandMedium",
  "dashboard.scoreBandHigh", "dashboard.scoreBandVeryHigh",
] as const;

export function faixaDeCompatibilidade(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(4, Math.max(0, Math.floor(score / 20)));
}

export function corDaFaixaDeCompatibilidade(score: number): string {
  return CORES_DAS_FAIXAS[faixaDeCompatibilidade(score)];
}

// Acessibilidade: a cor não pode ser o único indicador da faixa — quem não
// distingue o marrom do azul (ou lê num print em cinza) precisa do rótulo.
export function rotuloDaFaixaDeCompatibilidade(t: (k: string) => string, score: number): string {
  return t(ROTULOS_DAS_FAIXAS[faixaDeCompatibilidade(score)]);
}

// ─── Animated Score Ring ─────────────────────────────────────────────────────
function ScoreRing({ score, size = 64, animate = false }: { score: number; size?: number; animate?: boolean }) {
  const { t } = useTranslation();
  const [displayed, setDisplayed] = useState(animate ? 0 : score);
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (displayed / 100) * circ;
  const color = corDaFaixaDeCompatibilidade(displayed);
  // A cor do rótulo segue a nota FINAL: o anel varre as faixas enquanto anima e
  // o texto ficaria piscando de vermelho a verde.
  const corDaFaixa = corDaFaixaDeCompatibilidade(score);

  useEffect(() => {
    if (!animate) return;
    let start: number | null = null;
    const duration = 1200;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplayed(Math.round(ease * score));
      if (p < 1) requestAnimationFrame(step);
    };
    const raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [score, animate]);

  return (
    <div className="flex flex-shrink-0 flex-col items-center gap-1">
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={5}
          strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.05s linear, stroke 0.3s ease" }} />
        <text x={size/2} y={size/2} textAnchor="middle" dominantBaseline="central"
          style={{ transform: `rotate(90deg)`, transformOrigin: `${size/2}px ${size/2}px`, fill: color, fontSize: size * 0.22, fontWeight: "bold" }}>
          {displayed}%
        </text>
      </svg>
      <span className="text-[10px] font-semibold leading-none" style={{ color: corDaFaixa }}>
        {rotuloDaFaixaDeCompatibilidade(t, score)}
      </span>
    </div>
  );
}

// ─── Animated Score Bar ───────────────────────────────────────────────────────
function ScoreBar({ label, value, color = "#c98f70", delay = 0 }: { label: string; value: number; color?: string; delay?: number }) {
  const [width, setWidth] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setWidth(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return (
    <div ref={ref}>
      <div className="flex justify-between text-xs mb-1.5">
        <span className="text-white/50">{label}</span>
        <span style={{ color }} className="font-bold">{value}%</span>
      </div>
      <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${width}%`, background: color, transition: `width 0.9s cubic-bezier(0.23,1,0.32,1)` }} />
      </div>
    </div>
  );
}

// ─── Animated Counter ─────────────────────────────────────────────────────────
function AnimatedNumber({ value, suffix = "" }: { value: number | string; suffix?: string }) {
  const num = typeof value === "number" ? value : parseInt(String(value)) || 0;
  const [displayed, setDisplayed] = useState(0);
  const isString = typeof value === "string" && isNaN(parseInt(value));

  useEffect(() => {
    if (isString) return;
    let start: number | null = null;
    const duration = 800;
    const step = (ts: number) => {
      if (!start) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplayed(Math.round(ease * num));
      if (p < 1) requestAnimationFrame(step);
    };
    const raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [num, isString]);

  if (isString) return <>{value}</>;
  return <>{displayed}{suffix}</>;
}

// ─── Distribution Chart ───────────────────────────────────────────────────────
function DistributionChart({ data }: { data: number[] }) {
  const [animated, setAnimated] = useState(false);
  const max = Math.max(...data, 1);
  const labels = ["0–20", "20–40", "40–60", "60–80", "80+"];
  // A MESMA paleta dos anéis de compatibilidade (item 12): a barra e o anel de
  // uma nota de 65% não podem sair de cores diferentes na mesma tela.
  const colors = CORES_DAS_FAIXAS;

  useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 200);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex items-end gap-3 h-24">
      {data.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
          <div className="text-xs font-bold" style={{ color: colors[i], opacity: v > 0 ? 1 : 0.3 }}>{v}</div>
          <div className="w-full rounded-t-lg relative overflow-hidden" style={{
            height: animated ? `${(v / max) * 72}px` : "0px",
            background: colors[i],
            opacity: v === 0 ? 0.15 : 1,
            transition: `height 0.7s cubic-bezier(0.23,1,0.32,1) ${i * 0.08}s`,
            minHeight: v > 0 ? "4px" : "0",
          }}>
            {v > 0 && (
              <div className="absolute inset-0 shimmer-bg opacity-30" />
            )}
          </div>
          <div className="text-xs text-white/30">{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Match Card ───────────────────────────────────────────────────────────────
// Perfis criados a partir de 31/08 guardam a CHAVE da opção ("engineering") em
// vez do rótulo traduzido, para o match funcionar entre idiomas. A exibição
// traduz de volta; texto livre e dados antigos passam intactos. O estilo de
// trabalho sempre foi gravado pela chave ("remote").
const OPTION_NAMESPACES = ["specialties", "sectors", "seeking", "values", "languages", "workStyle"];
function optionLabel(t: (k: string, o?: Record<string, unknown>) => string, valor?: string | null): string {
  if (!valor) return "";
  for (const ns of OPTION_NAMESPACES) {
    const traduzido = t(`onboarding.${ns}.${valor}`, { defaultValue: "" });
    if (traduzido) return traduzido;
  }
  return valor;
}

// O onboarding grava o setor pelo RÓTULO do idioma em que foi preenchido
// ("Tecnologia & Software", "Technology & Software"), não pela chave, e a
// tela mostrava esse texto cru fosse qual fosse o idioma escolhido depois.
// Procura o rótulo nos setores dos 10 idiomas, acha a chave ("technology") e
// traduz de volta; setor personalizado (texto livre) não bate com nenhum e
// passa intacto. A raiz (gravar a chave no Onboarding) fica para outra PR.
function sectorLabel(t: (k: string, o?: Record<string, unknown>) => string, i18n: I18n, valor?: string | null): string {
  if (!valor) return "";
  for (const codigo of CODIGOS) {
    const setores: Record<string, string> | undefined = i18n.getResourceBundle(codigo, "translation")?.onboarding?.sectors;
    const chave = setores && Object.keys(setores).find(k => setores[k] === valor);
    // Traduz pelo namespace de SETORES: optionLabel procura specialties antes,
    // e "health", "education" e "retail" existem nos dois, com rótulos diferentes
    // (o Dashboard mostrava a especialidade no lugar do setor).
    if (chave) return t(`onboarding.sectors.${chave}`, { defaultValue: chave });
  }
  // Perfis novos já gravam a chave do setor: mesma regra.
  const direto = t(`onboarding.sectors.${valor}`, { defaultValue: "" });
  if (direto) return direto;
  return optionLabel(t, valor);
}

// ─── Lista de conexões: normalização e agrupamento (item 13 do reteste v4) ───
// Setor e cidade são texto livre digitado no onboarding, e a lista mostrava o
// que estava gravado: "tecnologia", "SÃO PAULO - sp", "belo horizonte/mg".
// A caixa só é refeita quando o valor veio TODO em minúsculas ou TODO em
// maiúsculas — "TI e Telecom" e "Tecnologia & Software" já vêm certos e não
// podem virar "Ti E Telecom".
const PALAVRAS_MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e", "del", "di", "du", "la", "le", "van", "von", "y"]);

// Caixa alta e caixa baixa são conceito da escrita LATINA. O chinês e o japonês
// não têm caixa, então "可持续发展与ESG" é igual a si mesmo em toLocaleUpperCase:
// a regra abaixo o tomava por "veio todo em maiúsculas", refazia a caixa e
// achatava a sigla latina de dentro ("可持续发展与esg").
// A faixa aceita é Latim básico, Latin-1, Latim estendido A/B e adicional, mais
// pontuação geral e símbolos de moeda. QUALQUER caractere fora dela (ideograma,
// kana, cirílico, grego, árabe, hangul, emoji) e o texto volta como foi
// digitado. Faixas de código, e não `\p{Script=Latin}`: o tsconfig do projeto
// não fixa `target`, e o TypeScript recusa a flag `u` em ES5.
const FORA_DO_ALFABETO_LATINO = /[^\u0000-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20BF]/;

export function normalizarCaixa(valor?: string | null): string {
  const texto = (valor ?? "").trim().replace(/\s+/g, " ");
  if (!texto) return "";
  if (FORA_DO_ALFABETO_LATINO.test(texto)) return texto;
  const caixaUniforme = texto === texto.toLocaleLowerCase() || texto === texto.toLocaleUpperCase();
  if (!caixaUniforme) return texto;
  return texto.split(" ").map((palavra, i) => {
    const minuscula = palavra.toLocaleLowerCase();
    if (i > 0 && PALAVRAS_MINUSCULAS.has(minuscula)) return minuscula;
    return minuscula.charAt(0).toLocaleUpperCase() + minuscula.slice(1);
  }).join(" ");
}

// "Cidade, UF" quando a sigla vem colada depois de vírgula, hífen ou barra.
// Duas letras no fim são exigidas: "Porto Alegre" e "Mogi-Mirim" passam inteiras.
export function normalizarCidade(valor?: string | null): string {
  const texto = (valor ?? "").trim();
  if (!texto) return "";
  const comSigla = texto.match(/^(.+?)\s*[,/–-]\s*([A-Za-z]{2})$/);
  if (comSigla) return `${normalizarCaixa(comSigla[1])}, ${comSigla[2].toLocaleUpperCase()}`;
  return normalizarCaixa(texto);
}

// Os grupos da lista, nesta ordem: primeiro o que espera por mim, por último o
// que já acabou. O rótulo "Aguardando resposta" servia para os dois lados do
// pedido e não dizia de quem era a vez (item 13.2); "Em análise" fica só para o
// que ainda está com a distribuidora.
const GRUPOS_DE_CONEXAO = [
  { chave: "aguardando-voce", titulo: "dashboard.awaitingYourReply" },
  { chave: "em-analise", titulo: "dashboard.inReview" },
  { chave: "aguardando-outro", titulo: "dashboard.awaitingOtherReply" },
  { chave: "efetivadas", titulo: "dashboard.connectionsEstablished" },
  { chave: "encerradas", titulo: "dashboard.groupClosed" },
] as const;

function grupoDaConexao(conexao: { status: string; souDestinataria: boolean }): string {
  if (conexao.status === "accepted") return "efetivadas";
  if (conexao.status === "in_review") return "em-analise";
  if (conexao.status === "pending") return conexao.souDestinataria ? "aguardando-voce" : "aguardando-outro";
  return "encerradas";
}

// `souDestinataria` é `sql<boolean>` nas duas consultas de server/db.ts, mas o
// driver do MySQL entrega 1/0: `status === "pending" && conn.souDestinataria`
// valia `0` e o React desenhava o zero solto abaixo do setor (item 6.2). A
// lista inteira é normalizada na entrada, uma vez, para nenhum uso novo cair
// na mesma armadilha.
function comSouDestinatariaBooleana<T extends { souDestinataria: unknown }>(linhas: T[]) {
  return linhas.map(linha => ({ ...linha, souDestinataria: Boolean(linha.souDestinataria) }));
}

// ─── Banner de Promoção Ouro ───
function GoldPromotionBanner({ userId }: { userId?: number }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const [shown, setShown] = useState(false);
  const notificationsQuery = trpc.notifications.list.useQuery(undefined, {
    enabled: !!userId,
    staleTime: 30_000,
  });
  const markReadMutation = trpc.notifications.markAllRead.useMutation();

  const goldNotif = notificationsQuery.data?.find(
    (n: { type: string; isRead: boolean | null }) => n.type === "gold_granted" && !n.isRead
  );

  useEffect(() => {
    if (goldNotif && !dismissed) {
      const t = setTimeout(() => setShown(true), 500);
      return () => clearTimeout(t);
    }
  }, [goldNotif, dismissed]);

  if (!goldNotif || dismissed || !shown) return null;

  const handleDismiss = () => {
    setDismissed(true);
    markReadMutation.mutate();
  };

  return (
    <div className="relative overflow-hidden" style={{
      background: "linear-gradient(135deg, #6e4530 0%, #4f3222 40%, #2f1d13 100%)",
      borderBottom: "1px solid rgba(201,143,112,0.3)",
      animation: "slideDown 0.5s cubic-bezier(0.23,1,0.32,1)",
    }}>
      <div className="absolute inset-0 opacity-10" style={{
        backgroundImage: "radial-gradient(circle at 20% 50%, #c98f70 0%, transparent 50%), radial-gradient(circle at 80% 50%, #efcba8 0%, transparent 50%)"
      }} />
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-4 relative">
        <div className="text-3xl animate-bounce">⭐</div>
        <div className="flex-1">
          <div className="font-black text-amber-300 text-lg">{t("dashboard.goldBannerTitle")}</div>
          <div className="text-amber-200/80 text-sm mt-0.5">{goldNotif.body || t("dashboard.goldBannerBody")}</div>
        </div>
        <button onClick={handleDismiss}
          className="text-amber-300/60 hover:text-amber-300 transition-colors text-xl font-bold px-2 py-1 rounded"
          title={t("dashboard.close")}>
          ×
        </button>
      </div>
    </div>
  );
}

// O cartão não sabe nome: `matches.list` não traz mais `displayName`, `avatarUrl`,
// `bio`, nome civil, empresa nem cargo — e nem o `matchedUserId`. A identidade
// mora do outro lado, na lista de conexões, e só depois do interesse mútuo.
type MatchData = {
  matchId: number; overallScore: number;
  specialtyScore: number | null; objectivesScore: number | null;
  incomeScore: number | null; locationScore: number | null; valuesScore: number | null;
  aiInsight: string | null; city: string | null; country: string | null;
  primarySpecialty: string | null; seekingTypes: unknown; businessInterests: unknown;
  values: unknown; sector: string | null;
  // O estado do interesse e o nome (quando há) chegam resolvidos do servidor.
  connectionId: number | null;
  connectionStatus: "pending" | "accepted" | "declined" | "blocked" | "in_review" | "not_forwarded" | null;
  souDestinataria: boolean | null;
  displayName: string | null;
};

function MatchCard({ match, onInterest, onDismiss, onResponder, onVerConexoes, index }: {
  match: MatchData; onInterest: (matchId: number) => void;
  onDismiss: (mid: number) => void;
  onResponder: (connectionId: number, accept: boolean) => void;
  onVerConexoes: () => void; index: number;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [entered, setEntered] = useState(false);
  const seekingTypes = Array.isArray(match.seekingTypes) ? match.seekingTypes as string[] : [];
  const businessInterests = Array.isArray(match.businessInterests) ? match.businessInterests as string[] : [];
  const values = Array.isArray(match.values) ? match.values as string[] : [];

  // Combina seekingTypes + businessInterests, resolve sinônimos e remove
  // duplicatas. Três vocabulários convivem na mesma coluna e cada um tem a sua
  // vez, nesta ordem:
  //
  //  1. CHAVE DE SETOR (`construcao`, `logistica`): é o que "Interesses de
  //     negócio" volta a gravar, e o rótulo tem de ser o MESMO que a usuária
  //     marcou no cadastro — por isso vem de `shared/setores.ts`, a fonte
  //     daquela tela, e não de um vocabulário paralelo. Sem este passo a chave
  //     saía CRUA no cartão ("construcao"), porque nenhum dos dois de baixo a
  //     conhece.
  //  2. sinônimo do termo CRU, antes de traduzir (lib/interesses.ts): é o que
  //     casa o dado antigo — as chaves em inglês (`tech`) e os rótulos já
  //     gravados ("Alimentos & Bebidas").
  //  3. "O que você busca?", que tem rótulo próprio, inclusive para as chaves
  //     antigas (investor → Investimento / Capital; job e mentor com o rótulo
  //     de antes); depois a chave de opção do onboarding ("investor" vira o
  //     rótulo do idioma da tela). Texto livre não bate com nada e passa
  //     intacto, que é como o dado antigo continua legível.
  const allInterests = Array.from(new Set(
    [...seekingTypes, ...businessInterests].map(k => ehChaveDeSetor(k)
      ? rotuloDoSetor(t, k)
      : rotuloDeInteresse(t, k, termo => rotuloDaBusca(t, termo) ?? optionLabel(t, termo)))
  )).slice(0, 5);

  useEffect(() => {
    const t = setTimeout(() => setEntered(true), index * 80);
    return () => clearTimeout(t);
  }, [index]);

  const isTopMatch = match.overallScore >= 80;

  // Os cinco estados do cartão. `revelada` é o único em que existe nome, e ele
  // vem do servidor pela lista de conexões — o cartão nunca teve o nome guardado
  // esperando a hora de mostrar.
  const revelada = match.connectionStatus === "accepted";
  const aguardando = match.connectionStatus === "pending" && !match.souDestinataria;
  const recebido = match.connectionStatus === "pending" && Boolean(match.souDestinataria);
  const recusada = match.connectionStatus === "declined" || match.connectionStatus === "blocked";
  // O passo do distribuidor: quem pediu vê "em análise" e, se for o caso, "não
  // encaminhado". A destinatária não vê nada disso — o servidor nem manda a
  // linha para ela —, a não ser que ela também tenha clicado (aí é "em análise"
  // dos dois lados, e a aprovação já revela os dois nomes).
  const emAnalise = match.connectionStatus === "in_review";
  const naoEncaminhada = match.connectionStatus === "not_forwarded";
  const nome = revelada ? (match.displayName || t("dashboard.userFallback")) : null;
  // Dispensar só faz sentido quando não há conversa em curso: some nos estados
  // em que a outra parte está esperando algo, para ninguém sumir com um cartão
  // do qual ainda depende.
  const podeDispensar = !aguardando && !recebido && !revelada && !emAnalise;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        opacity: entered ? 1 : 0,
        transform: entered ? "translateY(0) scale(1)" : "translateY(20px) scale(0.97)",
        transition: `opacity 0.4s cubic-bezier(0.23,1,0.32,1), transform 0.4s cubic-bezier(0.23,1,0.32,1)`,
      }}
      className={`bg-[#1b1714] border rounded-2xl overflow-hidden transition-all duration-300 ${
        isTopMatch
          ? "border-emerald-500/30 shadow-lg shadow-emerald-500/5"
          : hovered ? "border-white/20" : "border-white/8"
      } ${hovered ? "shadow-xl shadow-black/30" : ""}`}>

      {isTopMatch && (
        <div className="h-0.5 bg-gradient-to-r from-emerald-500/0 via-emerald-400 to-emerald-500/0" />
      )}

      <div className="p-6">
        <div className="flex items-start gap-4 mb-4">
          {/* Avatar */}
          <div aria-label={revelada ? undefined : t("dashboard.anonAvatarAlt")}
            className={`relative w-14 h-14 rounded-full flex-shrink-0 flex items-center justify-center text-black font-black text-xl transition-transform duration-200 ${hovered ? "scale-105" : ""}`}
            style={{ background: "linear-gradient(135deg, #c98f70, #efcba8)" }}>
            {/* Sem nome não há inicial: a letra sozinha já estreita demais quem
                pode ser, numa rede em que as membras se conhecem. */}
            {revelada ? nome![0].toUpperCase() : <User className="w-6 h-6 opacity-60" strokeWidth={2.5} />}
            {isTopMatch && (
              <div className="absolute -top-1 -right-1 w-5 h-5 bg-emerald-400 rounded-full flex items-center justify-center text-[9px] font-black text-black">★</div>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <h3 className="font-bold text-lg leading-tight">{revelada ? nome : t("dashboard.anonTitle")}</h3>
              {isTopMatch && (
                <Badge className="bg-emerald-400/15 text-emerald-400 border-emerald-400/25 text-xs px-2 py-0.5">{t("dashboard.topMatch")}</Badge>
              )}
              {revelada && (
                <Badge className="bg-emerald-400/15 text-emerald-400 border-emerald-400/25 text-xs px-2 py-0.5">{t("dashboard.revealedBadge")}</Badge>
              )}
              {recebido && (
                <Badge className="bg-[#c98f70]/15 text-[#c98f70] border-[#c98f70]/25 text-xs px-2 py-0.5">{t("dashboard.interestReceived")}</Badge>
              )}
            </div>
            <div className="text-xs text-white/40 mt-0.5 flex items-center gap-1">
              <span className="text-[10px]">📍</span>
              {sectorLabel(t, i18n, match.sector) || optionLabel(t, match.primarySpecialty)}
              {(match.sector || match.primarySpecialty) && (match.city) && " · "}
              {match.city}{match.country && `, ${match.country}`}
            </div>
          </div>

          <ScoreRing score={match.overallScore} size={64} animate={entered} />
        </div>

        {/* AI Insight */}
        {match.aiInsight && (
          <div className={`bg-[#c98f70]/8 border border-[#c98f70]/20 rounded-xl p-3 mb-4 text-sm text-white/65 leading-relaxed transition-all duration-300 ${hovered ? "border-[#c98f70]/35 bg-[#c98f70]/12" : ""}`}>
            <span className="text-[#c98f70] font-semibold">✦ {t("dashboard.aiPrefix")} </span>{match.aiInsight}
          </div>
        )}

        {/* Interest tags — sinônimos normalizados */}
        {allInterests.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {allInterests.map((interest: string) => (
              <span key={interest} className="px-2.5 py-0.5 rounded-full bg-amber-500/8 border border-amber-500/20 text-xs text-amber-300/70 hover:border-amber-500/40 hover:text-amber-300 transition-colors">
                {interest}
              </span>
            ))}
          </div>
        )}

        {/* Expanded scores */}
        {expanded && (
          <div className="space-y-2.5 mb-4 pt-4 border-t border-white/5">
            <ScoreBar label={t("dashboard.scoreObjectives")} value={match.objectivesScore ?? 0} color="#c98f70" delay={0} />
            <ScoreBar label={t("dashboard.scoreSpecialty")} value={match.specialtyScore ?? 0} color="#3b82f6" delay={80} />
            <ScoreBar label={t("dashboard.scoreValues")} value={match.valuesScore ?? 0} color="#10b981" delay={160} />
            <ScoreBar label={t("dashboard.scoreLocation")} value={match.locationScore ?? 0} color="#8b5cf6" delay={240} />
            <ScoreBar label={t("dashboard.scoreIncome")} value={match.incomeScore ?? 0} color="#f97316" delay={320} />
            {values.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-2">
                {values.map((v: string) => (
                  <span key={v} className="px-2.5 py-0.5 rounded-full bg-[#c98f70]/10 border border-[#c98f70]/20 text-xs text-[#c98f70]">{optionLabel(t, v)}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Aviso de reciprocidade: quem enviou não clicou em nada agora, então
            precisa ser dita a razão de o nome ter aparecido — e que o dela
            apareceu do outro lado também. */}
        {revelada && (
          <div className="mb-3 text-xs text-emerald-400/80">{t("dashboard.revealedNote")}</div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {recebido ? (
            <>
              <button onClick={() => onResponder(match.connectionId!,true)}
                className="flex-1 py-2.5 px-4 rounded-xl font-bold text-sm bg-emerald-400 hover:bg-emerald-500 text-black transition-all duration-200 active:scale-95">
                {t("dashboard.acceptReveal")}
              </button>
              <button onClick={() => onResponder(match.connectionId!,false)}
                className="px-3 py-2.5 rounded-xl text-xs font-medium border border-white/15 text-white/50 hover:border-white/30 hover:text-white transition-all duration-200">
                {t("dashboard.decline")}
              </button>
            </>
          ) : revelada ? (
            <button onClick={onVerConexoes}
              className="flex-1 py-2.5 px-4 rounded-xl font-bold text-sm bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95 shadow-md shadow-[#c98f70]/15">
              {t("dashboard.viewConnection")}
            </button>
          ) : aguardando || recusada || emAnalise || naoEncaminhada ? (
            // Desabilitado em vez de sumir: antes o botão continuava clicável e o
            // segundo clique devolvia erro vermelho de conflito.
            <button disabled
              className="flex-1 py-2.5 px-4 rounded-xl font-medium text-sm border border-white/15 text-white/50 cursor-default">
              {aguardando ? t("dashboard.interestWaiting")
                : emAnalise ? t("dashboard.interestInReview")
                  : naoEncaminhada ? t("dashboard.interestNotForwarded")
                    : t("dashboard.interestDeclined")}
            </button>
          ) : (
            <button
              onClick={() => onInterest(match.matchId)}
              className="flex-1 py-2.5 px-4 rounded-xl font-bold text-sm bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95 shadow-md shadow-[#c98f70]/15">
              {t("dashboard.connect")}
            </button>
          )}
          <button onClick={() => setExpanded(e => !e)}
            className="px-3 py-2.5 rounded-xl text-xs font-medium border border-white/15 text-white/50 hover:border-white/30 hover:text-white transition-all duration-200">
            {expanded ? "▲" : t("opportunitiesPage.viewDetails")}
          </button>
          {podeDispensar && (
            <button onClick={() => onDismiss(match.matchId)}
              className="px-3 py-2.5 rounded-xl text-white/25 hover:text-white/60 hover:bg-white/5 transition-all duration-200 text-sm">✕</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
// `suffix` existia no AnimatedNumber e o StatCard não repassava: a
// "Compatibilidade Média" saía "72", um número sem unidade nenhuma ao lado de
// três contagens (item 6.3 do reteste v4). O traço de consulta que falhou não
// ganha sufixo — o AnimatedNumber devolve texto não numérico intacto.
function StatCard({ label, value, color, icon, index, suffix = "" }: {
  label: string; value: number | string; color: string; icon: string; index: number; suffix?: string;
}) {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), index * 80);
    return () => clearTimeout(t);
  }, [index]);

  return (
    <div style={{
      opacity: entered ? 1 : 0,
      transform: entered ? "translateY(0)" : "translateY(16px)",
      transition: "opacity 0.4s cubic-bezier(0.23,1,0.32,1), transform 0.4s cubic-bezier(0.23,1,0.32,1)",
    }}
      className="bg-[#1b1714] border border-white/8 rounded-xl p-4 hover:border-white/15 transition-colors duration-200 group">
      <div className="flex items-center justify-between mb-2">
        <span className="text-lg">{icon}</span>
        <div className="w-1.5 h-1.5 rounded-full opacity-60" style={{ background: color }} />
      </div>
      <div className={`text-2xl font-black mb-1 transition-colors duration-300`} style={{ color }}>
        {entered ? <AnimatedNumber value={value} suffix={suffix} /> : "0"}
      </div>
      <div className="text-xs text-white/35">{label}</div>
    </div>
  );
}

// ─── Skeleton Card ────────────────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div className="bg-[#1b1714] border border-white/8 rounded-2xl p-6 animate-pulse">
      <div className="flex gap-4 mb-4">
        <div className="w-14 h-14 rounded-full shimmer-bg" />
        <div className="flex-1 space-y-2.5">
          <div className="h-4 shimmer-bg rounded-lg w-3/4" />
          <div className="h-3 shimmer-bg rounded-lg w-1/2" />
          <div className="h-3 shimmer-bg rounded-lg w-2/3" />
        </div>
        <div className="w-16 h-16 rounded-full shimmer-bg" />
      </div>
      <div className="h-14 shimmer-bg rounded-xl mb-4" />
      <div className="flex gap-2">
        <div className="flex-1 h-10 shimmer-bg rounded-xl" />
        <div className="w-16 h-10 shimmer-bg rounded-xl" />
      </div>
    </div>
  );
}

// ─── Language Selector (mini) ────────────────────────────────────────────────
function LangSelectorMini() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  // O idioma RESOLVIDO: o pedido pode ser regional ("en-US") e não existir
  // na lista — a bandeira ficava no Brasil com a tela em inglês.
  const idiomaAtual = i18n.resolvedLanguage ?? i18n.language;
  const current = LANGUAGES.find(l => l.code === idiomaAtual) ?? LANGUAGES[0];
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-xs text-white/40 hover:text-white/70 transition-colors px-2 py-1.5 rounded-lg hover:bg-white/5">
        <span>{current.flag}</span>
        <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor"><path d="M5 7L1 3h8L5 7z" /></svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 bg-[#211e1b] border border-white/20 rounded-xl shadow-2xl overflow-hidden min-w-[140px]">
            {LANGUAGES.map(lang => (
              <button key={lang.code}
                onClick={() => { i18n.changeLanguage(lang.code); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors text-left ${
                  lang.code === idiomaAtual ? "bg-[#c98f70]/20 text-[#c98f70]" : "text-white/60 hover:bg-white/10 hover:text-white"
                }`}>
                <span>{lang.flag}</span><span>{lang.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Recommended Opportunities ──────────────────────────────────────────────
function RecommendedOpportunities() {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const recommendedQuery = trpc.matching.getRecommendedOpportunities.useQuery(undefined, {
    enabled: isAuthenticated,
    staleTime: 5 * 60_000, // 5 min cache — LLM call is expensive
  });

  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!recommendedQuery.isLoading) {
      const t = setTimeout(() => setEntered(true), 200);
      return () => clearTimeout(t);
    }
  }, [recommendedQuery.isLoading]);

  // Rótulos de confiabilidade e de tipo são os mesmos das telas de
  // oportunidade (newOpportunity.compliance*Label, opportunitiesPage.type*).
  const COMPLIANCE_COLORS: Record<string, { border: string; badge: string; label: string }> = {
    green:   { border: "rgba(34,197,94,0.35)",  badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",  label: t("newOpportunity.complianceGreenLabel") },
    yellow:  { border: "rgba(234,179,8,0.35)",  badge: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",    label: t("newOpportunity.complianceYellowLabel") },
    orange:  { border: "rgba(249,115,22,0.35)", badge: "bg-orange-500/15 text-orange-400 border-orange-500/25",    label: t("newOpportunity.complianceOrangeLabel") },
    red:     { border: "rgba(239,68,68,0.35)",  badge: "bg-red-500/15 text-red-400 border-red-500/25",             label: t("newOpportunity.complianceRedLabel") },
    pending: { border: "rgba(107,114,128,0.3)", badge: "bg-gray-500/15 text-gray-400 border-gray-500/25",          label: t("newOpportunity.compliancePendingLabel") },
  };

  const TYPE_LABELS: Record<string, string> = {
    offer: t("opportunitiesPage.typeOffer"), demand: t("opportunitiesPage.typeDemand"),
    investment: t("opportunitiesPage.typeInvestment"), partnership: t("opportunitiesPage.typePartnership"),
    distribution: t("opportunitiesPage.typeDistribution"), other: t("opportunitiesPage.typeOther"),
  };

  return (
    <div className="mt-10" style={{
      opacity: entered ? 1 : 0,
      transform: entered ? "translateY(0)" : "translateY(24px)",
      transition: "opacity 0.5s cubic-bezier(0.23,1,0.32,1), transform 0.5s cubic-bezier(0.23,1,0.32,1)",
    }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl"
          style={{ background: "linear-gradient(135deg, rgba(201,143,112,0.2), rgba(139,92,246,0.2))", border: "1px solid rgba(201,143,112,0.25)" }}>
          <span className="text-lg">✦</span>
        </div>
        <div>
          <h2 className="font-black text-white text-lg leading-tight">{t("dashboard.recommendedTitle")}</h2>
          <p className="text-xs text-white/35 mt-0.5">{t("dashboard.recommendedSubtitle")}</p>
        </div>
      </div>

      {/* Loading skeleton */}
      {recommendedQuery.isLoading && (
        <div className="grid md:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-[#1b1714] border border-white/8 rounded-2xl p-5 animate-pulse">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 space-y-2">
                  <div className="h-4 shimmer-bg rounded-lg w-3/4" />
                  <div className="h-3 shimmer-bg rounded-lg w-1/2" />
                </div>
                <div className="w-14 h-14 rounded-full shimmer-bg ml-3" />
              </div>
              <div className="h-12 shimmer-bg rounded-xl mb-3" />
              <div className="h-9 shimmer-bg rounded-xl" />
            </div>
          ))}
        </div>
      )}

      {/* Erro da consulta: não é culpa do perfil da usuária. Este bloco foi o
          molde do ErroDeConsulta; agora usa o componente (e sai traduzido). */}
      {!recommendedQuery.isLoading && recommendedQuery.isError && (
        <ErroDeConsulta erro={recommendedQuery.error} aoTentarDeNovo={() => recommendedQuery.refetch()} />
      )}

      {/* Lista realmente vazia */}
      {!recommendedQuery.isLoading && !recommendedQuery.isError && (!recommendedQuery.data || recommendedQuery.data.length === 0) && (
        <div className="bg-[#1b1714] border border-white/8 rounded-2xl p-8 text-center">
          <div className="text-4xl mb-3">🔭</div>
          <p className="text-white/40 text-sm">{t("dashboard.recommendedEmpty")}</p>
          <Link href="/opportunities">
            <button className="mt-4 px-5 py-2 rounded-xl text-xs font-semibold border border-[#c98f70]/30 text-[#c98f70] hover:bg-[#c98f70]/8 transition-colors">
              {t("dashboard.exploreOpportunities")}
            </button>
          </Link>
        </div>
      )}

      {/* Recommendation cards */}
      {!recommendedQuery.isLoading && recommendedQuery.data && recommendedQuery.data.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          {recommendedQuery.data.map((opp, i) => {
            const level = (opp.complianceLevel ?? "pending") as string;
            const compliance = COMPLIANCE_COLORS[level] ?? COMPLIANCE_COLORS.pending;
            const scoreColor = corDaFaixaDeCompatibilidade(opp.compatibilityScore);
            return (
              <div key={opp.id}
                style={{
                  opacity: entered ? 1 : 0,
                  transform: entered ? "translateY(0) scale(1)" : "translateY(16px) scale(0.97)",
                  transition: `opacity 0.4s cubic-bezier(0.23,1,0.32,1) ${i * 60}ms, transform 0.4s cubic-bezier(0.23,1,0.32,1) ${i * 60}ms`,
                  borderColor: compliance.border,
                }}
                className="bg-[#1b1714] border rounded-2xl overflow-hidden hover:shadow-xl hover:shadow-black/30 transition-all duration-300 group">

                {/* Compliance top stripe */}
                <div className="h-0.5" style={{ background: `linear-gradient(90deg, transparent, ${compliance.border.replace("0.35", "0.8")}, transparent)` }} />

                <div className="p-5">
                  {/* Header row */}
                  <div className="flex items-start gap-3 mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-white text-base leading-tight truncate group-hover:text-[#c98f70] transition-colors">
                        {opp.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {opp.sector && (
                          <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-xs text-white/50">
                            {opportunitySectorLabel(t, opp.sector)}
                          </span>
                        )}
                        <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-xs text-white/50">
                          {TYPE_LABELS[opp.type] ?? opp.type}
                        </span>
                        <span className={`px-2 py-0.5 rounded-full border text-xs ${compliance.badge}`}>
                          {compliance.label}
                        </span>
                      </div>
                    </div>

                    {/* Compatibility score ring */}
                    <div className="flex-shrink-0 flex flex-col items-center gap-1">
                      <svg width={56} height={56} style={{ transform: "rotate(-90deg)" }}>
                        <circle cx={28} cy={28} r={22} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={4} />
                        <circle cx={28} cy={28} r={22} fill="none" stroke={scoreColor} strokeWidth={4}
                          strokeDasharray={`${(opp.compatibilityScore / 100) * (2 * Math.PI * 22)} ${2 * Math.PI * 22}`}
                          strokeLinecap="round"
                          style={{ transition: "stroke-dasharray 0.8s cubic-bezier(0.23,1,0.32,1)" }} />
                        <text x={28} y={28} textAnchor="middle" dominantBaseline="central"
                          style={{ transform: "rotate(90deg)", transformOrigin: "28px 28px", fill: scoreColor, fontSize: 11, fontWeight: 700 }}>
                          {opp.compatibilityScore}%
                        </text>
                      </svg>
                      {/* A faixa por escrito ao lado da cor (item 12): o anel
                          sozinho obriga a distinguir marrom de azul. */}
                      <span className="text-[9px] font-semibold text-center leading-tight" style={{ color: scoreColor }}>
                        {t("dashboard.compatible")}
                        <span className="block text-white/45">{rotuloDaFaixaDeCompatibilidade(t, opp.compatibilityScore)}</span>
                      </span>
                    </div>
                  </div>

                  {/* AI compatibility reason */}
                  <div className="bg-[#c98f70]/6 border border-[#c98f70]/18 rounded-xl p-3 mb-3 text-xs text-white/60 leading-relaxed group-hover:border-[#c98f70]/30 group-hover:bg-[#c98f70]/10 transition-all duration-300">
                    <span className="text-[#c98f70] font-semibold">✦ {t("dashboard.aiPrefix")} </span>{opp.compatibilityReason}
                  </div>

                  {/* CTA */}
                  <Link href={`/opportunities/${opp.id}`}>
                    <button className="w-full py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-[#c98f70]/90 to-[#efcba8]/90 hover:from-[#c98f70] hover:to-[#efcba8] text-[#151312] transition-all duration-200 active:scale-95 shadow-md shadow-[#c98f70]/15">
                      {t("dashboard.viewOpportunity")}
                    </button>
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Deal Rooms Tab ─────────────────────────────────────────────────────────
function DealRoomsTab() {
  const { t } = useTranslation();
  const { isAuthenticated, user } = useAuth();
  const isGold = user?.role === "gold" || user?.role === "president" || user?.role === "admin";
  const [viewAll, setViewAll] = useState(false);

  const { data: rooms = [], isLoading, isError: salasFalharam, error: erroDasSalas, refetch: recarregarSalas } = trpc.dealRoom.listRooms.useQuery(undefined, {
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });
  const { data: allRooms = [], isLoading: isLoadingAll, isError: todasFalharam, error: erroDeTodas, refetch: recarregarTodas } = trpc.dealRoom.listAllRooms.useQuery(undefined, {
    enabled: isAuthenticated && isGold && viewAll,
    refetchInterval: 30_000,
  });

  const displayRooms = (isGold && viewAll ? allRooms : rooms) as any[];
  const isLoadingDisplay = isGold && viewAll ? isLoadingAll : isLoading;
  // A consulta que a aba está mostrando: erro nela não é "nenhuma sala".
  const consultaExibida = isGold && viewAll
    ? { falhou: todasFalharam, erro: erroDeTodas, recarregar: recarregarTodas }
    : { falhou: salasFalharam, erro: erroDasSalas, recarregar: recarregarSalas };

  if (isLoadingDisplay) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="bg-[#1b1714] border border-white/8 rounded-2xl p-5 animate-pulse">
            <div className="h-4 bg-white/10 rounded w-1/3 mb-2" />
            <div className="h-3 bg-white/5 rounded w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toggle Ouro: Minhas Salas / Todas as Salas */}
      {isGold && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => setViewAll(false)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              !viewAll ? "bg-amber-400/20 text-amber-300 border border-amber-400/30" : "text-white/40 hover:text-white/60"
            }`}
          >
            {t("dashboard.myRooms")}
          </button>
          <button
            onClick={() => setViewAll(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
              viewAll ? "bg-amber-400/20 text-amber-300 border border-amber-400/30" : "text-white/40 hover:text-white/60"
            }`}
          >
            ⭐ {t("dashboard.allRoomsGold")}
          </button>
        </div>
      )}

      {consultaExibida.falhou ? (
        <ErroDeConsulta erro={consultaExibida.erro} aoTentarDeNovo={() => consultaExibida.recarregar()} />
      ) : displayRooms.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-5xl mb-4">🔐</div>
          <h3 className="text-xl font-black mb-2">{viewAll ? t("dashboard.noRoomsPlatformTitle") : t("dashboard.noRoomsTitle")}</h3>
          <p className="text-white/40 text-sm max-w-sm mx-auto mb-6">
            {viewAll ? t("dashboard.noRoomsPlatformDesc") : t("dashboard.noRoomsDesc")}
          </p>
          {!viewAll && (
            <Link href="/opportunities">
              <button className="px-6 py-2.5 rounded-xl text-sm font-bold bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95">
                {t("dashboard.viewOpportunities")}
              </button>
            </Link>
          )}
        </div>
      ) : (
        <>
          <p className="text-white/40 text-xs mb-2">
            {viewAll ? t("dashboard.roomsOnPlatform", { count: displayRooms.length }) : t("dashboard.roomsPrivacyNotice")}
          </p>
          {displayRooms.map((room: any) => {
            const statusColor = room.status === "active" ? "#22c55e" : room.status === "awaiting_nda" ? "#eab308" : "#9ca3af";
            // Os mesmos rótulos de status da própria sala (DealRoom.tsx).
            const statusLabel = room.status === "active" ? t("dealRoom.statusActive") : room.status === "awaiting_nda" ? t("dealRoom.statusAwaitingNda") : t("dealRoom.statusClosed");
            return (
              <Link key={room.id} href={`/deal-room/${room.id}`}>
                <div className="bg-[#1b1714] border border-white/8 hover:border-amber-500/30 rounded-2xl p-5 cursor-pointer transition-all duration-200 hover:bg-[#1b1714]/80">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
                        <span className="text-amber-400 text-xs">🔐</span>
                      </div>
                      <div>
                        <p className="text-white font-semibold text-sm">{room.opportunityTitle}</p>
                        <p className="text-white/40 text-xs">{t("dashboard.withParty", { name: room.otherPartyName })}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full" style={{ background: statusColor }} />
                      <span className="text-xs" style={{ color: statusColor }}>{statusLabel}</span>
                    </div>
                  </div>
                  {room.status === "awaiting_nda" && (
                    <p className="text-amber-400/60 text-xs mt-2">⚠️ {t("dashboard.ndaPendingNotice")}</p>
                  )}
                </div>
              </Link>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { user, isAuthenticated, loading, logout } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"matches" | "connections" | "dealrooms" | "profile">("matches");
  const [tabVisible, setTabVisible] = useState(true);

  const profileQuery = trpc.profile.get.useQuery(undefined, { enabled: isAuthenticated });
  const matchesQuery = trpc.matches.list.useQuery({ limit: 20 }, { enabled: isAuthenticated });
  // Etapa 11: com termo publicado e não aceito, matches.list devolve [] de
  // propósito — sem isto o Dashboard esvaziaria em silêncio no dia da
  // publicação, sem nada convidando a autorizar.
  const consentQuery = trpc.consent.status.useQuery({ type: "termo_smart_match" }, { enabled: isAuthenticated });
  // Etapa 13 (prontidão): separa "nenhum perfil compatível" de "a rede ainda
  // está autorizando o termo" — a primeira aceitante via o vazio errado.
  const redeQuery = trpc.matches.redeAguardando.useQuery(undefined, { enabled: isAuthenticated });
  const statsQuery = trpc.matches.list.useQuery({ limit: 50 }, { enabled: isAuthenticated, select: (data) => ({
    total: data.length,
    highScore: data.filter(m => m.overallScore >= 80).length,
    avgScore: data.length > 0 ? Math.round(data.reduce((s, m) => s + m.overallScore, 0) / data.length) : 0,
    distribution: [0,1,2,3,4].map(b => data.filter(m => Math.min(4, Math.floor(m.overallScore / 20)) === b).length),
  }) });
  const connectionsQuery = trpc.connections.list.useQuery(undefined, { enabled: isAuthenticated });
  // QUEM PEDIU VÊ O ACEITE SEM F5 (achado do Nicolas na #136). O aceite manda um
  // aviso `interest_received` para a solicitante, e o sino relê a lista de
  // avisos a cada 30 s — mas o Dashboard não escutava nada disso, então o cartão
  // dela continuava anônimo até o F5. Aqui a tela observa o aviso e relê as duas
  // listas que desenham o nome.
  //
  // A comparação é pelo maior id JÁ VISTO, e não pelo tamanho da lista: aviso de
  // outro tipo não relê nada, e a primeira leitura também não — senão toda
  // abertura do Dashboard faria duas consultas a mais, e quem nunca teve um
  // aceite pagaria por isso.
  const avisosDeInteresse = trpc.notifications.list.useQuery(undefined, { enabled: isAuthenticated, staleTime: 30_000 });
  const maiorAvisoVisto = useRef<number | null>(null);
  useEffect(() => {
    const ids = (avisosDeInteresse.data ?? [])
      .filter((aviso: { type: string }) => aviso.type === "interest_received")
      .map((aviso: { id: number }) => aviso.id);
    if (!ids.length) return;
    const maior = Math.max(...ids);
    const anterior = maiorAvisoVisto.current;
    maiorAvisoVisto.current = maior;
    if (anterior !== null && maior > anterior) {
      void connectionsQuery.refetch();
      void matchesQuery.refetch();
    }
    // As duas consultas ficam fora das dependências de propósito: a identidade
    // delas muda a cada render, e o que decide a releitura é o aviso novo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avisosDeInteresse.data]);
  // Números da plataforma inteira. É a MESMA consulta que alimentava os quatro
  // indicadores da Hero (stats.platform, em server/routers/stats.ts), que saíram
  // da página pública: nenhum cálculo novo, nenhum número fixo no código.
  // Com MOSTRAR_NUMEROS_DA_REDE desligado (pedido do Rosber, 16/09) as duas
  // consultas nem saem: a seção não é desenhada, e não há por que buscar o número.
  const plataformaQuery = trpc.stats.platform.useQuery(undefined, { enabled: isAuthenticated && MOSTRAR_NUMEROS_DA_REDE });
  // Meu Network Inteligente: minutos usados no mês e limite por reunião no atalho.
  const minutosDoNetwork = trpc.networkInteligente.minutos.useQuery(undefined, { enabled: isAuthenticated });
  // Membros Bronze, Prata e Ouro (Governança, itens 1 e 12): saíram da Home e
  // só aparecem aqui. Consulta de quem está logada, com contagens reais por nível.
  const niveisQuery = trpc.stats.membrosPorNivel.useQuery(undefined, { enabled: isAuthenticated && MOSTRAR_NUMEROS_DA_REDE });

  // O número do aviso de novidades, CONGELADO na carga em que apareceu. A tela
  // se refaz o tempo todo (demonstrar interesse, aceitar, dispensar, marcar como
  // vista) e cada refetch traz `userSeen` já verdadeiro — o aviso sumia dois
  // segundos depois de aparecer, debaixo do olho de quem estava lendo.
  //
  // O que solta o congelamento é a lista trazer SUGESTÃO QUE AINDA NÃO FOI
  // CONTADA — um `matchId` que nunca apareceu nesta carga —, e só isso. Antes
  // quem soltava era o `onSuccess` do "Reanalisar", zerando o número à mão: só
  // que o refetch dele demora, a tela se redesenha na hora com a lista VELHA já
  // marcada como vista, e o aviso piscava e sumia mesmo quando o servidor não
  // tinha achado sugestão nenhuma. Pelo conteúdo, os dois casos ficam certos:
  // "Reanalisar" que encontra sugestões novas anuncia quantas (os ids novos
  // entram), e o que não encontra nada deixa o número quieto — como deixam
  // dispensar, aceitar e responder, que só encurtam a lista.
  //
  // Na carga seguinte (outro acesso, F5) o número já nasce menor, que é o que o
  // item 6.4 pedia: o servidor guardou `userSeen` no caminho silencioso abaixo.
  const novidadesDaCarga = useRef<number | null>(null);
  const sugestoesJaContadas = useRef<Set<number> | null>(null);
  if (matchesQuery.data) {
    const contadas = sugestoesJaContadas.current;
    const temSugestaoNova = !contadas || matchesQuery.data.some(m => !contadas.has(m.matchId));
    if (temSugestaoNova) {
      novidadesDaCarga.current = matchesQuery.data.filter(m => !m.userSeen).length;
      sugestoesJaContadas.current = new Set(matchesQuery.data.map(m => m.matchId));
    }
  }

  const dismissMutation = trpc.matches.dismiss.useMutation({
    onSuccess: () => { matchesQuery.refetch(); toast.success(t("dashboard.dismiss")); },
  });
  const interestMutation = trpc.connections.send.useMutation({
    // `matchesQuery` também: o estado do cartão ("em análise") vem do servidor,
    // e sem este refetch o botão continuava "Demonstrar Interesse" até o F5.
    // `revelou`: a outra pessoa já tinha um pedido encaminhado para mim (o cartão
    // aberto estava velho), e este clique fechou o interesse mútuo. O aviso é o
    // da conexão criada, não "interesse enviado, o distribuidor confere".
    onSuccess: (data) => {
      toast.success(data?.revelou ? t("dashboard.connectionAccepted") : t("dashboard.interestSent"));
      connectionsQuery.refetch(); matchesQuery.refetch();
    },
    onError: (err) => toast.error(err.message || t("dashboard.interestError")),
  });
  const respondMutation = trpc.connections.respond.useMutation({
    // `matchesQuery` também: o nome do cartão vem do servidor, e sem este refetch
    // a pessoa aceita e o cartão continua anônimo até apertar F5.
    onSuccess: (_, vars) => { toast.success(vars.accept ? t("dashboard.connectionAccepted") : t("dashboard.connectionDeclined")); connectionsQuery.refetch(); matchesQuery.refetch(); },
  });
  const regenerateMutation = trpc.matches.regenerate.useMutation({
    // Quantas vieram está no aviso desta mutation (`dashboard.newMatches`). O
    // número da saudação NÃO é zerado aqui: ele se refaz sozinho quando o
    // refetch trouxer sugestão com id novo (ver `novidadesDaCarga`, acima).
    // Zerar à mão fazia o aviso piscar enquanto o refetch não voltava.
    onSuccess: (data) => {
      toast.success(data.count > 0 ? t("dashboard.newMatches", { count: data.count }) : t("dashboard.analysisDone"));
      matchesQuery.refetch();
    },
  });
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => { logout(); navigate("/"); },
  });

  // Reteste v4 (item 6.4): "N novas conexões sugeridas esperando pela sua
  // atenção" nunca baixava — `userSeen` nasce false e nada marcava a linha como
  // vista. Quando a lista de sugestões aparece na tela, avisamos o servidor UMA
  // VEZ por carga: o ref guarda os ids já enviados, então o efeito pode
  // reexecutar à vontade (troca de aba, re-render, refetch) sem virar laço, e
  // sugestão nova que chegar depois entra sozinha na próxima leva.
  const vistasEnviadas = useRef(new Set<number>());
  // A marcação é SILENCIOSA: o servidor grava `userSeen` e a tela não se refaz
  // por causa disso. A primeira versão pedia `matchesQuery.refetch()` aqui, e a
  // lista voltava com `userSeen` verdadeiro enquanto a pessoa ainda lia a
  // saudação — o aviso piscava e sumia. Quem precisa do valor novo é a carga
  // SEGUINTE, que já o lê do banco.
  const marcarVistasMutation = trpc.matches.marcarVistas.useMutation();
  useEffect(() => {
    if (activeTab !== "matches") return;
    const naoVistas = (matchesQuery.data ?? [])
      .filter(m => !m.userSeen && !vistasEnviadas.current.has(m.matchId))
      .map(m => m.matchId);
    if (naoVistas.length === 0) return;
    for (const id of naoVistas) vistasEnviadas.current.add(id);
    marcarVistasMutation.mutate({ matchIds: naoVistas });
    // A mutation fica fora das dependências de propósito: sua identidade muda a
    // cada render e o que decide a chamada é o conteúdo da lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, matchesQuery.data]);

  // Cadastro não concluído não chega aqui: o ProtectedRoute manda para
  // /onboarding (user.onboardingCompleted === false) e o servidor recusa
  // (server/cadastro-concluido.ts). Havia aqui um redirecionamento por
  // `profileQuery.data === null` que nunca disparava, porque profile.get sempre
  // devolve { user, profile }. Perfil ausente com cadastro concluído (conta
  // criada por script) fica no Dashboard, com o convite da aba Perfil.

  const switchTab = (tab: typeof activeTab) => {
    if (tab === activeTab) return;
    setTabVisible(false);
    setTimeout(() => { setActiveTab(tab); setTabVisible(true); }, 180);
  };

  if (loading || profileQuery.isLoading) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-center">
          <div className="w-14 h-14 border-2 border-[#c98f70]/20 border-t-[#c98f70] rounded-full animate-spin mx-auto mb-5" />
          <div className="text-white/50 text-sm font-medium">{t("dashboard.loading")}</div>
          <div className="text-white/20 text-xs mt-1">{t("dashboard.loadingDesc")}</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-2xl font-bold mb-4 text-white">{t("dashboard.restricted")}</h2>
          <a href={getLoginUrl()}><Button className="bg-[#c98f70] text-[#151312] font-bold hover:bg-[#b07a5c]">{t("auth.login")}</Button></a>
        </div>
      </div>
    );
  }

  const stats = statsQuery.data;
  const plataforma = plataformaQuery.data;
  const matches = matchesQuery.data || [];
  // O número do aviso sai da lista que a tela DESENHA — as mesmas linhas que o
  // efeito acima manda marcar como vistas. Contar a janela inteira (statsQuery,
  // 50) deixava o aviso alto para sempre em quem tem mais sugestões do que a
  // lista mostra: ninguém chega a ver as de fora para "zerá-las". E o valor é o
  // congelado, que só se refaz quando chega sugestão de id novo.
  const novidades = novidadesDaCarga.current ?? 0;
  const aguardandoTermo = Boolean(consentQuery.data?.document) && !consentQuery.data?.accepted;
  const connections = comSouDestinatariaBooleana(connectionsQuery.data || []);
  const profileData = profileQuery.data;
  const profile = profileData?.profile;
  const pendingConnections = connections.filter((c) => c.status === "pending" && Boolean(c.souDestinataria));
  // Item 6.1: o cartão de resumo contava as efetivadas e a aba contava todas as
  // linhas da MESMA consulta — dois números para a mesma coisa na mesma tela.
  // Vale a regra do cartão nos dois lugares (decisão do Roberto), e o rótulo
  // passou a dizer o que está sendo contado.
  const conexoesEfetivadas = connections.filter(c => c.status === "accepted").length;

  return (
    <div className="min-h-screen bg-transparent text-white">

      {/* ─── NAVBAR ─── */}
      <nav className="border-b border-white/[0.06] px-4 sm:px-6 py-3 flex items-center justify-between sticky top-0 z-40 bg-[#151312]/90 backdrop-blur-2xl">
        {/* O logo levava para a landing e tirava a usuária do app sem querer. */}
        <Link href="/dashboard">
          <BrandMark />
        </Link>
        <div className="flex items-center gap-2 sm:gap-3">
          {pendingConnections.length > 0 && (
            <button onClick={() => switchTab("connections")}
              className="text-xs text-[#c98f70] border border-[#c98f70]/30 px-3 py-1.5 rounded-full bg-[#c98f70]/5 hover:bg-[#c98f70]/10 transition-colors animate-pulse">
              {t("dashboard.pendingInvites", { count: pendingConnections.length })}
            </button>
          )}

          <GlobalMenu />

          <NotificationBell />
          <LangSelectorMini />
          <Link href="/profile">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-[#151312] font-black text-sm cursor-pointer hover:scale-105 transition-transform ring-2 ring-transparent hover:ring-[#c98f70]/40"
              style={{ background: "linear-gradient(135deg, #c98f70, #efcba8)" }} title={t("appHeader.myProfile")}>
              {(user?.name || "U")[0].toUpperCase()}
            </div>
          </Link>
        </div>
      </nav>

      {/* ─── BANNER PROMOÇÃO OURO ─── */}
      <GoldPromotionBanner userId={user?.id} />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">

        {/* ─── HEADER ─── */}
        <div className="mb-8 animate-fade-in-up flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-black mb-1">
              {t("dashboard.title")}, {profile?.displayName || user?.name || ""} 👋
            </h1>
            {/* Plural por chave (_one/_other e as formas do russo e do árabe),
                nunca por sufixo concatenado: "novo{s} match{es}" só existe em
                português. A parte destacada e o complemento são duas chaves. */}
            <p className="text-white/40">
              {novidades > 0
                ? <><span className="text-[#c98f70] font-semibold">{t("dashboard.greetingUnseen", { count: novidades })}</span> {t("dashboard.greetingUnseenSuffix")}</>
                : stats?.total && stats.total > 0
                  ? t("dashboard.greetingTotal", { count: stats.total })
                  // Em erro, nada de convite a "gerar os primeiros matches": eles podem existir.
                  : statsQuery.isError ? "" : t("dashboard.greetingWelcome")}
            </p>
          </div>
          {/* O gravador em um toque, também daqui (pedido da cliente de 20/10/2026). */}
          <Link href={ROTA_GRAVAR} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#c98f70] px-5 py-3 font-bold text-[#1a120c] hover:bg-[#efcba8]">
            <Mic size={18} /> {t("dashboard.recordMeeting")}
          </Link>
        </div>

        {/* ─── STATS ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[
            // Consulta falhou não é "0 matches": o traço diz que o número não veio
            // (o erro com "tentar de novo" está na aba de matches, logo abaixo).
            { label: t("dashboard.matches"), value: statsQuery.isError ? "—" : stats?.total ?? 0, color: "#c98f70", icon: "🎯", suffix: "" },
            // O único dos quatro que é porcentagem, e o único que saía sem
            // unidade nenhuma ao lado de três contagens (item 6.3).
            { label: t("dashboard.compatibility"), value: statsQuery.isError ? "—" : stats?.avgScore ?? 0, color: "#3b82f6", icon: "📊", suffix: "%" },
            { label: t("dashboard.topMatches"), value: statsQuery.isError ? "—" : stats?.highScore ?? 0, color: "#10b981", icon: "⭐", suffix: "" },
            { label: t("dashboard.connectionsEstablished"), value: connectionsQuery.isError ? "—" : conexoesEfetivadas, color: "#8b5cf6", icon: "🤝", suffix: "" },
          ].map((s, i) => (
            <StatCard key={s.label} {...s} index={i} />
          ))}
        </div>

        {/* ─── A REDE INTEIRA ───
            Os quatro indicadores que ficavam na Hero pública. Aqui eles fazem
            sentido: quem já entrou lê o tamanho da rede em que está, em vez de
            ver o número servir de vitrine na primeira tela.
            O título existe porque a grade acima também tem um cartão
            "Conexões" — lá é a da usuária, aqui é a da plataforma; sem a
            separação os dois números pareceriam o mesmo, contraditório.
            Mesmo StatCard, mesmas quatro cores e mesma grade da grade de cima:
            nenhum componente novo, nenhuma cor fora da identidade. O índice
            começa em 4 para a entrada escalonada continuar a de cima em vez de
            recomeçar.
            Escondida, com "Membros por nível", até os números serem atraentes
            (Rosber, 16/09): ver MOSTRAR_NUMEROS_DA_REDE em lib/numeros-da-rede.ts. */}
        {MOSTRAR_NUMEROS_DA_REDE && (<div className="mb-8">
          <div className="flex items-baseline gap-3 mb-3 flex-wrap">
            {/* Mesmo corpo do título "Oportunidades Recomendadas" (linha 592), que é
                a outra seção fora de cartão. Sem a classe de tamanho, o h2 cai no
                padrão do navegador e sai com 36 px — medido: gritava mais alto que
                os indicadores da própria usuária, que nem título têm. */}
            <h2 className="font-black text-white text-lg leading-tight">{t("dashboard.networkTitle")}</h2>
            <p className="text-xs text-white/35">{t("dashboard.networkDesc")}</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              // Mesma convenção da grade de cima: consulta que falhou não é
              // "0 pessoas cadastradas" — o traço diz que o número não veio.
              { label: t("stats.users"), value: plataforma?.users ?? 0, color: "#c98f70", icon: "👥" },
              { label: t("stats.opportunities"), value: plataforma?.opportunities ?? 0, color: "#3b82f6", icon: "💼" },
              { label: t("stats.connections"), value: plataforma?.connections ?? 0, color: "#10b981", icon: "🔗" },
              { label: t("stats.countries"), value: plataforma?.countries ?? 0, color: "#8b5cf6", icon: "🌍" },
            ].map((s, i) => (
              <StatCard key={s.label} {...s} value={plataformaQuery.isError ? "—" : s.value} index={4 + i} />
            ))}
          </div>
          {/* Membros por nível: mesma seção, mesmo StatCard e a mesma convenção
              do traço quando a consulta falha. Ouro soma presidente e admin
              ("Ouro = Presidente = administradora"), no servidor. */}
          <h3 className="mt-5 mb-3 text-sm font-bold text-white/70">{t("governanca.dashboard.title")}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: t("governanca.dashboard.bronze"), value: niveisQuery.data?.bronze ?? 0, color: "#c98f70", icon: "🥉" },
              { label: t("governanca.dashboard.silver"), value: niveisQuery.data?.silver ?? 0, color: "#cbd5e1", icon: "🥈" },
              { label: t("governanca.dashboard.gold"), value: niveisQuery.data?.gold ?? 0, color: "#fbbf24", icon: "🥇" },
            ].map((s, i) => (
              <StatCard key={s.label} {...s} value={niveisQuery.isError ? "—" : s.value} index={8 + i} />
            ))}
          </div>
        </div>)}

        {/* ─── MEU NETWORK INTELIGENTE ───
            Entrada do painel da rede particular (pedido do Nicolas, 13/09/2026).
            Spec da Glenda de 14/09, item 19 e validação 24: o Dashboard mostra
            o consumo e o limite de minutos — a consulta leve de
            networkInteligente.minutos; o resto dos números mora no painel. */}
        <Link href="/meu-network-inteligente"
          className="mb-8 flex items-center gap-4 rounded-2xl border border-[#c98f70]/25 bg-[#c98f70]/[0.06] p-5 transition-colors duration-200 hover:border-[#c98f70]/45">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#c98f70]/30 bg-[#c98f70]/15">
            <Network className="h-5 w-5 text-[#c98f70]" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-white">{t("networkPanel.title")}</span>
            <span className="mt-0.5 block text-sm text-white/50">{t("networkPanel.dashboardCard")}</span>
            {minutosDoNetwork.data && (
              <span className="mt-1 block text-xs font-semibold text-[#efcba8]">
                {t("networkInteligente.dashboard.minutesLine", {
                  usados: minutosDoNetwork.data.usadosNoMesSegundos > 0 ? Math.max(1, Math.round(minutosDoNetwork.data.usadosNoMesSegundos / 60)) : 0,
                  limite: Math.round(minutosDoNetwork.data.limitePorReuniaoSegundos / 60),
                })}
                {!minutosDoNetwork.data.ampliacao.disponivel && ` · ${t("networkInteligente.dashboard.expandSoon")}`}
              </span>
            )}
          </span>
          <span className="shrink-0 text-sm font-semibold text-[#c98f70]">{t("networkPanel.open")}</span>
        </Link>

        {/* ─── TABS ─── */}
        <div className="flex gap-1 mb-6 bg-white/4 rounded-xl p-1 w-fit border border-white/5 flex-wrap">
          {(["matches", "connections", "dealrooms", "profile"] as const).map(tab => (
            <button key={tab} onClick={() => switchTab(tab as any)}
              // O número da aba Conexões conta as EFETIVADAS, como o cartão de
              // resumo; o título diz isso a quem passa o mouse.
              title={tab === "connections" ? t("dashboard.connectionsEstablished") : undefined}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                activeTab === tab
                  ? "bg-[#c98f70] text-[#151312] font-bold shadow-md shadow-[#c98f70]/20"
                  : "text-white/45 hover:text-white hover:bg-white/5"
              }`}>
              {tab === "matches"
                ? `${t("dashboard.matches")}${matches.length > 0 ? ` (${matches.length})` : ""}`
                : tab === "connections"
                  ? `${t("dashboard.connections")}${conexoesEfetivadas > 0 ? ` (${conexoesEfetivadas})` : ""}`
                  : tab === "dealrooms"
                  ? `🔐 ${t("dashboard.dealRooms")}`
                  : t("dashboard.profile")}
            </button>
          ))}
        </div>

        {/* ─── TAB CONTENT ─── */}
        <div style={{
          opacity: tabVisible ? 1 : 0,
          transform: tabVisible ? "translateY(0)" : "translateY(10px)",
          transition: "opacity 0.18s ease, transform 0.18s cubic-bezier(0.23,1,0.32,1)",
        }}>

          {/* TAB: MATCHES */}
          {activeTab === "matches" && (
            <div>
              {stats && stats.total > 0 && (
                <div className="bg-[#1b1714] border border-white/8 rounded-2xl p-6 mb-6 animate-fade-in-scale">
                  <div className="flex items-center justify-between mb-5">
                    <div>
                      <h2 className="font-bold text-white">{t("dashboard.distribution")}</h2>
                      <p className="text-xs text-white/35 mt-0.5">{t("dashboard.distributionDesc")}</p>
                    </div>
                    <button onClick={() => regenerateMutation.mutate()} disabled={regenerateMutation.isPending}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium border border-white/15 text-white/50 hover:border-white/30 hover:text-white transition-all duration-200 disabled:opacity-40">
                      <span className={regenerateMutation.isPending ? "animate-spin" : ""}>↻</span>
                      {regenerateMutation.isPending ? t("dashboard.analyzing") : t("dashboard.regenerate")}
                    </button>
                  </div>
                  <DistributionChart data={stats.distribution} />
                </div>
              )}

              {matchesQuery.isLoading ? (
                <div className="grid md:grid-cols-2 gap-4">
                  {[1, 2, 3, 4].map(i => <SkeletonCard key={i} />)}
                </div>
              ) : matchesQuery.isError ? (
                // Consulta falhou não é "nenhum match" com botão de gerar:
                // o servidor lança de propósito quando o banco cai.
                <ErroDeConsulta erro={matchesQuery.error} aoTentarDeNovo={() => matchesQuery.refetch()} />
              ) : aguardandoTermo ? (
                // Etapa 11: quando o termo do Cruzamento existe e ainda não foi
                // aceito, a lista viria vazia SEM EXPLICAÇÃO — a trava age em
                // silêncio no servidor. O convite de autorização mora aqui,
                // no caminho principal, não só em /intelligent-matches.
                <SmartMatchConsent onAccepted={() => { consentQuery.refetch(); matchesQuery.refetch(); statsQuery.refetch(); }} />
              ) : matches.length === 0 && (redeQuery.data?.ocultas ?? 0) > 0 ? (
                // Há matches, mas o outro lado ainda não autorizou o termo: a
                // causa é a rede, não o perfil dela — dizer o contrário fazia a
                // primeira aceitante achar que não tinha ninguém compatível.
                <div className="text-center py-20 animate-fade-in-up">
                  <div className="text-6xl mb-5">🕐</div>
                  <h3 className="text-2xl font-black mb-2">{t("dashboard.redeAutorizandoTitulo")}</h3>
                  <p className="text-white/40 mb-8 max-w-sm mx-auto">{t("dashboard.redeAutorizandoDesc")}</p>
                </div>
              ) : matches.length === 0 ? (
                <div className="text-center py-20 animate-fade-in-up">
                  <div className="text-6xl mb-5">🔍</div>
                  <h3 className="text-2xl font-black mb-2">{t("dashboard.noMatches")}</h3>
                  <p className="text-white/40 mb-8 max-w-sm mx-auto">{t("dashboard.noMatchesDesc")}</p>
                  <button onClick={() => regenerateMutation.mutate()} disabled={regenerateMutation.isPending}
                    className="px-8 py-3 rounded-xl font-bold bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95 shadow-lg shadow-[#c98f70]/20 disabled:opacity-60">
                    {regenerateMutation.isPending ? t("dashboard.analyzing") : t("dashboard.generateMatches")}
                  </button>
                </div>
              ) : (
                <>
                  {/* Uma linha para a lista inteira, não uma por cartão: é assim
                      que a vitrine coletiva já explica a ausência de dados
                      pessoais, e repetir em 20 cartões seria ruído. */}
                  <p className="text-xs text-white/40 mb-3">{t("dashboard.anonListNotice")}</p>
                  <div className="grid md:grid-cols-2 gap-4">
                    {matches.map((match, i) => (
                      <MatchCard key={match.matchId} match={match} index={i}
                        onInterest={(matchId) => interestMutation.mutate({ matchId })}
                        onResponder={(connectionId, accept) => respondMutation.mutate({ connectionId, accept })}
                        onVerConexoes={() => switchTab("connections")}
                        onDismiss={(mid) => dismissMutation.mutate({ matchId: mid })} />
                    ))}
                  </div>
                </>
              )}

              {/* ─── OPORTUNIDADES RECOMENDADAS ─── */}
              <RecommendedOpportunities />
            </div>
          )}

          {/* TAB: CONNECTIONS */}
          {activeTab === "connections" && (
            <div className="space-y-3">
              {connectionsQuery.isError ? (
                <ErroDeConsulta erro={connectionsQuery.error} aoTentarDeNovo={() => connectionsQuery.refetch()} />
              ) : connections.length === 0 ? (
                <div className="text-center py-20 animate-fade-in-up">
                  <div className="text-6xl mb-5">🤝</div>
                  <h3 className="text-2xl font-black mb-2">{t("dashboard.noMatches")}</h3>
                  <p className="text-white/40 mb-8 max-w-sm mx-auto">{t("dashboard.noMatchesDesc")}</p>
                  <button onClick={() => switchTab("matches")}
                    className="px-8 py-3 rounded-xl font-bold bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95">
                    {t("dashboard.matches")}
                  </button>
                </div>
              ) : GRUPOS_DE_CONEXAO.map(grupo => {
                // Item 13.4: a lista era uma pilha única em que o pedido que
                // espera por mim ficava entre uma conexão velha e uma recusada.
                const doGrupo = connections.filter(c => grupoDaConexao(c) === grupo.chave);
                if (doGrupo.length === 0) return null;
                return (
                  <section key={grupo.chave} className="space-y-3">
                    <h3 className="mt-6 text-xs font-bold uppercase tracking-wide text-white/40 first:mt-0">
                      <span>{t(grupo.titulo)}</span>{" "}
                      <span className="text-white/25">({doGrupo.length})</span>
                    </h3>
                    {doGrupo.map((conn, i) => {
                      // Item 13.1: o que está gravado é texto livre do onboarding.
                      const setor = normalizarCaixa(optionLabel(t, conn.primarySpecialty));
                      const cidade = normalizarCidade(conn.city);
                      const esperaPorMim = conn.status === "pending" && Boolean(conn.souDestinataria);
                      // Conexão ACEITA sem apelido aparecia como "Membro da rede",
                      // mesmo com o servidor já mandando o nome da conta: o
                      // `userName` vem atrás do mesmo CASE WHEN que libera o
                      // resto, ou seja, só depois do aceite (server/db.ts:930).
                      // Achado do Nicolas na #136, item 4 da validação da #108.
                      const nomeVisivel = conn.displayName || (conn as { userName?: string | null }).userName || null;
                      const pedidoEm = conn.createdAt ? new Date(conn.createdAt) : null;
                      return (
                        <div key={conn.id}
                          style={{
                            opacity: 1,
                            animation: `fadeInScale 0.35s cubic-bezier(0.23,1,0.32,1) ${i * 0.06}s both`,
                          }}
                          className="bg-[#1b1714] border border-white/8 rounded-2xl p-5 flex flex-wrap items-center gap-4 hover:border-white/15 transition-colors duration-200">
                          <div className="w-12 h-12 rounded-full flex items-center justify-center text-[#151312] font-black flex-shrink-0"
                            style={{ background: "linear-gradient(135deg, #c98f70, #efcba8)" }}>
                            {nomeVisivel
                              ? nomeVisivel[0].toUpperCase()
                              : <User className="w-5 h-5 opacity-60" strokeWidth={2.5} aria-label={t("dashboard.anonAvatarAlt")} />}
                          </div>
                          {/* Celular (print do Severo, 16/09): o selo "Aguardando resposta do
                              outro membro" é whitespace-nowrap e ficava na mesma linha, então a
                              coluna do texto encolhia a ~50 px e o nome saía uma palavra por
                              linha, com o selo por cima. Com flex-wrap e um mínimo para o texto,
                              o selo (ou os botões de aceitar e recusar) desce para a linha de
                              baixo quando não cabe; na tela larga tudo continua numa linha só. */}
                          <div className="flex-1 min-w-[10rem]">
                            <div className="font-bold">{nomeVisivel || t("dashboard.anonTitle")}</div>
                            {/* Sem o filtro, uma cidade em branco deixava um " · " solto. */}
                            <div className="text-sm text-white/40">{[setor, cidade].filter(Boolean).join(" · ")}</div>
                            {conn.message && <div className="text-xs text-white/25 mt-1 truncate">"{conn.message}"</div>}
                            {/* Item 6.2: `Boolean` porque o driver entrega 1/0 e o `&&`
                                desenhava o zero na tela. */}
                            {esperaPorMim && (
                              <div className="text-xs text-white/35 mt-1">{t("dashboard.acceptRevealHint")}</div>
                            )}
                            {conn.status === "accepted" && (
                              <div className="text-xs text-emerald-400/70 mt-1">{t("dashboard.revealedNote")}</div>
                            )}
                            {/* Item 13.3: a data já vinha de getConnectionsForUser e não
                                era mostrada — sem ela, "aguardando" não tem tamanho. */}
                            {pedidoEm && !Number.isNaN(pedidoEm.getTime()) && (
                              <div className="text-xs text-white/25 mt-1">
                                {t("dashboard.requestedOn", { data: pedidoEm.toLocaleDateString(i18n.language) })}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                            {esperaPorMim ? (
                              <>
                                <button onClick={() => respondMutation.mutate({ connectionId: conn.id, accept: true })}
                                  className="px-4 py-2 rounded-xl text-xs font-bold bg-emerald-400 hover:bg-emerald-500 text-black transition-all duration-200 active:scale-95">
                                  {t("dashboard.acceptReveal")}
                                </button>
                                <button onClick={() => respondMutation.mutate({ connectionId: conn.id, accept: false })}
                                  className="px-4 py-2 rounded-xl text-xs font-medium border border-white/15 text-white/50 hover:border-white/30 hover:text-white transition-all duration-200">
                                  {t("dashboard.decline")}
                                </button>
                              </>
                            ) : (
                              <Badge className={
                                conn.status === "accepted" ? "bg-emerald-400/15 text-emerald-400 border-emerald-400/25"
                                  : conn.status === "pending" || conn.status === "in_review" ? "bg-[#c98f70]/15 text-[#c98f70] border-[#c98f70]/25"
                                    : "bg-white/8 text-white/35 border-white/15"
                              }>
                                {/* Item 13.2: "Aguardando resposta" servia para os dois
                                    lados. Aqui só chega o que espera o OUTRO membro. */}
                                {conn.status === "accepted" ? t("dashboard.connected")
                                  : conn.status === "pending" ? t("dashboard.awaitingOtherReply")
                                    : conn.status === "in_review" ? t("dashboard.inReview")
                                      : conn.status === "not_forwarded" ? t("dashboard.notForwarded")
                                        : t("dashboard.declined")}
                              </Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          )}

          {/* TAB: DEAL ROOMS */}
          {activeTab === "dealrooms" && (
            <DealRoomsTab />
          )}

          {/* TAB: PROFILE */}
          {activeTab === "profile" && (
            <div className="space-y-5">
              {profileQuery.isError ? (
                // Perfil que não pôde ser lido não é "crie seu perfil": o
                // convite mandaria a usuária refazer o onboarding à toa.
                <ErroDeConsulta erro={profileQuery.error} aoTentarDeNovo={() => profileQuery.refetch()} />
              ) : profile ? (
                <>
                  <div className="bg-[#1b1714] border border-white/8 rounded-2xl p-6 animate-fade-in-scale">
                    <div className="flex items-center gap-4 mb-6">
                      <div className="w-18 h-18 w-[72px] h-[72px] rounded-full flex items-center justify-center text-[#151312] font-black text-2xl flex-shrink-0"
                        style={{ background: "linear-gradient(135deg, #c98f70, #efcba8)" }}>
                        {(profile.displayName || "U")[0].toUpperCase()}
                      </div>
                      <div className="flex-1">
                        <h2 className="text-xl font-black">{profile.displayName}</h2>
                        <div className="text-white/40 text-sm">{profile.jobTitle}{profile.jobTitle && profile.city && " · "}{profile.city}</div>
                        <div className="text-xs text-white/25 mt-0.5">{optionLabel(t, profile.primarySpecialty)}</div>
                      </div>
                        <div className="text-right">
                        <div className="text-3xl font-black text-[#c98f70]">{profile.profileCompleteness}%</div>
                        <div className="text-xs text-white/35">{t("dashboard.profileComplete")}</div>
                      </div>
                    </div>

                    {/* Completeness bar */}
                    <div className="h-2 bg-white/8 rounded-full overflow-hidden mb-5">
                      <div className="h-full rounded-full relative overflow-hidden"
                        style={{ width: `${profile.profileCompleteness}%`, background: "linear-gradient(90deg, #c98f70, #efcba8)", transition: "width 1.2s cubic-bezier(0.23,1,0.32,1)" }}>
                        <div className="absolute inset-0 shimmer-bg opacity-40" />
                      </div>
                    </div>

                    {profile.bio && (
                      <p className="text-white/55 text-sm leading-relaxed mb-5 p-4 bg-white/3 rounded-xl border border-white/5">
                        "{profile.bio}"
                      </p>
                    )}

                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {[
                        { label: t("onboarding.specialty"), value: optionLabel(t, profile.primarySpecialty), icon: "⚡" },
                        { label: t("onboarding.sector"), value: sectorLabel(t, i18n, profile.sector), icon: "🌐" },
                        // Plural por chave ("1 ano", "2 anos"; "1 год", "2 года", "5 лет"), não número + "anos".
                        { label: t("onboarding.experience"), value: profile.experienceYears ? t("dashboard.years", { count: profile.experienceYears }) : null, icon: "📅" },
                        // "onboarding.workStyle" é o NÓ das opções (remote/hybrid/…), não um texto: como
                        // rótulo, o i18next devolvia "returned an object instead of string" e o valor saía
                        // cru ("remote"). O rótulo é a folha dashboard.workStyle (a de onboarding.fields
                        // carrega o " *" de obrigatório) e o valor gravado vira "100% Remoto" pelas opções.
                        { label: t("dashboard.workStyle"), value: optionLabel(t, profile.workStyle), icon: "💼" },
                      ].filter(f => f.value).map((field, i) => (
                        <div key={field.label}
                          style={{ animation: `fadeInScale 0.3s cubic-bezier(0.23,1,0.32,1) ${i * 0.07}s both` }}
                          className="bg-white/4 rounded-xl p-3 border border-white/5 hover:border-white/10 transition-colors">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-sm">{field.icon}</span>
                            <span className="text-xs text-white/30">{field.label}</span>
                          </div>
                          <div className="font-semibold text-sm">{field.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-3">
                    {/* "Editar perfil" leva ao PERFIL, não ao cadastro. Mandava
                        para /onboarding, e quem já tinha conta era obrigada a
                        refazer as oito etapas e, no fim delas, a aceitar o Termo
                        Geral — que conta antiga não precisa aceitar (janela B da
                        revisão do Nicolas na #135). Quem ainda não tem perfil
                        continua indo para /onboarding, logo abaixo: lá o
                        cadastro é o caminho certo. */}
                    <Link href="/profile" className="flex-1">
                      <button className="w-full py-3 px-4 rounded-xl font-medium text-sm border border-white/15 text-white/60 hover:border-white/30 hover:text-white transition-all duration-200">
                        ✏️ {t("dashboard.editProfile")}
                      </button>
                    </Link>
                    <button onClick={() => regenerateMutation.mutate()} disabled={regenerateMutation.isPending}
                      className="flex-1 py-3 px-4 rounded-xl font-bold text-sm bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95 shadow-md shadow-[#c98f70]/15 disabled:opacity-60">
                      {regenerateMutation.isPending ? t("dashboard.analyzing") : t("dashboard.reanalyze")}
                    </button>
                  </div>

                  {/* O Perfil edita quase tudo, mas não a especialidade, o setor,
                      a experiência, a escolaridade e "O que você busca?": esses
                      cinco só existem no cadastro. Sem este segundo caminho, o
                      conserto da janela B trocaria uma armadilha (refazer tudo
                      sem querer) por um beco sem saída (não ter como mexer neles).
                      O aviso diz o preço: refazer o cadastro passa de novo pelo
                      Termo Geral. */}
                  <Link href="/onboarding">
                    <button className="mt-2 w-full text-center text-xs text-white/35 hover:text-white/60 transition-colors">
                      {t("dashboard.redoOnboarding")}
                    </button>
                  </Link>
                </>
              ) : (
                <div className="text-center py-20 animate-fade-in-up">
                  <div className="text-6xl mb-5">👤</div>
                  <h3 className="text-2xl font-black mb-2">{t("dashboard.noProfile")}</h3>
                  <p className="text-white/40 mb-8">{t("dashboard.noProfileDesc")}</p>
                  <Link href="/onboarding">
                    <button className="px-8 py-3 rounded-xl font-bold bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] transition-all duration-200 active:scale-95">
                      {t("dashboard.createProfile")}
                    </button>
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
