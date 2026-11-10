import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, Briefcase, Brain, ChevronDown, Crown, LogOut,
  MapPin, Menu as MenuIcon, Mic, Network, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "@/components/NotificationBell";
import { ROTA_DAS_REUNIOES } from "@shared/rotas";
import { BrandMark } from "@/components/BrandLogo";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { LANGUAGES } from "@/i18n";

// Header único da área logada. Antes, cada página montava o seu: eram 16
// variações com 5 cores de fundo, 3 ícones de "voltar" e 4 páginas sem header
// nenhum — e o menu de navegação global só existia no Dashboard, obrigando a
// voltar lá para trocar de área. O logo aponta para /dashboard de propósito:
// apontar para a landing fazia quem clicasse nele "sair" do app sem querer.

type Traduzir = (key: string) => string;

// Função, não constante de módulo: os rótulos dependem de t(), que só existe
// dentro de um componente (molde: getNiveisDeVisibilidade em Network.tsx). O
// array fixo em português era o motivo de a navegação primária do app inteiro
// sair em pt-BR para as outras 9 línguas, ao lado de um título já traduzido.
// Reuniões vem em primeiro: o gravador é a primeira coisa que a cliente quer
// ver depois do login (pedido de 20/10/2026; ver shared/rotas.ts).
export function getMenuItems(t: Traduzir) {
  return [
    { href: ROTA_DAS_REUNIOES, icon: Mic, label: t("appHeader.menu.meetings"), desc: t("appHeader.menu.meetingsDesc") },
    { href: "/meu-network-inteligente", icon: Network, label: t("appHeader.menu.smartNetwork"), desc: t("appHeader.menu.smartNetworkDesc") },
    { href: "/opportunities", icon: Briefcase, label: t("appHeader.menu.opportunities"), desc: t("appHeader.menu.opportunitiesDesc") },
    { href: "/verification", icon: ShieldCheck, label: t("appHeader.menu.verification"), desc: t("appHeader.menu.verificationDesc") },
    { href: "/network", icon: Users, label: t("appHeader.menu.network"), desc: t("appHeader.menu.networkDesc") },
    { href: "/contexts", icon: MapPin, label: t("appHeader.menu.contexts"), desc: t("appHeader.menu.contextsDesc") },
    { href: "/memory", icon: Brain, label: t("appHeader.menu.memory"), desc: t("appHeader.menu.memoryDesc") },
    { href: "/intelligent-matches", icon: Sparkles, label: t("appHeader.menu.intelligentMatches"), desc: t("appHeader.menu.intelligentMatchesDesc") },
  ];
}

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

export function GlobalMenu() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  const { t } = useTranslation();
  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => { logout(); navigate("/"); },
  });
  const itens = getMenuItems(t);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="group flex items-center gap-2 text-sm font-medium text-white/80 border border-white/10 pl-3 pr-2.5 py-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] hover:border-[#c98f70]/40 hover:text-white transition-all duration-200 active:scale-[0.97] data-[state=open]:border-[#c98f70]/50 data-[state=open]:bg-white/[0.06] data-[state=open]:text-white">
          <MenuIcon className="w-4 h-4 text-[#c98f70]" />
          <span className="hidden sm:inline">{t("appHeader.menuButton")}</span>
          <ChevronDown className="w-3.5 h-3.5 text-white/40 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10}
        className="w-72 rounded-2xl border-white/10 bg-[#211e1b]/95 backdrop-blur-2xl text-white shadow-2xl shadow-black/60 p-2">
        <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-widest text-white/35 px-3 pt-2 pb-1">
          {t("appHeader.navigation")}
        </DropdownMenuLabel>
        {itens.map(item => (
          <DropdownMenuItem key={item.href} asChild
            className="rounded-xl px-3 py-2.5 cursor-pointer focus:bg-white/[0.07] focus:text-white data-[highlighted]:bg-white/[0.07]">
            <Link href={item.href}>
              <span className="flex items-center gap-3 w-full">
                <span className="w-9 h-9 rounded-lg bg-white/[0.05] border border-white/[0.06] flex items-center justify-center shrink-0">
                  <item.icon className="w-4 h-4 text-white/70" />
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-white leading-tight">{item.label}</span>
                  <span className="text-[11px] text-white/35 leading-tight truncate">{item.desc}</span>
                </span>
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
        {(user?.role === "president" || user?.role === "gold" || user?.role === "admin" || user?.isDistributor === true) && (
          <>
            <DropdownMenuSeparator className="bg-white/[0.07] my-2" />
            <DropdownMenuItem asChild
              className="rounded-xl px-3 py-2.5 cursor-pointer focus:bg-amber-400/10 data-[highlighted]:bg-amber-400/10">
              <Link href="/president">
                <span className="flex items-center gap-3 w-full">
                  <span className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#c98f70]/25 to-[#efcba8]/10 border border-amber-400/25 flex items-center justify-center shrink-0">
                    <Crown className="w-4 h-4 text-amber-400" />
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold text-amber-300 leading-tight">{t("appHeader.goldPanel")}</span>
                    <span className="text-[11px] text-amber-200/40 leading-tight truncate">{t("appHeader.goldPanelDesc")}</span>
                  </span>
                </span>
              </Link>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator className="bg-white/[0.07] my-2" />
        <DropdownMenuItem
          onClick={() => logoutMutation.mutate()}
          className="rounded-xl px-3 py-2.5 cursor-pointer text-white/50 focus:bg-red-500/10 focus:text-red-300 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-300">
          <span className="flex items-center gap-3 w-full">
            <span className="w-9 h-9 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center shrink-0">
              <LogOut className="w-4 h-4" />
            </span>
            <span className="text-sm font-medium leading-tight">{t("dashboard.logout")}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppHeader({ title, backTo, actions }: {
  /** Título da página, opcional, exibido ao lado do voltar. */
  title?: string;
  /** Rota do botão voltar; sem ela o botão não aparece. */
  backTo?: string;
  /** Ações específicas da página (botões extras), à esquerda do menu. */
  actions?: React.ReactNode;
}) {
  const { user } = useAuth();
  const { t } = useTranslation();

  return (
    // Altura fixa (h-16 = 64px) porque as barras próprias das páginas grudam
    // logo abaixo dele, com `sticky top-16`: com a altura variando conforme o
    // botão mais alto do momento, a barra de baixo escorregava para cima ou
    // deixava uma fresta. O conteúdo já era centrado, então nada se mexe.
    <nav className="border-b border-white/[0.06] px-4 sm:px-6 h-16 flex items-center justify-between sticky top-0 z-40 bg-[#151312]/95 backdrop-blur-2xl">
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/dashboard">
          <BrandMark />
        </Link>
        {backTo && (
          <Link href={backTo}>
            <span className="flex items-center gap-1 text-white/40 hover:text-white text-sm cursor-pointer transition-colors">
              <ArrowLeft size={15} />
            </span>
          </Link>
        )}
        {title && <h1 className="text-white font-semibold text-sm sm:text-base truncate">{title}</h1>}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        {actions}
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
  );
}
