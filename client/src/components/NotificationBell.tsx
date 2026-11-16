import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { textoDoAviso } from "@/lib/aviso-do-sino";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { Link } from "wouter";

// ─── Tipos ───────────────────────────────────────────────────────────────────
type Notification = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  actionUrl: string | null;
  // Os avisos do gravador (H15) guardam aqui o que a tela escreve no idioma de
  // quem lê (lib/aviso-do-sino.ts); nos outros, é nulo.
  parametros?: unknown;
  isRead: boolean | null;
  createdAt: Date;
};

// ─── Ícone por tipo de notificação ───────────────────────────────────────────
function NotifIcon({ type }: { type: string }) {
  const icons: Record<string, string> = {
    gold_granted: "⭐",
    gold_revoked: "🔻",
    opportunity_approved: "✅",
    opportunity_rejected: "❌",
    new_match: "⚡",
    interest_received: "💬",
    compliance_update: "🛡️",
    system: "📎",
    new_message: "✉️",
    lembrete: "⏰",
    reuniao_pronta: "🎙️",
  };
  return <span className="text-base">{icons[type] ?? "🔔"}</span>;
}

// ─── Formatar tempo relativo ──────────────────────────────────────────────────
// Recebe o `t` porque é função de módulo, e quem tem o hook é quem a chama
// (NotifItem). O texto era fixo em português e o sino saía assim nos dez
// idiomas; o plural fica com o i18next (notifications.unread_*), não com um
// "s" somado à mão.
function timeAgo(date: Date, t: (chave: string, opcoes?: Record<string, unknown>) => string): string {
  const now = Date.now();
  const diff = now - new Date(date).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t("notifications.timeNow");
  if (mins < 60) return t("notifications.timeMinutes", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("notifications.timeHours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("notifications.timeDays", { count: days });
}

// ─── Componente principal ─────────────────────────────────────────────────────
export function NotificationBell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [animating, setAnimating] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const notificationsQuery = trpc.notifications.list.useQuery(undefined, {
    refetchInterval: 30_000, // poll a cada 30s
    staleTime: 15_000,
  });
  // Marcar como lido que falha (o banco fora do ar, a rede caindo) é dito na
  // tela, no idioma dela: sem isso, o aviso voltava como novo na consulta
  // seguinte, sem explicação.
  const aoFalharAoMarcar = (erro: unknown) => toast.error(mensagemDeErroParaTela(erro, t));
  const markAllReadMutation = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => notificationsQuery.refetch(),
    onError: aoFalharAoMarcar,
  });
  // Aviso por aviso (H15): tocar um aviso novo o marca lido, e os outros
  // continuam novos.
  const markReadMutation = trpc.notifications.markRead.useMutation({
    onSuccess: () => notificationsQuery.refetch(),
    onError: aoFalharAoMarcar,
  });

  const notifications: Notification[] = (notificationsQuery.data || []) as Notification[];
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  // Animar sino quando chegar nova notificação
  useEffect(() => {
    if (unreadCount > 0) {
      setAnimating(true);
      const t = setTimeout(() => setAnimating(false), 800);
      return () => clearTimeout(t);
    }
  }, [unreadCount]);

  // Fechar ao clicar fora
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleOpen = () => {
    setOpen((o) => !o);
  };

  const handleMarkAllRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    markAllReadMutation.mutate();
  };

  return (
    <div ref={dropdownRef} className="relative">
      {/* Botão sino */}
      <button
        onClick={handleOpen}
        className="relative flex items-center justify-center w-9 h-9 rounded-full hover:bg-white/8 transition-colors duration-200"
        title={t("notifications.title")}
        style={{ color: unreadCount > 0 ? "#c98f70" : "rgba(255,255,255,0.45)" }}
      >
        {/* Ícone sino SVG */}
        <svg
          width="18" height="18" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{
            animation: animating ? "bellShake 0.6s cubic-bezier(0.36,0.07,0.19,0.97)" : "none",
            transformOrigin: "top center",
          }}
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {/* Badge de contagem */}
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center text-[9px] font-black text-[#151312] rounded-full min-w-[16px] h-4 px-1"
            style={{
              background: "linear-gradient(135deg, #c98f70, #efcba8)",
              animation: "badgePop 0.3s cubic-bezier(0.23,1,0.32,1)",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <>
          {/* Overlay para fechar */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          <div
            className="absolute right-0 top-full mt-2 z-50 w-80 rounded-2xl overflow-hidden shadow-2xl shadow-black/50"
            style={{
              background: "linear-gradient(180deg, #211e1b 0%, #211e1b 100%)",
              border: "1px solid rgba(255,255,255,0.1)",
              animation: "dropdownIn 0.2s cubic-bezier(0.23,1,0.32,1)",
              transformOrigin: "top right",
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{t("notifications.title")}</span>
                {unreadCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#c98f70]/20 text-[#c98f70] border border-[#c98f70]/30">
                    {t("notifications.unread", { count: unreadCount })}
                  </span>
                )}
              </div>
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  className="text-[10px] text-white/35 hover:text-white/70 transition-colors"
                >
                  {t("notifications.markAllRead")}
                </button>
              )}
            </div>

            {/* Lista de notificações */}
            <div className="max-h-96 overflow-y-auto">
              {/* Erro de consulta é erro, nunca "nenhuma notificação" (server/CLAUDE.md). */}
              {notificationsQuery.isError && !notificationsQuery.data ? (
                <div className="p-3">
                  <ErroDeConsulta erro={notificationsQuery.error} aoTentarDeNovo={() => void notificationsQuery.refetch()} />
                </div>
              ) : notifications.length === 0 ? (
                <div className="py-10 text-center">
                  <div className="text-3xl mb-2">🔔</div>
                  <p className="text-white/30 text-xs">{t("notifications.empty")}</p>
                </div>
              ) : (
                notifications.slice(0, 20).map((notif, i) => (
                  <NotifItem
                    key={notif.id}
                    notif={notif}
                    index={i}
                    onClose={() => setOpen(false)}
                    onRead={(id) => markReadMutation.mutate({ id })}
                  />
                ))
              )}
            </div>

            {/* Footer */}
            {notifications.length > 0 && (
              <div className="border-t border-white/8 px-4 py-2.5 text-center">
                <Link href="/dashboard" onClick={() => setOpen(false)}>
                  <span className="text-[11px] text-[#c98f70]/70 hover:text-[#c98f70] transition-colors cursor-pointer">
                    {t("notifications.seeAll")}
                  </span>
                </Link>
              </div>
            )}
          </div>
        </>
      )}

      {/* Keyframes injetados via style tag */}
      <style>{`
        @keyframes bellShake {
          0%, 100% { transform: rotate(0deg); }
          15% { transform: rotate(12deg); }
          30% { transform: rotate(-10deg); }
          45% { transform: rotate(8deg); }
          60% { transform: rotate(-6deg); }
          75% { transform: rotate(4deg); }
          90% { transform: rotate(-2deg); }
        }
        @keyframes badgePop {
          0% { transform: scale(0.5); opacity: 0; }
          70% { transform: scale(1.2); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes dropdownIn {
          0% { opacity: 0; transform: scale(0.95) translateY(-8px); }
          100% { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes notifSlideIn {
          0% { opacity: 0; transform: translateX(12px); }
          100% { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

// ─── Item de notificação ──────────────────────────────────────────────────────
function NotifItem({ notif, index, onClose, onRead }: { notif: Notification; index: number; onClose: () => void; onRead: (id: number) => void }) {
  const { t, i18n } = useTranslation();
  const isUnread = !notif.isRead;
  // Os avisos do gravador saem no idioma de quem lê; os outros, como foram gravados.
  const { titulo, corpo } = textoDoAviso(notif, t, i18n.language);
  const aoTocar = () => {
    if (isUnread) onRead(notif.id);
    onClose();
  };

  const content = (
    <div
      className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors duration-150 ${
        isUnread ? "bg-[#c98f70]/4 hover:bg-[#c98f70]/8" : "hover:bg-white/4"
      }`}
      style={{
        animation: `notifSlideIn 0.25s cubic-bezier(0.23,1,0.32,1) ${index * 30}ms both`,
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      {/* Ícone */}
      <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5"
        style={{ background: isUnread ? "rgba(201,143,112,0.12)" : "rgba(255,255,255,0.05)" }}>
        <NotifIcon type={notif.type} />
      </div>

      {/* Conteúdo */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p dir="auto" className={`text-xs font-semibold leading-tight ${isUnread ? "text-white" : "text-white/60"}`}>
            {titulo}
          </p>
          {isUnread && (
            <div className="w-1.5 h-1.5 rounded-full bg-[#c98f70] flex-shrink-0 mt-1" />
          )}
        </div>
        {corpo && (
          <p dir="auto" className="text-[11px] text-white/40 mt-0.5 leading-relaxed line-clamp-2">
            {corpo}
          </p>
        )}
        <p className="text-[10px] text-white/25 mt-1">
          {timeAgo(notif.createdAt, t)}
        </p>
      </div>
    </div>
  );

  if (notif.actionUrl) {
    return (
      <Link href={notif.actionUrl} onClick={aoTocar}>
        {content}
      </Link>
    );
  }
  // Sem link, tocar só marca o aviso lido; a lista fica aberta.
  return isUnread
    ? <div role="button" tabIndex={0} onClick={() => onRead(notif.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRead(notif.id); } }}>{content}</div>
    : content;
}
