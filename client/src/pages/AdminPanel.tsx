import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import {
  Shield, Users, FileText, AlertTriangle, Activity, Lock,
  Eye, CheckCircle, XCircle, RefreshCw, LogOut, Wifi, Ban,
  Trash2, Server, Clock, Globe, Monitor, Package, Star,
  ShieldCheck, AlertCircle
} from "lucide-react";
import { toast } from "sonner";

const playfairStyle = { fontFamily: '"Playfair Display", serif' };

type TabType = "overview" | "users" | "audit" | "security" | "sessions" | "opportunities";

export default function AdminPanel() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const [lockReason, setLockReason] = useState<Record<number, string>>({});
  const utils = trpc.useUtils();

  // Queries
  const isAdminOrPresident = user?.role === "admin" || user?.role === "president";

  const statsQuery = trpc.admin.getStats.useQuery(undefined, {
    enabled: isAuthenticated && isAdminOrPresident,
    refetchInterval: 30000, // Atualiza a cada 30s (monitoramento em tempo real)
  });
  const usersQuery = trpc.admin.getUsers.useQuery(
    { limit: 50, offset: 0 },
    { enabled: activeTab === "users" && isAuthenticated }
  );
  const auditQuery = trpc.admin.getAuditLogs.useQuery(
    { limit: 100, offset: 0 },
    { enabled: activeTab === "audit" && isAuthenticated, refetchInterval: activeTab === "audit" ? 15000 : false }
  );
  const securityQuery = trpc.admin.getSecurityEvents.useQuery(
    { resolved: false },
    { enabled: activeTab === "security" && isAuthenticated, refetchInterval: activeTab === "security" ? 10000 : false }
  );
  const sessionsQuery = trpc.admin.getActiveSessions.useQuery(
    { limit: 100 },
    { enabled: activeTab === "sessions" && isAuthenticated, refetchInterval: activeTab === "sessions" ? 15000 : false }
  );
  const pendingOppsQuery = trpc.admin.getPendingOpportunities.useQuery(
    undefined,
    { enabled: activeTab === "opportunities" && isAuthenticated }
  );
  const moderateOppMutation = trpc.admin.moderateOpportunity.useMutation({
    onSuccess: (_, vars) => {
      toast.success(vars.action === "approve" ? "Oportunidade aprovada!" : "Oportunidade rejeitada");
      pendingOppsQuery.refetch();
      statsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });
  const [moderationNotes, setModerationNotes] = useState<Record<number, string>>({});

  // Mutations
  const resolveEventMutation = trpc.admin.resolveEvent.useMutation({
    onSuccess: () => {
      toast.success("Evento resolvido com sucesso");
      securityQuery.refetch();
      statsQuery.refetch();
    },
  });

  const updateRoleMutation = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => {
      toast.success("Função do usuário atualizada");
      usersQuery.refetch();
    },
  });

  const toggleStatusMutation = trpc.admin.toggleUserStatus.useMutation({
    onSuccess: (_, vars) => {
      toast.success(vars.isActive ? "Conta ativada" : "Conta desativada");
      usersQuery.refetch();
    },
  });

  const revokeSessionsMutation = trpc.admin.revokeUserSessions.useMutation({
    onSuccess: () => {
      toast.success("Todas as sessões do usuário foram revogadas");
      usersQuery.refetch();
      sessionsQuery.refetch();
      statsQuery.refetch();
    },
    onError: () => toast.error("Erro ao revogar sessões"),
  });

  const lockAccountMutation = trpc.admin.lockAccount.useMutation({
    onSuccess: () => {
      toast.success("Conta bloqueada e sessões revogadas");
      usersQuery.refetch();
      sessionsQuery.refetch();
      statsQuery.refetch();
    },
    onError: (err) => toast.error(err.message || "Erro ao bloquear conta"),
  });

  const revokeSessionMutation = trpc.admin.revokeUserSessions.useMutation({
    onSuccess: () => {
      toast.success("Sessão revogada com sucesso");
      sessionsQuery.refetch();
      statsQuery.refetch();
    },
    onError: () => toast.error("Erro ao revogar sessão"),
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-[#C98F70] border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-white">Verificando credenciais...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    navigate("/");
    return null;
  }

  if (user.role !== "admin" && user.role !== "president") {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-center">
          <Shield className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 style={playfairStyle} className="text-2xl font-bold text-white mb-2">Acesso Negado</h1>
          <p className="text-gray-400 mb-6">Este painel é restrito a Administradores e membros Ouro da plataforma.</p>
          <button
            onClick={() => navigate("/dashboard")}
            className="px-6 py-3 bg-[#C98F70] text-[#1A120C] font-semibold rounded-lg hover:bg-[#B07A5C] transition-colors"
          >
            Voltar ao Dashboard
          </button>
        </div>
      </div>
    );
  }

  const stats = statsQuery.data;

  const getRiskColor = (level: string) => {
    switch (level) {
      case "critical": return "text-red-400 bg-red-900/30";
      case "high": return "text-orange-400 bg-orange-900/30";
      case "medium": return "text-yellow-400 bg-yellow-900/30";
      default: return "text-green-400 bg-green-900/30";
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical": return "text-red-400";
      case "warning": return "text-yellow-400";
      default: return "text-blue-400";
    }
  };

  const getRoleBadge = (role: string) => {
    const colors: Record<string, string> = {
      president: "bg-[#C98F70]/20 text-[#C98F70] border border-[#C98F70]/60",
      admin: "bg-red-900/50 text-red-300 border border-red-700",
      gold: "bg-amber-900/40 text-amber-300 border border-amber-600",
      silver: "bg-slate-700/50 text-slate-300 border border-slate-500",
      bronze: "bg-orange-900/40 text-orange-400 border border-orange-700",
    };
    return colors[role] || colors.bronze;
  };

  const getRoleLabel = (role: string) => {
    const labels: Record<string, string> = {
      president: "Ouro",
      admin: "Admin",
      gold: "Ouro",
      silver: "Prata",
      bronze: "Bronze",
    };
    return labels[role] || role;
  };

  const formatUserAgent = (ua: string | null) => {
    if (!ua) return "Desconhecido";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Safari")) return "Safari";
    if (ua.includes("Edge")) return "Edge";
    return ua.substring(0, 30) + "...";
  };

  const tabs = [
    { id: "overview" as TabType, label: "Visão Geral", icon: Activity },
    { id: "sessions" as TabType, label: "Sessões Ativas", icon: Wifi },
    { id: "users" as TabType, label: "Usuários", icon: Users },
    { id: "opportunities" as TabType, label: "Oportunidades", icon: Package },
    { id: "audit" as TabType, label: "Auditoria", icon: FileText },
    { id: "security" as TabType, label: "Alertas", icon: AlertTriangle },
  ];

  return (
    <div className="min-h-screen bg-transparent text-white">
      {/* Header */}
      <header className="bg-[#1B1714] border-b border-[#C98F70]/30 sticky top-16 z-30">
        {/* Em 375 px esta linha não caberia nunca: logo + subtítulo + nome +
            selo ADMIN + "Dashboard" + "Sair" numa única fila. Como os itens de
            flex encolhem abaixo do conteúdo, o texto vazava da própria caixa: o
            selo ADMIN saía DESENHADO EM CIMA do botão "Dashboard" e o "Sair"
            terminava fora da tela. Agora a fila quebra (flex-wrap), o nome
            corta com truncate e os botões não encolhem. */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-center gap-3">
            <Shield className="w-7 h-7 flex-shrink-0 text-[#C98F70]" />
            <div className="min-w-0">
              <button
                onClick={() => navigate("/dashboard")}
                style={playfairStyle}
                className="text-xl font-bold text-white hover:text-[#C98F70] transition-colors"
              >
                WRW
              </button>
              <p className="text-xs text-gray-400 truncate">Painel Administrativo Seguro</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <div className="flex min-w-0 items-center gap-2">
              <div className="w-2 h-2 flex-shrink-0 bg-green-400 rounded-full animate-pulse"></div>
              <span className="truncate text-sm text-gray-300">{user.name}</span>
              <span className="flex-shrink-0 px-2 py-0.5 text-xs bg-red-900/50 text-red-300 border border-red-700 rounded">ADMIN</span>
            </div>
            <button
              onClick={() => navigate("/dashboard")}
              className="flex-shrink-0 px-4 py-2 text-sm border border-[#C98F70]/50 text-[#C98F70] rounded-lg hover:bg-[#C98F70]/10 transition-colors"
            >
              Dashboard
            </button>
            <button
              onClick={() => { logout(); navigate("/"); }}
              className="flex flex-shrink-0 items-center gap-2 px-4 py-2 text-sm bg-red-900/30 text-red-400 border border-red-700/50 rounded-lg hover:bg-red-900/50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sair
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Tabs */}
        <div className="flex gap-2 mb-8 bg-[#1B1714]/50 p-1 rounded-xl border border-[#C98F70]/20 w-fit flex-wrap">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === id
                  ? "bg-[#C98F70] text-[#1A120C]"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* ====================================================
            VISÃO GERAL
        ==================================================== */}
        {activeTab === "overview" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 style={playfairStyle} className="text-3xl font-bold text-white">
                🔒 Centro de Controle de Segurança
              </h2>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                <span className="text-xs text-gray-400">Atualização automática a cada 30s</span>
                <button
                  onClick={() => statsQuery.refetch()}
                  className="p-1.5 text-[#C98F70] hover:bg-[#C98F70]/10 rounded transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {[
                { label: "Total de Usuários", value: stats?.totalUsers ?? "-", icon: Users, color: "text-blue-400", bg: "bg-blue-900/20" },
                { label: "Sessões Ativas", value: stats?.activeSessions ?? "-", icon: Wifi, color: "text-green-400", bg: "bg-green-900/20" },
                { label: "Alertas Pendentes", value: stats?.unresolvedSecurityEvents ?? "-", icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-900/20" },
                { label: "Logs Hoje", value: stats?.todayAuditLogs ?? "-", icon: FileText, color: "text-purple-400", bg: "bg-purple-900/20" },
              ].map((stat, idx) => (
                <div key={idx} className={`bg-[#1B1714] border border-[#C98F70]/20 rounded-xl p-5 relative overflow-hidden`}>
                  <div className={`absolute inset-0 ${stat.bg} opacity-30`}></div>
                  <div className="relative">
                    <div className="flex items-center justify-between mb-3">
                      <stat.icon className={`w-6 h-6 ${stat.color}`} />
                      <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                    </div>
                    <div className="text-3xl font-bold text-white mb-1">{stat.value}</div>
                    <div className="text-xs text-gray-400">{stat.label}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Arquitetura de Segurança */}
            <div className="grid md:grid-cols-2 gap-6">
              <div className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl p-6">
                <h3 style={playfairStyle} className="text-xl font-bold text-[#C98F70] mb-4">Camadas de Proteção Ativas</h3>
                <div className="space-y-3">
                  {[
                    { layer: "Criptografia AES-256-GCM (Cofre)", status: "Ativo" },
                    { layer: "Rate Limiting Global (200 req/min/IP)", status: "Ativo" },
                    { layer: "Rate Limiting API (100 req/min/IP)", status: "Ativo" },
                    { layer: "Rate Limiting OAuth (10 req/min/IP)", status: "Ativo" },
                    { layer: "Logs de Auditoria Imutáveis", status: "Ativo" },
                    { layer: "Sessões com Expiração (90 dias sem uso)", status: "Ativo" },
                    { layer: "RBAC (5 níveis de permissão)", status: "Ativo" },
                    { layer: "Detecção de IP Suspeito", status: "Ativo" },
                    { layer: "Detecção de Múltiplas Sessões", status: "Ativo" },
                    { layer: "Bloqueio por Brute Force (5 tentativas)", status: "Ativo" },
                    { layer: "Headers HTTP (Helmet + HSTS)", status: "Ativo" },
                    { layer: "Anti-Scanner (Nikto, SQLMap, etc.)", status: "Ativo" },
                    { layer: "Revogação Real de Sessão no Banco", status: "Ativo" },
                    { layer: "Verificação de Integridade SHA-256", status: "Ativo" },
                    { layer: "Cookie SameSite=Lax + HttpOnly", status: "Ativo" },
                  ].map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between py-2 border-b border-[#C98F70]/10">
                      <div className="flex items-center gap-2">
                        <Lock className="w-3 h-3 text-[#C98F70] flex-shrink-0" />
                        <span className="text-xs text-gray-300">{item.layer}</span>
                      </div>
                      <span className="text-xs font-semibold text-green-400 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" />
                        {item.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-6">
                <div className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl p-6">
                  <h3 style={playfairStyle} className="text-xl font-bold text-[#C98F70] mb-4">Governança Institucional</h3>
                  <div className="space-y-3">
                    {[
                      {
                        role: "Ouro",
                        badge: "bg-[#C98F70]/20 text-[#C98F70] border-[#C98F70]/60",
                        desc: "Guardiões da governança. Aprovam/revogam o Status Ouro, homologam líderes, validam oportunidades estratégicas."
                      },
                      {
                        role: "Admin",
                        badge: "bg-red-900/50 text-red-300 border-red-700",
                        desc: "Acesso técnico total ao sistema. Suporte operacional da plataforma."
                      },
                      {
                        role: "Ouro",
                        badge: "bg-amber-900/40 text-amber-300 border-amber-600",
                        desc: "Categoria premium mediante mensalidade. Acesso em primeira mão a oportunidades selecionadas e a encontros estratégicos nacionais e internacionais."
                      },
                      // Bronze e Prata medem a qualificação do perfil, não são planos
                      // (Governança, 14/09/2026). Os acessos das duas são os mesmos.
                      {
                        role: "Prata",
                        badge: "bg-slate-700/50 text-slate-300 border-slate-500",
                        desc: "Perfil qualificado: Quem Sou, O Que Tenho e O Que Preciso completos. Sem mensalidade. Cadastra oportunidades, demonstra interesse e utiliza a IA de compliance."
                      },
                      {
                        role: "Bronze",
                        badge: "bg-orange-900/40 text-orange-400 border-orange-700",
                        desc: "Perfil em qualificação: todo cadastro começa aqui e passa a Prata automaticamente quando o perfil fica completo. Sem mensalidade, com os mesmos acessos da Prata."
                      },
                    ].map((item, idx) => (
                      <div key={idx} className="flex flex-col gap-1 py-3 border-b border-[#C98F70]/10 last:border-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded border ${item.badge} font-semibold`}>{item.role}</span>
                        </div>
                        <p className="text-xs text-gray-400 leading-relaxed">{item.desc}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-4 text-xs text-[#C98F70]/60 italic">
                    O Status Ouro é a categoria premium da rede, mediante mensalidade. Não há preço nem cobrança integrados à plataforma: por enquanto, ele é concedido manualmente pelos membros Ouro.
                  </p>
                </div>

                {/* Ações Rápidas */}
                <div className="bg-[#1B1714] border border-red-700/30 rounded-xl p-6">
                  <h3 style={playfairStyle} className="text-xl font-bold text-red-400 mb-4 flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" />
                    Ações de Emergência
                  </h3>
                  <div className="space-y-3">
                    <button
                      onClick={() => setActiveTab("sessions")}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-orange-900/20 border border-orange-700/50 text-orange-400 rounded-lg hover:bg-orange-900/40 transition-colors text-sm"
                    >
                      <Wifi className="w-4 h-4" />
                      Gerenciar Sessões Ativas ({stats?.activeSessions ?? "-"})
                    </button>
                    <button
                      onClick={() => setActiveTab("security")}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-red-900/20 border border-red-700/50 text-red-400 rounded-lg hover:bg-red-900/40 transition-colors text-sm"
                    >
                      <AlertTriangle className="w-4 h-4" />
                      Ver Alertas Pendentes ({stats?.unresolvedSecurityEvents ?? "-"})
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ====================================================
            SESSÕES ATIVAS (NOVO)
        ==================================================== */}
        {activeTab === "sessions" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 style={playfairStyle} className="text-3xl font-bold text-white">Sessões Ativas</h2>
                <p className="text-sm text-gray-400 mt-1">Monitoramento em tempo real de todas as sessões autenticadas no sistema</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                  <span className="text-xs text-gray-400">Atualiza a cada 15s</span>
                </div>
                <button
                  onClick={() => sessionsQuery.refetch()}
                  className="flex items-center gap-2 px-4 py-2 text-sm border border-[#C98F70]/50 text-[#C98F70] rounded-lg hover:bg-[#C98F70]/10 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  Atualizar
                </button>
              </div>
            </div>

            {/* Resumo */}
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-[#1B1714] border border-green-700/30 rounded-xl p-4">
                <div className="text-2xl font-bold text-green-400">{sessionsQuery.data?.length ?? 0}</div>
                <div className="text-xs text-gray-400 mt-1">Sessões Ativas Agora</div>
              </div>
              <div className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl p-4">
                <div className="text-2xl font-bold text-[#C98F70]">
                  {new Set((sessionsQuery.data as Array<{ userId: number }> | undefined)?.map((s) => s.userId)).size ?? 0}
                </div>
                <div className="text-xs text-gray-400 mt-1">Usuários Únicos Online</div>
              </div>
              <div className="bg-[#1B1714] border border-orange-700/30 rounded-xl p-4">
                <div className="text-2xl font-bold text-orange-400">
                  {(sessionsQuery.data as Array<{ userId: number }> | undefined)?.filter((s) => {
                    const userSessions = (sessionsQuery.data as Array<{ userId: number }> | undefined)?.filter((x) => x.userId === s.userId) ?? [];
                    return userSessions.length > 1;
                  }).length ?? 0}
                </div>
                <div className="text-xs text-gray-400 mt-1">Sessões Múltiplas Detectadas</div>
              </div>
            </div>

            {sessionsQuery.isLoading ? (
              <div className="text-center py-12 text-gray-400">Carregando sessões...</div>
            ) : (
              <div className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl overflow-x-auto">
                {/* Em 375 px estas tabelas (7, 5 e 6 colunas) não cabem. O
                    container era `overflow-hidden`: a tabela ficava cortada e as
                    últimas colunas, inclusive "Ações", eram inalcançáveis.
                    `overflow-x-auto` deixa a tabela rolar DENTRO do cartão, sem
                    arrastar a página para o lado. */}
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-[#C98F70]/20">
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">ID Sessão</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Usuário</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">IP</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Dispositivo</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Última Atividade</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Expira em</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionsQuery.data?.map((session: { id: number; userId: number; ipAddress?: string | null; userAgent?: string | null; lastActivityAt?: string | Date | null; expiresAt?: string | Date | null; userName?: string | null }) => {
                      const userSessions = sessionsQuery.data?.filter((s: { userId: number }) => s.userId === session.userId) ?? [];
                      const hasMultiple = userSessions.length > 1;
                      const expiresAt = session.expiresAt ? new Date(session.expiresAt as string | Date) : null;
                      const isExpiringSoon = expiresAt ? expiresAt.getTime() - Date.now() < 60 * 60 * 1000 : false; // < 1h

                      return (
                        <tr
                          key={session.id}
                          className={`border-b border-[#C98F70]/10 hover:bg-[#C98F70]/5 transition-colors ${hasMultiple ? "bg-orange-900/10" : ""}`}
                        >
                          <td className="px-6 py-4">
                            <span className="font-mono text-xs text-gray-400">#{session.id}</span>
                            {hasMultiple && (
                              <span className="ml-2 text-xs px-1.5 py-0.5 bg-orange-900/50 text-orange-400 border border-orange-700/50 rounded">
                                múltipla
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span className="text-sm text-gray-300">ID: {session.userId}</span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-1">
                              <Globe className="w-3 h-3 text-gray-500" />
                              <span className="font-mono text-xs text-gray-400">{session.ipAddress || "-"}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-1">
                              <Monitor className="w-3 h-3 text-gray-500" />
                              <span className="text-xs text-gray-400">{formatUserAgent(session.userAgent ?? null)}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-1">
                              <Clock className="w-3 h-3 text-gray-500" />
                              <span className="text-xs text-gray-400">
                                {session.lastActivityAt ? new Date(session.lastActivityAt as string | Date).toLocaleString("pt-BR") : "-"}
                              </span>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <span className={`text-xs ${isExpiringSoon ? "text-orange-400" : "text-gray-400"}`}>
                              {expiresAt?.toLocaleString("pt-BR") ?? "-"}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <button
                              onClick={() => {
                                if (confirm(`Revogar sessão #${session.id}? O usuário será desconectado imediatamente.`)) {
                                  revokeSessionMutation.mutate({ userId: session.id });
                                }
                              }}
                              disabled={revokeSessionMutation.isPending}
                              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-red-900/30 text-red-400 border border-red-700/50 rounded-lg hover:bg-red-900/50 transition-colors disabled:opacity-50"
                            >
                              <Ban className="w-3 h-3" />
                              Revogar
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {(!sessionsQuery.data || sessionsQuery.data.length === 0) && (
                  <div className="text-center py-12">
                    <Server className="w-12 h-12 text-gray-600 mx-auto mb-3" />
                    <p className="text-gray-400">Nenhuma sessão ativa no momento</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ====================================================
            USUÁRIOS
        ==================================================== */}
        {activeTab === "users" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 style={playfairStyle} className="text-3xl font-bold text-white">Gestão de Usuários</h2>
              <button
                onClick={() => usersQuery.refetch()}
                className="flex items-center gap-2 px-4 py-2 text-sm border border-[#C98F70]/50 text-[#C98F70] rounded-lg hover:bg-[#C98F70]/10 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Atualizar
              </button>
            </div>

            {usersQuery.isLoading ? (
              <div className="text-center py-12 text-gray-400">Carregando usuários...</div>
            ) : (
              <div className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl overflow-x-auto">
                {/* Em 375 px estas tabelas (7, 5 e 6 colunas) não cabem. O
                    container era `overflow-hidden`: a tabela ficava cortada e as
                    últimas colunas, inclusive "Ações", eram inalcançáveis.
                    `overflow-x-auto` deixa a tabela rolar DENTRO do cartão, sem
                    arrastar a página para o lado. */}
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-[#C98F70]/20">
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Usuário</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Função</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Status</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Último Acesso</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usersQuery.data?.map((u) => (
                      <tr key={u.id} className="border-b border-[#C98F70]/10 hover:bg-[#C98F70]/5 transition-colors">
                        <td className="px-6 py-4">
                          <div>
                            <div className="font-medium text-white">{u.name || "-"}</div>
                            <div className="text-xs text-gray-400">{u.email || "-"}</div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col gap-1">
                            <select
                              value={u.role}
                              onChange={(e) => {
                                const newRole = e.target.value as "bronze" | "silver" | "gold" | "admin" | "president";
                                if (newRole === "gold" && u.role !== "gold") {
                                  if (!confirm(`Conceder Status Ouro a ${u.name || u.email}?\n\nOuro é a categoria premium da rede. A decisão será registrada no log de auditoria.`)) return;
                                }
                                if (u.role === "gold" && newRole !== "gold") {
                                  if (!confirm(`Revogar Status Ouro de ${u.name || u.email}?\n\nEsta ação será registrada no log de auditoria.`)) return;
                                }
                                updateRoleMutation.mutate({ userId: u.id, role: newRole });
                              }}
                              className={`text-xs px-2 py-1 rounded border bg-[#1B1714] cursor-pointer ${getRoleBadge(u.role)}`}
                            >
                              <option className="bg-white text-[#322C26]" value="bronze">Bronze (perfil em qualificação)</option>
                              <option className="bg-white text-[#322C26]" value="silver">Prata (perfil qualificado)</option>
                              <option className="bg-white text-[#322C26]" value="gold">Ouro (categoria premium)</option>
                              <option className="bg-white text-[#322C26]" value="admin">Admin (suporte técnico)</option>
                              <option className="bg-white text-[#322C26]" value="president">Ouro (governança)</option>
                            </select>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`flex items-center gap-1 text-xs ${u.isActive ? "text-green-400" : "text-red-400"}`}>
                            {u.isActive ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                            {u.isActive ? "Ativo" : "Inativo"}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-400">
                          {new Date(u.lastSignedIn).toLocaleString("pt-BR")}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            {/* Ativar/Desativar */}
                            <button
                              onClick={() => toggleStatusMutation.mutate({ userId: u.id, isActive: !u.isActive })}
                              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                                u.isActive
                                  ? "border-red-700/50 text-red-400 hover:bg-red-900/30"
                                  : "border-green-700/50 text-green-400 hover:bg-green-900/30"
                              }`}
                            >
                              {u.isActive ? "Desativar" : "Ativar"}
                            </button>

                            {/* Revogar Sessões */}
                            <button
                              onClick={() => {
                                if (confirm(`Revogar todas as sessões de ${u.name || "este usuário"}? Ele será desconectado imediatamente.`)) {
                                  revokeSessionsMutation.mutate({ userId: u.id });
                                }
                              }}
                              title="Revogar todas as sessões"
                              className="text-xs px-2 py-1.5 rounded-lg border border-orange-700/50 text-orange-400 hover:bg-orange-900/30 transition-colors"
                            >
                              <Wifi className="w-3 h-3" />
                            </button>

                            {/* Bloquear Conta */}
                            {u.isActive && (
                              <div className="flex items-center gap-1">
                                <input
                                  type="text"
                                  placeholder="Motivo..."
                                  value={lockReason[u.id] || ""}
                                  onChange={(e) => setLockReason(prev => ({ ...prev, [u.id]: e.target.value }))}
                                  className="text-xs px-2 py-1.5 bg-[#151312] border border-gray-700 text-gray-300 rounded-lg w-28 focus:border-red-700 focus:outline-none"
                                />
                                <button
                                  onClick={() => {
                                    const reason = lockReason[u.id] || "";
                                    if (reason.length < 10) {
                                      toast.error("Informe um motivo com pelo menos 10 caracteres");
                                      return;
                                    }
                                    if (confirm(`BLOQUEAR conta de ${u.name}? Esta ação revogará todas as sessões e desativará a conta.`)) {
                                      lockAccountMutation.mutate({ userId: u.id, reason });
                                    }
                                  }}
                                  title="Bloquear conta"
                                  className="text-xs px-2 py-1.5 rounded-lg border border-red-700/50 text-red-400 hover:bg-red-900/30 transition-colors"
                                >
                                  <Ban className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(!usersQuery.data || usersQuery.data.length === 0) && (
                  <div className="text-center py-12 text-gray-400">Nenhum usuário encontrado</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ====================================================
            AUDITORIA
        ==================================================== */}
        {activeTab === "audit" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 style={playfairStyle} className="text-3xl font-bold text-white">Logs de Auditoria</h2>
                <p className="text-sm text-gray-400 mt-1">Registro imutável de todas as ações no sistema</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                <span className="text-xs text-gray-400">Atualiza a cada 15s</span>
                <button
                  onClick={() => auditQuery.refetch()}
                  className="p-1.5 text-[#C98F70] hover:bg-[#C98F70]/10 rounded transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            {auditQuery.isLoading ? (
              <div className="text-center py-12 text-gray-400">Carregando logs...</div>
            ) : (
              <div className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl overflow-x-auto">
                {/* Em 375 px estas tabelas (7, 5 e 6 colunas) não cabem. O
                    container era `overflow-hidden`: a tabela ficava cortada e as
                    últimas colunas, inclusive "Ações", eram inalcançáveis.
                    `overflow-x-auto` deixa a tabela rolar DENTRO do cartão, sem
                    arrastar a página para o lado. */}
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="border-b border-[#C98F70]/20">
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Ação</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Usuário</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Recurso</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Risco</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">IP</th>
                      <th className="text-left px-6 py-4 text-xs font-semibold text-[#C98F70] uppercase tracking-wider">Data</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditQuery.data?.map((log) => (
                      <tr key={log.id} className="border-b border-[#C98F70]/10 hover:bg-[#C98F70]/5 transition-colors">
                        <td className="px-6 py-3">
                          <span className="font-mono text-xs text-green-400">{log.action}</span>
                        </td>
                        <td className="px-6 py-3 text-sm text-gray-300">{log.userName || `ID:${log.userId}` || "Sistema"}</td>
                        <td className="px-6 py-3 text-xs text-gray-400">{log.resource || "-"}</td>
                        <td className="px-6 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded ${getRiskColor(log.riskLevel)}`}>
                            {log.riskLevel}
                          </span>
                        </td>
                        <td className="px-6 py-3 text-xs font-mono text-gray-400">{log.ipAddress || "-"}</td>
                        <td className="px-6 py-3 text-xs text-gray-400">
                          {new Date(log.createdAt).toLocaleString("pt-BR")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(!auditQuery.data || auditQuery.data.length === 0) && (
                  <div className="text-center py-12 text-gray-400">Nenhum log encontrado</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ====================================================
            ALERTAS DE SEGURANÇA
        ==================================================== */}
        {activeTab === "security" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 style={playfairStyle} className="text-3xl font-bold text-white">Alertas de Segurança</h2>
                <p className="text-sm text-gray-400 mt-1">Eventos suspeitos detectados automaticamente pelo sistema</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-red-400 rounded-full animate-pulse"></div>
                <span className="text-xs text-gray-400">Atualiza a cada 10s</span>
                <button
                  onClick={() => securityQuery.refetch()}
                  className="p-1.5 text-[#C98F70] hover:bg-[#C98F70]/10 rounded transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>

            {securityQuery.isLoading ? (
              <div className="text-center py-12 text-gray-400">Carregando eventos...</div>
            ) : (
              <div className="space-y-3">
                {securityQuery.data?.map((event) => (
                  <div
                    key={event.id}
                    className={`bg-[#1B1714] border rounded-xl p-5 flex items-center justify-between ${
                      event.severity === "critical"
                        ? "border-red-700/50 bg-red-900/10"
                        : event.severity === "warning"
                        ? "border-yellow-700/50"
                        : "border-[#C98F70]/20"
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <AlertTriangle className={`w-6 h-6 flex-shrink-0 ${getSeverityColor(event.severity)}`} />
                      <div>
                        <div className="font-medium text-white">
                          {event.eventType.replace(/_/g, " ").toUpperCase()}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {event.userName || `Usuário ID: ${event.userId}` || "Desconhecido"} •
                          IP: {event.ipAddress || "-"} •
                          {new Date(event.createdAt).toLocaleString("pt-BR")}
                        </div>
                        {(event as any).details && (
                          <div className="text-xs text-gray-500 mt-1 font-mono">
                            {JSON.stringify((event as any).details).substring(0, 120)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className={`text-xs px-2 py-1 rounded border ${
                        event.severity === "critical"
                          ? "bg-red-900/30 text-red-400 border-red-700/50"
                          : event.severity === "warning"
                          ? "bg-yellow-900/30 text-yellow-400 border-yellow-700/50"
                          : "bg-blue-900/30 text-blue-400 border-blue-700/50"
                      }`}>
                        {event.severity}
                      </span>
                      {!event.resolved && (
                        <button
                          onClick={() => resolveEventMutation.mutate({ eventId: event.id })}
                          disabled={resolveEventMutation.isPending}
                          className="flex items-center gap-1 text-xs px-3 py-1.5 bg-green-900/30 text-green-400 border border-green-700/50 rounded-lg hover:bg-green-900/50 transition-colors disabled:opacity-50"
                        >
                          <CheckCircle className="w-3 h-3" />
                          Resolver
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {(!securityQuery.data || securityQuery.data.length === 0) && (
                  <div className="text-center py-12">
                    <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
                    <p className="text-gray-400">Nenhum alerta de segurança pendente</p>
                    <p className="text-xs text-gray-600 mt-1">O sistema está monitorando continuamente</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* ====================================================
            OPORTUNIDADES · MODERAÇÃO
        ==================================================== */}
        {activeTab === "opportunities" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <h2 style={playfairStyle} className="text-3xl font-bold text-white">
                📋 Moderação de Oportunidades
              </h2>
              <button
                onClick={() => pendingOppsQuery.refetch()}
                className="p-1.5 text-[#C98F70] hover:bg-[#C98F70]/10 rounded transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {pendingOppsQuery.isLoading ? (
              <div className="text-center py-12">
                <div className="w-8 h-8 border-2 border-[#C98F70] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
                <p className="text-gray-400 text-sm">Carregando oportunidades...</p>
              </div>
            ) : !pendingOppsQuery.data?.length ? (
              <div className="text-center py-16">
                <CheckCircle className="w-12 h-12 text-green-400 mx-auto mb-3" />
                <p className="text-gray-400">Nenhuma oportunidade pendente de moderação</p>
                <p className="text-xs text-gray-600 mt-1">Todas as oportunidades foram revisadas</p>
              </div>
            ) : (
              <div className="space-y-4">
                {(pendingOppsQuery.data as any[]).map((opp: any) => {
                  const complianceColors: Record<string, { bg: string; text: string; label: string }> = {
                    green: { bg: "bg-green-900/30", text: "text-green-400", label: "Confiável" },
                    yellow: { bg: "bg-yellow-900/30", text: "text-yellow-400", label: "Atenção" },
                    orange: { bg: "bg-orange-900/30", text: "text-orange-400", label: "Suspeita" },
                    red: { bg: "bg-red-900/30", text: "text-red-400", label: "Bloqueada" },
                    pending: { bg: "bg-gray-900/30", text: "text-gray-400", label: "Pendente" },
                  };
                  const cc = complianceColors[opp.complianceLevel ?? "pending"];
                  return (
                    <div key={opp.id} className="bg-[#1B1714] border border-[#C98F70]/20 rounded-xl p-6">
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-xs px-2 py-0.5 rounded bg-[#C98F70]/20 text-[#C98F70] font-medium">
                              {opp.type}
                            </span>
                            <span className={`text-xs px-2 py-0.5 rounded ${cc.bg} ${cc.text} font-medium`}>
                              Nota {Math.round(opp.frauenTrustScore ?? 0)} · {cc.label}
                            </span>
                            {opp.isConfidential && (
                              <span className="text-xs px-2 py-0.5 rounded bg-amber-900/30 text-amber-400">★ Confidencial</span>
                            )}
                          </div>
                          <h3 className="text-white font-semibold text-lg leading-tight mb-1">{opp.title}</h3>
                          <p className="text-gray-400 text-sm leading-relaxed line-clamp-3">{opp.description}</p>
                          {opp.complianceExplanation && (
                            <p className="text-gray-500 text-xs mt-2 italic">IA: "{opp.complianceExplanation}"</p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0 text-xs text-gray-500">
                          <span>#{opp.id}</span>
                          {opp.sector && <span>{opp.sector}</span>}
                          {opp.country && <span>🌍 {opp.country}</span>}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mt-4">
                        <input
                          type="text"
                          placeholder="Nota de moderação (opcional)..."
                          value={moderationNotes[opp.id] ?? ""}
                          onChange={(e) => setModerationNotes({ ...moderationNotes, [opp.id]: e.target.value })}
                          className="flex-1 bg-[#151312] border border-[#C98F70]/20 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-[#C98F70]/50"
                        />
                        <button
                          onClick={() => moderateOppMutation.mutate({ opportunityId: opp.id, action: "approve", note: moderationNotes[opp.id] })}
                          disabled={moderateOppMutation.isPending}
                          className="flex items-center gap-1.5 px-4 py-2 bg-green-900/40 text-green-400 border border-green-700/50 rounded-lg text-sm font-medium hover:bg-green-900/60 transition-colors"
                        >
                          <CheckCircle className="w-4 h-4" />
                          Aprovar
                        </button>
                        <button
                          onClick={() => moderateOppMutation.mutate({ opportunityId: opp.id, action: "reject", note: moderationNotes[opp.id] })}
                          disabled={moderateOppMutation.isPending}
                          className="flex items-center gap-1.5 px-4 py-2 bg-red-900/40 text-red-400 border border-red-700/50 rounded-lg text-sm font-medium hover:bg-red-900/60 transition-colors"
                        >
                          <XCircle className="w-4 h-4" />
                          Rejeitar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
