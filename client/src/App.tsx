import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import ProtectedRoute from "./components/ProtectedRoute";
import { RetomadaDasPartes } from "./components/RetomadaDasPartes";
import { RetomadaDosDescartes } from "./components/RetomadaDosDescartes";
import { ThemeProvider } from "./contexts/ThemeContext";
import { PageTransition } from "./components/PageTransition";
import { PrivacyPage, TermsPage } from "@/pages/LegalPage";

// Lazy loading de todas as páginas para melhor performance
const Home = lazy(() => import("./pages/Home"));
const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Opportunities = lazy(() => import("./pages/Opportunities"));
const OpportunityDetail = lazy(() => import("./pages/OpportunityDetail"));
const NewOpportunity = lazy(() => import("./pages/NewOpportunity"));
const Profile = lazy(() => import("./pages/Profile"));
const Connections = lazy(() => import("./pages/Connections"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const PresidentPanel = lazy(() => import("./pages/PresidentPanel"));
const DealRoom = lazy(() => import("./pages/DealRoom"));
const SIVCVerification = lazy(() => import("./pages/SIVCVerification"));
const Network = lazy(() => import("./pages/Network"));
const Contexts = lazy(() => import("./pages/Contexts"));
const Meetings = lazy(() => import("./pages/Meetings"));
const Memory = lazy(() => import("./pages/Memory"));
const IntelligentMatches = lazy(() => import("./pages/IntelligentMatches"));
const MeuNetworkInteligente = lazy(() => import("./pages/MeuNetworkInteligente"));
const PerfilDoContatoNetwork = lazy(() => import("./pages/PerfilDoContatoNetwork"));
const ReuniaoAberta = lazy(() => import("./pages/ReuniaoAberta"));
const ProximasAcoes = lazy(() => import("./pages/ProximasAcoes"));
const Agenda = lazy(() => import("./pages/Agenda"));
const PainelDaEntidade = lazy(() => import("./pages/PainelDaEntidade"));
const ConviteDaEntidade = lazy(() => import("./pages/ConviteDaEntidade"));
const AtivarCadastro = lazy(() => import("./pages/AtivarCadastro"));
const ConviteDaReuniao = lazy(() => import("./pages/ConviteDaReuniao"));
const ReuniaoCompartilhada = lazy(() => import("./pages/ReuniaoCompartilhada"));
const EquipeDaPasta = lazy(() => import("./pages/EquipeDaPasta"));
const ConviteDaEquipe = lazy(() => import("./pages/ConviteDaEquipe"));
const ReuniaoDaEquipe = lazy(() => import("./pages/ReuniaoDaEquipe"));

// O cabeçalho da área logada entra pelo mesmo caminho das páginas (lazy) para
// não engordar o pacote da landing, que não o usa. `lazy` só aceita export
// default; o AppHeader é um export nomeado, daí o `.then`.
const AppHeader = lazy(() => import("./components/AppHeader").then(m => ({ default: m.AppHeader })));

// Skeleton de loading global
function PageLoader() {
  return (
    <div className="min-h-screen bg-transparent flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="w-12 h-12 rounded-full border-2 border-amber-500/20 border-t-amber-500 animate-spin" />
          <div className="absolute inset-0 w-12 h-12 rounded-full border-2 border-amber-500/10 border-b-amber-400/50 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
        </div>
        <span className="text-sm font-medium tracking-wide text-white">Marquesa Global Match</span>
      </div>
    </div>
  );
}

/**
 * Uma tela autenticada: a guarda de acesso e o cabeçalho com o menu global,
 * montado UMA vez, aqui. Não há mais corte por inatividade (saiu em 10/11/2026,
 * pedido do Roberto): a sessão dura 90 dias desde o último uso, e quem decide
 * quando ela acaba é o servidor (server/duracao-da-sessao.ts).
 *
 * Pedido do Rosber em 14/09/2026: "o ideal é que o menu fique sempre visível na
 * página. Entra em oportunidades: o menu some. Para acessar o menu de novo ele
 * tem que voltar". Eram 11 telas logadas sem cabeçalho nenhum (Oportunidades,
 * Nova Oportunidade, Detalhe, Perfil, Conexões, Rede, Contextos, Deal Room,
 * Painel Admin e Painel Ouro): de dentro delas só se voltava a navegar passando
 * pelo Dashboard. Montar aqui, e não em cada página, é o que faz a tela 19
 * nascer com menu sem ninguém precisar lembrar.
 *
 * As telas que já montam o próprio cabeçalho — porque querem título, "voltar"
 * ou ações próprias — pedem `cabecalhoProprio` para ele não sair em dobro.
 * A guarda disso é client/src/App.cabecalho-de-todas-as-telas.test.ts.
 *
 * Exportada só para o teste montá-la sozinha (App.tela-autenticada.test.tsx);
 * quem usa é o Router logo abaixo.
 *
 * Aqui também moram as retomadas da gravação em partes: a dos descartes que não
 * terminaram (G13b, components/RetomadaDosDescartes.tsx) e a das partes que
 * ficaram no aparelho e dos fins que o servidor não confirmou (G13c,
 * components/RetomadaDasPartes.tsx). Uma vez por tela logada, no mesmo lugar em
 * todas, para elas seguirem montadas de uma tela a outra.
 */
export function TelaAutenticada({
  children,
  cabecalhoProprio = false,
  ...guarda
}: {
  children: React.ReactNode;
  /** A página monta o seu cabeçalho; a rota não monta o global. */
  cabecalhoProprio?: boolean;
  requireAdmin?: boolean;
  requireGold?: boolean;
  requireOpportunities?: boolean;
}) {
  return (
    <ProtectedRoute {...guarda}>
      <RetomadaDosDescartes />
      <RetomadaDasPartes />
      {!cabecalhoProprio && <AppHeader />}
      {children}
    </ProtectedRoute>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        {/* Rota pública - landing page */}
        <Route path={"/"} component={Home} />

        {/* Páginas legais: placeholders até os textos jurídicos da cliente */}
        <Route path={"/privacidade"} component={PrivacyPage} />
        <Route path={"/termos"} component={TermsPage} />

        {/* Autenticação própria */}
        <Route path={"/login"} component={Login} />
        <Route path={"/register"} component={Register} />
        <Route path={"/forgot-password"} component={ForgotPassword} />
        <Route path={"/reset-password"} component={ResetPassword} />

        {/* O link aberto de uma reunião (12/11/2026): público, sem conta. O
            caminho é ROTA_DA_REUNIAO_ABERTA, de shared/rotas.ts. */}
        <Route path="/r/:token" component={ReuniaoAberta} />

        {/* O convite de uma entidade ao app (a base das associações, N1): público, sem conta.
            O caminho é ROTA_DO_CONVITE_DA_ENTIDADE, de shared/entidades.ts; /convite/:token é
            o convite para uma reunião (R1b), mais abaixo. */}
        <Route path="/convite-da-entidade/:token" component={ConviteDaEntidade} />

        {/* A ativação do cadastro importado (N3): o link de uso único que a entidade
            distribui; público, sem conta. O caminho é ROTA_DA_ATIVACAO, de shared/entidades.ts. */}
        <Route path="/ativar/:token" component={AtivarCadastro} />

        {/* Rota de onboarding — protegida, mas, de
            propósito, sem o menu global: com o cadastro incompleto toda outra
            rota protegida devolve a pessoa para cá (ver ProtectedRoute), e um
            menu aqui seria um beco sem saída. */}
        <Route path={"/onboarding"}>
          <ProtectedRoute permitirCadastroIncompleto>
            <Onboarding />
          </ProtectedRoute>
        </Route>

        {/* Rotas protegidas com guard de autenticação. O Dashboard monta a
            própria barra (o aviso de convites pendentes fica nela, ao lado do
            GlobalMenu), por isso vai de `cabecalhoProprio`. */}
        <Route path={"/dashboard"}>
          <TelaAutenticada cabecalhoProprio>
            <Dashboard />
          </TelaAutenticada>
        </Route>

        <Route path={"/admin"}>
          <TelaAutenticada requireAdmin>
            <AdminPanel />
          </TelaAutenticada>
        </Route>

        {/* Painel Ouro — Ouro/Admin, ou quem tem o poder de distribuição do Smart
            Match (só a aba Distribuição). A guarda fina mora no próprio painel. */}
        <Route path={"/president"}>
          <TelaAutenticada>
            <PresidentPanel />
          </TelaAutenticada>
        </Route>

        {/* Rota de perfil */}
        <Route path="/profile">
          <TelaAutenticada>
            <Profile />
          </TelaAutenticada>
        </Route>

        {/* Rotas de oportunidades — Prata e Bronze têm acesso */}
        <Route path="/opportunities/new">
          <TelaAutenticada requireOpportunities>
            <NewOpportunity />
          </TelaAutenticada>
        </Route>

        <Route path="/opportunities/:id">
          <TelaAutenticada requireOpportunities>
            <OpportunityDetail />
          </TelaAutenticada>
        </Route>

        <Route path="/opportunities">
          <TelaAutenticada requireOpportunities>
            <Opportunities />
          </TelaAutenticada>
        </Route>

        {/* Conexões estratégicas — exclusivo para Ouro */}
        <Route path="/connections">
          <TelaAutenticada requireGold>
            <Connections />
          </TelaAutenticada>
        </Route>

        {/* Deal Room — sala de negociação privada */}
        <Route path="/deal-room/:id">
          <TelaAutenticada>
            <DealRoom />
          </TelaAutenticada>
        </Route>

        {/* SIVC — Verificação de Identidade */}
        <Route path="/verification">
          <TelaAutenticada cabecalhoProprio>
            <SIVCVerification />
          </TelaAutenticada>
        </Route>

        {/* Minha Rede de Relacionamentos — Base Particular de Contatos */}
        <Route path="/network">
          <TelaAutenticada>
            <Network />
          </TelaAutenticada>
        </Route>

        {/* Contextos — Onde e Como Conheceu */}
        <Route path="/contexts">
          <TelaAutenticada>
            <Contexts />
          </TelaAutenticada>
        </Route>

        {/* Assistente de Reuniões — gravação e transcrição privada. A isenção
            vale para a tela inteira: a página monta o cabeçalho ACIMA dos seus
            três ramos (lista, nova reunião, detalhe), e não dentro de um deles
            — montado só na lista, os outros dois ficavam sem menu nenhum.
            A URL escolhe o ramo (shared/rotas.ts): /gravar é o gravador, o
            link exclusivo e a primeira tela depois do login (pedido da cliente
            de 20/10/2026); /meetings/:id é o detalhe; /meetings, a lista.
            Os três blocos ficam idênticos, sem key: assim montam a MESMA
            instância da página, e a gravação em curso não se perde entre eles
            (App.cabecalho-de-todas-as-telas.test.ts confere). */}
        <Route path="/gravar">
          <TelaAutenticada cabecalhoProprio>
            <Meetings />
          </TelaAutenticada>
        </Route>

        <Route path="/meetings/:id">
          <TelaAutenticada cabecalhoProprio>
            <Meetings />
          </TelaAutenticada>
        </Route>

        <Route path="/meetings">
          <TelaAutenticada cabecalhoProprio>
            <Meetings />
          </TelaAutenticada>
        </Route>

        {/* As participantes (R1b): o convite por link (/convite/{token}, só
            logada; o login volta para cá) e a reunião compartilhada com a
            participante, a leitura dela, fora do detalhe da dona. Os caminhos
            são ROTA_DO_CONVITE e ROTA_DA_REUNIAO_COMPARTILHADA, de shared/rotas.ts. */}
        <Route path="/convite/:token">
          <TelaAutenticada>
            <ConviteDaReuniao />
          </TelaAutenticada>
        </Route>

        <Route path="/reunioes-compartilhadas/:id">
          <TelaAutenticada>
            <ReuniaoCompartilhada />
          </TelaAutenticada>
        </Route>

        {/* Os espaços de equipe (R2): o convite (/convite-da-equipe/{token}, só
            logada), a equipe da pasta (reuniões, tarefas, agenda e membras) e a
            reunião da equipe lida pela membra. Os caminhos são de shared/rotas.ts. */}
        <Route path="/convite-da-equipe/:token">
          <TelaAutenticada>
            <ConviteDaEquipe />
          </TelaAutenticada>
        </Route>

        <Route path="/equipes/:pastaId/reunioes/:id">
          <TelaAutenticada>
            <ReuniaoDaEquipe />
          </TelaAutenticada>
        </Route>

        <Route path="/equipes/:pastaId">
          <TelaAutenticada>
            <EquipeDaPasta />
          </TelaAutenticada>
        </Route>

        {/* A agenda de reuniões (H16a): marcar, convidar e o "Gravar agora",
            que abre o /gravar com a reunião marcada. O caminho é
            ROTA_DA_AGENDA, de shared/rotas.ts. */}
        {/* O painel da entidade (a base das associações, N1): só a conta com o poder
            de entidade; o servidor recusa as outras (entidadeProcedure). */}
        <Route path="/entidade">
          <TelaAutenticada>
            <PainelDaEntidade />
          </TelaAutenticada>
        </Route>

        <Route path="/agenda">
          <TelaAutenticada>
            <Agenda />
          </TelaAutenticada>
        </Route>

        <Route path="/memory">
          <TelaAutenticada cabecalhoProprio>
            <Memory />
          </TelaAutenticada>
        </Route>

        {/* Próximas ações (H5a): o que a dona confirmou nos resumos das reuniões
            e o que anotou à mão. O caminho é ROTA_DAS_PROXIMAS_ACOES, de
            shared/proximas-acoes.ts. */}
        <Route path="/proximas-acoes">
          <TelaAutenticada>
            <ProximasAcoes />
          </TelaAutenticada>
        </Route>

        <Route path="/intelligent-matches">
          <TelaAutenticada cabecalhoProprio>
            <IntelligentMatches />
          </TelaAutenticada>
        </Route>

        {/* Meu Network Inteligente — perfil de um contato: Quem Sou, O Que
            Tenho, O Que Preciso, ID anônimo, sugestões da IA, conexões e a
            memória de relacionamento (spec de 14/09, itens 20 e 22) */}
        <Route path="/meu-network-inteligente/contatos/:id">
          <TelaAutenticada cabecalhoProprio>
            <PerfilDoContatoNetwork />
          </TelaAutenticada>
        </Route>

        {/* Meu Network Inteligente — painel da rede particular: reuniões,
            contatos, informações faltando e matches internos */}
        <Route path="/meu-network-inteligente">
          <TelaAutenticada cabecalhoProprio>
            <MeuNetworkInteligente />
          </TelaAutenticada>
        </Route>

        <Route path={"/404"} component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          {/* abstract-bg aplica o fundo azul-escuro com formas retangulares em TODAS as páginas */}
          <div className="abstract-bg min-h-screen">
            <PageTransition>
              <Router />
            </PageTransition>
          </div>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
