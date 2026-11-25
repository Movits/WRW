import { useEffect, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { opcaoDaBusca } from "@shared/o-que-busca";
import { rotuloDoQuePreciso } from "@shared/o-que-preciso";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Shield, Users, Star, CheckCircle, XCircle, Clock,
  AlertTriangle, BarChart3, Crown, UserCheck, Globe,
  FileText, ChevronRight, Search, Award, Lock, Share2, Link2, Mic
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { ConexoesRegistradasDaPlataforma } from "@/components/ConexoesRegistradasDaPlataforma";
import { ConsultaDeReunioesDaPlataforma } from "@/components/ConsultaDeReunioesDaPlataforma";

type Tab = "overview" | "gold" | "leaders" | "opportunities" | "compliance" | "conexoes" | "reunioes" | "distribuicao";

// ─── Helpers ─────────────────────────────────────────────────────────────────
// A busca vai ao SERVIDOR (LIKE em nome e e-mail), com 300 ms de espera para
// não disparar uma consulta por tecla. Antes as duas abas filtravam em memória
// as 100 usuárias mais recentes: a membra mais antiga que a 100ª "não existia"
// para a presidente — nem para conceder Ouro, nem para nomear líder.
function useBuscaComAtraso(valor: string, atrasoMs = 300) {
  const [comAtraso, setComAtraso] = useState(valor);
  useEffect(() => {
    const timer = setTimeout(() => setComAtraso(valor.trim()), atrasoMs);
    return () => clearTimeout(timer);
  }, [valor, atrasoMs]);
  return comAtraso;
}

// O servidor devolve no máximo `limit` linhas e o total real; quando o total
// passa da página, a tela diz isso em vez de fingir que a lista está completa.
function AvisoListaCortada({ mostrando, total }: { mostrando: number; total: number }) {
  if (total <= mostrando) return null;
  return (
    <p className="text-xs text-amber-300/80 mb-2">
      Mostrando {mostrando} de {total} — refine a busca para encontrar quem não aparece.
    </p>
  );
}

function StatCard({ icon: Icon, label, value, color = "amber" }: {
  icon: React.ElementType; label: string; value: number | string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    amber: "text-amber-400 bg-amber-400/10 border-amber-400/20",
    blue: "text-blue-400 bg-blue-400/10 border-blue-400/20",
    green: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
    red: "text-red-400 bg-red-400/10 border-red-400/20",
    purple: "text-purple-400 bg-purple-400/10 border-purple-400/20",
    orange: "text-orange-400 bg-orange-400/10 border-orange-400/20",
  };
  return (
    <div className={`rounded-2xl border p-5 ${colorMap[color] || colorMap.amber}`}>
      <div className="flex items-center gap-3 mb-3">
        <Icon size={18} />
        <span className="text-xs font-medium opacity-70">{label}</span>
      </div>
      <div className="text-3xl font-black">{value}</div>
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }: {
  icon: React.ElementType; title: string; subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className="w-10 h-10 rounded-xl bg-amber-400/15 border border-amber-400/30 flex items-center justify-center flex-shrink-0">
        <Icon size={18} className="text-amber-400" />
      </div>
      <div>
        <h2 className="text-lg font-bold text-white">{title}</h2>
        {subtitle && <p className="text-sm text-white/40 mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

// ─── Módulo: Visão Geral ──────────────────────────────────────────────────────
function OverviewTab() {
  const { data: stats, isLoading } = trpc.president.getGovernanceStats.useQuery();

  if (isLoading) return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {[...Array(7)].map((_, i) => (
        <div key={i} className="h-28 rounded-2xl bg-white/5 animate-pulse" />
      ))}
    </div>
  );

  if (!stats) return <p className="text-white/40 text-sm">Sem dados disponíveis.</p>;

  return (
    <div className="space-y-6">
      <SectionHeader icon={BarChart3} title="Visão Geral da Plataforma" subtitle="Indicadores de governança em tempo real" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Users} label="Total de Membros" value={stats.totalUsers} color="blue" />
        <StatCard icon={Shield} label="Membros Bronze" value={stats.bronzeUsers ?? 0} color="orange" />
        <StatCard icon={Shield} label="Membros Prata" value={stats.silverUsers} color="blue" />
        <StatCard icon={Star} label="Membros Ouro" value={stats.goldUsers} color="amber" />
        <StatCard icon={Clock} label="Oportunidades Pendentes" value={stats.pendingOpportunities} color="amber" />
        <StatCard icon={CheckCircle} label="Oportunidades Ativas" value={stats.activeOpportunities} color="green" />
        <StatCard icon={AlertTriangle} label="Alertas Vermelhos" value={stats.redFlagOpportunities} color="red" />
      </div>

      <div className="mt-8 p-5 rounded-2xl bg-amber-400/8 border border-amber-400/20">
        <div className="flex items-center gap-3 mb-3">
          <Crown size={16} className="text-amber-400" />
          <span className="text-sm font-bold text-amber-400">Responsabilidades do Painel Ouro</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm text-white/60">
          {[
            "Conceder e revogar o Status Ouro",
            "Nomear e gerenciar Líderes Nacionais",
            "Validar oportunidades estratégicas de alto valor",
            "Supervisionar o compliance geral da plataforma",
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <CheckCircle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Módulo: Gestão de Ouro ───────────────────────────────────────────────────
function GoldTab() {
  const [search, setSearch] = useState("");
  const [grantDialog, setGrantDialog] = useState<{ userId: number; name: string } | null>(null);
  const [revokeDialog, setRevokeDialog] = useState<{ userId: number; name: string } | null>(null);
  const [reason, setReason] = useState("");
  const buscaSilver = useBuscaComAtraso(search);

  // keepPreviousData: enquanto a consulta do termo novo viaja, a lista do
  // termo anterior fica na tela — sem isso ela piscava "Nenhuma membra
  // encontrada." a cada busca.
  // Bronze E Prata: o Ouro é adesão à categoria premium, não degrau depois da
  // Prata (Governança, 14/09/2026). Antes a lista era só Prata, e um cadastro
  // novo, que nasce Bronze, não podia receber Ouro por aqui.
  const { data: silverUsers, refetch: refetchSilver } = trpc.president.listAllUsers.useQuery(
    { roles: ["bronze", "silver"], search: buscaSilver || undefined },
    { placeholderData: keepPreviousData },
  );
  const { data: goldGrants, refetch: refetchGrants } = trpc.president.getGoldGrants.useQuery();

  const grantMutation = trpc.president.grantGold.useMutation({
    onSuccess: () => {
      toast.success("Selo Ouro concedido com sucesso!");
      setGrantDialog(null);
      setReason("");
      refetchSilver();
      refetchGrants();
    },
    onError: (e) => toast.error(e.message),
  });

  const revokeMutation = trpc.president.revokeGold.useMutation({
    onSuccess: (r) => {
      // O nível de volta vem do perfil: Prata se ele atende à régua, Bronze se não.
      toast.success(`✅ Selo Ouro revogado. A conta do membro continua ativa como ${r?.novoNivel === "bronze" ? "Bronze" : "Prata"}.`);
      setRevokeDialog(null);
      setReason("");
      refetchGrants();
      refetchSilver(); // Atualizar lista Prata para mostrar a membra rebaixada imediatamente
    },
    onError: (e) => toast.error(e.message),
  });

  // Sem filtro em memória: a lista é exatamente o que o servidor encontrou.
  const filteredSilver = silverUsers?.users ?? [];

  return (
    <div className="space-y-8">
      <SectionHeader
        icon={Star}
        title="Gestão do Selo Ouro"
        subtitle="Ouro é a categoria premium da rede, mediante mensalidade. Não há preço nem cobrança integrados à plataforma: por enquanto, o Status Ouro é concedido e revogado manualmente aqui."
      />

      {/* Membras Ouro Ativas */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Membros com Selo Ouro Ativo</h3>
        {!goldGrants || goldGrants.length === 0 ? (
          <div className="p-6 rounded-xl bg-white/3 border border-white/8 text-center text-white/30 text-sm">
            Nenhum membro com Selo Ouro ativo no momento.
          </div>
        ) : (
          <div className="space-y-2">
            {goldGrants.filter(g => !g.grant.revokedAt).map((g) => (
              <div key={g.grant.id} className="flex items-center justify-between p-4 rounded-xl bg-amber-400/8 border border-amber-400/20">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-amber-400/20 flex items-center justify-center">
                    <Star size={14} className="text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{g.userName || "-"}</p>
                    <p className="text-xs text-white/40">{g.userEmail}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-400 border-red-400/30 hover:bg-red-400/10 bg-transparent text-xs"
                  onClick={() => { setRevokeDialog({ userId: g.grant.grantedTo, name: g.userName || "Membro" }); setReason(""); }}
                >
                  Revogar
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Conceder Ouro */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Conceder Status Ouro a Membros Bronze e Prata</h3>
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nome ou e-mail..."
            className="pl-9 bg-white/5 border-white/15 text-white placeholder-white/25 text-sm"
          />
        </div>
        <AvisoListaCortada mostrando={filteredSilver.length} total={silverUsers?.total ?? 0} />
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {filteredSilver.length === 0 ? (
            <p className="text-center text-white/30 text-sm py-6">Nenhum membro encontrado.</p>
          ) : filteredSilver.map(u => (
            <div key={u.id} className="flex items-center justify-between p-3.5 rounded-xl bg-white/3 border border-white/8 hover:border-white/15 transition-colors">
              <div>
                <p className="text-sm font-medium text-white">{u.name || "Sem nome"}</p>
                <p className="text-xs text-white/40">{u.email} {u.country ? `· ${u.country}` : ""}</p>
              </div>
              <Button
                size="sm"
                className="bg-amber-400 hover:bg-amber-500 text-[#151312] text-xs font-bold"
                onClick={() => { setGrantDialog({ userId: u.id, name: u.name || "Membro" }); setReason(""); }}
              >
                <Star size={12} className="mr-1" /> Conceder Ouro
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Dialog: Conceder — ação direta, sem campo de justificativa */}
      <Dialog open={!!grantDialog} onOpenChange={() => setGrantDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-amber-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-amber-400 flex items-center gap-2">
              <Star size={16} /> Conceder Selo Ouro
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-white/70">
              Você está concedendo o <strong className="text-amber-400">Status Ouro</strong>, a categoria premium da rede, para <strong className="text-white">{grantDialog?.name}</strong>.
            </p>
            {/* Mensagem automática que será enviada */}
            <div className="bg-amber-400/8 border border-amber-400/25 rounded-xl p-4">
              <p className="text-[11px] text-amber-400/70 uppercase tracking-wider font-semibold mb-2">Mensagem automática que será enviada:</p>
              <p className="text-sm text-white/80 leading-relaxed italic">
                "Seu Status Ouro está ativo. Você passa a ter acesso em primeira mão a oportunidades selecionadas de negócios nacionais e internacionais e a encontros estratégicos da rede, conforme disponibilidade e regras da plataforma."
              </p>
            </div>
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setGrantDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-amber-400 hover:bg-amber-500 text-[#151312] font-bold"
              disabled={grantMutation.isPending}
              onClick={() => grantDialog && grantMutation.mutate({ userId: grantDialog.userId })}
            >
              {grantMutation.isPending ? "Concedendo..." : "⭐ Confirmar e Enviar Mensagem"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Revogar */}
      <Dialog open={!!revokeDialog} onOpenChange={() => setRevokeDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-red-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-red-400 flex items-center gap-2">
              <XCircle size={16} /> Revogar Selo Ouro
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-white/60">
              Você está revogando o Selo Ouro de <strong className="text-white">{revokeDialog?.name}</strong>.
            </p>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-400/8 border border-blue-400/20">
              <CheckCircle size={14} className="text-blue-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-blue-300">
                <strong>A conta não será excluída.</strong> O membro continuará ativo na plataforma, com nível Prata se o perfil atender aos critérios de qualificação ou Bronze se não atender, e poderá receber o Selo Ouro novamente no futuro.
              </p>
            </div>
          </div>
          <Textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Motivo da revogação (mínimo 10 caracteres)..."
            className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm resize-none"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white font-bold"
              disabled={reason.length < 10 || revokeMutation.isPending}
              onClick={() => revokeDialog && revokeMutation.mutate({ userId: revokeDialog.userId, reason })}
            >
              {revokeMutation.isPending ? "Revogando..." : "Confirmar Revogação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Módulo: Líderes Nacionais ────────────────────────────────────────────────
function LeadersTab() {
  const [nominateDialog, setNominateDialog] = useState<{ userId: number; name: string } | null>(null);
  const [revokeDialog, setRevokeDialog] = useState<{ leaderId: number; name: string } | null>(null);
  const [oppDialog, setOppDialog] = useState<{ userId: number; name: string } | null>(null);
  const [region, setRegion] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [search, setSearch] = useState("");
  const buscaMembras = useBuscaComAtraso(search);

  // keepPreviousData pelo mesmo motivo da aba Ouro: a lista não pisca vazia
  // enquanto a busca nova viaja.
  const { data: allUsers } = trpc.president.listAllUsers.useQuery(
    { search: buscaMembras || undefined },
    { placeholderData: keepPreviousData },
  );
  const { data: leaders, refetch } = trpc.president.listLeaders.useQuery();
  const { data: leaderOpps } = trpc.president.getLeaderOpportunities.useQuery(
    { userId: oppDialog?.userId ?? 0 },
    { enabled: !!oppDialog }
  );

  const nominateMutation = trpc.president.nominateLeader.useMutation({
    onSuccess: () => {
      toast.success("Líder nacional nomeado com sucesso!");
      setNominateDialog(null);
      setRegion("");
      setSpecialty("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const revokeMutation = trpc.president.revokeLeader.useMutation({
    onSuccess: () => {
      toast.success("Líder revogado com sucesso.");
      setRevokeDialog(null);
      setRevokeReason("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // Sem filtro em memória: a lista é exatamente o que o servidor encontrou.
  const filteredUsers = allUsers?.users ?? [];

  const leaderList = (leaders as Array<{ id: number; userId: number; name: string; email: string; region: string; specialty: string; country: string }> | undefined) ?? [];

  return (
    <div className="space-y-8">
      <SectionHeader
        icon={Globe}
        title="Líderes Nacionais"
        subtitle="Gerencie especialistas setoriais e líderes regionais. Múltiplas nomeações são permitidas."
      />

      {/* Líderes ativas com botão Revogar e Ver Oportunidades */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">
          Líderes Ativos ({leaderList.length})
        </h3>
        {leaderList.length === 0 ? (
          <div className="p-6 rounded-xl bg-white/3 border border-white/8 text-center text-white/30 text-sm">
            Nenhum líder nacional nomeado ainda.
          </div>
        ) : (
          <div className="space-y-2">
            {leaderList.map((l) => (
              <div key={l.id} className="flex items-center gap-4 p-4 rounded-xl bg-purple-400/8 border border-purple-400/20">
                <div className="w-9 h-9 rounded-full bg-purple-400/20 flex items-center justify-center flex-shrink-0">
                  <UserCheck size={14} className="text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{l.name}</p>
                  <p className="text-xs text-white/40">{l.email}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  <Badge className="bg-purple-400/15 text-purple-300 border-purple-400/30 text-xs">{l.region}</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className="bg-transparent border-blue-400/30 text-blue-300 hover:bg-blue-400/10 text-xs h-7 px-2"
                    onClick={() => setOppDialog({ userId: l.userId, name: l.name })}
                  >
                    <Search size={10} className="mr-1" /> Oportunidades
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="bg-transparent border-red-400/30 text-red-300 hover:bg-red-400/10 text-xs h-7 px-2"
                    onClick={() => { setRevokeDialog({ leaderId: l.id, name: l.name }); setRevokeReason(""); }}
                  >
                    <XCircle size={10} className="mr-1" /> Revogar
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Nomear nova líder */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Nomear Novo Líder</h3>
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar membro por nome ou e-mail..."
            className="pl-9 bg-white/5 border-white/15 text-white placeholder-white/25 text-sm"
          />
        </div>
        <AvisoListaCortada mostrando={filteredUsers.length} total={allUsers?.total ?? 0} />
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {filteredUsers.map(u => (
            <div key={u.id} className="flex items-center justify-between p-3.5 rounded-xl bg-white/3 border border-white/8 hover:border-white/15 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{u.name || "Sem nome"}</p>
                <p className="text-xs text-white/40 truncate">{u.email}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  className="bg-transparent border-blue-400/30 text-blue-300 hover:bg-blue-400/10 text-xs h-7 px-2"
                  onClick={() => setOppDialog({ userId: u.id, name: u.name || "Membro" })}
                  title="Ver oportunidades deste membro"
                >
                  <Search size={10} className="mr-1" /> Oportunidades
                </Button>
                <Button
                  size="sm"
                  className="bg-purple-500 hover:bg-purple-600 text-white text-xs font-bold"
                  onClick={() => { setNominateDialog({ userId: u.id, name: u.name || "Membro" }); setRegion(""); setSpecialty(""); }}
                >
                  <Award size={12} className="mr-1" /> Nomear
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Dialog: Nomear Líder */}
      <Dialog open={!!nominateDialog} onOpenChange={() => setNominateDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-purple-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-purple-400 flex items-center gap-2">
              <Award size={16} /> Nomear Líder Nacional
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-white/60">
            Nomeando <strong className="text-white">{nominateDialog?.name}</strong> como líder nacional.
          </p>
          <Input
            value={region}
            onChange={e => setRegion(e.target.value)}
            placeholder="Região / País (ex: Brasil, América Latina)"
            className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm"
          />
          <Input
            value={specialty}
            onChange={e => setSpecialty(e.target.value)}
            placeholder="Especialidade setorial (opcional)"
            className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNominateDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-purple-500 hover:bg-purple-600 text-white font-bold"
              disabled={region.length < 2 || nominateMutation.isPending}
              onClick={() => nominateDialog && nominateMutation.mutate({ userId: nominateDialog.userId, region, specialty: specialty || undefined })}
            >
              {nominateMutation.isPending ? "Nomeando..." : "Confirmar Nomeação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Revogar Líder */}
      <Dialog open={!!revokeDialog} onOpenChange={() => setRevokeDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-red-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-red-400 flex items-center gap-2">
              <XCircle size={16} /> Revogar Líder
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-white/60">
            Você está revogando a nomeação de <strong className="text-white">{revokeDialog?.name}</strong>. Esta ação é imediata.
          </p>
          <Input
            value={revokeReason}
            onChange={e => setRevokeReason(e.target.value)}
            placeholder="Motivo da revogação (opcional)"
            className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white font-bold"
              disabled={revokeMutation.isPending}
              onClick={() => revokeDialog && revokeMutation.mutate({ leaderId: revokeDialog.leaderId, reason: revokeReason || undefined })}
            >
              {revokeMutation.isPending ? "Revogando..." : "Confirmar Revogação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Oportunidades do Líder */}
      <Dialog open={!!oppDialog} onOpenChange={() => setOppDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-blue-400/30 text-white max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-blue-400 flex items-center gap-2">
              <Search size={16} /> Oportunidades de {oppDialog?.name}
            </DialogTitle>
          </DialogHeader>
          {!leaderOpps || (leaderOpps as unknown[]).length === 0 ? (
            <p className="text-white/40 text-sm text-center py-6">Nenhuma oportunidade cadastrada por este líder.</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {(leaderOpps as Array<{ id: number; title: string; type: string; status: string; complianceLevel: string; country: string; createdAt: string }>).map(o => (
                <div key={o.id} className="p-3.5 rounded-xl bg-white/3 border border-white/8">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-white truncate">{o.title}</p>
                      <p className="text-xs text-white/40 mt-0.5">{o.type} · {o.country}</p>
                    </div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      <Badge className={`text-xs ${
                        o.status === "active" ? "bg-emerald-400/15 text-emerald-300 border-emerald-400/30" :
                        o.status === "pending" ? "bg-amber-400/15 text-amber-300 border-amber-400/30" :
                        "bg-red-400/15 text-red-300 border-red-400/30"
                      }`}>{o.status}</Badge>
                      <Badge className={`text-xs ${
                        o.complianceLevel === "green" ? "bg-emerald-400/15 text-emerald-300 border-emerald-400/30" :
                        o.complianceLevel === "yellow" ? "bg-yellow-400/15 text-yellow-300 border-yellow-400/30" :
                        "bg-red-400/15 text-red-300 border-red-400/30"
                      }`}>{o.complianceLevel}</Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOppDialog(null)} className="bg-transparent border-white/20 text-white/60">Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Módulo: Validação de Oportunidades ──────────────────────────────────────
function OpportunitiesTab() {
  // Modal apenas para Solicitar Info (precisa de input do que precisa)
  const [requestInfoDialog, setRequestInfoDialog] = useState<{
    id: number; title: string; publisherName: string;
  } | null>(null);
  const [infoNeeded, setInfoNeeded] = useState("");

  const { data: pending, refetch } = trpc.president.listPendingOpportunities.useQuery();

  const validateMutation = trpc.president.validateOpportunity.useMutation({
    onSuccess: (_, vars) => {
      const action = vars.status === "approved" ? "aprovada" : "rejeitada";
      toast.success(`Oportunidade ${action}! Mensagem automática enviada.`);
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const requestInfoMutation = trpc.president.requestInfo.useMutation({
    onSuccess: () => {
      toast.success("Solicitação enviada! Mensagem automática enviada para quem publicou.");
      setRequestInfoDialog(null);
      setInfoNeeded("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // Mensagens automáticas que serão enviadas (para exibir no card)
  const autoMessages = {
    approved: (name: string) => `Olá, ${name.split(" ")[0]}. Analisamos a sua proposta e ela se encaixa muito bem no que buscamos.`,
    rejected: (name: string) => `Olá, ${name.split(" ")[0]}. Agradecemos o envio da proposta e o seu tempo. No momento, essa oportunidade não está alinhada com as nossas prioridades e foco estratégico atual.`,
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={FileText}
        title="Validação de Oportunidades"
        subtitle="Homologue oportunidades estratégicas. Mensagens automáticas são enviadas ao clicar em Aprovar, Rejeitar ou Solicitar Info."
      />

      {!pending || pending.length === 0 ? (
        <div className="p-10 rounded-2xl bg-white/3 border border-white/8 text-center">
          <CheckCircle size={32} className="text-emerald-400 mx-auto mb-3" />
          <p className="text-white font-semibold">Nenhuma oportunidade pendente</p>
          <p className="text-white/40 text-sm mt-1">Todas as oportunidades foram validadas.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map((item) => (
            <div key={item.opp.id} className="p-5 rounded-2xl bg-white/3 border border-white/8 hover:border-white/15 transition-colors">
              {/* Info da oportunidade */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <Badge className="bg-amber-400/15 text-amber-300 border-amber-400/30 text-xs">{item.opp.type}</Badge>
                  {item.opp.sector && <Badge className="bg-white/10 text-white/50 border-white/10 text-xs">{item.opp.sector}</Badge>}
                </div>
                <h4 className="text-sm font-semibold text-white">{item.opp.title}</h4>
                <p className="text-xs text-white/40 mt-0.5">Publicada por <strong className="text-white/60">{item.publisherName || item.publisherEmail}</strong></p>
                <p className="text-xs text-white/30 mt-2 line-clamp-2">{item.opp.description}</p>
              </div>

              {/* Botões de ação direta */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  disabled={validateMutation.isPending}
                  onClick={() => validateMutation.mutate({ opportunityId: item.opp.id, status: "approved" })}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-bold hover:bg-emerald-500/25 transition-all active:scale-95 disabled:opacity-50"
                >
                  <CheckCircle size={13} /> Aprovar
                </button>
                <button
                  disabled={validateMutation.isPending}
                  onClick={() => validateMutation.mutate({ opportunityId: item.opp.id, status: "rejected" })}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 text-xs font-bold hover:bg-red-500/25 transition-all active:scale-95 disabled:opacity-50"
                >
                  <XCircle size={13} /> Rejeitar
                </button>
                <button
                  onClick={() => { setRequestInfoDialog({ id: item.opp.id, title: item.opp.title, publisherName: item.publisherName || "" }); setInfoNeeded(""); }}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold hover:bg-amber-500/25 transition-all active:scale-95"
                >
                  <Clock size={13} /> Solicitar Info
                </button>
              </div>

              {/* Preview das mensagens automáticas */}
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-emerald-400/60 font-semibold uppercase tracking-wider mb-1">Msg ao Aprovar:</p>
                  <p className="text-[11px] text-white/45 italic leading-relaxed line-clamp-2">{autoMessages.approved(item.publisherName || "Membro")}</p>
                </div>
                <div className="bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
                  <p className="text-[10px] text-red-400/60 font-semibold uppercase tracking-wider mb-1">Msg ao Rejeitar:</p>
                  <p className="text-[11px] text-white/45 italic leading-relaxed line-clamp-2">{autoMessages.rejected(item.publisherName || "Membro")}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal: Solicitar Informações */}
      <Dialog open={!!requestInfoDialog} onOpenChange={() => setRequestInfoDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-amber-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-amber-400 flex items-center gap-2">
              <Clock size={16} /> Solicitar Informações Adicionais
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-white/60">
              Enviando solicitação para <strong className="text-white">{requestInfoDialog?.publisherName || "quem publicou"}</strong>.
            </p>
            <div>
              <label className="text-xs text-white/50 mb-1.5 block">O que você precisa que essa pessoa envie?</label>
              <Input
                value={infoNeeded}
                onChange={e => setInfoNeeded(e.target.value)}
                placeholder="ex: o detalhamento de custos / o cronograma / o portfólio"
                className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm"
              />
            </div>
            {infoNeeded.length >= 5 && (
              <div className="bg-amber-400/8 border border-amber-400/25 rounded-xl p-4">
                <p className="text-[11px] text-amber-400/70 uppercase tracking-wider font-semibold mb-2">Mensagem que será enviada:</p>
                <p className="text-sm text-white/80 leading-relaxed italic">
                  "Olá, {(requestInfoDialog?.publisherName || "Membro").split(" ")[0]}. Recebemos a sua proposta e temos interesse em avaliar melhor. Para seguirmos para a próxima etapa, você poderia nos enviar {infoNeeded}? Ficamos no aguardo."
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestInfoDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-amber-500 hover:bg-amber-600 text-[#151312] font-bold"
              disabled={infoNeeded.length < 5 || requestInfoMutation.isPending}
              onClick={() => requestInfoDialog && requestInfoMutation.mutate({ opportunityId: requestInfoDialog.id, infoNeeded })}
            >
              {requestInfoMutation.isPending ? "Enviando..." : "📤 Enviar Solicitação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Módulo: Compliance ───────────────────────────────────────────────────────
function ComplianceTab() {
  const { data: stats } = trpc.president.getGovernanceStats.useQuery();
  const { data: allOpps } = trpc.president.listPendingOpportunities.useQuery();
  const { data: redFlags } = trpc.opportunities.list.useQuery({ complianceLevel: 'red', limit: 20 });

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Shield}
        title="Supervisão de Compliance"
        subtitle="Visão geral da integridade e confiabilidade do ecossistema."
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-emerald-400/8 border border-emerald-400/20">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle size={16} className="text-emerald-400" />
            <span className="text-xs text-emerald-400/70 font-medium">Oportunidades Ativas</span>
          </div>
          <div className="text-3xl font-black text-emerald-400">{stats?.activeOpportunities ?? "-"}</div>
        </div>
        <div className="p-5 rounded-2xl bg-amber-400/8 border border-amber-400/20">
          <div className="flex items-center gap-2 mb-2">
            <Clock size={16} className="text-amber-400" />
            <span className="text-xs text-amber-400/70 font-medium">Pendentes de Validação</span>
          </div>
          <div className="text-3xl font-black text-amber-400">{stats?.pendingOpportunities ?? "-"}</div>
        </div>
        <div className="p-5 rounded-2xl bg-red-400/8 border border-red-400/20">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={16} className="text-red-400" />
            <span className="text-xs text-red-400/70 font-medium">Alertas Vermelhos (IA)</span>
          </div>
          <div className="text-3xl font-black text-red-400">{stats?.redFlagOpportunities ?? "-"}</div>
        </div>
      </div>

      {/* Oportunidades de Alto Risco */}
      {redFlags && Array.isArray(redFlags) && redFlags.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-red-400/70 uppercase tracking-wider mb-3 flex items-center gap-2">
            <AlertTriangle size={13} /> Oportunidades com Baixa Confiabilidade: Ação Recomendada
          </h3>
          <div className="space-y-2">
            {(redFlags as Array<{ id: number; title: string; frauenTrustScore: number | null; sector: string | null }>).map((opp) => (
              <div key={opp.id} className="flex items-center justify-between p-4 rounded-xl bg-red-400/8 border border-red-400/20">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{opp.title}</p>
                  <p className="text-xs text-white/40">{opp.sector} {opp.frauenTrustScore != null ? `· Score: ${Math.round(opp.frauenTrustScore)}%` : ""}</p>
                </div>
                <Badge className="bg-red-400/15 text-red-300 border-red-400/30 text-xs ml-3 flex-shrink-0">🔴 Alto Risco</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Oportunidades Pendentes de Validação */}
      {allOpps && allOpps.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-amber-400/70 uppercase tracking-wider mb-3 flex items-center gap-2">
            <Clock size={13} /> Aguardando Validação
          </h3>
          <div className="space-y-2">
            {allOpps.map((item: { opp: { id: number; title: string; frauenTrustScore: number | null; sector: string | null }; publisherName: string | null; publisherEmail: string | null }) => (
              <div key={item.opp.id} className="flex items-center justify-between p-4 rounded-xl bg-amber-400/8 border border-amber-400/20">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-white truncate">{item.opp.title}</p>
                  <p className="text-xs text-white/40">{item.opp.sector} · Publicada por {item.publisherName || item.publisherEmail}</p>
                </div>
                <Badge className="bg-amber-400/15 text-amber-300 border-amber-400/30 text-xs ml-3 flex-shrink-0">🟠 Pendente</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="p-5 rounded-2xl bg-white/3 border border-white/8">
        <h3 className="text-sm font-semibold text-white mb-4">Legenda do Sistema de Compliance (IA)</h3>
        <div className="space-y-3">
          {[
            { color: "bg-emerald-400", label: "Verde: altamente documentado", desc: "Oportunidade com documentação completa e verificável. Score acima de 80%." },
            { color: "bg-amber-400", label: "Amarelo: boa documentação, precisa complementar", desc: "Score entre 50-79%. Documentação parcial, mas com boa base de confiança." },
            { color: "bg-orange-400", label: "Laranja: pouco documentado, precisa de validação", desc: "Score entre 20-49%. Pede atenção e documentação adicional antes de avançar." },
            { color: "bg-red-500", label: "Vermelho: baixa confiabilidade", desc: "Score abaixo de 20%. Sinalizada pela IA como de alto risco. Revisão presidencial recomendada." },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className={`w-3 h-3 rounded-full ${item.color} mt-1 flex-shrink-0`} />
              <div>
                <p className="text-sm font-medium text-white">{item.label}</p>
                <p className="text-xs text-white/40">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Módulo: Distribuição do Smart Match ─────────────────────────────────────
// O distribuidor é a pessoa real que confere cada pedido de interesse antes de
// encaminhá-lo à outra pessoa. O poder mora em `users.isDistributor` e acumula
// com qualquer nível. Nesta etapa a aba traz só "Quem distribui" (conceder e
// revogar, para Ouro/presidente/admin); a fila de análise chega na etapa
// seguinte. Quem só distribui (sem Ouro) NÃO consulta `distribuicao.listar`:
// a procedure é da presidência e devolveria 403.
const NOME_DO_NIVEL: Record<string, string> = {
  bronze: "Bronze", silver: "Prata", gold: "Ouro", admin: "Admin", president: "Presidente",
};

function QuemDistribui() {
  const [search, setSearch] = useState("");
  const [concederDialog, setConcederDialog] = useState<{ userId: number; name: string } | null>(null);
  const [revogarDialog, setRevogarDialog] = useState<{ userId: number; name: string } | null>(null);
  const [motivo, setMotivo] = useState("");
  const busca = useBuscaComAtraso(search);

  const { data: distribuidores, refetch: refetchDistribuidores } = trpc.distribuicao.listar.useQuery();
  // Mesma busca no servidor da aba Ouro; sem filtro de nível, porque o poder
  // acumula com qualquer um. Quem já distribui sai da lista de candidatas.
  const { data: membros } = trpc.president.listAllUsers.useQuery(
    { search: busca || undefined },
    { placeholderData: keepPreviousData },
  );

  const concederMutation = trpc.distribuicao.conceder.useMutation({
    onSuccess: () => {
      toast.success("Poder de distribuição concedido. A pessoa foi avisada no sino.");
      setConcederDialog(null);
      setMotivo("");
      refetchDistribuidores();
    },
    onError: (e) => toast.error(e.message),
  });

  const revogarMutation = trpc.distribuicao.revogar.useMutation({
    onSuccess: () => {
      toast.success("Poder de distribuição revogado. O nível da conta não muda.");
      setRevogarDialog(null);
      setMotivo("");
      refetchDistribuidores();
    },
    onError: (e) => toast.error(e.message),
  });

  const idsQueDistribuem = new Set((distribuidores ?? []).map(d => d.id));
  const candidatas = (membros?.users ?? []).filter(u => !idsQueDistribuem.has(u.id));

  return (
    <>
      {/* Quem distribui hoje */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Quem distribui hoje</h3>
        {!distribuidores || distribuidores.length === 0 ? (
          <div className="p-6 rounded-xl bg-white/3 border border-white/8 text-center text-white/30 text-sm">
            Ninguém tem o poder de distribuição no momento.
          </div>
        ) : (
          <div className="space-y-2">
            {distribuidores.map(d => (
              <div key={d.id} className="flex items-center justify-between p-4 rounded-xl bg-amber-400/8 border border-amber-400/20">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-amber-400/20 flex items-center justify-center">
                    <Share2 size={14} className="text-amber-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{d.name || "Sem nome"}</p>
                    <p className="text-xs text-white/40">
                      {d.email} · {NOME_DO_NIVEL[d.role] ?? d.role}{d.isActive ? "" : " · conta inativa"}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-400 border-red-400/30 hover:bg-red-400/10 bg-transparent text-xs"
                  onClick={() => { setRevogarDialog({ userId: d.id, name: d.name || "Membro" }); setMotivo(""); }}
                >
                  Revogar
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Conceder o poder */}
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Conceder o poder de distribuição</h3>
        <div className="relative mb-3">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar quem vai distribuir (nome ou e-mail)..."
            className="pl-9 bg-white/5 border-white/15 text-white placeholder-white/25 text-sm"
          />
        </div>
        <AvisoListaCortada mostrando={membros?.users.length ?? 0} total={membros?.total ?? 0} />
        <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
          {candidatas.length === 0 ? (
            <p className="text-center text-white/30 text-sm py-6">Nenhum membro encontrado.</p>
          ) : candidatas.map(u => (
            <div key={u.id} className="flex items-center justify-between p-3.5 rounded-xl bg-white/3 border border-white/8 hover:border-white/15 transition-colors">
              <div>
                <p className="text-sm font-medium text-white">{u.name || "Sem nome"}</p>
                <p className="text-xs text-white/40">{u.email} · {NOME_DO_NIVEL[u.role] ?? u.role}</p>
              </div>
              <Button
                size="sm"
                className="bg-amber-400 hover:bg-amber-500 text-[#151312] text-xs font-bold"
                onClick={() => { setConcederDialog({ userId: u.id, name: u.name || "Membro" }); setMotivo(""); }}
              >
                <Share2 size={12} className="mr-1" /> Conceder poder
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Dialog: Conceder */}
      <Dialog open={!!concederDialog} onOpenChange={() => setConcederDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-amber-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-amber-400 flex items-center gap-2">
              <Share2 size={16} /> Conceder poder de distribuição
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-white/70">
              <strong className="text-white">{concederDialog?.name}</strong> passa a conferir cada pedido de
              interesse do Smart Match antes de ele chegar à outra pessoa. O nível da conta não muda.
            </p>
            <Textarea
              value={motivo}
              onChange={e => setMotivo(e.target.value)}
              placeholder="Motivo (opcional, fica na auditoria)..."
              className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm resize-none"
              rows={2}
            />
          </div>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setConcederDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-amber-400 hover:bg-amber-500 text-[#151312] font-bold"
              disabled={concederMutation.isPending}
              onClick={() => concederDialog && concederMutation.mutate({ userId: concederDialog.userId, reason: motivo.trim() || undefined })}
            >
              {concederMutation.isPending ? "Concedendo..." : "Confirmar concessão"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Revogar */}
      <Dialog open={!!revogarDialog} onOpenChange={() => setRevogarDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-red-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-red-400 flex items-center gap-2">
              <XCircle size={16} /> Revogar poder de distribuição
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-white/60">
            <strong className="text-white">{revogarDialog?.name}</strong> deixa de conferir os pedidos de interesse.
            A conta continua ativa, no mesmo nível.
          </p>
          <Textarea
            value={motivo}
            onChange={e => setMotivo(e.target.value)}
            placeholder="Motivo da revogação (mínimo 10 caracteres)..."
            className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm resize-none"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevogarDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white font-bold"
              disabled={motivo.trim().length < 10 || revogarMutation.isPending}
              onClick={() => revogarDialog && revogarMutation.mutate({ userId: revogarDialog.userId, reason: motivo.trim() })}
            >
              {revogarMutation.isPending ? "Revogando..." : "Confirmar revogação"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Fila de análise (só quem tem o poder) ───────────────────────────────────
// Cada pedido mostra as DUAS partes com nome, a nota do Smart Match na direção do
// pedido e as travas que o servidor reconfere ao encaminhar (termo, conta ativa,
// portão da demanda expressa). É leitura nominal: o servidor a audita.
const RESULTADO_DA_DECISAO: Record<string, string> = {
  pending: "Encaminhado · aguardando resposta",
  accepted: "Encaminhado · interesse mútuo, nomes revelados",
  declined: "Encaminhado · a outra pessoa não aceitou",
  not_forwarded: "Não encaminhado",
  blocked: "Bloqueado",
  in_review: "Em análise",
};

function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] border ${
      ok ? "bg-emerald-400/10 text-emerald-300 border-emerald-400/25" : "bg-red-400/10 text-red-300 border-red-400/25"
    }`}>
      {ok ? <CheckCircle size={10} /> : <XCircle size={10} />} {children}
    </span>
  );
}

function ListaCurta({ rotulo, itens }: { rotulo: string; itens: unknown }) {
  const lista = Array.isArray(itens) ? itens.map(String).filter(Boolean) : [];
  if (lista.length === 0) return null;
  return (
    <p className="text-xs text-white/50 mt-1">
      <span className="text-white/30">{rotulo}: </span>{lista.slice(0, 6).join(", ")}{lista.length > 6 ? "…" : ""}
    </p>
  );
}

type PerfilDaFila = {
  name: string | null; displayName: string | null; role: string;
  isActive: boolean; isVerified: boolean; onboardingCompleted: boolean;
  company: string | null; jobTitle: string | null; city: string | null; country: string | null;
  sector: string | null; primarySpecialty: string | null; bio: string | null;
  whatIHave: unknown; whatINeed: unknown; seekingTypes: unknown; profileCompleteness: number | null;
  /** O texto de "Outra necessidade", já filtrado (só com a opção marcada) e mascarado pelo servidor. */
  seekingOtherNeed?: string | null;
};

function PerfilNaFila({ titulo, perfil, termoOk }: { titulo: string; perfil: PerfilDaFila; termoOk: boolean }) {
  const nome = perfil.name || perfil.displayName || "Sem nome";
  const lugar = [perfil.city, perfil.country].filter(Boolean).join(", ");
  const atuacao = [perfil.sector, perfil.primarySpecialty].filter(Boolean).join(" · ");
  return (
    <div className="flex-1 min-w-0 rounded-xl bg-white/3 border border-white/8 p-4">
      <p className="text-[11px] uppercase tracking-wider text-white/40 mb-1">{titulo}</p>
      <p className="text-sm font-semibold text-white">{nome}</p>
      {perfil.displayName && perfil.displayName !== perfil.name && (
        <p className="text-xs text-white/40">aparece como "{perfil.displayName}"</p>
      )}
      <p className="text-xs text-white/50 mt-1">{[perfil.jobTitle, perfil.company].filter(Boolean).join(" · ") || "Cargo e empresa não informados"}</p>
      {(lugar || atuacao) && <p className="text-xs text-white/40">{[lugar, atuacao].filter(Boolean).join(" · ")}</p>}
      <div className="flex flex-wrap gap-1.5 mt-2">
        <Chip ok={termoOk}>termo do Smart Match</Chip>
        <Chip ok={perfil.isActive}>conta ativa</Chip>
        <Chip ok={perfil.isVerified}>verificada</Chip>
        <Chip ok={perfil.onboardingCompleted}>perfil concluído</Chip>
        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] border bg-white/5 text-white/50 border-white/10">
          {NOME_DO_NIVEL[perfil.role] ?? perfil.role} · perfil {perfil.profileCompleteness ?? 0}%
        </span>
      </div>
      <ListaCurta rotulo="Tem" itens={perfil.whatIHave} />
      {/* Chaves de "O que preciso" pelo título (as 17 de 14/09 e "Consultoria" dos perfis antigos). */}
      {/* "Outra necessidade" é necessidade declarada, como nos motores: entra em "Precisa", antes das chaves. */}
      <ListaCurta rotulo="Precisa" itens={[
        ...(perfil.seekingOtherNeed ? [perfil.seekingOtherNeed] : []),
        ...(Array.isArray(perfil.whatINeed) ? perfil.whatINeed.map(item => rotuloDoQuePreciso(String(item))) : []),
      ]} />
      {/* Chave nova (ou antiga com equivalente) sai com o rótulo; job e mentor, crus como antes. */}
      <ListaCurta rotulo="Busca" itens={Array.isArray(perfil.seekingTypes)
        ? perfil.seekingTypes.map(valor => opcaoDaBusca(String(valor))?.titulo ?? valor)
        : perfil.seekingTypes} />
      {perfil.bio && <p className="text-xs text-white/50 mt-2 whitespace-pre-line">{perfil.bio}</p>}
    </div>
  );
}

function FilaDeAnalise() {
  const [recusaDialog, setRecusaDialog] = useState<{ connectionId: number; quem: string } | null>(null);
  const [nota, setNota] = useState("");
  const { data: fila, refetch: refetchFila } = trpc.distribuicao.fila.useQuery();
  const { data: historico, refetch: refetchHistorico } = trpc.distribuicao.historico.useQuery({ limit: 30 });

  const decidirMutation = trpc.distribuicao.decidir.useMutation({
    onSuccess: (r) => {
      toast.success(
        r.statusFinal === "not_forwarded" ? "Pedido não encaminhado. A outra pessoa não foi avisada."
          : r.statusFinal === "accepted" ? "Encaminhado. Era recíproco: os nomes já aparecem para as duas partes."
            : "Encaminhado. A outra pessoa recebe o pedido agora.",
      );
      setRecusaDialog(null);
      setNota("");
      refetchFila();
      refetchHistorico();
    },
    onError: (e) => { toast.error(e.message); refetchFila(); },
  });

  const pedidos = fila ?? [];

  return (
    <>
      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Fila de análise</h3>
        {pedidos.length === 0 ? (
          <div className="p-6 rounded-xl bg-white/3 border border-white/8 text-center text-white/30 text-sm">
            Nenhum pedido de interesse esperando análise.
          </div>
        ) : (
          <div className="space-y-4">
            {pedidos.map(p => {
              const travasOk = p.termoOk.solicitante && p.termoOk.destinataria && p.ativas.solicitante && p.ativas.destinataria && !p.bloqueadoPeloPortao;
              const quem = `${p.solicitante.name || "Sem nome"} → ${p.destinataria.name || "Sem nome"}`;
              return (
                <div key={p.connectionId} className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-5 space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <p className="text-xs text-white/40">
                      Pedido #{p.connectionId} · {new Date(p.createdAt).toLocaleString("pt-BR")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {p.reciprocado && (
                        <Badge className="bg-emerald-400/15 text-emerald-300 border-emerald-400/30 text-[11px]">Interesse recíproco</Badge>
                      )}
                      {p.bloqueadoPeloPortao && (
                        <Badge className="bg-red-400/15 text-red-300 border-red-400/30 text-[11px]">Portão da demanda expressa</Badge>
                      )}
                      <Badge className="bg-amber-400/15 text-amber-300 border-amber-400/30 text-[11px]">
                        {p.compatibilidade ? `Compatibilidade ${p.compatibilidade.overallScore}%` : "Sem nota do Smart Match"}
                      </Badge>
                    </div>
                  </div>

                  <div className="flex flex-col md:flex-row gap-3">
                    <PerfilNaFila titulo="Quem pediu" perfil={p.solicitante} termoOk={p.termoOk.solicitante} />
                    <PerfilNaFila titulo="Quem recebe" perfil={p.destinataria} termoOk={p.termoOk.destinataria} />
                  </div>

                  {p.compatibilidade && (
                    <div className="rounded-xl bg-white/3 border border-white/8 p-3">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs text-white/50">
                        {([
                          ["Especialidade", p.compatibilidade.specialtyScore],
                          ["Objetivos", p.compatibilidade.objectivesScore],
                          ["Porte", p.compatibilidade.incomeScore],
                          ["Localização", p.compatibilidade.locationScore],
                          ["Valores", p.compatibilidade.valuesScore],
                        ] as const).map(([rotulo, valor]) => (
                          <div key={rotulo}><span className="text-white/30">{rotulo}</span> <span className="text-white/80 font-semibold">{valor ?? 0}%</span></div>
                        ))}
                      </div>
                      {p.compatibilidade.aiInsight && (
                        <p className="text-xs text-white/50 mt-2 italic">{p.compatibilidade.aiInsight}</p>
                      )}
                    </div>
                  )}

                  {!travasOk && (
                    <p className="text-xs text-red-300/80">
                      Uma trava está vermelha: o servidor recusa o encaminhamento até ela ficar verde.
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-400 border-red-400/30 hover:bg-red-400/10 bg-transparent text-xs"
                      disabled={decidirMutation.isPending}
                      onClick={() => { setRecusaDialog({ connectionId: p.connectionId, quem }); setNota(""); }}
                    >
                      Não encaminhar
                    </Button>
                    <Button
                      size="sm"
                      className="bg-amber-400 hover:bg-amber-500 text-[#151312] text-xs font-bold"
                      disabled={decidirMutation.isPending || !travasOk}
                      onClick={() => decidirMutation.mutate({ connectionId: p.connectionId, aprovar: true })}
                    >
                      <Share2 size={12} className="mr-1" /> Encaminhar
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-3">Últimas decisões</h3>
        {!historico || historico.length === 0 ? (
          <div className="p-6 rounded-xl bg-white/3 border border-white/8 text-center text-white/30 text-sm">
            Nenhuma decisão registrada ainda.
          </div>
        ) : (
          <div className="space-y-2">
            {historico.map(h => (
              <div key={h.connectionId} className="p-3.5 rounded-xl bg-white/3 border border-white/8 text-xs">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <span className="text-white/80">
                    {h.solicitanteNome || "Sem nome"} → {h.destinatariaNome || "Sem nome"}
                    {h.reciprocado ? " (recíproco)" : ""}
                  </span>
                  <span className={h.resultado === "not_forwarded" ? "text-red-300" : "text-emerald-300"}>
                    {RESULTADO_DA_DECISAO[h.resultado] ?? h.resultado}
                  </span>
                </div>
                <p className="text-white/35 mt-1">
                  {h.decididoEm ? new Date(h.decididoEm).toLocaleString("pt-BR") : ""} · por {h.decididoPor?.name || "—"}
                  {h.nota ? ` · nota: ${h.nota}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialog: Não encaminhar */}
      <Dialog open={!!recusaDialog} onOpenChange={() => setRecusaDialog(null)}>
        <DialogContent className="bg-[#211e1b] border-red-400/30 text-white">
          <DialogHeader>
            <DialogTitle className="text-red-400 flex items-center gap-2">
              <XCircle size={16} /> Não encaminhar o pedido
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-white/60">
            <strong className="text-white">{recusaDialog?.quem}</strong>. Quem pediu vê "interesse não encaminhado";
            a outra pessoa não é avisada. A nota fica só na trilha interna.
          </p>
          <Textarea
            value={nota}
            onChange={e => setNota(e.target.value)}
            placeholder="Por que não encaminhar (obrigatório, fica na trilha interna)..."
            className="bg-white/5 border-white/15 text-white placeholder-white/30 text-sm resize-none"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecusaDialog(null)} className="bg-transparent border-white/20 text-white/60">Cancelar</Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white font-bold"
              disabled={nota.trim().length === 0 || decidirMutation.isPending}
              onClick={() => recusaDialog && decidirMutation.mutate({ connectionId: recusaDialog.connectionId, aprovar: false, nota: nota.trim() })}
            >
              {decidirMutation.isPending ? "Registrando..." : "Confirmar: não encaminhar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DistribuicaoTab({ podeGerir, souDistribuidor }: { podeGerir: boolean; souDistribuidor: boolean }) {
  return (
    <div className="space-y-8">
      <SectionHeader
        icon={Share2}
        title="Distribuição do Smart Match"
        subtitle="Uma pessoa real confere cada pedido de interesse antes de encaminhá-lo. O poder é da conta e acumula com qualquer nível."
      />
      {souDistribuidor && <FilaDeAnalise />}
      {podeGerir && <QuemDistribui />}
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────
export default function PresidentPanel() {
  const { user, loading } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  if (loading) return (
    <div className="min-h-screen bg-transparent flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin" />
    </div>
  );

  // Ouro = presidente = admin abre o painel inteiro. O poder de distribuição
  // (users.isDistributor) abre SÓ a aba Distribuição, para quem não é Ouro.
  const ehOuro = !!user && (user.role === "president" || user.role === "admin" || user.role === "gold");
  const souDistribuidor = user?.isDistributor === true;

  if (!user || (!ehOuro && !souDistribuidor)) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center p-6">
        <div className="text-center max-w-sm">
          <Lock size={40} className="text-red-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Acesso Restrito</h2>
          <p className="text-white/50 text-sm mb-6">Este painel é exclusivo para membros com Status Ouro ou com o poder de distribuição.</p>
          <Button onClick={() => navigate("/dashboard")} className="bg-amber-400 hover:bg-amber-500 text-[#151312] font-bold">
            Voltar ao Dashboard
          </Button>
        </div>
      </div>
    );
  }

  const abaDistribuicao = { id: "distribuicao" as const, label: "Distribuição", icon: Share2 };
  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = ehOuro ? [
    { id: "overview", label: "Visão Geral", icon: BarChart3 },
    { id: "gold", label: "Gestão Ouro", icon: Star },
    { id: "leaders", label: "Líderes", icon: Globe },
    { id: "opportunities", label: "Validações", icon: FileText },
    { id: "compliance", label: "Compliance", icon: Shield },
    // Meu Network Inteligente, itens 17 e 18: a rastreabilidade das conexões
    // para a apuração de comissão. A lista atravessa a rede de todas as donas,
    // então as rotas são só da staff (admin e presidente; ver
    // plataformaProcedure em routers/networkInteligente.ts): Ouro sem cargo e
    // quem só distribui não veem a aba.
    ...(user.role === "admin" || user.role === "president"
      ? [
          { id: "conexoes" as const, label: "Conexões registradas", icon: Link2 },
          // A consulta das reuniões gravadas (R1a): só a staff, com motivo e
          // auditoria (plataformaProcedure em routers/_procedures.ts).
          { id: "reunioes" as const, label: "Reuniões", icon: Mic },
        ]
      : []),
    abaDistribuicao,
  ] : [abaDistribuicao];
  // Quem só distribui não tem outra aba para abrir.
  const abaAtiva: Tab = ehOuro ? activeTab : "distribuicao";

  return (
    <div className="min-h-screen bg-transparent text-white">
      {/* Header
          flex-wrap: conta Ouro ou admin que também distribui leva dois selos, e em
          360-375 px a linha passava da tela (a página inteira rolava ~40 px para o
          lado). Sem espaço, os selos descem para uma segunda linha. */}
      <div className="border-b border-white/8 bg-[#211e1b]">
        <div className="max-w-6xl mx-auto px-6 py-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex items-center gap-4">
            {/* shrink-0 e nowrap: no mesmo print, o "← Dashboard" quebrava em duas
                linhas por baixo da coroa (a regra global das abas, logo abaixo). */}
            <button onClick={() => navigate("/dashboard")} className="shrink-0 whitespace-nowrap text-white/40 hover:text-white transition-colors text-sm">
              ← Dashboard
            </button>
            <div className="w-px h-4 bg-white/15" />
            <div className="flex items-center gap-2.5">
              {/* shrink-0: a regra global .flex { min-width: 0 } encolhia o quadrado da coroa. */}
              <div className="shrink-0 w-8 h-8 rounded-lg bg-amber-400/15 border border-amber-400/30 flex items-center justify-center">
                <Crown size={14} className="text-amber-400" />
              </div>
              <div>
                <h1 className="text-sm font-bold text-white whitespace-nowrap">Painel Ouro</h1>
                {/* Legenda decorativa: fica de fora no celular, onde não cabe ao lado do "← Dashboard". */}
                <p className="hidden sm:block text-xs text-amber-400/70">Marquesa Global Match · Backoffice Institucional</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ehOuro && (
              <Badge className="bg-amber-400/15 text-amber-300 border-amber-400/30 text-xs">
                <Crown size={10} className="mr-1" /> {user.role === "admin" ? "Admin" : "Ouro"}
              </Badge>
            )}
            {souDistribuidor && (
              <Badge className="bg-amber-400/15 text-amber-300 border-amber-400/30 text-xs">
                <Share2 size={10} className="mr-1" /> Distribuidor
              </Badge>
            )}
          </div>
        </div>

        {/* Tabs
            No celular (print de 16/09 no grupo, 360 px de largura) as abas se desenhavam
            umas por cima das outras e os ícones sumiam. A causa é a regra global
            `.flex { min-width: 0 }` do index.css: com ela cada botão (que é flex)
            encolhia abaixo do próprio texto, e o `whitespace-nowrap` deixava o
            texto vazar sobre o vizinho em vez de quebrar. `shrink-0` devolve a
            largura do rótulo a cada aba; a fileira rola na horizontal
            (overflow-x-auto), sem arrastar a página. `min-h-11` garante os 44 px
            de área de toque. */}
        <div className="max-w-6xl mx-auto px-6 flex gap-1 overflow-x-auto pb-px">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = abaAtiva === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex shrink-0 min-h-11 items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all duration-200 whitespace-nowrap ${
                  isActive
                    ? "border-amber-400 text-amber-400"
                    : "border-transparent text-white/40 hover:text-white/70"
                }`}>
                <Icon size={14} className="shrink-0" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        {abaAtiva === "overview" && <OverviewTab />}
        {abaAtiva === "gold" && <GoldTab />}
        {abaAtiva === "leaders" && <LeadersTab />}
        {abaAtiva === "opportunities" && <OpportunitiesTab />}
        {abaAtiva === "compliance" && <ComplianceTab />}
        {abaAtiva === "conexoes" && <ConexoesRegistradasDaPlataforma />}
        {abaAtiva === "reunioes" && <ConsultaDeReunioesDaPlataforma />}
        {abaAtiva === "distribuicao" && <DistribuicaoTab podeGerir={ehOuro} souDistribuidor={souDistribuidor} />}
      </div>
    </div>
  );
}
