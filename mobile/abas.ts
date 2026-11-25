// As abas da barra de baixo do app: qual tela do site cada uma abre, o nome em
// cada idioma do site e quando a barra aparece. A barra é do app (nativa), e o
// site não muda: cada aba só leva a WebView a uma rota que já existe.

export type IdDaAba = 'inicio' | 'rede' | 'reunioes' | 'oportunidades' | 'agenda';

/** `destaque`: o botão redondo do centro. */
export type Aba = { id: IdDaAba; caminho: string; destaque?: boolean };

// As seções do menu do site (getMenuItems em client/src/components/AppHeader.tsx)
// e o Início, que o logo do site abre. Reuniões fica no centro: é o que a
// cliente quer ver primeiro (o menu do site também começa por ela). Todas abrem
// para qualquer nível logado (bronze, prata, ouro, presidente, admin). O resto
// do menu (Meu Network Inteligente, Verificação, Linha do Tempo, Memória IA,
// Conexões Inteligentes) segue no Menu do site, e o Perfil, no avatar do topo.
export const ABAS: readonly Aba[] = [
  { id: 'inicio', caminho: '/dashboard' },
  { id: 'rede', caminho: '/network' },
  { id: 'reunioes', caminho: '/meetings', destaque: true },
  { id: 'oportunidades', caminho: '/opportunities' },
  { id: 'agenda', caminho: '/agenda' },
];

// Os nomes são os do site, nos 10 idiomas (client/src/i18n/locales):
// onboarding.nav.home, appHeader.menu.network, appHeader.menu.meetings,
// appHeader.menu.opportunities e appHeader.menu.agenda. Mudou lá, mude aqui.
const NOMES: Record<string, Record<IdDaAba, string>> = {
  'pt-BR': { inicio: 'Início', rede: 'Minha Rede', reunioes: 'Reuniões', oportunidades: 'Oportunidades', agenda: 'Agenda' },
  en: { inicio: 'Home', rede: 'My Network', reunioes: 'Meetings', oportunidades: 'Opportunities', agenda: 'Schedule' },
  es: { inicio: 'Inicio', rede: 'Mi Red', reunioes: 'Reuniones', oportunidades: 'Oportunidades', agenda: 'Agenda' },
  fr: { inicio: 'Accueil', rede: 'Mon réseau', reunioes: 'Réunions', oportunidades: 'Opportunités', agenda: 'Agenda' },
  ar: { inicio: 'الرئيسية', rede: 'شبكتي', reunioes: 'الاجتماعات', oportunidades: 'الفرص', agenda: 'الجدول' },
  zh: { inicio: '首页', rede: '我的人脉', reunioes: '会议', oportunidades: '机会', agenda: '日程' },
  hi: { inicio: 'होम', rede: 'मेरा नेटवर्क', reunioes: 'बैठकें', oportunidades: 'अवसर', agenda: 'शेड्यूल' },
  de: { inicio: 'Startseite', rede: 'Mein Netzwerk', reunioes: 'Meetings', oportunidades: 'Möglichkeiten', agenda: 'Termine' },
  ja: { inicio: 'ホーム', rede: 'マイネットワーク', reunioes: 'ミーティング', oportunidades: '機会', agenda: '予定' },
  ru: { inicio: 'Главная', rede: 'Моя сеть', reunioes: 'Встречи', oportunidades: 'Возможности', agenda: 'Расписание' },
};

/**
 * Conta ao site, antes de ele montar, quais telas já estão na barra: o Menu do
 * site deixa de repeti-las dentro do app (client/src/lib/barra-do-app.ts). Sem
 * isso, o menu com as 9 telas tomava a tela do celular e escondia o Sair.
 */
export function scriptDasRotasDaBarra(): string {
  return `window.__wrwRotasDaBarraDoApp = ${JSON.stringify(ABAS.map(aba => aba.caminho))};\ntrue;\n`;
}

/** O idioma do site que o app conhece: o exato ("pt-BR"), a base ("pt" → "pt-BR") ou o português. */
export function idiomaDaBarra(lang: string | null | undefined): string {
  if (!lang) return 'pt-BR';
  if (NOMES[lang]) return lang;
  const base = lang.split('-')[0].toLowerCase();
  return Object.keys(NOMES).find(codigo => codigo.split('-')[0] === base) ?? 'pt-BR';
}

export function nomeDaAba(id: IdDaAba, lang: string | null | undefined): string {
  return NOMES[idiomaDaBarra(lang)][id];
}

/** A aba da tela aberta: a da rota igual ou de uma rota abaixo dela (/meetings/12 é Reuniões). */
export function abaDoCaminho(caminho: string | null): IdDaAba | null {
  if (!caminho) return null;
  const aba = ABAS.find(({ caminho: rota }) => caminho === rota || caminho.startsWith(`${rota}/`));
  return aba ? aba.id : null;
}

// Fora da área logada a barra não aparece. Em /gravar também não: um toque sem
// querer numa aba tiraria a pessoa do gravador no meio da reunião.
const SEM_BARRA = new Set([
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/privacidade',
  '/termos',
  '/onboarding',
  '/404',
  '/gravar',
]);

export type EstadoDaTela = {
  /** O caminho da página aberta; null enquanto o app ainda não sabe. */
  caminho: string | null;
  gravando: boolean;
  /** A tela "Sem conexão" do app está aberta. */
  semConexao: boolean;
  /** O teclado está aberto: a barra sai para não ocupar a tela de quem digita. */
  tecladoAberto: boolean;
};

export function barraAparece({ caminho, gravando, semConexao, tecladoAberto }: EstadoDaTela): boolean {
  if (!caminho || gravando || semConexao || tecladoAberto) return false;
  const semBarraNoFim = caminho.length > 1 ? caminho.replace(/\/+$/, '') : caminho;
  if (SEM_BARRA.has(semBarraNoFim)) return false;
  // O link aberto de uma reunião (/r/:token) é para quem não tem conta.
  return !semBarraNoFim.startsWith('/r/');
}

/**
 * O script que leva a WebView à aba. Dentro do site, troca a rota sem
 * recarregar (o wouter ouve o pushState e o popstate), como um link do próprio
 * site; fora dele (página de erro, outra origem), carrega a página da aba.
 */
export function scriptParaAbrir(caminho: string, origem: string): string {
  const destino = JSON.stringify(caminho);
  const completo = JSON.stringify(origem + caminho);
  return `
(function () {
  try {
    if (/^https:\\/\\/(www\\.)?wrwglobal\\.org$/.test(location.origin) && window.history && history.pushState) {
      if (location.pathname !== ${destino} || location.search || location.hash) {
        history.pushState(null, '', ${destino});
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      }
      window.scrollTo(0, 0);
      return;
    }
  } catch (e) {}
  location.href = ${completo};
})();
true;
`;
}
