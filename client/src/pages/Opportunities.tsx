import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { SoNoNavegador } from "@/components/SoNoNavegador";
import { useTranslation } from "react-i18next";
import { opportunitySectorLabel } from "@/lib/opportunity-sectors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Search, Plus, Bookmark, BookmarkCheck, Eye, TrendingUp,
  Globe, Briefcase, DollarSign, Users, Package, Star,
  ShieldCheck, AlertTriangle, AlertCircle, XCircle, Clock, Trash2,
  Filter, ChevronRight, ArrowLeft, Crown
} from "lucide-react";

// ============================================================
// FTS Badge — Frauen Trust Score visual
// ============================================================
export function FTSBadge({ score, level, size = "md" }: {
  score: number;
  level: "green" | "yellow" | "orange" | "red" | "pending";
  size?: "sm" | "md" | "lg";
}) {
  const { t } = useTranslation();
  const colors = {
    green:   { ring: "#22c55e", bg: "rgba(34,197,94,0.15)",   text: "#22c55e", label: t("opportunitiesPage.ftsLabelGreen"),  shortLabel: "🟢 Confiável" },
    yellow:  { ring: "#eab308", bg: "rgba(234,179,8,0.15)",   text: "#eab308", label: t("opportunitiesPage.ftsLabelYellow"), shortLabel: "🟡 Atenção" },
    orange:  { ring: "#f97316", bg: "rgba(249,115,22,0.15)",  text: "#f97316", label: t("opportunitiesPage.ftsLabelOrange"), shortLabel: "🟠 Validação" },
    red:     { ring: "#ef4444", bg: "rgba(239,68,68,0.15)",   text: "#ef4444", label: t("opportunitiesPage.ftsLabelRed"),    shortLabel: "🔴 Baixa" },
    pending: { ring: "#6b7280", bg: "rgba(107,114,128,0.15)", text: "#9ca3af", label: t("opportunitiesPage.ftsLabelPending"), shortLabel: "... Analisando" },
  };
  const c = colors[level];
  const sizes = { sm: 44, md: 60, lg: 80 };
  const dim = sizes[size];
  const r = (dim / 2) - 5;
  const circ = 2 * Math.PI * r;
  const filled = level === "pending" ? 0 : (score / 100) * circ;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: dim, height: dim }}>
        <svg width={dim} height={dim} style={{ transform: "rotate(-90deg)" }}>
          <circle cx={dim / 2} cy={dim / 2} r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={size === "lg" ? 5 : 4} />
          <circle
            cx={dim / 2} cy={dim / 2} r={r}
            fill="none"
            stroke={c.ring}
            strokeWidth={size === "lg" ? 5 : 4}
            strokeDasharray={`${filled} ${circ}`}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.8s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ background: c.bg, borderRadius: "50%" }}>
          {level === "pending" ? (
            <Clock size={size === "lg" ? 20 : 14} color={c.text} />
          ) : (
            <span style={{ color: c.text, fontSize: size === "lg" ? 18 : size === "md" ? 13 : 10, fontWeight: 700, lineHeight: 1 }}>
              {Math.round(score)}
            </span>
          )}
        </div>
      </div>
      {size !== "sm" && (
        <span style={{ color: c.text, fontSize: 10, fontWeight: 600, letterSpacing: "0.05em" }}>
          {c.label}
        </span>
      )}
    </div>
  );
}

// ============================================================
// Ícone por tipo de oportunidade
// ============================================================
function TypeIcon({ type }: { type: string }) {
  const icons: Record<string, React.ReactNode> = {
    offer: <Package size={16} />,
    demand: <TrendingUp size={16} />,
    investment: <DollarSign size={16} />,
    partnership: <Users size={16} />,
    distribution: <Globe size={16} />,
    other: <Briefcase size={16} />,
  };
  return <>{icons[type] ?? <Briefcase size={16} />}</>;
}

const TYPE_LABEL_KEYS: Record<string, string> = {
  offer: "opportunitiesPage.typeOffer",
  demand: "opportunitiesPage.typeDemand",
  investment: "opportunitiesPage.typeInvestment",
  partnership: "opportunitiesPage.typePartnership",
  distribution: "opportunitiesPage.typeDistribution",
  other: "opportunitiesPage.typeOther",
};

// ============================================================
// Card de oportunidade
// ============================================================
const COMPLIANCE_BORDER: Record<string, string> = {
  green:   "hover:border-green-500/50",
  yellow:  "hover:border-yellow-500/50",
  orange:  "hover:border-orange-500/50",
  red:     "hover:border-red-500/50",
  pending: "hover:border-amber-500/40",
};

function OpportunityCard({ opp, isGold, isSaved = false, onToggleSave, onDelete }: {
  opp: any;
  isGold: boolean;
  isSaved?: boolean;
  onToggleSave?: () => void;
  onDelete?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const toggleSave = trpc.opportunities.toggleSave.useMutation({
    onSuccess: (data) => {
      toast.success(data?.saved ? t("opportunitiesPage.toastSaved") : t("opportunitiesPage.toastUnsaved"));
      utils.opportunities.saved.invalidate();
      onToggleSave?.();
    },
  });
  const deleteOpp = trpc.opportunities.deleteOpportunity.useMutation({
    onSuccess: () => {
      toast.success(t("opportunitiesPage.toastDeleteSuccess"));
      utils.opportunities.list.invalidate();
      onDelete?.(opp.id);
    },
    onError: (err: any) => toast.error(err.message || t("opportunitiesPage.toastDeleteError")),
  });
  const level = opp.complianceLevel ?? "pending";
  const borderClass = COMPLIANCE_BORDER[level] ?? "hover:border-amber-500/40";
  const emAnalise = opp.status === "pending";

  return (
    <Link href={`/opportunities/${opp.id}`}>
      <div className={`group relative bg-white/5 border border-white/10 rounded-2xl p-5 ${borderClass} hover:bg-white/8 transition-all duration-200 cursor-pointer card-lift ${emAnalise ? "opacity-80" : ""}`}>
        {emAnalise && (
          <div className="mb-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-yellow-500/15 border border-yellow-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse"/>
            <span className="text-yellow-300 text-xs font-semibold">{t("opportunitiesPage.pendingReviewBadge")}</span>
          </div>
        )}
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 flex items-center justify-center text-amber-400 flex-shrink-0">
              <TypeIcon type={opp.type} />
            </div>
            <div className="min-w-0">
              <h3 className="text-white font-semibold text-sm leading-tight line-clamp-2 group-hover:text-amber-300 transition-colors">
                {opp.title}
              </h3>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <FTSBadge score={opp.frauenTrustScore ?? 0} level={opp.complianceLevel ?? "pending"} size="sm" />
            <button
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleSave.mutate({ opportunityId: opp.id }); }}
              className={`transition-all duration-200 ${
                isSaved
                  ? "text-amber-400 hover:text-amber-300 scale-110"
                  : "text-white/30 hover:text-amber-400"
              }`}
              title={isSaved ? t("opportunitiesPage.unsaveTooltip") : t("opportunitiesPage.saveTooltip")}
            >
              {isSaved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
            </button>
            {isGold && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (confirm(t("opportunitiesPage.confirmDeleteOpportunity", { title: opp.title }))) {
                    deleteOpp.mutate({ opportunityId: opp.id, reason: "Removida por membro Ouro" });
                  }
                }}
                className="text-red-400/50 hover:text-red-400 transition-all duration-200"
                title={t("opportunitiesPage.deleteTooltip")}
                disabled={deleteOpp.isPending}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Description */}
        <p className="text-white/50 text-xs leading-relaxed line-clamp-2 mb-3">
          {opp.description}
        </p>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <Badge variant="outline" className="text-xs border-white/15 text-white/50 bg-transparent px-2 py-0">
            {TYPE_LABEL_KEYS[opp.type] ? t(TYPE_LABEL_KEYS[opp.type]) : opp.type}
          </Badge>
          {opp.sector && (
            <Badge variant="outline" className="text-xs border-white/15 text-white/50 bg-transparent px-2 py-0">
              {opportunitySectorLabel(t, opp.sector)}
            </Badge>
          )}
          {opp.country && (
            <Badge variant="outline" className="text-xs border-white/15 text-white/50 bg-transparent px-2 py-0">
              🌍 {opp.country}
            </Badge>
          )}
          {opp.isConfidential && (
            <Badge className="text-xs bg-amber-500/20 text-amber-300 border-amber-500/30 px-2 py-0">
              {t("opportunitiesPage.goldExclusiveBadge")}
            </Badge>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-white/30">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><Eye size={11} />{opp.viewCount ?? 0}</span>
            <span className="flex items-center gap-1"><Star size={11} />{opp.interestCount ?? 0}</span>
          </div>
          <span className="flex items-center gap-1 text-amber-400/60 group-hover:text-amber-400 transition-colors">
            {t("opportunitiesPage.viewDetails")} <ChevronRight size={11} />
          </span>
        </div>
      </div>
    </Link>
  );
}

// ============================================================
// Skeleton de loading
// ============================================================
function OpportunitySkeleton() {
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-5 space-y-3">
      <div className="flex items-start gap-3">
        <Skeleton className="w-8 h-8 rounded-lg bg-white/10" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-3/4 bg-white/10" />
          <Skeleton className="h-3 w-1/2 bg-white/10" />
        </div>
      </div>
      <Skeleton className="h-2 w-full bg-white/10" />
      <Skeleton className="h-2 w-4/5 bg-white/10" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-16 rounded-full bg-white/10" />
        <Skeleton className="h-5 w-20 rounded-full bg-white/10" />
      </div>
    </div>
  );
}

// ============================================================
// Página principal de oportunidades
// ============================================================
export default function Opportunities() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const isGold = user?.role === "gold" || user?.role === "admin" || user?.role === "president";

  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("all");
  const [complianceLevel, setComplianceLevel] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [showSaved, setShowSaved] = useState(false);

  // Buscar IDs das oportunidades salvas para mostrar o ícone amarelo nos cards
  const { data: savedData, refetch: refetchSaved, isError: salvasFalharam, error: erroDasSalvas } = trpc.opportunities.saved.useQuery(
    undefined,
    { enabled: !!user }
  );
  const savedIds = new Set<number>((savedData ?? []).map((s: any) => s.opportunity?.id ?? s.id).filter(Boolean));

  const { data: opps, isLoading, isError: listaFalhou, error: erroDaLista, refetch: recarregarLista } = trpc.opportunities.list.useQuery({
    search: search || undefined,
    type: type !== "all" ? (type as any) : undefined,
    complianceLevel: complianceLevel !== "all" ? (complianceLevel as any) : undefined,
    limit: 30,
    offset: 0,
  });

  // Etapa 8 — a vitrine coletiva: oportunidades dos contatos que as membras
  // marcaram como públicos. Só o que possui/procura, cidade e país — o servidor
  // nem seleciona os dados pessoais.
  const { data: vitrine, isError: vitrineFalhou, error: erroDaVitrine, refetch: recarregarVitrine } = trpc.network.vitrine.useQuery(undefined, { enabled: !!user });

  // Etapa 10 — o acervo Ouro: contatos que as donas marcaram "Compartilhado
  // com Usuários Ouro". A rota é goldProcedure; aqui só evitamos a chamada
  // (e o erro FORBIDDEN no console) para quem não é Ouro.
  const { data: acervoOuro, isError: acervoFalhou, error: erroDoAcervo, refetch: recarregarAcervo } = trpc.network.acervoOuro.useQuery(undefined, { enabled: isGold });

  return (
    <div className="min-h-screen bg-transparent text-white">
      {/* Header */}
      <div className="border-b border-white/10 bg-[#151312]/95 backdrop-blur-xl sticky top-16 z-30">
        {/* Em 375 px o bloco do título não encolhia (sem min-w-0, um filho de
            flex não desce da largura do conteúdo) e empurrava as ações para
            fora: o botão "Publicar" terminava em 405 px, 30 px além da tela.
            Agora o título encolhe e corta com truncate, e as ações não
            encolhem. O `-m-2 p-2` na seta amplia a área de toque sem mexer no
            desenho. */}
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between gap-2 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/dashboard">
              <button className="-m-2 p-2 text-white/50 hover:text-white transition-colors">
                <ArrowLeft size={18} />
              </button>
            </Link>
            <div className="min-w-0">
              <h1 className="text-white font-bold text-lg leading-tight truncate">{t("opportunitiesPage.pageTitle")}</h1>
              <SoNoNavegador><p className="text-white/40 text-xs truncate">{t("opportunitiesPage.pageSubtitle")}</p></SoNoNavegador>
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {/* Ícone de salvos */}
            {user && (
              <button
                onClick={() => setShowSaved(!showSaved)}
                className={`p-2 rounded-lg border transition-all duration-200 relative ${
                  showSaved
                    ? "border-amber-500/70 bg-amber-500/15 text-amber-400"
                    : savedIds.size > 0
                    ? "border-amber-500/30 text-amber-400/70 hover:text-amber-400"
                    : "border-white/10 text-white/50 hover:text-white"
                }`}
                title={showSaved ? t("opportunitiesPage.viewAllOpportunities") : t("opportunitiesPage.viewSavedTooltip", { count: savedIds.size })}
              >
                {showSaved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
                {savedIds.size > 0 && !showSaved && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 text-black text-[9px] font-bold flex items-center justify-center">
                    {savedIds.size > 9 ? "9+" : savedIds.size}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-2 rounded-lg border transition-colors ${showFilters ? "border-amber-500/50 bg-amber-500/10 text-amber-400" : "border-white/10 text-white/50 hover:text-white"}`}
              title={t("opportunitiesPage.advancedFiltersTooltip")}
            >
              <Filter size={16} />
            </button>
            <Link href="/opportunities/new">
              <Button size="sm" className="bg-amber-500 hover:bg-amber-400 text-black font-semibold gap-1.5">
                <Plus size={14} />
                {t("opportunitiesPage.publishButton")}
              </Button>
            </Link>
          </div>
        </div>

        {/* Barra de pesquisa — sempre visível */}
        <div className="max-w-6xl mx-auto px-4 pb-3">
          <div className="relative">
            <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30" />
            <Input
              placeholder={t("opportunitiesPage.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 pr-4 bg-white/5 border-white/10 text-white placeholder:text-white/30 h-10 text-sm rounded-xl focus:border-amber-500/40 focus:bg-white/8 transition-all"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Filtros avançados (colapsável) */}
        {showFilters && (
          <div className="max-w-6xl mx-auto px-4 pb-4 flex flex-wrap gap-3">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-40 bg-white/5 border-white/10 text-white h-9 text-sm">
                <SelectValue placeholder={t("opportunitiesPage.typeFilterPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="bg-[#211e1b] border-white/10 text-white">
                <SelectItem value="all">{t("opportunitiesPage.allTypes")}</SelectItem>
                <SelectItem value="offer">{t("opportunitiesPage.typeOffer")}</SelectItem>
                <SelectItem value="demand">{t("opportunitiesPage.typeDemand")}</SelectItem>
                <SelectItem value="investment">{t("opportunitiesPage.typeInvestment")}</SelectItem>
                <SelectItem value="partnership">{t("opportunitiesPage.typePartnership")}</SelectItem>
                <SelectItem value="distribution">{t("opportunitiesPage.typeDistribution")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={complianceLevel} onValueChange={setComplianceLevel}>
              <SelectTrigger className="w-44 bg-white/5 border-white/10 text-white h-9 text-sm">
                <SelectValue placeholder={t("opportunitiesPage.trustLevelPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="bg-[#211e1b] border-white/10 text-white">
                <SelectItem value="all">{t("opportunitiesPage.allLevels")}</SelectItem>
                <SelectItem value="green">{t("opportunitiesPage.levelGreen")}</SelectItem>
                <SelectItem value="yellow">{t("opportunitiesPage.levelYellow")}</SelectItem>
                <SelectItem value="orange">{t("opportunitiesPage.levelOrange")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Conteúdo */}
      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Banner Gold */}
        {!isGold && (
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center gap-3">
            <Star size={18} className="text-amber-400 flex-shrink-0" />
            <div>
              <p className="text-amber-300 text-sm font-semibold">{t("opportunitiesPage.goldBannerTitle")}</p>
              <p className="text-amber-300/60 text-xs">{t("opportunitiesPage.goldBannerText")}</p>
            </div>
          </div>
        )}

        {/* Stats rápidas */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { label: t("opportunitiesPage.statsActive"), value: opps?.length ?? "-", icon: <TrendingUp size={14} /> },
            { label: t("opportunitiesPage.statsTrusted"), value: opps?.filter((o: any) => o.complianceLevel === "green").length ?? "-", icon: <ShieldCheck size={14} /> },
            { label: t("opportunitiesPage.typeInvestment"), value: opps?.filter((o: any) => o.type === "investment").length ?? "-", icon: <DollarSign size={14} /> },
            { label: t("opportunitiesPage.statsPartnerships"), value: opps?.filter((o: any) => o.type === "partnership").length ?? "-", icon: <Users size={14} /> },
          ].map((s, i) => (
            <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-3 flex items-center gap-2">
              <span className="text-amber-400">{s.icon}</span>
              <div>
                <p className="text-white font-bold text-lg leading-none">{s.value}</p>
                <p className="text-white/40 text-xs">{s.label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Grid de oportunidades */}
        {showSaved ? (
          /* ---- MODO SALVOS ---- */
          <div>
            <div className="flex items-center gap-2 mb-4">
              <BookmarkCheck size={16} className="text-amber-400" />
              <h2 className="text-white font-semibold text-sm">{t("opportunitiesPage.savedTitle")}</h2>
              <span className="text-white/40 text-xs">({savedIds.size})</span>
            </div>
            {salvasFalharam ? (
              <ErroDeConsulta erro={erroDasSalvas} aoTentarDeNovo={() => refetchSaved()} />
            ) : !savedData || savedIds.size === 0 ? (
              <div className="text-center py-20">
                <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-4">
                  <Bookmark size={24} className="text-white/20" />
                </div>
                <p className="text-white/40 text-sm">{t("opportunitiesPage.savedEmptyTitle")}</p>
                <p className="text-white/25 text-xs mt-1">{t("opportunitiesPage.savedEmptyText")}</p>
                <Button size="sm" variant="ghost" className="mt-4 text-amber-400 hover:text-amber-300" onClick={() => setShowSaved(false)}>
                  {t("opportunitiesPage.viewAllOpportunities")}
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {(savedData ?? []).map((s: any) => {
                  const opp = s.opportunity ?? s;
                  return opp?.id ? (
                    <OpportunityCard
                      key={opp.id}
                      opp={opp}
                      isGold={isGold}
                      isSaved={true}
                      onToggleSave={() => refetchSaved()}
                    />
                  ) : null;
                })}
              </div>
            )}
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <OpportunitySkeleton key={i} />)}
          </div>
        ) : listaFalhou ? (
          // Consulta falhou não é "nenhuma oportunidade encontrada" (regra:
          // banco fora do ar é erro, nunca "sem dados").
          <ErroDeConsulta erro={erroDaLista} aoTentarDeNovo={() => recarregarLista()} />
        ) : !opps?.length ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-4">
              <Briefcase size={24} className="text-white/20" />
            </div>
            <p className="text-white/40 text-sm">{t("opportunitiesPage.emptyTitle")}</p>
            <p className="text-white/25 text-xs mt-1">{t("opportunitiesPage.emptyText")}</p>
            <Link href="/opportunities/new">
              <Button size="sm" className="mt-4 bg-amber-500 hover:bg-amber-400 text-black font-semibold">
                {t("opportunitiesPage.publishOpportunityButton")}
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {opps.map((opp: any) => (
              <OpportunityCard
                key={opp.id}
                opp={opp}
                isGold={isGold}
                isSaved={savedIds.has(opp.id)}
                onToggleSave={() => refetchSaved()}
              />
            ))}
          </div>
        )}

        {/* A vitrine e o acervo somem em silêncio quando a consulta falha —
            aqui o erro fica visível no lugar da seção. */}
        {!showSaved && vitrineFalhou && (
          <div className="mt-10"><ErroDeConsulta erro={erroDaVitrine} aoTentarDeNovo={() => recarregarVitrine()} /></div>
        )}
        {!showSaved && isGold && acervoFalhou && (
          <div className="mt-10"><ErroDeConsulta erro={erroDoAcervo} aoTentarDeNovo={() => recarregarAcervo()} /></div>
        )}

        {/* Vitrine do ecossistema (etapa 8): contatos públicos, sem dados pessoais */}
        {!showSaved && (vitrine?.length ?? 0) > 0 && (
          <div className="mt-10">
            <div className="flex items-center gap-2 mb-1">
              <Globe size={16} className="text-amber-400" />
              <h2 className="text-white font-semibold text-sm">{t("opportunitiesPage.vitrineTitle")}</h2>
              <span className="text-white/40 text-xs">({vitrine!.length})</span>
            </div>
            <p className="text-white/35 text-xs mb-4">
              {t("opportunitiesPage.vitrineDescription")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {vitrine!.map(item => (
                <div key={item.contatoRef} className="bg-white/5 border border-white/10 rounded-xl p-4">
                  <p className="text-white/40 text-xs mb-2">
                    {[item.city, item.country].filter(Boolean).join(", ") || t("opportunitiesPage.locationNotInformed")} {t("opportunitiesPage.refSeparator")} {item.contatoRef}
                  </p>
                  {item.possui.length > 0 && (
                    <div className="mb-2">
                      <p className="text-emerald-300/80 text-xs font-semibold mb-1">{t("opportunitiesPage.hasLabel")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.possui.map((coisa, i) => (
                          <span key={i} className="rounded-full border border-emerald-400/30 px-2.5 py-0.5 text-xs text-emerald-200/80">{coisa.label}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {item.procura.length > 0 && (
                    <div>
                      <p className="text-sky-300/80 text-xs font-semibold mb-1">{t("opportunitiesPage.seeksLabel")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.procura.map((coisa, i) => (
                          <span key={i} className="rounded-full border border-sky-300/30 px-2.5 py-0.5 text-xs text-sky-200/80">{coisa.label}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {item.possui.length === 0 && item.procura.length === 0 && (
                    <p className="text-white/25 text-xs">{t("opportunitiesPage.vitrineNoItems")}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Acervo Ouro (etapa 10): contatos compartilhados pelas donas com membras Ouro.
            A seção aparece para toda Ouro — vazia, explica o que é, senão o recurso é invisível. */}
        {!showSaved && isGold && acervoOuro !== undefined && (
          <div className="mt-10">
            <div className="flex items-center gap-2 mb-1">
              <Crown size={16} className="text-amber-400" />
              <h2 className="text-white font-semibold text-sm">{t("opportunitiesPage.acervoTitle")}</h2>
              <span className="text-white/40 text-xs">({acervoOuro.length})</span>
            </div>
            <p className="text-white/35 text-xs mb-4">
              {t("opportunitiesPage.acervoDescription")}
            </p>
            {acervoOuro.length === 0 && (
              <div className="rounded-xl border border-dashed border-amber-300/20 p-6 text-center text-white/35 text-xs">
                {t("opportunitiesPage.acervoEmpty")}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {acervoOuro!.map(item => (
                <div key={item.contatoRef} className="bg-amber-400/[.04] border border-amber-300/20 rounded-xl p-4">
                  <p className="text-white font-semibold text-sm">{item.fullName}</p>
                  <p className="text-white/50 text-xs mt-0.5">
                    {[item.jobTitle, item.company].filter(Boolean).join(" · ") || t("opportunitiesPage.noJobCompany")}
                  </p>
                  <p className="text-white/40 text-xs mt-0.5 mb-2">
                    {[item.city, item.country].filter(Boolean).join(", ") || t("opportunitiesPage.locationNotInformed")}
                    {item.compartilhadoPor ? ` ${t("opportunitiesPage.sharedByPrefix", { name: item.compartilhadoPor })}` : ""}
                  </p>
                  {(item.profileTags?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {item.profileTags!.map((tag, i) => (
                        <span key={i} className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs text-white/60">{tag}</span>
                      ))}
                    </div>
                  )}
                  {item.possui.length > 0 && (
                    <div className="mb-2">
                      <p className="text-emerald-300/80 text-xs font-semibold mb-1">{t("opportunitiesPage.hasLabel")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.possui.map((coisa, i) => (
                          <span key={i} className="rounded-full border border-emerald-400/30 px-2.5 py-0.5 text-xs text-emerald-200/80">{coisa.label}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {item.procura.length > 0 && (
                    <div>
                      <p className="text-sky-300/80 text-xs font-semibold mb-1">{t("opportunitiesPage.seeksLabel")}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {item.procura.map((coisa, i) => (
                          <span key={i} className="rounded-full border border-sky-300/30 px-2.5 py-0.5 text-xs text-sky-200/80">{coisa.label}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
