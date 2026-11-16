import { useAuth } from "@/_core/hooks/useAuth";
import { Link } from "wouter";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "@/i18n";
import { BrandLogo, BrandMark } from "@/components/BrandLogo";
import { trpc } from "@/lib/trpc";
// Ícone da seção Meu Network Inteligente. Import próprio, fora do bloco de ícones
// abaixo, para não encostar na linha que a PR #117 (Hero) altera.
import { Mic } from "lucide-react";
import { montarPracasDoGlobo, type Ligacao, type Praca } from "@/lib/pracas-do-globo";
import { GRAVACAO_EM_PARTES_SEGUNDOS_MAX } from "@shared/const";
import {
  Package, BriefcaseBusiness, HandCoins, Handshake, Radar,
  MapPin, MapIcon, Plane, Earth,
  ShieldCheck, BadgeCheck, Check, ArrowDown,
  UserRound, BrainCircuit, Zap, Sparkles, ArrowRight, ChevronDown, Star, Send, Globe,
} from "lucide-react";

// Imagem do hero (client/public/images). O mapa bordado em fio de ouro sobre
// tecido escuro: a base do quadro é vazia de propósito, porque o gradiente do
// container e o cartão flutuante caem justamente ali.
const HERO_IMG = "/images/hero-globo.webp";

// Intersection observer hook
function useInView(threshold = 0.2) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold }
    );
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

// PROVA (não é decisão final): com o mapa virando fundo da página inteira, ter
// o mesmo mapa também dentro do quadro do hero confunde a leitura do efeito.
// Basta voltar para `true` para recuperar o cartão como estava.
const MOSTRAR_CARTAO_DO_HERO = false;

/**
 * Progresso de rolagem da PÁGINA inteira (0 no topo, 1 no fim). É o que move
 * o planeta (a viagem da Rede viva, em lib/coreografia-do-globo.ts): a rolagem
 * controla a câmera, como no vídeo em que a rolagem controla o café caindo.
 *
 * Devolve uma FUNÇÃO, não um número: o valor muda a cada quadro de rolagem, e
 * o único consumidor hoje (GloboDoMundo) lê quando redesenha — repassar por
 * `useState` forçaria um render do React a cada pixel rolado, e a página
 * engasgaria.
 *
 * No máximo uma medição por quadro, como no parallax.
 *
 * `movimentoLigado` é o estado do botão de movimento (useMovimentoDoFundo,
 * que já leva em conta a escolha guardada e o `prefers-reduced-motion`).
 * DESLIGADO = VISTA PARADA, o segundo valor devolvido: o planeta inteiro com o
 * Brasil de frente e a rede toda acesa, sem acompanhar a rolagem (decisão do
 * dono, 16/09). A Rede viva não tem animação própria, então "desligar o
 * movimento" só pode querer dizer isto — antes, o botão só parava os pulsos e,
 * sem eles, não mudava nada.
 *
 * A medição continua mesmo com o globo parado: custa uma conta por quadro de
 * rolagem, e assim, ao religar, o primeiro quadro do globo já sai na posição
 * certa (pregado em 1, ele desenhava antes um quadro inteiro no fim da viagem).
 */
function useProgressoDaPagina(movimentoLigado: boolean) {
  const valor = useRef(0);
  const progresso = useRef(() => valor.current).current;

  useEffect(() => {
    let quadro = 0;
    const medir = () => {
      quadro = 0;
      const alcance = document.documentElement.scrollHeight - window.innerHeight;
      valor.current = alcance > 0 ? Math.min(Math.max(window.scrollY / alcance, 0), 1) : 0;
    };
    const aoRolar = () => {
      if (quadro) return;
      quadro = requestAnimationFrame(medir);
    };

    window.addEventListener("scroll", aoRolar, { passive: true });
    window.addEventListener("resize", aoRolar, { passive: true });
    medir();

    return () => {
      window.removeEventListener("scroll", aoRolar);
      window.removeEventListener("resize", aoRolar);
      if (quadro) cancelAnimationFrame(quadro);
    };
    // Uma vez só, na montagem: assim este ouvinte de rolagem fica antes do
    // ouvinte do globo (que é carregado depois), e o globo lê o valor já medido.
  }, []);

  return [progresso, !movimentoLigado] as const;
}

/**
 * Parallax do hero.
 *
 * Escreve o progresso do scroll dentro do hero (0 no topo, 1 quando ele já
 * saiu) numa custom property `--p` do próprio elemento. Quem decide o que cada
 * plano faz com esse número é o CSS lá embaixo — aqui só se mede.
 *
 * Três decisões que não são estilo, são o que faz isto não travar a página:
 *
 * 1. Nada de `useState` no scroll. Rerenderizar o React a cada pixel rolado
 *    engasga a home inteira; o valor vai direto no DOM.
 * 2. Uma medição por quadro, no máximo. O listener só agenda um
 *    requestAnimationFrame se não houver outro pendente.
 * 3. `prefers-reduced-motion` é checado AQUI, no JavaScript. O bloco de
 *    index.css zera `animation` e `transition`, mas não alcança um `transform`
 *    escrito por script: sem esta guarda, quem pediu menos movimento no
 *    sistema receberia o parallax inteiro mesmo assim.
 */
function useParallax<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [semMovimento, setSemMovimento] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sincronizar = () => setSemMovimento(mq.matches);
    mq.addEventListener("change", sincronizar);
    return () => mq.removeEventListener("change", sincronizar);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Preferência respeitada: tudo fica no estado de repouso (--p = 0).
    if (semMovimento) {
      el.style.setProperty("--p", "0");
      return;
    }

    let quadro = 0;
    let visivel = true;

    const medir = () => {
      quadro = 0;
      const r = el.getBoundingClientRect();
      const p = Math.min(Math.max(-r.top / Math.max(r.height, 1), 0), 1);
      el.style.setProperty("--p", p.toFixed(4));
    };

    const aoRolar = () => {
      if (quadro || !visivel) return;
      quadro = requestAnimationFrame(medir);
    };

    // Passou do hero, para de medir: o resto da home rola sem nenhum trabalho
    // extra por quadro.
    const obs = new IntersectionObserver(([entrada]) => {
      visivel = entrada.isIntersecting;
      if (visivel) aoRolar();
    });
    obs.observe(el);

    window.addEventListener("scroll", aoRolar, { passive: true });
    window.addEventListener("resize", aoRolar, { passive: true });
    medir();

    return () => {
      obs.disconnect();
      window.removeEventListener("scroll", aoRolar);
      window.removeEventListener("resize", aoRolar);
      if (quadro) cancelAnimationFrame(quadro);
    };
  }, [semMovimento]);

  return ref;
}

// Rótulo de seção minimalista
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-4">
      <span className="h-px w-8 bg-[#c98f70]/40" />
      <span className="text-[#c98f70] text-xs font-bold uppercase tracking-[0.25em]">{children}</span>
      <span className="h-px w-8 bg-[#c98f70]/40" />
    </div>
  );
}

// Language Selector Component
function LanguageSelector() {
  const { i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  // O idioma RESOLVIDO: o pedido pode ser regional ("en-US") e não existir
  // na lista — o seletor mostrava a bandeira do Brasil com a página em inglês.
  const idiomaAtual = i18n.resolvedLanguage ?? i18n.language;
  const current = LANGUAGES.find(l => l.code === idiomaAtual) ?? LANGUAGES[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white transition-colors duration-200 px-2.5 py-1.5 rounded-lg hover:bg-white/[0.06]"
      >
        <span className="text-base">{current.flag}</span>
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-50 bg-[#211e1b]/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden min-w-[170px] p-1.5"
            style={{ animation: "fadeInDown 0.2s cubic-bezier(0.23,1,0.32,1) both" }}>
            {LANGUAGES.map(lang => (
              <button
                key={lang.code}
                onClick={() => { i18n.changeLanguage(lang.code); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-3.5 py-2 text-sm rounded-xl transition-colors duration-150 text-left
                  ${lang.code === idiomaAtual
                    ? "bg-[#c98f70]/15 text-[#c98f70]"
                    : "text-white/60 hover:bg-white/[0.06] hover:text-white"
                  }`}
              >
                <span className="text-base">{lang.flag}</span>
                <span>{lang.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── FAQ ─────────────────────────────────────────────────────
// Respostas fixas: abrir uma pergunta não pode custar uma chamada de IA nem
// depender dela estar no ar. A caixa "Pergunte à IA" continua logo abaixo
// para dúvidas fora desta lista.
// As perguntas e as respostas moram nos 10 JSONs de idioma (`faq.items.*`).
// Eram texto fixo em português aqui dentro, e por isso a seção inteira
// continuava em português nos outros nove idiomas. O conteúdo das respostas
// não mudou: as dos níveis seguem as palavras da spec de Governança (Glenda,
// 14/09) — Bronze e Prata medem a qualificação do perfil e não têm
// mensalidade; Ouro é categoria premium mediante mensalidade, sem preço.
const FAQ_IDS = ["i1", "i2", "i3", "i4", "i5", "i6"] as const;

function FAQSection() {
  const { t, i18n } = useTranslation();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [customQ, setCustomQ] = useState("");
  const [customAnswer, setCustomAnswer] = useState("");
  const [customLoading, setCustomLoading] = useState(false);
  const faqMutation = trpc.faq.ask.useMutation();

  const handleToggle = (idx: number) => {
    setOpenIdx(openIdx === idx ? null : idx);
  };

  const handleCustom = async () => {
    if (!customQ.trim()) return;
    setCustomLoading(true);
    setCustomAnswer("");
    try {
      // O idioma vai junto: a resposta da IA precisa sair no idioma da tela, e
      // o servidor não tem outro jeito de saber qual é (não há cabeçalho de
      // idioma nem coluna de idioma da usuária).
      const res = await faqMutation.mutateAsync({ question: customQ, idioma: i18n.resolvedLanguage ?? i18n.language });
      setCustomAnswer(typeof res.answer === 'string' ? res.answer : String(res.answer));
    } catch { setCustomAnswer(t("faq.askError")); }
    setCustomLoading(false);
  };

  return (
    <section id="faq" className="py-28 relative">
      <div className="relative container mx-auto px-6 max-w-3xl">
        <div className="text-center mb-14">
          <SectionLabel>{t("faq.label")}</SectionLabel>
          <h2 className="text-4xl md:text-5xl font-extrabold text-white mb-4">
            {t("faq.headline1")}<span className="text-[#c98f70]">{t("faq.headline2")}</span>
          </h2>
          <p className="text-white/40 text-lg">{t("faq.subtitle")}</p>
        </div>

        {/* Perguntas pré-definidas */}
        <div className="space-y-2.5 mb-8">
          {FAQ_IDS.map((id, idx) => (
            <div key={id} className="bg-[#211e1b]/90 border border-white/[0.06] rounded-2xl overflow-hidden transition-all duration-200 hover:border-white/15">
              <button
                onClick={() => handleToggle(idx)}
                className="w-full flex items-center justify-between px-6 py-4 text-left"
              >
                <span className="text-white/90 font-medium text-sm md:text-base">{t(`faq.items.${id}.q`)}</span>
                <span className={`text-[#c98f70] text-xl font-bold transition-transform duration-200 flex-shrink-0 ml-4 ${openIdx === idx ? 'rotate-45' : ''}`}>+</span>
              </button>
              {openIdx === idx && (
                <div className="px-6 pb-5">
                  <p className="text-white/60 text-sm leading-relaxed whitespace-pre-line">{t(`faq.items.${id}.a`)}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Campo de pergunta personalizada */}
        <div className="bg-[#211e1b]/90 border border-white/[0.06] rounded-2xl p-6">
          <p className="text-white/50 text-sm mb-3 font-medium">{t("faq.askTitle")}</p>
          {/* Em 375 px a linha não cabia: `flex-1` num <input> não encolhe abaixo
              da largura intrínseca dele (min-width auto), então o campo empurrava
              o botão e os últimos 6 px de "Perguntar" ficavam fora da tela, sem
              toque possível. Empilha no celular e vira linha a partir de sm; o
              `min-w-0` deixa o campo encolher quando a linha volta. */}
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={customQ}
              onChange={e => setCustomQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCustom()}
              placeholder={t("faq.askPlaceholder")}
              className="w-full min-w-0 flex-1 bg-white/[0.04] border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm placeholder:text-white/25 outline-none focus:border-[#c98f70]/50 transition-colors"
            />
            <button
              onClick={handleCustom}
              disabled={customLoading || !customQ.trim()}
              className="w-full sm:w-auto bg-[#c98f70] hover:bg-[#b07a5c] disabled:opacity-40 text-[#151312] font-bold px-5 py-3 rounded-xl text-sm transition-all duration-200 active:scale-95 flex-shrink-0 flex items-center justify-center gap-2"
            >
              {customLoading ? (
                <div className="w-4 h-4 border-2 border-[#151312]/40 border-t-[#151312] rounded-full animate-spin" />
              ) : <><Send className="w-3.5 h-3.5" /> {t("faq.askButton")}</>}
            </button>
          </div>
          {customAnswer && (
            <div className="mt-4 p-4 bg-[#c98f70]/[0.04] border border-[#c98f70]/15 rounded-xl">
              <p className="text-white/75 text-sm leading-relaxed whitespace-pre-line">{customAnswer}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * O planeta só é baixado quando alguém abre a home: são ~600 KB de three.js
 * mais os contornos do Natural Earth, e nenhuma outra tela do sistema precisa
 * disso. `lazy` faz o Vite cortar num pedaço separado.
 */
const GloboDoMundo = lazy(() => import("@/components/GloboDoMundo"));

const CHAVE_DO_MOVIMENTO = "mmm:movimento-do-fundo";

const MENOS_MOVIMENTO = "(prefers-reduced-motion: reduce)";

/** A escolha feita no botão e guardada no navegador, se houver. */
function escolhaGuardada(): boolean | null {
  try {
    const guardado = localStorage.getItem(CHAVE_DO_MOVIMENTO);
    if (guardado === "on") return true;
    if (guardado === "off") return false;
  } catch {
    // Navegador em modo privado ou com armazenamento bloqueado: segue o fluxo.
  }
  return null;
}

/**
 * Decide se o planeta acompanha a rolagem.
 *
 * Primeiro a escolha explícita de quem visita, guardada no navegador — ela
 * vence tudo, porque quem clicou sabe o que quer. Depois
 * `prefers-reduced-motion`, que é uma escolha feita no sistema operacional.
 * Fora isso, LIGADO.
 *
 * Não há mais palpite pelo aparelho (núcleos e memória): ele existia para
 * poupar o laço de animação dos pulsos, e a Rede viva só desenha quando a
 * página rola. Com o palpite, muito celular abria na vista parada e perdia a
 * viagem.
 */
function movimentoPadrao(): boolean {
  return escolhaGuardada() ?? !window.matchMedia(MENOS_MOVIMENTO).matches;
}

/**
 * O estado do botão de movimento. Sem escolha feita, acompanha a preferência
 * do sistema também se ela mudar com a página aberta.
 */
function useMovimentoDoFundo() {
  const [ativo, setAtivo] = useState(movimentoPadrao);
  // O clique vale nesta visita mesmo sem armazenamento (modo privado,
  // bloqueado): sem isto, uma mudança no sistema desfazia a escolha.
  const escolheuNestaVisita = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia(MENOS_MOVIMENTO);
    const sincronizar = () => {
      if (!escolheuNestaVisita.current && escolhaGuardada() === null) setAtivo(!mq.matches);
    };
    mq.addEventListener("change", sincronizar);
    return () => mq.removeEventListener("change", sincronizar);
  }, []);

  const alternar = () => {
    escolheuNestaVisita.current = true;
    setAtivo(atual => {
      const proximo = !atual;
      // A escolha fica guardada: quem desligou não precisa desligar de novo a
      // cada visita.
      try { localStorage.setItem(CHAVE_DO_MOVIMENTO, proximo ? "on" : "off"); } catch { /* sem armazenamento */ }
      return proximo;
    });
  };

  return [ativo, alternar] as const;
}

/**
 * Botão discreto para ligar e desligar o movimento do fundo. Desligado, o
 * planeta fica parado: inteiro, com o Brasil de frente e a rede toda acesa.
 */
function ChaveDoMovimento({ ativo, alternar }: { ativo: boolean; alternar: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={alternar}
      aria-pressed={ativo}
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-[#211e1b]/85 px-3.5 py-2 text-[11px] font-medium text-white/55 backdrop-blur-xl transition-colors duration-200 hover:border-white/25 hover:text-white/85"
      title={ativo ? t("hero.motionTurnOff") : t("hero.motionTurnOn")}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${ativo ? "bg-[#c98f70]" : "bg-white/30"}`}
        aria-hidden="true"
      />
      {ativo ? t("hero.motionOn") : t("hero.motionOff")}
    </button>
  );
}

/**
 * Fundo da página com o planeta girando conforme a rolagem.
 *
 * A imagem bordada continua atrás, bem apagada: ela dá textura ao fundo e é o
 * que aparece se o WebGL não existir (aparelho antigo, GPU bloqueada) — assim
 * a falha degrada para o desenho anterior em vez de um retângulo preto.
 */
function FundoDoPlaneta({ progresso, vistaParada, pracas, ligacoes }: {
  progresso: () => number;
  vistaParada: boolean;
  pracas: Praca[];
  ligacoes: Ligacao[];
}) {
  return (
    <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
      <img src={HERO_IMG} alt=""
        className="absolute inset-0 w-full h-full object-cover opacity-25" />
      <div className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, rgba(6,11,20,0.80) 0%, rgba(6,11,20,0.88) 45%, rgba(6,11,20,0.94) 100%)" }} />
      <Suspense fallback={null}>
        <div className="absolute inset-0">
          <GloboDoMundo progresso={progresso} vistaParada={vistaParada} pracas={pracas} ligacoes={ligacoes} />
        </div>
      </Suspense>
    </div>
  );
}

export default function Home() {
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const { ref: stepsRef, inView: stepsInView } = useInView();
  const { ref: oppsRef, inView: oppsInView } = useInView();
  const heroRef = useParallax<HTMLElement>();
  const [movimentoAtivo, alternarMovimento] = useMovimentoDoFundo();
  const [progressoDaPagina, vistaParada] = useProgressoDaPagina(movimentoAtivo);

  // A Home pública não consulta mais stats.platform: os quatro indicadores e as
  // contagens de Bronze, Prata e Ouro moram no Dashboard (spec da Glenda, 14/09).
  // A consulta continua existindo no servidor; só deixou de ser exibida aqui.

  // Praças do globo: agregado por país das usuárias reais. staleTime infinito
  // porque o dado muda no ritmo de cadastros, não de rolagem — refetch em foco
  // derrubaria e reconstruiria a cena 3D à toa. useMemo pelo mesmo motivo: as
  // props do globo estão nas deps do useEffect que monta a cena, e precisam
  // manter identidade entre renders.
  const { data: presenca } = trpc.stats.presencaPorPais.useQuery(undefined, { staleTime: Infinity });
  const { pracas, ligacoes } = useMemo(() => montarPracasDoGlobo(presenca), [presenca]);

  const [activeStep, setActiveStep] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const scrollTo = (id: string) => {
    setMobileMenuOpen(false);
    setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };
  useEffect(() => {
    if (!stepsInView) return;
    const interval = setInterval(() => setActiveStep(p => (p + 1) % 3), 2500);
    return () => clearInterval(interval);
  }, [stepsInView]);

  const steps = [
    { num: "01", Icon: UserRound, chamada: t("steps.step1.eyebrow"), title: t("steps.step1.title"), desc: t("steps.step1.desc") },
    { num: "02", Icon: BrainCircuit, chamada: t("steps.step2.eyebrow"), title: t("steps.step2.title"), desc: t("steps.step2.desc") },
    { num: "03", Icon: Zap, chamada: t("steps.step3.eyebrow"), title: t("steps.step3.title"), desc: t("steps.step3.desc") },
  ];

  const opportunityTypes = [
    { Icon: Globe, key: "internationalize" },
    { Icon: Package, key: "sellProducts" },
    { Icon: BriefcaseBusiness, key: "sellServices" },
    { Icon: HandCoins, key: "findInvestment" },
    { Icon: Handshake, key: "partnerships" },
    { Icon: Radar, key: "findOpportunities" },
  ];

  // Até onde o negócio chega, da cidade ao mercado ainda sem acesso. MapIcon e
  // não Map: o nome do ícone esconderia o Map do JavaScript neste arquivo.
  const reachSteps = [
    { Icon: MapPin, key: "city" },
    { Icon: MapIcon, key: "state" },
    { Icon: Plane, key: "country" },
    { Icon: Earth, key: "markets" },
  ];

  return (
    <div className="min-h-screen bg-[#151312] text-white overflow-x-hidden antialiased">
      <FundoDoPlaneta progresso={progressoDaPagina} vistaParada={vistaParada} pracas={pracas} ligacoes={ligacoes} />
      <ChaveDoMovimento ativo={movimentoAtivo} alternar={alternarMovimento} />

      {/* ─── NAVBAR ─── */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.05] bg-[#151312]/80 backdrop-blur-2xl">
        <div className="flex items-center justify-between px-6 md:px-12 py-3.5">
          <div className="flex items-center">
            <a href="#" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
              className="cursor-pointer" aria-label={t("nav.backToTop")}>
              <BrandMark />
            </a>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-white/50">
            <button onClick={() => scrollTo('como-funciona')} className="whitespace-nowrap hover:text-white transition-colors duration-200 cursor-pointer bg-transparent border-none">{t("nav.howItWorks")}</button>
            <button onClick={() => scrollTo('oportunidades')} className="whitespace-nowrap hover:text-white transition-colors duration-200 cursor-pointer bg-transparent border-none">{t("nav.opportunities")}</button>
            <button onClick={() => scrollTo('network-inteligente')} className="whitespace-nowrap hover:text-white transition-colors duration-200 cursor-pointer bg-transparent border-none">{t("nav.smartNetwork")}</button>
          </div>
          {/* Mobile hamburger button */}
          <button
            className="md:hidden flex flex-col justify-center items-center w-10 h-10 gap-1.5 bg-transparent border-none cursor-pointer z-50"
            onClick={() => setMobileMenuOpen(o => !o)}
            aria-label={t("nav.menu")}
          >
            <span className={`block w-6 h-0.5 bg-white transition-all duration-300 origin-center ${mobileMenuOpen ? 'rotate-45 translate-y-2' : ''}`} />
            <span className={`block w-6 h-0.5 bg-white transition-all duration-300 ${mobileMenuOpen ? 'opacity-0 scale-x-0' : ''}`} />
            <span className={`block w-6 h-0.5 bg-white transition-all duration-300 origin-center ${mobileMenuOpen ? '-rotate-45 -translate-y-2' : ''}`} />
          </button>
          <div className="hidden md:flex items-center gap-3">
            <LanguageSelector />
            {isAuthenticated ? (
              <Link href="/dashboard">
                <button className="bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-5 py-2 rounded-xl text-sm transition-all duration-200 active:scale-95">
                  {t("nav.myDashboard")}
                </button>
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-sm text-white/50 hover:text-white transition-colors duration-200">{t("nav.login")}</Link>
                <Link href="/register">
                  <button className="bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-5 py-2 rounded-xl text-sm transition-all duration-200 active:scale-95">
                    {t("nav.startFree")}
                  </button>
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ─── MOBILE MENU OVERLAY ─── */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-all duration-300 ${mobileMenuOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        style={{ background: 'rgba(6,11,20,0.97)', backdropFilter: 'blur(16px)' }}
      >
        <div className={`flex flex-col items-center justify-center h-full gap-8 transition-all duration-300 ${mobileMenuOpen ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'}`}>
          <button onClick={() => scrollTo('como-funciona')} className="text-2xl font-bold text-white hover:text-[#c98f70] transition-colors duration-200 bg-transparent border-none cursor-pointer">{t("nav.howItWorks")}</button>
          <button onClick={() => scrollTo('oportunidades')} className="text-2xl font-bold text-white hover:text-[#c98f70] transition-colors duration-200 bg-transparent border-none cursor-pointer">{t("nav.opportunities")}</button>
          <button onClick={() => scrollTo('network-inteligente')} className="text-2xl font-bold text-white hover:text-[#c98f70] transition-colors duration-200 bg-transparent border-none cursor-pointer text-center px-6">{t("nav.smartNetwork")}</button>
          <LanguageSelector />
          <div className="w-16 h-px bg-white/15 my-2" />
          {isAuthenticated ? (
            <Link href="/dashboard" onClick={() => setMobileMenuOpen(false)}>
              <button className="bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-8 py-3 rounded-xl text-lg transition-all duration-200 active:scale-95">
                {t("nav.myDashboard")}
              </button>
            </Link>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <Link href="/login" onClick={() => setMobileMenuOpen(false)}>
                <span className="text-xl text-white/60 hover:text-white transition-colors duration-200">{t("nav.login")}</span>
              </Link>
              <Link href="/register" onClick={() => setMobileMenuOpen(false)}>
                <button className="bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-8 py-3 rounded-xl text-lg transition-all duration-200 active:scale-95">
                  {t("nav.startFree")}
                </button>
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* ─── HERO ─── */}
      {/*
        Parallax em três planos. `useParallax` escreve `--p` (0 → 1) aqui no
        section; cada plano abaixo traduz esse número em deslocamento próprio.
        Quem desce MENOS que a página parece estar longe; quem desce MAIS (valor
        negativo) parece estar perto. Daí a profundidade: o glow fica para trás,
        a imagem afunda um pouco, o cartão flutua para a frente.
        Sempre `var(--p, 0)`: antes de o script rodar, o CSS precisa de um valor
        válido, senão o calc inteiro é descartado e o transform não existe.
      */}
      <section ref={heroRef}
        // --k é o fator de intensidade do parallax: 1 é o ajuste final, valores
        // maiores exageram tudo proporcionalmente. Fica aqui, num lugar só, para
        // dar para calibrar ao vivo no console sem recompilar:
        //   document.querySelectorAll('section')[1].style.setProperty('--k', 3)
        style={{ "--k": 3 } as React.CSSProperties}
        className="relative min-h-screen flex items-center overflow-hidden pt-24 pb-16">
        {/* glow sutil — plano de fundo, o que mais fica para trás */}
        <div className="absolute inset-0 pointer-events-none will-change-transform"
          style={{
            background: "radial-gradient(ellipse 60% 45% at 75% 40%, rgba(201,143,112,0.07) 0%, transparent 70%)",
            transform: "translate3d(0, calc(var(--p, 0) * var(--k, 1) * 64px), 0) scale(calc(1 + var(--p, 0) * var(--k, 1) * 0.18))",
          }} />

        <div className="relative z-10 container mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-14 items-center max-w-6xl mx-auto">
            {/* Texto — desce um pouco mais devagar que a coluna da direita, só
                o suficiente para as duas se descolarem durante a rolagem. */}
            <div className="will-change-transform"
              style={{ transform: "translate3d(0, calc(var(--p, 0) * var(--k, 1) * 22px), 0)" }}>
              <div className="inline-flex max-w-full lg:w-max lg:max-w-none items-center gap-2 bg-white/[0.03] border border-white/[0.08] rounded-full px-4 py-1.5 mb-8 text-xs text-white/60 font-medium"
                style={{ animation: "fadeInDown 0.8s cubic-bezier(0.23,1,0.32,1) both" }}>
                <span className="w-1.5 h-1.5 shrink-0 bg-[#c98f70] rounded-full animate-pulse" />
                {/* O selo vem em trechos separados por " • ". Quando a linha não
                    comporta a frase inteira (celular), a quebra cai ENTRE trechos,
                    e o separador que abriria a linha nova fica na margem negativa
                    recortada pelo overflow-hidden: nenhuma linha começa com "•".
                    Se um trecho sozinho não cabe (telas de ~320 px), o recuo deslocado
                    (pl + -indent de 1em) faz a continuação começar fora do recorte;
                    o marcador zera o indent, que é herdado e o empurraria 1em à esquerda.
                    Os marcadores são aria-hidden, mas o t("hero.badge") cru ainda
                    tem os " • ", e o leitor de tela os lê em voz alta; por isso o
                    sr-only troca cada separador por vírgula e lê só os trechos.

                    No desktop o selo mede a frase inteira (w-max) e cabe em UMA
                    linha. A largura muda com a fonte do sistema, porque o selo
                    herda a pilha ui-sans-serif/system-ui do Tailwind, não a Inter.
                    Com os textos desta Hero, no Chrome do Windows (Segoe UI), o
                    selo mais largo dos 10 idiomas é o alemão: 539,6 px (o pt-BR
                    mede 484). Medido em 15/09 com "33+"; "+30" usa os mesmos
                    caracteres, e os algarismos da Segoe UI têm a mesma largura.
                    A coluna de texto tem 548 px a partir de 1280, então cabe com
                    só 8 px de folga — quem for traduzir o selo tem esses 548 px de
                    orçamento, e uma fonte mais larga que a Segoe UI já passa.
                    Entre 1024 e 1279 o utilitário `container` troca de max-width e
                    a coluna cai para 460 (um pouco menos logo acima de 1024, onde a
                    barra de rolagem come parte da janela): aí o selo alemão
                    TRANSBORDA uns 80 px (82,6 em 1024), mais que os 56 px de
                    `gap-14`. Não bate em nada hoje porque a coluna da direita
                    não é renderizada (MOSTRAR_CARTAO_DO_HERO = false, lá em cima);
                    o globo que aparece ali é o FundoDoPlaneta, fixo atrás da
                    página inteira, não aquele cartão. Quem religar o cartão troca
                    `lg:` por `xl:` nas duas classes do selo: ele passa a quebrar
                    em duas linhas de 1024 a 1279 px e não invade em largura alguma. */}
                <span className="sr-only">{t("hero.badge").split(" • ").join(", ")}</span>
                <span aria-hidden="true" className="min-w-0 overflow-hidden">
                  <span className="-ml-[1em] flex flex-wrap">
                    {t("hero.badge").split(" • ").map((trecho, i) => (
                      <span key={i} className="pl-[1em] -indent-[1em]">
                        <span className="inline-block w-[1em] indent-0 text-center">•</span>
                        {trecho}
                      </span>
                    ))}
                  </span>
                </span>
              </div>

              {/* Hierarquia da Hero, do mais forte ao botão: o título é o maior
                  elemento; a frase "quem você precisa conhecer" vem logo abaixo,
                  em corpo intermediário; alcance e IA são duas linhas de apoio com
                  ícone, a do alcance mais clara (o país em destaque) e a da IA mais
                  discreta, para não competir com o título; o gatilho de
                  curiosidade ganha a rampa do ouro rosé e o filete lateral; o
                  fechamento fica colado ao botão. Tudo com as cores, os raios e a
                  entrada fadeInUp que a Hero já usava.
                  Medido no navegador: com o título em 6xl na coluna estreita das
                  duas colunas (lg+), ele quebrava em 4 linhas e o botão caía abaixo
                  da primeira tela em 1280×800 e 1440×900; em lg ele fica em 5xl
                  (continua de longe o maior texto). O título é "Inteligência que
                  conecta negócios que acontecem" (pedido do Rosber, 14/09), no lugar
                  de "Grandes negócios começam com acesso às pessoas certas." da spec.
                  As duas metades têm quase o mesmo tamanho, então o título quebra
                  equilibrado (text-balance) em vez de forçar o destaque num bloco
                  inline-block: pela conta de largura, com o bloco "conecta" ficaria
                  sozinho numa linha em md (conta, não medição no navegador). As margens
                  entre os blocos são um degrau menores que as antigas para o botão
                  caber na primeira tela em 1280×800, e o texto do botão quebra
                  equilibrado no celular ("ENCONTRE SEU / BUSINESS MATCH"). O espaço
                  entre as duas partes do título mora no fim de hero.headline1, e
                  não aqui: japonês e chinês não separam palavras com espaço. */}
              <h1 className="text-4xl md:text-6xl lg:text-5xl font-extrabold leading-[1.05] mb-5 tracking-tight text-balance"
                style={{ animation: "fadeInUp 0.9s cubic-bezier(0.23,1,0.32,1) 0.1s both" }}>
                <span className="text-white">{t("hero.headline1")}</span>
                <span className="text-[#c98f70]">{t("hero.headline2")}</span>
              </h1>

              <p className="text-lg md:text-xl text-white/75 max-w-xl mb-5 leading-relaxed"
                style={{ animation: "fadeInUp 0.9s cubic-bezier(0.23,1,0.32,1) 0.2s both" }}>
                {t("hero.subtitle")}
              </p>

              <div className="max-w-xl space-y-3 mb-5"
                style={{ animation: "fadeInUp 0.9s cubic-bezier(0.23,1,0.32,1) 0.25s both" }}>
                <div className="flex items-start gap-3">
                  <span className="w-9 h-9 shrink-0 rounded-xl bg-[#c98f70]/10 border border-[#c98f70]/25 flex items-center justify-center" aria-hidden="true">
                    <Globe className="w-4 h-4 text-[#c98f70]" />
                  </span>
                  <p className="text-sm md:text-base text-white/70 leading-relaxed">
                    {t("hero.globalBefore")}<strong className="font-semibold text-white">{t("hero.globalHighlight")}</strong>{t("hero.globalAfter")}
                  </p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="w-9 h-9 shrink-0 rounded-xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-center" aria-hidden="true">
                    <Sparkles className="w-4 h-4 text-white/50" />
                  </span>
                  <p className="text-sm text-white/45 leading-relaxed">
                    {t("hero.ai")}
                  </p>
                </div>
              </div>

              {/* As três frases de destaque (esta, steps.closing e opportunities.closing)
                  eram um degradê ouro rosé recortado no texto (bg-clip-text). O degradê
                  é FUNDO, e o modo escuro do navegador do celular (Samsung Internet,
                  "escurecer sites" do Chrome) escurece fundos: nos prints do Rosber de
                  16/09 a frase saiu num marrom-avermelhado de ~rgb(64,16,0) sobre ~rgb(24,24,20),
                  contraste 1,2:1 — enquanto o "40" do Dashboard, cor de TEXTO #c98f70, saiu
                  intacto. Agora é cor de texto sólida #efcba8 (o champanhe da paleta,
                  --chart-5): 12,9:1 sobre o fundo da página (#060b14). Sobre o globo,
                  medido nos mesmos prints, o corpo dele dá 6 a 9:1, mas os arcos e os
                  pontos brancos das praças dão 1 a 3:1 (cerca de 2% do fundo atrás da
                  frase). Por isso o halo escuro (text-shadow): recorta os arcos em volta
                  das letras, e o anel de fundo encostado nelas fica abaixo de 3:1 em 0,2%
                  dos pixels, contra 2,6% sem ele (simulação sobre o print 05). O Chrome
                  com o modo escuro forçado não clareia o halo (testado em 16/09). */}
              <div className="max-w-xl border-s-2 border-[#c98f70]/60 ps-4 mb-5"
                style={{ animation: "fadeInUp 0.9s cubic-bezier(0.23,1,0.32,1) 0.3s both" }}>
                <p className="text-xl md:text-2xl font-bold leading-snug text-[#efcba8] [text-shadow:0_0_3px_rgba(6,11,20,.95),0_0_12px_rgba(6,11,20,.85)]">
                  {t("hero.hook")}
                </p>
                <p className="text-sm md:text-base text-white/55 mt-2 leading-relaxed">
                  {t("hero.discover")}
                </p>
              </div>

              <p className="text-base font-semibold text-white mb-3"
                style={{ animation: "fadeInUp 0.9s cubic-bezier(0.23,1,0.32,1) 0.35s both" }}>
                {t("hero.closing")}
              </p>

              <div className="flex flex-col sm:flex-row gap-3 mb-14"
                style={{ animation: "fadeInUp 0.9s cubic-bezier(0.23,1,0.32,1) 0.4s both" }}>
                <Link href={isAuthenticated ? "/dashboard" : "/register"}>
                  <button className="group w-full sm:w-auto bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-7 py-3.5 rounded-2xl text-base text-balance transition-all duration-200 active:scale-[0.97] flex items-center justify-center gap-2">
                    {t("hero.cta")}
                    <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                  </button>
                </Link>
                <button
                  onClick={() => scrollTo('como-funciona')}
                  className="w-full sm:w-auto border border-white/10 hover:border-white/25 text-white/60 hover:text-white px-7 py-3.5 rounded-2xl text-base transition-all duration-200"
                >
                  {t("hero.ctaSecondary")}
                </button>
              </div>

              {/* Os quatro indicadores da plataforma (pessoas, oportunidades,
                  conexões e países) moravam aqui, logo abaixo do botão. Saíram
                  da primeira tela pública para a área logada, em Dashboard.tsx:
                  na Hero eles disputavam a atenção com a mensagem e com o globo,
                  e um número baixo de rede nova enfraquece o convite justamente
                  para quem ainda não entrou. Nada foi apagado: a mesma consulta
                  stats.platform alimenta agora os cartões do Dashboard. */}
            </div>

            {/* Imagem */}
            {MOSTRAR_CARTAO_DO_HERO && (
            <div className="relative" style={{ animation: "fadeInUp 1s cubic-bezier(0.23,1,0.32,1) 0.25s both" }}>
              <div className="absolute -inset-6 bg-[#c98f70]/[0.06] rounded-[2.5rem] blur-3xl pointer-events-none" />
              <div className="relative rounded-3xl overflow-hidden border border-white/[0.08] shadow-2xl shadow-black/50">
                {/*
                  A moldura fica parada e a imagem deriva DENTRO dela — é o que
                  dá a sensação de olhar por uma janela em movimento. O
                  scale(1.16) de repouso existe para haver imagem sobrando dos
                  dois lados: sem ela, a deriva descobriria a borda do container.

                  A deriva é em PORCENTAGEM (da própria altura da imagem), não em
                  pixels, e é isso que a torna segura em qualquer largura de tela:
                  o scale deixa 8% sobrando de cada lado e a deriva usa 3,5%, então
                  a folga é a mesma no desktop largo e na largura em que o grid
                  ainda tem duas colunas. Com 34px fixos a folga caía para ~3px
                  perto de 1024px de viewport e a borda do container aparecia.

                  O mesmo `--k` que exagera a deriva também abre o scale, e por
                  isso a folga sobrevive a qualquer intensidade: sobra k×8% de
                  cada lado contra k×3,5% de deriva — a razão não muda com k.
                */}
                <img src={HERO_IMG}
                  alt="Mapa-múndi bordado em fio de ouro sobre tecido escuro, com arcos luminosos ligando a América do Sul à África e à Europa"
                  className="w-full h-auto block will-change-transform"
                  style={{ transform: "translate3d(0, calc(var(--p, 0) * var(--k, 1) * 3.5%), 0) scale(calc(1 + var(--k, 1) * 0.16))" }} />
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "linear-gradient(180deg, transparent 60%, rgba(6,11,20,0.5) 100%)" }} />
              </div>
              {/* badge flutuante — plano da frente: sobe MAIS que a página, e é
                  esse descolamento que faz a imagem parecer afundar atrás dele. */}
              <div className="absolute -bottom-5 -left-5 bg-[#211e1b]/95 backdrop-blur-xl border border-white/10 rounded-2xl px-5 py-4 shadow-xl shadow-black/50 will-change-transform"
                style={{ transform: "translate3d(0, calc(var(--p, 0) * var(--k, 1) * -42px), 0)" }}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-[#c98f70]/10 border border-[#c98f70]/25 flex items-center justify-center">
                    <Sparkles className="w-5 h-5 text-[#c98f70]" />
                  </div>
                  <div>
                    <div className="text-white font-bold text-sm leading-none">{t("aiEngine.badgeTitle")}</div>
                    <div className="text-white/40 text-[11px] mt-1.5">{t("aiEngine.badgeDesc")}</div>
                  </div>
                </div>
              </div>
            </div>
            )}
          </div>
        </div>
      </section>

      {/* ─── COMO FUNCIONA ─── */}
      <section id="como-funciona" className="py-28 relative border-t border-white/[0.04]">
        <div className="relative container mx-auto px-6">
          <div ref={stepsRef} className="text-center mb-16">
            <SectionLabel>{t("steps.title")}</SectionLabel>
            <h2 className="text-4xl md:text-5xl font-extrabold text-white">
              {t("steps.subtitle")}
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-5 max-w-5xl mx-auto">
            {steps.map((step, i) => (
              <div key={i}
                style={{
                  opacity: stepsInView ? 1 : 0,
                  transform: stepsInView ? "translateY(0)" : "translateY(40px)",
                  transition: `all 0.7s cubic-bezier(0.23,1,0.32,1) ${i * 0.15}s`,
                }}>
                <div className={`relative h-full p-8 rounded-3xl border transition-all duration-300 cursor-default ${activeStep === i
                  ? "bg-[#c98f70]/[0.05] border-[#c98f70]/30"
                  : "bg-[#211e1b]/90 border-white/[0.06] hover:border-white/15"
                  }`}>
                  <div className="flex items-center justify-between mb-6">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border transition-colors duration-300 ${activeStep === i ? "bg-[#c98f70]/15 border-[#c98f70]/30" : "bg-white/[0.03] border-white/[0.07]"}`}>
                      <step.Icon className={`w-5 h-5 transition-colors duration-300 ${activeStep === i ? "text-[#c98f70]" : "text-white/50"}`} />
                    </div>
                    <span className="text-white/15 font-extrabold text-sm tracking-widest">{step.num}</span>
                  </div>
                  {/* Três degraus de leitura no cartão: chamada, título, explicação.
                      A chamada fica em ouro rosé, o mesmo tratamento do SectionLabel
                      logo acima (uppercase por CSS, não em caixa alta no JSON).
                      É de propósito: caixa alta guardada no texto faz leitor de tela
                      soletrar, e japonês, chinês, árabe e híndi não têm caixa — nesses
                      a frase sai como foi escrita, que é o certo. O tracking é menor
                      que o do SectionLabel porque aqui é uma frase, não um rótulo de
                      duas palavras. */}
                  <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#c98f70]/90 leading-snug mb-2.5">{step.chamada}</p>
                  <h3 className="text-lg font-bold text-white mb-2.5">{step.title}</h3>
                  <p className="text-white/40 text-sm leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Fechamento da jornada: as três etapas explicam o mecanismo, esta
              frase devolve a pergunta para quem lê ("quem está procurando o que
              eu tenho?") e o botão responde. O destaque é a mesma cor sólida #efcba8,
              com o mesmo halo, que a Hero usa no gatilho dela (era degradê até 16/09;
              ver lá o porquê).
              O botão NÃO é um CTA novo: é o mesmo elemento do CTA final desta
              página (mesmo Link, mesma rota, mesmas classes) e lê a MESMA chave
              hero.cta do botão da Hero, para os dois nunca divergirem. */}
          <div className="max-w-3xl mx-auto mt-16 text-center"
            style={{
              opacity: stepsInView ? 1 : 0,
              transform: stepsInView ? "translateY(0)" : "translateY(40px)",
              transition: "all 0.7s cubic-bezier(0.23,1,0.32,1) 0.45s",
            }}>
            <p className="text-2xl md:text-3xl font-extrabold leading-snug text-balance text-[#efcba8] [text-shadow:0_0_3px_rgba(6,11,20,.95),0_0_12px_rgba(6,11,20,.85)]">
              {t("steps.closing")}
            </p>
            <Link href={isAuthenticated ? "/dashboard" : "/register"}>
              <button className="group mt-8 bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-9 py-4 rounded-2xl text-lg text-balance transition-all duration-200 active:scale-[0.97] inline-flex items-center gap-2.5">
                {t("hero.cta")}
                <ArrowRight className="w-5 h-5 transition-transform duration-200 group-hover:translate-x-1" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* ─── MOTOR DE IA ─── */}
      <section className="py-28 relative border-t border-white/[0.04]">
        <div className="relative container mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center max-w-5xl mx-auto">
            {/* Mock de match minimalista */}
            <div className="relative">
              <div className="absolute -inset-4 bg-[#c98f70]/[0.05] rounded-[2rem] blur-2xl pointer-events-none" />
              <div className="relative bg-[#211e1b]/90 border border-white/[0.07] rounded-3xl p-7">
                <div className="flex items-center justify-between mb-7">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-gradient-to-br from-[#c98f70] to-[#efcba8] flex items-center justify-center text-[#151312] font-extrabold text-sm">AM</div>
                    <div className="w-8 h-px bg-gradient-to-r from-[#c98f70]/60 to-transparent" />
                    <div className="w-11 h-11 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center text-white/70 font-extrabold text-sm">CR</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[#c98f70] font-extrabold text-2xl leading-none">94%</div>
                    <div className="text-white/30 text-[10px] uppercase tracking-wider mt-1">{t("testimonials.match")}</div>
                  </div>
                </div>
                <div className="text-[10px] uppercase tracking-wider text-white/25 mb-5">{t("aiEngine.illustrative")}</div>
                {[
                  { label: t("aiEngine.dim1"), pct: 92 },
                  { label: t("aiEngine.dim2"), pct: 88 },
                  { label: t("aiEngine.dim3"), pct: 95 },
                  { label: t("aiEngine.dim4"), pct: 79 },
                ].map((item, i) => (
                  <div key={i} className="mb-4 last:mb-0">
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-white/50">{item.label}</span>
                      <span className="text-[#c98f70] font-bold">{item.pct}%</span>
                    </div>
                    <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-[#c98f70] to-[#efcba8] rounded-full transition-all duration-1000"
                        style={{ width: `${item.pct}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="h-px w-8 bg-[#c98f70]/40" />
                <span className="text-[#c98f70] text-xs font-bold uppercase tracking-[0.25em]">{t("aiEngine.label")}</span>
              </div>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white mb-5">
                {t("aiEngine.title")}
              </h2>
              <p className="text-white/40 leading-relaxed">
                {t("aiEngine.desc")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── OPORTUNIDADES ─── */}
      <section id="oportunidades" className="py-28 relative border-t border-white/[0.04]">
        <div className="relative container mx-auto px-6">
          <div ref={oppsRef} className="relative text-center mb-12">
            <SectionLabel>{t("nav.opportunities")}</SectionLabel>
            <h2 className="text-4xl md:text-5xl font-extrabold text-white text-balance max-w-3xl mx-auto">
              {t("opportunities.title")}
            </h2>
            <p className="text-white/55 md:text-lg mt-5 max-w-2xl mx-auto leading-relaxed text-balance">{t("opportunities.subtitle")}</p>
          </div>

          {/* Alcance: responde ao título sem parágrafo institucional. Quatro
              marcos numa linha, da própria cidade ao mercado novo, acendendo da
              esquerda para a direita (da direita para a esquerda em árabe, por
              isso os rtl: na linha). O último marco leva o ouro rosé: é ali que
              o título aponta. Os círculos são opacos para a linha passar POR
              TRÁS deles, como uma rota ligando escalas. */}
          <div className="relative max-w-2xl mx-auto mb-14">
            <span aria-hidden="true"
              className="absolute top-[18px] left-[12.5%] right-[12.5%] h-px bg-gradient-to-r rtl:bg-gradient-to-l from-white/10 via-[#c98f70]/40 to-[#c98f70] origin-left rtl:origin-right"
              style={{
                transform: oppsInView ? "scaleX(1)" : "scaleX(0)",
                transition: "transform 1.1s cubic-bezier(0.23,1,0.32,1) 0.15s",
              }} />
            <ol className="relative grid grid-cols-4">
              {reachSteps.map((passo, i) => {
                const destino = i === reachSteps.length - 1;
                return (
                  <li key={passo.key} className="relative flex flex-col items-center gap-2.5 px-1 text-center"
                    style={{
                      opacity: oppsInView ? 1 : 0,
                      transform: oppsInView ? "translateY(0)" : "translateY(12px)",
                      transition: `all 0.6s cubic-bezier(0.23,1,0.32,1) ${0.15 + i * 0.22}s`,
                    }}>
                    <span aria-hidden="true"
                      className={`w-9 h-9 rounded-full bg-[#211e1b] border flex items-center justify-center ${destino ? "border-[#c98f70]/60 shadow-[0_0_24px_rgba(201,143,112,0.35)]" : "border-white/10"}`}>
                      <passo.Icon className={`w-4 h-4 ${destino ? "text-[#c98f70]" : "text-white/50"}`} />
                    </span>
                    {/* A sombra na cor do fundo separa o rótulo do contorno do
                        planeta, que gira atrás e cruza esta linha. */}
                    <span className={`text-xs sm:text-sm leading-snug text-balance [text-shadow:0_1px_10px_rgba(21,19,18,0.95)] ${destino ? "font-semibold text-[#efcba8]" : "text-white/65"}`}>
                      {t(`opportunities.reach.${passo.key}`)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Uma coluna no celular, com o ícone ao lado do texto para os seis
              cartões não virarem uma torre; duas no tablet; três no desktop.
              Os textos são frases inteiras, por isso o corpo subiu de xs/sm
              para sm/base — no tamanho antigo não eram legíveis no celular. */}
          <div className="relative grid sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl mx-auto">
            {opportunityTypes.map((opp, i) => (
              <div key={opp.key}
                className="group flex items-start gap-4 sm:flex-col sm:gap-0 h-full p-6 md:p-7 rounded-3xl bg-[#211e1b]/90 border border-white/[0.06] hover:border-[#c98f70]/30 hover:bg-[#c98f70]/[0.03] transition-all duration-300 cursor-default"
                style={{
                  opacity: oppsInView ? 1 : 0,
                  transform: oppsInView ? "scale(1)" : "scale(0.95)",
                  transition: `all 0.6s cubic-bezier(0.23,1,0.32,1) ${i * 0.08}s`,
                }}>
                <div className="w-11 h-11 shrink-0 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center sm:mb-5 group-hover:border-[#c98f70]/30 transition-colors duration-300">
                  <opp.Icon className="w-5 h-5 text-white/50 group-hover:text-[#c98f70] transition-colors duration-300" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-white text-base md:text-lg leading-snug mb-1.5">
                    {t(`opportunities.${opp.key}.label`)}
                  </h3>
                  <p className="text-sm text-white/45 leading-relaxed">
                    {t(`opportunities.${opp.key}.desc`)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Fechamento no mesmo molde do de "Como funciona": frase na cor
              de destaque #efcba8 (ver o gatilho da Hero) e o MESMO botão (mesmo Link, mesma rota, mesmas classes,
              mesma chave hero.cta). Não é CTA novo nem rota nova. */}
          <div className="max-w-3xl mx-auto mt-16 text-center"
            style={{
              opacity: oppsInView ? 1 : 0,
              transform: oppsInView ? "translateY(0)" : "translateY(40px)",
              transition: "all 0.7s cubic-bezier(0.23,1,0.32,1) 0.55s",
            }}>
            <p className="text-2xl md:text-3xl font-extrabold leading-snug text-balance text-[#efcba8] [text-shadow:0_0_3px_rgba(6,11,20,.95),0_0_12px_rgba(6,11,20,.85)]">
              {t("opportunities.closing")}
            </p>
            <Link href={isAuthenticated ? "/dashboard" : "/register"}>
              <button className="group mt-8 bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-9 py-4 rounded-2xl text-lg text-balance transition-all duration-200 active:scale-[0.97] inline-flex items-center gap-2.5">
                {t("hero.cta")}
                <ArrowRight className="w-5 h-5 transition-transform duration-200 group-hover:translate-x-1" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* ─── MEU NETWORK INTELIGENTE ───
          Substitui a antiga seção "Segurança" (13/09/2026). Era só propaganda: os
          mecanismos reais (limite de requisições, bloqueio de login, CSP, SIVC)
          continuam no servidor, e o card "criptografia ponta a ponta" prometia o
          que não existe. A seção apresenta o recurso da área logada; o CTA leva
          quem não tem conta ao cadastro de sempre e quem já entrou ao painel
          Meu Network Inteligente (/meu-network-inteligente). */}
      <section id="network-inteligente" className="py-28 relative border-t border-white/[0.04]">
        <div className="relative container mx-auto px-6">
          <div className="max-w-5xl mx-auto text-center">
            <SectionLabel>{t("smartNetwork.label")}</SectionLabel>
            <h2 className="text-3xl md:text-5xl font-extrabold text-white mb-5 tracking-tight text-balance max-w-4xl mx-auto">
              {t("smartNetwork.title")}
            </h2>
            <p className="text-base md:text-lg text-white/50 max-w-2xl mx-auto mb-6 leading-relaxed">
              {t("smartNetwork.subtitle")}
            </p>
            {/* Mesma troca das frases de destaque da Hero (degradê → cor sólida
                com halo): o modo escuro do celular escurece o degradê. */}
            <p className="text-xl md:text-2xl font-bold leading-snug text-[#efcba8] [text-shadow:0_0_3px_rgba(6,11,20,.95),0_0_12px_rgba(6,11,20,.85)] mb-12 text-balance max-w-3xl mx-auto">
              {t("smartNetwork.impact")}
            </p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-start">
              {[
                { num: "01", Icon: Mic, key: "record" },
                { num: "02", Icon: BrainCircuit, key: "organize" },
                { num: "03", Icon: Handshake, key: "discover" },
                { num: "04", Icon: HandCoins, key: "value" },
              ].map((card) => (
                <div key={card.key} className="h-full p-6 rounded-3xl bg-[#211e1b]/90 border border-white/[0.06] hover:border-[#c98f70]/30 transition-colors duration-300">
                  <div className="flex items-center justify-between mb-5">
                    <div className="w-10 h-10 rounded-2xl bg-[#c98f70]/10 border border-[#c98f70]/25 flex items-center justify-center">
                      <card.Icon className="w-5 h-5 text-[#c98f70]" aria-hidden="true" />
                    </div>
                    <span className="text-white/15 font-extrabold text-sm tracking-widest" aria-hidden="true">{card.num}</span>
                  </div>
                  <h3 className="font-extrabold text-white text-sm tracking-wide mb-2 leading-snug">{t(`smartNetwork.${card.key}.title`)}</h3>
                  {/* As horas vão a todos os cartões, e só o de gravar as usa: a
                      gravação vai até o teto técnico da gravação em partes (G13b). */}
                  <p className="text-sm text-white/45 leading-relaxed">{t(`smartNetwork.${card.key}.desc`, { horas: GRAVACAO_EM_PARTES_SEGUNDOS_MAX / 3600 })}</p>
                </div>
              ))}
            </div>
            <p className="text-2xl md:text-4xl font-extrabold text-white mt-16 mb-5 tracking-tight text-balance max-w-3xl mx-auto">
              {t("smartNetwork.closingQuestion")}
            </p>
            <p className="text-base md:text-lg text-white/55 max-w-2xl mx-auto mb-10 leading-relaxed">
              {t("smartNetwork.closingLine")}
            </p>
            <Link href={isAuthenticated ? "/meu-network-inteligente" : "/register"}>
              <button className="group bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-8 py-4 rounded-2xl text-base text-balance transition-all duration-200 active:scale-[0.97] inline-flex items-center justify-center gap-2.5">
                {t("smartNetwork.cta")}
                <ArrowRight className="w-5 h-5 shrink-0 transition-transform duration-200 group-hover:translate-x-1" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* ─── GOVERNANÇA: BRONZE / PRATA / OURO ───
          Novo conceito (spec da Glenda, 14/09): Bronze e Prata medem a
          QUALIFICAÇÃO das informações do perfil (Quem Sou, O Que Tenho, O Que
          Preciso) e não têm mensalidade; Ouro é outra coisa, uma categoria
          premium mediante mensalidade, e NÃO a continuação automática do Prata.
          Por isso a seta liga só Bronze a Prata, e o Ouro fica num cartão à
          parte, com mais destaque (sem cara de anúncio: nada de preço, selo
          "oferta" ou botão de assinar — não existe cobrança implementada).
          As contagens de membros por nível saíram daqui para o Dashboard; a
          Home pública não mostra mais número de membros. */}
      <section id="governanca" className="py-28 relative border-t border-white/[0.04]">
        <div className="relative container mx-auto px-6">
          <div className="max-w-3xl mx-auto text-center mb-14">
            <SectionLabel>{t("governance.label")}</SectionLabel>
            <h2 className="text-3xl md:text-5xl font-extrabold text-white mb-5 tracking-tight text-balance">
              {t("governance.title")}
            </h2>
            <p className="text-base md:text-lg text-white/50 leading-relaxed text-balance">
              {t("governance.subtitle")}
            </p>
          </div>

          {/* Desktop: Bronze → Prata ocupam três quintos, o Ouro dois. Tablet:
              Bronze e Prata lado a lado, o Ouro inteiro embaixo. Celular: uma
              coluna, e a seta vira para baixo. */}
          <div className="grid lg:grid-cols-5 gap-5 max-w-6xl mx-auto">
            <div className="lg:col-span-3 flex flex-col gap-4">
              <div className="grid sm:grid-cols-[1fr_auto_1fr] gap-3 flex-1">
                {([
                  {
                    key: "bronze", Icon: BadgeCheck,
                    icone: "bg-[#c98f70]/10 border-[#c98f70]/25 text-[#c98f70]",
                    titulo: "text-[#c98f70]", destaque: "border-[#c98f70]/50 text-[#efcba8]",
                    borda: "hover:border-[#c98f70]/30",
                  },
                  null,
                  {
                    key: "silver", Icon: ShieldCheck,
                    icone: "bg-slate-500/10 border-slate-400/25 text-slate-300",
                    titulo: "text-slate-200", destaque: "border-slate-300/50 text-slate-200",
                    borda: "hover:border-white/20",
                  },
                ] as const).map(nivel => nivel === null ? (
                  <div key="seta" className="flex items-center justify-center" aria-hidden="true">
                    <span className="w-9 h-9 rounded-full bg-[#211e1b] border border-white/10 flex items-center justify-center">
                      <ArrowDown className="w-4 h-4 text-white/45 sm:hidden" />
                      <ArrowRight className="w-4 h-4 text-white/45 hidden sm:block rtl:rotate-180" />
                    </span>
                  </div>
                ) : (
                  <div key={nivel.key}
                    className={`h-full flex flex-col p-6 md:p-7 rounded-3xl bg-[#211e1b]/90 border border-white/[0.06] transition-colors duration-300 ${nivel.borda}`}>
                    <div className="flex items-center gap-3 mb-5">
                      <span className={`w-11 h-11 shrink-0 rounded-2xl border flex items-center justify-center ${nivel.icone}`} aria-hidden="true">
                        <nivel.Icon className="w-5 h-5" />
                      </span>
                      <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-white/40 leading-snug">
                        {t(`governance.${nivel.key}.stage`)}
                      </span>
                    </div>
                    <h3 className={`text-lg font-extrabold tracking-wide leading-snug mb-1.5 ${nivel.titulo}`}>{t(`governance.${nivel.key}.title`)}</h3>
                    <p className="text-base font-semibold text-white leading-snug mb-3">{t(`governance.${nivel.key}.tagline`)}</p>
                    <p className="text-sm text-white/45 leading-relaxed mb-5">{t(`governance.${nivel.key}.desc`)}</p>
                    <p className={`mt-auto border-s-2 ps-3 text-sm font-medium leading-relaxed ${nivel.destaque}`}>
                      {t(`governance.${nivel.key}.highlight`)}
                    </p>
                  </div>
                ))}
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-5 py-4">
                <HandCoins className="w-5 h-5 shrink-0 mt-0.5 text-[#c98f70]" aria-hidden="true" />
                <p className="text-sm text-white/60 leading-relaxed">{t("governance.noFee")}</p>
              </div>
            </div>

            <div className="lg:col-span-2 h-full flex flex-col p-6 md:p-8 rounded-3xl bg-[#c98f70]/[0.05] border border-amber-400/30 hover:border-amber-400/50 transition-colors duration-300 shadow-[0_0_60px_-24px_rgba(251,191,36,0.35)]">
              <div className="flex items-center gap-3 mb-5">
                <span className="w-11 h-11 shrink-0 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center" aria-hidden="true">
                  <Star className="w-5 h-5 text-amber-400 fill-amber-400" />
                </span>
                <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-amber-400/75 leading-snug">
                  {t("governance.gold.stage")}
                </span>
              </div>
              <h3 className="text-lg font-extrabold tracking-wide leading-snug text-amber-300 mb-1.5">{t("governance.gold.title")}</h3>
              <p className="text-base font-semibold text-white leading-snug mb-3">{t("governance.gold.tagline")}</p>
              <p className="text-sm text-white/50 leading-relaxed mb-5">{t("governance.gold.desc")}</p>
              <ul className="space-y-2.5 mb-6">
                {(["b1", "b2", "b3", "b4", "b5"] as const).map(b => (
                  <li key={b} className="flex items-start gap-2.5 text-sm text-white/70 leading-relaxed">
                    <Check className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" aria-hidden="true" />
                    <span>{t(`governance.gold.benefits.${b}`)}</span>
                  </li>
                ))}
              </ul>
              {/* Cor sólida, e não degradê recortado no texto: o modo escuro do
                  celular escurece o degradê (ver as frases de destaque da Hero). */}
              <p className="text-lg font-bold leading-snug text-amber-300 mb-2">
                {t("governance.gold.highlight")}
              </p>
              <p className="text-sm text-white/60 leading-relaxed mb-6">{t("governance.gold.closing")}</p>
              <p className="mt-auto border-t border-amber-400/15 pt-4 text-sm font-medium text-amber-200/85">
                {t("governance.gold.fee")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── CTA FINAL ─── */}
      <section className="py-28 relative border-t border-white/[0.04] overflow-hidden">
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: "radial-gradient(ellipse 55% 60% at 50% 100%, rgba(201,143,112,0.08) 0%, transparent 70%)" }} />
        <div className="relative container mx-auto px-6 text-center">
          <h2 className="text-4xl md:text-6xl font-extrabold text-white mb-3 tracking-tight">
            {t("cta.title")}
          </h2>
          <p className="text-2xl md:text-3xl font-extrabold text-[#c98f70] mb-10">
            {t("cta.subtitle")}
          </p>
          <Link href={isAuthenticated ? "/dashboard" : "/register"}>
            <button className="group bg-[#c98f70] hover:bg-[#b07a5c] text-[#151312] font-bold px-9 py-4 rounded-2xl text-lg transition-all duration-200 active:scale-[0.97] inline-flex items-center gap-2.5">
              {t("cta.button")}
              <ArrowRight className="w-5 h-5 transition-transform duration-200 group-hover:translate-x-1" />
            </button>
          </Link>
        </div>
      </section>

      {/* ─── FAQ COM IA ─── */}
      <FAQSection />

      {/* ─── FOOTER ─── */}
      {/* pb-20 no celular: o botão fixo de movimento (canto de baixo) cobria o link dos Termos. */}
      <footer className="relative border-t border-white/[0.05] pt-10 pb-20 md:pb-10">
        <div className="container mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4 text-white/25 text-sm">
          <a href="#" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            className="cursor-pointer" aria-label="Voltar ao topo">
            <BrandLogo variante="lockup" className="h-16 w-auto opacity-80" />
          </a>
          <div className="text-center">
            <div className="text-white/40 text-xs mb-1">{t("footer.tagline")}</div>
            <div>© 2026 WRW — Women Rocking the World. {t("footer.rights")}</div>
          </div>
          <div className="flex gap-6">
            {/* O link de contato volta quando houver e-mail ou WhatsApp
                institucional definido pela cliente. */}
            <Link href="/privacidade" className="hover:text-white/60 transition-colors">{t("footer.privacy")}</Link>
            <Link href="/termos" className="hover:text-white/60 transition-colors">{t("footer.terms")}</Link>
          </div>
        </div>
      </footer>

      {/* ─── GLOBAL ANIMATIONS ─── */}
      <style>{`
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
