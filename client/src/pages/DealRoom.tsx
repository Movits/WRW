import { useState, useRef, useEffect } from "react";
import { useParams, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { EncerrarNegociacao } from "@/components/EncerrarNegociacao";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  Lock, Shield, FileText, MessageSquare, Upload, ArrowLeft,
  Send, CheckCircle, Clock, AlertTriangle, Download, User
} from "lucide-react";

export default function DealRoom() {
  const { id } = useParams<{ id: string }>();
  const roomId = Number(id);
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<"nda" | "chat" | "docs">("nda");
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const { data: room, isLoading, refetch: refetchRoom } = trpc.dealRoom.getRoom.useQuery(
    { roomId },
    { enabled: !!roomId && !isNaN(roomId) }
  );

  const { data: messages = [], refetch: refetchMessages } = trpc.dealRoom.getMessages.useQuery(
    { roomId },
    { enabled: !!room && room.status === "active", refetchInterval: 5000 }
  );

  const { data: documents = [], refetch: refetchDocs } = trpc.dealRoom.listDocuments.useQuery(
    { roomId },
    { enabled: !!room && room.status === "active" }
  );

  const acceptNDA = trpc.dealRoom.acceptNDA.useMutation({
    onSuccess: () => {
      toast.success(t("dealRoom.ndaSignedSuccess"));
      refetchRoom();
    },
    onError: (err) => toast.error(err.message),
  });

  const sendMessage = trpc.dealRoom.sendMessage.useMutation({
    onSuccess: () => {
      setMessage("");
      refetchMessages();
    },
    onError: (err) => toast.error(err.message),
  });

  const uploadDocument = trpc.dealRoom.uploadDocument.useMutation({
    onSuccess: () => {
      toast.success(t("dealRoom.documentUploadedSuccess"));
      refetchDocs();
      setUploading(false);
    },
    onError: (err) => {
      toast.error(err.message);
      setUploading(false);
    },
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (room?.status === "active") setActiveTab("chat");
  }, [room?.status]);

  const [isDragOver, setIsDragOver] = useState(false);

  const uploadFile = (file: File) => {
    // Mesmo teto do servidor (MAX_DOCUMENTO_BYTES, 10 MB): avisar 16 MB aqui e
    // recusar em 10 no servidor era prometer o que não entregava.
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t("dealRoom.fileTooLarge", { fileName: file.name }));
      return;
    }
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      uploadDocument.mutate({
        roomId,
        name: file.name,
        fileBase64: base64,
        mimeType: file.type,
        sizeBytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach(uploadFile);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach(uploadFile);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-white/40 text-sm">{t("dealRoom.loadingRoom")}</div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-screen bg-transparent flex items-center justify-center">
        <div className="text-center">
          <p className="text-white/40 mb-4">{t("dealRoom.roomNotFound")}</p>
          <Link href="/dashboard">
            <Button variant="outline" className="border-white/20 text-white/60 bg-transparent">
              <ArrowLeft size={14} className="mr-1.5" /> {t("dealRoom.backToHome")}
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const isOwner = room.ownerId === user?.id;
  const myNdaAccepted = isOwner ? room.ndaAcceptedByOwner : room.ndaAcceptedByInterested;
  const otherNdaAccepted = isOwner ? room.ndaAcceptedByInterested : room.ndaAcceptedByOwner;
  const otherParty = isOwner ? (room as any).interested : (room as any).owner;
  const opp = (room as any).opportunity;

  const statusColor = room.status === "active" ? "#22c55e" : room.status === "awaiting_nda" ? "#eab308" : "#9ca3af";
  const statusLabel = room.status === "active" ? t("dealRoom.statusActive") : room.status === "awaiting_nda" ? t("dealRoom.statusAwaitingNda") : t("dealRoom.statusClosed");

  return (
    <div className="min-h-screen bg-transparent">
      {/* Header */}
      <div className="border-b border-white/10 bg-[#151312]/90 backdrop-blur-sm sticky top-16 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard">
              <button className="text-white/40 hover:text-white transition-colors">
                <ArrowLeft size={18} />
              </button>
            </Link>
            <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
              <Lock size={14} className="text-amber-400" />
            </div>
            <div>
              <h1 className="text-white font-semibold text-sm">{t("dealRoom.roomTitle", { roomId })}</h1>
              <p className="text-white/40 text-xs">{opp?.title || t("dealRoom.opportunityFallback")}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ background: statusColor }} />
            <span className="text-xs" style={{ color: statusColor }}>{statusLabel}</span>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Participantes */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          {[
            { label: t("dealRoom.ownerLabel"), person: (room as any).owner, accepted: room.ndaAcceptedByOwner, acceptedAt: room.ndaAcceptedByOwnerAt },
            { label: t("dealRoom.interestedLabel"), person: (room as any).interested, accepted: room.ndaAcceptedByInterested, acceptedAt: room.ndaAcceptedByInterestedAt },
          ].map((p, i) => (
            <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                <User size={16} className="text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white/40 text-xs">{p.label}</p>
                <p className="text-white text-sm font-medium truncate">{p.person?.name || "-"}</p>
              </div>
              <div className="flex-shrink-0">
                {p.accepted ? (
                  <div className="flex items-center gap-1 text-green-400">
                    <CheckCircle size={14} />
                    <span className="text-xs">{t("dealRoom.ndaCheckmark")}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-amber-400/60">
                    <Clock size={14} />
                    <span className="text-xs">{t("dealRoom.waitingLabel")}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* A11 / etapa 12 — encerrar registrando o negócio e a comissão. Só depois
            que as duas partes aceitaram o acordo: antes disso não há negociação
            para encerrar. Quem só acompanha (Ouro) vê o registro, não o formulário. */}
        {room.status !== "awaiting_nda" && (
          <div className="mb-6">
            <EncerrarNegociacao
              roomId={roomId}
              ehParte={room.ownerId === user?.id || room.interestedId === user?.id}
              onEncerrada={() => refetchRoom()}
            />
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-white/5 rounded-xl p-1">
          {[
            { key: "nda", icon: <Shield size={14} />, label: t("dealRoom.tabNda") },
            { key: "chat", icon: <MessageSquare size={14} />, label: t("dealRoom.tabChat"), disabled: room.status !== "active" },
            { key: "docs", icon: <FileText size={14} />, label: t("dealRoom.tabDocs"), disabled: room.status !== "active" },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => !tab.disabled && setActiveTab(tab.key as any)}
              disabled={tab.disabled}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium transition-all ${
                activeTab === tab.key
                  ? "bg-amber-500 text-black"
                  : tab.disabled
                  ? "text-white/20 cursor-not-allowed"
                  : "text-white/50 hover:text-white hover:bg-white/5"
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.disabled && <Lock size={10} />}
            </button>
          ))}
        </div>

        {/* Tab: NDA */}
        {activeTab === "nda" && (
          <div className="space-y-4">
            <div className="bg-white/5 border border-amber-500/20 rounded-2xl p-6">
              <div className="flex items-center gap-2 mb-4">
                <Shield size={18} className="text-amber-400" />
                <h2 className="text-white font-bold">{t("dealRoom.ndaTitle")}</h2>
              </div>

              <div className="bg-black/30 border border-white/10 rounded-xl p-4 mb-5 text-xs text-white/60 leading-relaxed space-y-3 max-h-72 overflow-y-auto">
                <p className="text-amber-400 font-semibold text-sm">{t("dealRoom.ndaHeading")}</p>
                <p>{t("dealRoom.ndaIntro")}</p>
                <p><strong className="text-white/80">{t("dealRoom.ndaClause1Title")}</strong> {t("dealRoom.ndaClause1Text")}</p>
                <p><strong className="text-white/80">{t("dealRoom.ndaClause2Title")}</strong> {t("dealRoom.ndaClause2Text")} <strong className="text-amber-400">{t("dealRoom.ndaClause2Fee")}</strong> {t("dealRoom.ndaClause2TextEnd")}</p>
                <p><strong className="text-white/80">{t("dealRoom.ndaClause3Title")}</strong> {t("dealRoom.ndaClause3Text")}</p>
                <p><strong className="text-white/80">{t("dealRoom.ndaClause4Title")}</strong> {t("dealRoom.ndaClause4Text")}</p>
                <p className="text-white/40 border-t border-white/10 pt-3">
                  {t("dealRoom.ndaOpportunityLabel")} <strong className="text-white/60">{opp?.title}</strong><br />
                  {t("dealRoom.ndaRoomIdLabel", { roomId })}<br />
                  {t("dealRoom.ndaCreatedLabel")} {room.createdAt ? new Date(room.createdAt).toLocaleDateString(i18n.language) : "-"}
                </p>
              </div>

              {room.status === "active" ? (
                <div className="flex items-center gap-3 p-4 bg-green-500/10 border border-green-500/20 rounded-xl">
                  <CheckCircle size={20} className="text-green-400 flex-shrink-0" />
                  <div>
                    <p className="text-green-400 font-semibold text-sm">{t("dealRoom.ndaSignedBoth")}</p>
                    <p className="text-green-400/60 text-xs">{t("dealRoom.ndaSignedBothDesc")}</p>
                  </div>
                </div>
              ) : myNdaAccepted ? (
                <div className="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl">
                  <Clock size={20} className="text-amber-400 flex-shrink-0" />
                  <div>
                    <p className="text-amber-400 font-semibold text-sm">{t("dealRoom.ndaSignedByMe")}</p>
                    <p className="text-amber-400/60 text-xs">{t("dealRoom.ndaSignedByMeDesc")}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {!otherNdaAccepted && (
                    <div className="flex items-center gap-2 text-white/40 text-xs">
                      <AlertTriangle size={12} />
                      <span>{t("dealRoom.ndaOtherPartyWaiting")}</span>
                    </div>
                  )}
                  <Button
                    className="w-full bg-amber-500 hover:bg-amber-400 text-black font-bold"
                    // Etapa 13: junto do aceite vai o texto que estava na tela
                    // (varia por idioma) — o servidor guarda idioma, texto e
                    // hash como prova do que foi aceito.
                    onClick={() => acceptNDA.mutate({
                      roomId,
                      locale: i18n.resolvedLanguage ?? i18n.language,
                      textoExibido: [
                        t("dealRoom.ndaHeading"), t("dealRoom.ndaIntro"),
                        t("dealRoom.ndaClause1Title"), t("dealRoom.ndaClause1Text"),
                        t("dealRoom.ndaClause2Title"), t("dealRoom.ndaClause2Text"), t("dealRoom.ndaClause2Fee"), t("dealRoom.ndaClause2TextEnd"),
                        t("dealRoom.ndaClause3Title"), t("dealRoom.ndaClause3Text"),
                        t("dealRoom.ndaClause4Title"), t("dealRoom.ndaClause4Text"),
                      ].join("\n"),
                    })}
                    disabled={acceptNDA.isPending}
                  >
                    {acceptNDA.isPending ? t("dealRoom.signingNda") : t("dealRoom.signNdaButton")}
                  </Button>
                  <p className="text-white/30 text-xs text-center">
                    {t("dealRoom.ndaConfirmHint")}
                  </p>
                </div>
              )}
            </div>

            {room.interestMessage && (
              <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                <p className="text-white/40 text-xs mb-1">{t("dealRoom.interestMessageLabel")}</p>
                <p className="text-white/70 text-sm italic">"{room.interestMessage}"</p>
              </div>
            )}
          </div>
        )}

        {/* Tab: Chat */}
        {activeTab === "chat" && room.status === "active" && (
          <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden flex flex-col" style={{ height: "500px" }}>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <MessageSquare size={32} className="text-white/20 mx-auto mb-2" />
                    <p className="text-white/30 text-sm">{t("dealRoom.noMessagesYet")}</p>
                    <p className="text-white/20 text-xs">{t("dealRoom.beFirstToMessage")}</p>
                  </div>
                </div>
              ) : (
                messages.map((msg: any) => {
                  const isMine = msg.senderId === user?.id;
                  return (
                    <div key={msg.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-xs rounded-2xl px-4 py-2.5 text-sm ${
                          isMine
                            ? "bg-amber-500 text-black rounded-br-sm"
                            : "bg-white/10 text-white rounded-bl-sm"
                        }`}
                      >
                        <p>{msg.content}</p>
                        <p className={`text-xs mt-1 ${isMine ? "text-black/50" : "text-white/30"}`}>
                          {new Date(msg.createdAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={chatEndRef} />
            </div>
            <div className="border-t border-white/10 p-3 flex gap-2">
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && message.trim()) {
                    e.preventDefault();
                    sendMessage.mutate({ roomId, content: message.trim() });
                  }
                }}
                placeholder={t("dealRoom.messagePlaceholder")}
                className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm placeholder:text-white/30 focus:outline-none focus:border-amber-500/40"
              />
              <Button
                size="sm"
                className="bg-amber-500 hover:bg-amber-400 text-black"
                onClick={() => message.trim() && sendMessage.mutate({ roomId, content: message.trim() })}
                disabled={!message.trim() || sendMessage.isPending}
              >
                <Send size={14} />
              </Button>
            </div>
          </div>
        )}

        {/* Tab: Documentos */}
        {activeTab === "docs" && room.status === "active" && (
          <div className="space-y-4">
            <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-semibold text-sm flex items-center gap-2">
                  <FileText size={16} className="text-amber-400" />
                  {t("dealRoom.confidentialDocsTitle")}
                </h3>
                <Button
                  size="sm"
                  className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  <Upload size={12} className="mr-1.5" />
                  {uploading ? t("dealRoom.uploadingFile") : t("dealRoom.attachFileButton")}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.zip,.rar,.txt,.csv"
                  onChange={handleFileUpload}
                />
              </div>
              {/* Drag-and-drop area */}
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-4 mb-4 text-center cursor-pointer transition-all duration-200 ${
                  isDragOver
                    ? 'border-amber-400 bg-amber-400/10'
                    : 'border-white/10 hover:border-amber-400/40 hover:bg-white/5'
                }`}
              >
                <Upload size={20} className={`mx-auto mb-1.5 ${isDragOver ? 'text-amber-400' : 'text-white/30'}`} />
                <p className={`text-xs ${isDragOver ? 'text-amber-400' : 'text-white/30'}`}>
                  {isDragOver ? t("dealRoom.dropToUpload") : t("dealRoom.dragDropHint")}
                </p>
                <p className="text-white/20 text-xs mt-0.5">{t("dealRoom.fileTypesHint")}</p>
              </div>

              {documents.length === 0 ? (
                <div className="text-center py-8">
                  <FileText size={32} className="text-white/20 mx-auto mb-2" />
                  <p className="text-white/30 text-sm">{t("dealRoom.noDocsYet")}</p>
                  <p className="text-white/20 text-xs mt-1">{t("dealRoom.sendDocsSecurely")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {documents.map((doc: any) => (
                    <div key={doc.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl">
                      <FileText size={16} className="text-amber-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-white text-sm truncate">{doc.name}</p>
                        <p className="text-white/40 text-xs">
                          {doc.uploadedBy === user?.id ? t("dealRoom.youLabel") : otherParty?.name} •{" "}
                          {new Date(doc.createdAt).toLocaleDateString(i18n.language)}
                          {doc.sizeBytes && ` • ${t("dealRoom.fileSizeKb", { size: (doc.sizeBytes / 1024).toFixed(0) })}`}
                        </p>
                      </div>
                      <a href={doc.url} target="_blank" rel="noopener noreferrer">
                        <Button size="sm" variant="outline" className="border-white/20 text-white/60 bg-transparent">
                          <Download size={12} />
                        </Button>
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 flex items-start gap-3">
              <Shield size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-amber-400/70 text-xs leading-relaxed">
                {t("dealRoom.docsProtectedNotice")}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
