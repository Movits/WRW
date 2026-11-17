import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ExcluirMinhaConta } from "@/components/ExcluirMinhaConta";
import { ConexaoGoogleAgenda } from "@/components/ConexaoGoogleAgenda";
import { TravaDoApp } from "@/components/TravaDoApp";
import { AssistenteDeTexto } from "@/components/AssistenteDeTexto";
import { QualificacaoDoPerfil } from "@/components/QualificacaoDoPerfil";
import { LIMITE_DA_BIO_GRAVADA } from "@shared/apresentacao";
import { DemandasDoPerfil, EditorDoQuePreciso } from "@/components/OQuePreciso";
import { categoriasPendentes, demandasParaGravar, lerDemandas, type DemandaDetalhada } from "@shared/o-que-preciso";
import { toast } from "sonner";
import { exigeCadastroEmpresarial, mascararCadastroEmpresarial, normalizarCadastroEmpresarial } from "@shared/business-registration";
import { sortOptionsAlphabetically, sortTextAlphabetically } from "@shared/option-sorting";
import { rotulosComLegado } from "@shared/setores";
import {
  ArrowLeft, User, Briefcase, Globe, Link2, Edit2, Save,
  MapPin, Building, X, Plus, CheckCircle, Network, Tag,
  Shield, Star, Crown
} from "lucide-react";

// ─── Constantes ───────────────────────────────────────────────────────────────
// Os "Setores de interesse" saíram daqui: a lista vem da fonte ÚNICA em
// shared/setores.ts, a mesma do cadastro e de "Nova Oportunidade" (reteste v4,
// item 7). `rotulosComLegado` acrescenta o que a usuária já tinha gravado e não
// está mais na lista (ex.: o antigo "Tecnologia", hoje "Tecnologia & Software"),
// para nenhuma seleção antiga sumir da tela. Havia ainda uma constante SECTORS
// idêntica, sem nenhum uso, apagada junto.

const LANGUAGES_LIST = [
  "Português", "English", "Español", "Français", "Deutsch",
  "中文", "日本語", "العربية", "हिन्दी", "Русский",
];

const COUNTRIES = [
  { code: "BR", chave: "newOpportunity.countryBrasil" }, { code: "PT", chave: "newOpportunity.countryPortugal" },
  { code: "US", chave: "newOpportunity.countryEstadosUnidos" }, { code: "AR", chave: "newOpportunity.countryArgentina" },
  { code: "CL", chave: "newOpportunity.countryChile" }, { code: "CO", chave: "newOpportunity.countryColombia" },
  { code: "MX", chave: "newOpportunity.countryMexico" }, { code: "ES", chave: "newOpportunity.countryEspanha" },
  { code: "FR", chave: "newOpportunity.countryFranca" }, { code: "DE", chave: "newOpportunity.countryAlemanha" },
  { code: "GB", chave: "newOpportunity.countryReinoUnido" }, { code: "IT", chave: "newOpportunity.countryItalia" },
  { code: "CN", chave: "newOpportunity.countryChina" }, { code: "JP", chave: "newOpportunity.countryJapao" },
  { code: "IN", chave: "newOpportunity.countryIndia" }, { code: "ZA", chave: "newOpportunity.countryAfricaDoSul" },
  { code: "NG", chave: "newOpportunity.countryNigeria" }, { code: "AE", chave: "newOpportunity.countryEmiradosArabes" },
];

// Tags "O que tenho" — a MESMA lista do Onboarding; as chaves ficam em
// `oQueTenho.*` para as duas telas lerem o mesmo rótulo, como já acontece com
// "O que preciso" (shared/o-que-preciso.ts).
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

// "O que preciso": as 17 categorias e a segunda camada vivem em shared/o-que-preciso.ts
// e components/OQuePreciso.tsx (Rosber, 14/09), as mesmas do Onboarding.

// ─── Componente de Tag Selecionável ───────────────────────────────────────────
// CAIXA ALTA nos títulos das categorias, como no cadastro (revisão de 15/09): a
// regra vale para as DUAS listas de seleção — "O que tenho" (este cartão) e "O
// que preciso" (components/OQuePreciso.tsx) — e para as duas telas em que elas
// aparecem. Aqui tinha ficado pela metade: "O que preciso" já saía em caixa alta
// por morar no componente compartilhado, e esta lista, logo acima dela, não.
// Nada mais do Perfil muda: setores de interesse são outra lista, e título de
// seção não é título de categoria. É por CSS, nunca reescrevendo o texto dos 10
// JSONs — árabe, chinês e japonês não têm caixa, e `text-transform` não os toca.
// Guarda: client/src/pages/Profile.caixa-dos-titulos.test.tsx.
function TagButton({
  icon, label, selected, onClick,
}: { icon: string; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl border text-sm font-medium transition-all duration-200 active:scale-95 ${
        selected
          ? "bg-amber-500/20 border-amber-500/60 text-amber-300 shadow-sm shadow-amber-500/10"
          : "bg-white/3 border-white/10 text-white/50 hover:border-white/25 hover:text-white/75 hover:bg-white/6"
      }`}
    >
      <span className="text-base leading-none">{icon}</span>
      <span className="uppercase">{label}</span>
      {selected && <CheckCircle size={13} className="text-amber-400 ml-auto" />}
    </button>
  );
}

// ─── Componente de Seção ──────────────────────────────────────────────────────
function Section({
  icon, title, subtitle, children,
}: { icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#1b1714] border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-6 pt-6 pb-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            {icon}
          </div>
          <div>
            <h2 className="text-white font-bold text-base leading-tight">{title}</h2>
            <p className="text-white/40 text-xs mt-0.5">{subtitle}</p>
          </div>
        </div>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────
export default function Profile() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.profile.get.useQuery();
  const profile = data?.profile;

  const [editing, setEditing] = useState(false);

  // Seção 1 — Quem sou
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [company, setCompany] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("BR");
  const [gender, setGender] = useState<"" | "male" | "female" | "prefer_not_to_say">("");
  const [personType, setPersonType] = useState<"" | "individual" | "legal_entity" | "mei" | "nonprofit">("");
  const [companySize, setCompanySize] = useState<"" | "mei" | "micro" | "small" | "medium" | "large">("");
  const [companyCnpj, setCompanyCnpj] = useState("");
  const [activityArea, setActivityArea] = useState("");
  const [institutionalNetwork, setInstitutionalNetwork] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");

  // Seção 1 — tags de setores de interesse
  const [interestSectors, setInterestSectors] = useState<string[]>([]);

  // Seção 2 — O que tenho
  const [whatIHave, setWhatIHave] = useState<string[]>([]);

  // Seção 3 — O que preciso
  const [whatINeed, setWhatINeed] = useState<string[]>([]);
  // A segunda camada (14/09): as demandas detalhadas e as categorias que já estavam gravadas ao abrir a edição.
  const [whatINeedDetails, setWhatINeedDetails] = useState<DemandaDetalhada[]>([]);
  const [categoriasJaSalvas, setCategoriasJaSalvas] = useState<string[]>([]);

  const startEditing = () => {
    setDisplayName(profile?.displayName || user?.name || "");
    setBio(profile?.bio || "");
    setCompany((profile as any)?.company || "");
    setJobTitle((profile as any)?.jobTitle || "");
    setCity(profile?.city || "");
    setCountry(profile?.country || "BR");
    const savedGender = (profile as any)?.gender;
    setGender(savedGender === "male" || savedGender === "female" || savedGender === "prefer_not_to_say" ? savedGender : "");
    const savedPersonType = (profile as any)?.personType;
    setPersonType(savedPersonType === "individual" || savedPersonType === "legal_entity" || savedPersonType === "mei" || savedPersonType === "nonprofit" ? savedPersonType : "");
    const savedCompanySize = (profile as any)?.companySize;
    setCompanySize(savedCompanySize === "mei" || savedCompanySize === "micro" || savedCompanySize === "small" || savedCompanySize === "medium" || savedCompanySize === "large" ? savedCompanySize : "");
    setCompanyCnpj((profile as any)?.companyCnpj || "");
    setActivityArea((profile as any)?.activityArea || "");
    setInstitutionalNetwork((profile as any)?.institutionalNetwork || "");
    setLinkedinUrl(profile?.linkedinUrl || "");
    setWebsiteUrl(profile?.websiteUrl || "");
    setInterestSectors(Array.isArray((profile as any)?.interestSectors) ? (profile as any).interestSectors : []);
    setWhatIHave(Array.isArray((profile as any)?.whatIHave) ? (profile as any).whatIHave : []);
    const necessidadesSalvas: string[] = Array.isArray((profile as any)?.whatINeed) ? (profile as any).whatINeed : [];
    setWhatINeed(necessidadesSalvas);
    setWhatINeedDetails(lerDemandas((profile as any)?.whatINeedDetails));
    setCategoriasJaSalvas(necessidadesSalvas);
    setEditing(true);
  };

  const updateMutation = trpc.profile.update.useMutation({
    onSuccess: (resultado) => {
      toast.success(t("profile.updated"));
      utils.profile.get.invalidate();
      // Bronze que qualificou o perfil saiu Prata no servidor: o selo e o cartão
      // de qualificação leem o nível de auth.me, que precisa ser relido.
      if (resultado?.promovidaAPrata) {
        toast.success(t("governanca.perfil.promovida"));
        utils.auth.me.invalidate();
      }
      setEditing(false);
    },
    onError: (err) => {
      // Erros de validação do zod chegam como JSON serializado; mostrar só a
      // primeira mensagem em vez do array cru.
      let msg = err.message;
      try { const issues = JSON.parse(err.message); if (Array.isArray(issues) && issues[0]?.message) msg = issues[0].message; } catch { /* mensagem simples */ }
      toast.error(msg);
    },
  });

  const handleSave = () => {
    if (exigeCadastroEmpresarial(personType) && !normalizarCadastroEmpresarial(companyCnpj)) {
      toast.error(t("profile.business.registrationNumberRequired"));
      return;
    }
    // "O que preciso": categoria marcada nesta edição precisa de demanda detalhada e válida;
    // as que o perfil já tinha gravadas sem detalhe seguem valendo (toleradas).
    const pendentes = categoriasPendentes(whatINeed, whatINeedDetails, categoriasJaSalvas);
    if (pendentes.length > 0) {
      toast.error(t("oQuePreciso.faltaDetalhar", { categorias: pendentes.map(chave => t(`oQuePreciso.categorias.${chave}.titulo`)).join(", ") }));
      return;
    }
    updateMutation.mutate({
      displayName,
      bio,
      company,
      jobTitle,
      city,
      country,
      gender: gender || undefined,
      personType: personType || undefined,
      companySize: personType === "mei" ? "mei" : companySize || undefined,
      companyCnpj: personType !== "individual" ? normalizarCadastroEmpresarial(companyCnpj) || undefined : undefined,
      activityArea,
      institutionalNetwork,
      linkedinUrl,
      websiteUrl,
      interestSectors,
      whatIHave,
      whatINeed,
      // Cada demanda separada, sem as em branco; o servidor valida de novo.
      whatINeedDetails: demandasParaGravar(whatINeed, whatINeedDetails),
    });
  };

  const toggleTag = (list: string[], setList: (v: string[]) => void, id: string) => {
    setList(list.includes(id) ? list.filter(i => i !== id) : [...list, id]);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-transparent text-white flex items-center justify-center">
        {/* A MESMA largura da tela carregada (max-w-6xl px-4 sm:px-6, logo
            abaixo). O esqueleto era mais estreito, então a página "pulava" de
            largura quando o perfil chegava — achado do Nicolas na #136. */}
        <div className="space-y-4 w-full max-w-6xl px-4 sm:px-6">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 bg-white/5 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const profileWhatIHave = Array.isArray((profile as any)?.whatIHave) ? (profile as any).whatIHave as string[] : [];
  const profileWhatINeed = Array.isArray((profile as any)?.whatINeed) ? (profile as any).whatINeed as string[] : [];
  const profileInterestSectors = Array.isArray((profile as any)?.interestSectors) ? (profile as any).interestSectors as string[] : [];

  const nomeDoPais = (codigo?: string | null) => {
    const pais = COUNTRIES.find(c => c.code === codigo);
    return pais ? t(pais.chave) : codigo ?? "";
  };

  return (
    <div className="min-h-screen bg-transparent text-white">
      {/* Barra da página, logo abaixo do cabeçalho da área logada (que já tem
          o logo, o menu, o sino e o idioma — ver App.tsx): aqui ficam só o
          "voltar" e o que é do perfil. O logo saiu daqui para não aparecer
          duas vezes na mesma tela. */}
      <nav className="border-b border-white/5 px-6 py-4 flex items-center justify-between gap-3 sticky top-16 z-30 bg-[#151312]/95 backdrop-blur-xl">
        <Link href="/dashboard">
          <span className="flex items-center gap-2 text-white/50 hover:text-white transition-colors cursor-pointer text-sm">
            <ArrowLeft size={16} />
            {t("profile.backToHome")}
          </span>
        </Link>
        {editing ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} className="text-white/40 hover:text-white/70">
              {t("profile.cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}
              className="bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
              <Save size={14} />
              {updateMutation.isPending ? t("profile.saving") : t("profile.save")}
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={startEditing}
            className="bg-white/8 hover:bg-white/15 border border-white/15 text-white gap-2">
            <Edit2 size={14} />
            {t("profile.editProfile")}
          </Button>
        )}
      </nav>

      {/* Mesma largura padrão das outras telas de app — ver Network.tsx. */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-5">

        {/* Header do perfil */}
        <div className="flex items-center gap-4 mb-2">
          <div className="relative">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-[#151312] font-black text-2xl flex-shrink-0"
              style={{ background: "linear-gradient(135deg, #c98f70, #efcba8)" }}>
              {(profile?.displayName || user?.name || "U")[0].toUpperCase()}
            </div>
            {/* Indicador de nível no avatar */}
            {user?.role === "president" && (
              <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-purple-500 border-2 border-[#151312] flex items-center justify-center">
                <Crown size={11} className="text-white" />
              </div>
            )}
            {user?.role === "gold" && (
              <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-amber-400 border-2 border-[#151312] flex items-center justify-center">
                <Star size={11} className="text-[#151312]" />
              </div>
            )}
            {user?.role === "silver" && (
              <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-slate-400 border-2 border-[#151312] flex items-center justify-center">
                <Shield size={11} className="text-white" />
              </div>
            )}
            {user?.role === "bronze" && (
              <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full border-2 border-[#151312] flex items-center justify-center" style={{ background: "#8e5a3f" }}>
                <Shield size={11} className="text-white" />
              </div>
            )}
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-white font-bold text-xl">{profile?.displayName || user?.name}</h1>
              {/* Badge de nível */}
              {user?.role === "president" && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-400/15 text-amber-300 border border-amber-400/30">
                  <Crown size={10} /> {t("profile.badgeGold")}
                </span>
              )}
              {user?.role === "gold" && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-400/15 text-amber-300 border border-amber-400/30">
                  <Star size={10} /> {t("profile.badgeGold")}
                </span>
              )}
              {user?.role === "silver" && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-slate-400/15 text-slate-300 border border-slate-400/30">
                  <Shield size={10} /> {t("profile.badgeSilver")}
                </span>
              )}
              {user?.role === "bronze" && (
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold border" style={{ background: "rgba(205,127,50,0.15)", color: "#c98f70", borderColor: "rgba(205,127,50,0.3)" }}>
                  <Shield size={10} /> {t("profile.badgeBronze")}
                </span>
              )}
            </div>
            <p className="text-white/50 text-sm">{user?.email}</p>
            {(profile as any)?.jobTitle && (
              <p className="text-white/40 text-xs mt-0.5">
                {(profile as any).jobTitle}
                {(profile as any)?.company && ` · ${(profile as any).company}`}
              </p>
            )}
          </div>
        </div>

        {/* Governança: quem é Bronze vê o que falta para a Prata. Em edição, a
            régua lê o que está SENDO digitado nos seis campos que ela mede: com
            o perfil salvo, o número ficava parado ao lado do texto que a pessoa
            reescrevia justamente para sair da recusa, e medir só a bio prometia
            Prata para um estado que o Salvar não grava (revisão de 16/09 na #135,
            item 8). */}
        <QualificacaoDoPerfil
          role={user?.role}
          perfil={editing ? { ...(profile ?? {}), displayName, city, activityArea, whatIHave, whatINeed, bio } : profile}
          onCompletar={editing ? undefined : startEditing}
        />

        {/* ── SEÇÃO 1: QUEM SOU ── */}
        <Section
          icon={<User size={16} />}
          title={t("profile.sections.whoIAmTitle")}
          subtitle={t("profile.sections.whoIAmSubtitle")}
        >
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.displayName")}</label>
                  <Input value={displayName} onChange={e => setDisplayName(e.target.value)}
                    placeholder={t("profile.fields.displayNamePlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.company")}</label>
                  <Input value={company} onChange={e => setCompany(e.target.value)}
                    placeholder={t("profile.fields.companyPlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.business.personType")}</label>
                  <Select value={personType} onValueChange={value => {
                    const next = value as typeof personType;
                    setPersonType(next);
                    setCompanySize(next === "mei" ? "mei" : "");
                    if (next === "individual") setCompanyCnpj("");
                  }}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:border-amber-500/50"><SelectValue placeholder={t("profile.business.personTypePlaceholder")} /></SelectTrigger>
                    <SelectContent className="bg-[#1b1714] border-white/10 text-white">
                      {sortOptionsAlphabetically([
                        { value: "individual", label: t("profile.business.individual") },
                        { value: "legal_entity", label: t("profile.business.legalEntity") },
                        { value: "mei", label: t("profile.business.mei") },
                        { value: "nonprofit", label: t("profile.business.nonprofit") },
                      ], i18n.language).map(option => (
                        <SelectItem key={option.value} value={option.value} className="text-white">{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.jobTitle")}</label>
                  <Input value={jobTitle} onChange={e => setJobTitle(e.target.value)}
                    placeholder={t("profile.fields.jobTitlePlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.activityArea")}</label>
                  <Input value={activityArea} onChange={e => setActivityArea(e.target.value)}
                    placeholder={t("profile.fields.activityAreaPlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.country")}</label>
                  <Select value={country} onValueChange={setCountry}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:border-amber-500/50">
                      <SelectValue placeholder={t("profile.fields.countryPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1b1714] border-white/10 text-white">
                      {sortOptionsAlphabetically(COUNTRIES.map(country => ({ ...country, label: t(country.chave) })), i18n.language).map(c => (
                        <SelectItem key={c.code} value={c.code} className="text-white hover:bg-white/10 focus:bg-white/10">{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.city")}</label>
                  <Input value={city} onChange={e => setCity(e.target.value)}
                    placeholder={t("profile.fields.cityPlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.gender.label")}</label>
                  <Select value={gender} onValueChange={value => setGender(value as typeof gender)}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white focus:border-amber-500/50">
                      <SelectValue placeholder={t("profile.gender.placeholder")} />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1b1714] border-white/10 text-white">
                      {sortOptionsAlphabetically([
                        { value: "male", label: t("profile.gender.male") },
                        { value: "female", label: t("profile.gender.female") },
                        { value: "prefer_not_to_say", label: t("profile.gender.preferNotToSay") },
                      ], i18n.language).map(option => (
                        <SelectItem key={option.value} value={option.value} className="text-white hover:bg-white/10 focus:bg-white/10">{option.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {exigeCadastroEmpresarial(personType) && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.business.companySize")}</label>
                    <Select value={companySize} onValueChange={value => setCompanySize(value as typeof companySize)}>
                      <SelectTrigger className="bg-white/5 border-white/10 text-white focus:border-amber-500/50"><SelectValue placeholder={t("profile.business.companySizePlaceholder")} /></SelectTrigger>
                      <SelectContent className="bg-[#1b1714] border-white/10 text-white">
                        {personType === "mei" ? (
                          <SelectItem value="mei" className="text-white">{t("profile.business.sizeMei")}</SelectItem>
                        ) : (
                          sortOptionsAlphabetically([
                            { value: "micro", label: t("profile.business.sizeMicro") },
                            { value: "small", label: t("profile.business.sizeSmall") },
                            { value: "medium", label: t("profile.business.sizeMedium") },
                            { value: "large", label: t("profile.business.sizeLarge") },
                          ], i18n.language).map(option => (
                            <SelectItem key={option.value} value={option.value} className="text-white">{option.label}</SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.business.registrationNumber")}</label>
                    {/* Durante a composição do IME (japonês, chinês) o texto não é mexido: trocá-lo no meio a interrompe. */}
                    <Input value={companyCnpj}
                      onChange={e => setCompanyCnpj((e.nativeEvent as InputEvent).isComposing ? e.target.value : normalizarCadastroEmpresarial(e.target.value))}
                      onCompositionEnd={e => setCompanyCnpj(normalizarCadastroEmpresarial(e.currentTarget.value))}
                      placeholder={t("profile.business.registrationNumberPlaceholder")}
                      className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                  </div>
                </div>
              )}

              <div>
                <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.institutionalNetwork")}</label>
                <Input value={institutionalNetwork} onChange={e => setInstitutionalNetwork(e.target.value)}
                  placeholder={t("profile.fields.institutionalNetworkPlaceholder")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>

              <div>
                <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">{t("profile.fields.bio")}</label>
                <Textarea value={bio} onChange={e => setBio(e.target.value)}
                  placeholder={t("profile.fields.bioPlaceholder")}
                  rows={3}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50 resize-none" />
                {/* Gravar áudio e Revisar texto: só mudam o campo; salvar continua sendo o botão do Perfil. */}
                <AssistenteDeTexto valor={bio} onChange={setBio} />
                {bio.length > LIMITE_DA_BIO_GRAVADA && (
                  <p className="text-xs text-red-400/80 mt-1">{t("assistenteTexto.textoLongo", { maximo: LIMITE_DA_BIO_GRAVADA })}</p>
                )}
              </div>

              <div>
                <label className="text-xs text-white/40 uppercase tracking-wider mb-2 block">{t("onboarding.misc.interestSectors")}</label>
                <div className="flex flex-wrap gap-2">
                  {sortTextAlphabetically(rotulosComLegado(t, interestSectors), i18n.language).map(s => (
                    <button key={s} type="button" onClick={() => toggleTag(interestSectors, setInterestSectors, s)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-200 ${
                        interestSectors.includes(s)
                          ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                          : "bg-white/3 border-white/10 text-white/45 hover:border-white/25 hover:text-white/70"
                      }`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">LinkedIn</label>
                  <Input value={linkedinUrl} onChange={e => setLinkedinUrl(e.target.value)}
                    placeholder={t("profile.fields.linkedinPlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/40 uppercase tracking-wider mb-1.5 block">Website</label>
                  <Input value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)}
                    placeholder={t("profile.fields.websitePlaceholder")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {profile?.bio && (
                <p className="text-white/60 text-sm leading-relaxed">{profile.bio}</p>
              )}
              <div className="grid grid-cols-2 gap-3">
                {[(profile as any)?.company && { icon: <Building size={13} />, label: (profile as any).company },
                  (profile as any)?.jobTitle && { icon: <Briefcase size={13} />, label: (profile as any).jobTitle },
                  (profile as any)?.activityArea && { icon: <Tag size={13} />, label: (profile as any).activityArea },
                  (profile as any)?.personType && { icon: <Building size={13} />, label: t(`profile.business.${(profile as any).personType === "legal_entity" ? "legalEntity" : (profile as any).personType}`) },
                  (profile as any)?.companySize && { icon: <Building size={13} />, label: t(`profile.business.size${String((profile as any).companySize).charAt(0).toUpperCase()}${String((profile as any).companySize).slice(1)}`) },
                  (profile as any)?.companyCnpj && { icon: <Building size={13} />, label: `${t("profile.business.registrationNumber")}: ${mascararCadastroEmpresarial((profile as any).companyCnpj)}` },
                  (profile?.city || profile?.country) && { icon: <MapPin size={13} />, label: [profile?.city, nomeDoPais(profile?.country)].filter(Boolean).join(", ") },
                  // O banco guarda "prefer_not_to_say" e a chave de tradução é
                  // "preferNotToSay": interpolar o valor cru punha o nome da
                  // chave na tela, nos dez idiomas. O cadastro já fazia esta
                  // conversão na revisão; o Perfil não fazia — e a tela ficou
                  // mais visível nesta entrega, porque "Editar perfil" passou a
                  // levar para cá.
                  (profile as any)?.gender && { icon: <User size={13} />, label: t(`profile.gender.${(profile as any).gender === "prefer_not_to_say" ? "preferNotToSay" : (profile as any).gender}`) },
                  (profile as any)?.institutionalNetwork && { icon: <Network size={13} />, label: (profile as any).institutionalNetwork },
                  profile?.linkedinUrl && { icon: <Link2 size={13} />, label: "LinkedIn", href: profile.linkedinUrl },
                  profile?.websiteUrl && { icon: <Globe size={13} />, label: "Website", href: profile.websiteUrl },
                ].filter(Boolean).map((item: any, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-white/55">
                    <span className="text-white/30">{item.icon}</span>
                    {item.href ? (
                      <a href={item.href} target="_blank" rel="noopener noreferrer" className="hover:text-amber-400 transition-colors truncate">{item.label}</a>
                    ) : (
                      <span className="truncate">{item.label}</span>
                    )}
                  </div>
                ))}
              </div>
              {profileInterestSectors.length > 0 && (
                <div>
                  <p className="text-xs text-white/30 uppercase tracking-wider mb-2">{t("onboarding.misc.interestSectors")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {profileInterestSectors.map((s: string) => (
                      <span key={s} className="px-2.5 py-1 rounded-full bg-amber-500/8 border border-amber-500/20 text-xs text-amber-300/70">{s}</span>
                    ))}
                  </div>
                </div>
              )}
              {!profile?.bio && !(profile as any)?.company && !(profile as any)?.jobTitle && (
                <div className="text-center py-6">
                  <p className="text-white/30 text-sm">{t("profile.sections.noProfessionalInfo")}</p>
                  <button onClick={startEditing} className="text-amber-400 text-sm mt-1 hover:text-amber-300 transition-colors">
                    {t("profile.sections.clickToEdit")}
                  </button>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* ── SEÇÃO 2: O QUE TENHO ── */}
        <Section
          icon={<span className="text-sm">✦</span>}
          title={t("profile.sections.whatIHaveTitle")}
          subtitle={t("profile.sections.whatIHaveSubtitle")}
        >
          {editing ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {sortOptionsAlphabetically(WHAT_I_HAVE_OPTIONS.map(o => ({ ...o, label: t(o.chave) })), i18n.language).map(opt => (
                <TagButton
                  key={opt.id}
                  icon={opt.icon}
                  label={opt.label}
                  selected={whatIHave.includes(opt.id)}
                  onClick={() => toggleTag(whatIHave, setWhatIHave, opt.id)}
                />
              ))}
            </div>
          ) : (
            profileWhatIHave.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {sortOptionsAlphabetically(WHAT_I_HAVE_OPTIONS.filter(o => profileWhatIHave.includes(o.id)).map(o => ({ ...o, label: t(o.chave) })), i18n.language).map(opt => (
                  <div key={opt.id} className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-amber-500/8 border border-amber-500/20">
                    <span className="text-base">{opt.icon}</span>
                    {/* Mesma caixa alta dos cartões de edição: é a mesma lista,
                        e a leitura de "O que preciso" logo abaixo já sai assim
                        (DemandasDoPerfil, em components/OQuePreciso.tsx). */}
                    <span className="text-sm text-amber-300/80 font-medium uppercase">{opt.label}</span>
                    <CheckCircle size={13} className="text-amber-400 ml-auto" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6">
                <p className="text-white/30 text-sm">{t("profile.sections.noAssets")}</p>
                <button onClick={startEditing} className="text-amber-400 text-sm mt-1 hover:text-amber-300 transition-colors">
                  {t("profile.sections.clickToEdit")}
                </button>
              </div>
            )
          )}
        </Section>

        {/* ── SEÇÃO 3: O QUE PRECISO ── */}
        <Section
          icon={<span className="text-sm">◈</span>}
          title={t("profile.sections.whatINeedTitle")}
          subtitle={t("profile.sections.whatINeedSubtitle")}
        >
          {editing ? (
            // Os mesmos 17 cartões e a mesma segunda camada do Onboarding (components/OQuePreciso.tsx).
            <div className="space-y-4">
              <div>
                <p className="text-white/40 text-sm">{t("oQuePreciso.textoExplicativo")}</p>
                <p className="text-white/25 text-xs mt-1">{t("oQuePreciso.fraseDiscreta")}</p>
              </div>
              <EditorDoQuePreciso
                variante="perfil"
                valor={{ categorias: whatINeed, demandas: whatINeedDetails }}
                onChange={({ categorias, demandas }) => { setWhatINeed(categorias); setWhatINeedDetails(demandas); }}
                toleradas={categoriasJaSalvas}
              />
            </div>
          ) : (
            profileWhatINeed.length > 0 ? (
              // Categoria nova com as demandas detalhadas; chave antiga ("consultoria") com o rótulo dela.
              <DemandasDoPerfil whatINeed={profileWhatINeed} whatINeedDetails={(profile as any)?.whatINeedDetails} />
            ) : (
              <div className="text-center py-6">
                <p className="text-white/30 text-sm">{t("profile.sections.noDemands")}</p>
                <button onClick={startEditing} className="text-amber-400 text-sm mt-1 hover:text-amber-300 transition-colors">
                  {t("profile.sections.clickToEdit")}
                </button>
              </div>
            )
          )}
        </Section>

        {/* A Google Agenda (H16b): só aparece com a função disponível no
            servidor; fora da edição, como a zona de risco abaixo. */}
        {!editing && <ConexaoGoogleAgenda />}

        {/* A trava do app das lojas (Face ID ou digital ao abrir): só aparece
            dentro do app, que guarda a escolha e pede a biometria. */}
        {!editing && <TravaDoApp />}

        {/* Zona de risco: o caminho de saída da plataforma (não durante a edição,
            para não competir com o botão de salvar) */}
        {!editing && <ExcluirMinhaConta />}

        {/* Botão de salvar no rodapé (mobile) */}
        {editing && (
          <div className="sticky bottom-4 flex gap-3 pt-2">
            <Button variant="ghost" onClick={() => setEditing(false)}
              className="flex-1 border border-white/10 text-white/50 hover:text-white hover:bg-white/5">
              {t("profile.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending}
              className="flex-1 bg-amber-500 hover:bg-amber-400 text-black font-bold gap-2">
              <Save size={14} />
              {updateMutation.isPending ? t("profile.saving") : t("profile.saveProfile")}
            </Button>
          </div>
        )}

      </div>
    </div>
  );
}
