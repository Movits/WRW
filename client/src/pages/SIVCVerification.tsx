/**
 * SIVC — Sistema Inteligente de Verificação e Classificação de Usuários
 * Página de verificação de identidade com upload de documentos e painel de status
 */
import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  Shield, ShieldCheck, ShieldAlert, Upload, FileText, CheckCircle2,
  Clock, AlertCircle, XCircle, ChevronRight, Lock, Star, Award,
  Eye, Loader2, Info, ChevronDown, ChevronUp
} from "lucide-react";
import { AppHeader } from "@/components/AppHeader";

// ─── Helpers de UI ────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  verified:    { label: "Verificado",    color: "text-emerald-400", icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
  partial:     { label: "Parcial",       color: "text-yellow-400",  icon: <AlertCircle className="w-4 h-4 text-yellow-400" /> },
  analyzing:   { label: "Analisando",    color: "text-blue-400",    icon: <Loader2 className="w-4 h-4 text-blue-400 animate-spin" /> },
  insufficient:{ label: "Insuficiente",  color: "text-orange-400",  icon: <AlertCircle className="w-4 h-4 text-orange-400" /> },
  unverified:  { label: "Não verificado",color: "text-zinc-500",    icon: <XCircle className="w-4 h-4 text-zinc-500" /> },
  inconsistent:{ label: "Inconsistente", color: "text-red-400",     icon: <XCircle className="w-4 h-4 text-red-400" /> },
};

const MODULE_ICONS: Record<string, string> = {
  identity: "🪪",
  corporate: "🏢",
  finance: "💰",
  employment: "💼",
  professional_council: "⚖️",
  academic: "🎓",
  assets: "🏠",
  financial_assets: "📊",
  background: "🔍",
};

// ─── Componente de barra de progresso ────────────────────────────────────────
function ScoreRing({ score, size = 80 }: { score: number; size?: number }) {
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? "#10b981" : score >= 60 ? "#c98f70" : "#ef4444";

  return (
    <svg width={size} height={size} className="rotate-[-90deg]">
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1f2937" strokeWidth="6" />
      <circle
        cx={size / 2} cy={size / 2} r={radius} fill="none"
        stroke={color} strokeWidth="6"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 1s ease" }}
      />
      <text
        x={size / 2} y={size / 2 + 6}
        textAnchor="middle" fill={color}
        fontSize="16" fontWeight="700"
        style={{ transform: `rotate(90deg)`, transformOrigin: `${size / 2}px ${size / 2}px` }}
      >
        {Math.round(score)}%
      </text>
    </svg>
  );
}

// ─── Componente de upload de arquivo ─────────────────────────────────────────
function DocumentUploadCard({
  module, docType, verificationId, onUploaded
}: {
  module: string; docType: string; verificationId: number; onUploaded: () => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadMutation = trpc.sivc.uploadDocument.useMutation();

  const handleFile = async (file: File) => {
    // Mesmo teto do servidor (MAX_DOCUMENTO_BYTES, 10 MB).
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Arquivo muito grande. Limite: 10 MB.");
      return;
    }
    setUploading(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await uploadMutation.mutateAsync({
        verificationId,
        module,
        docType,
        fileBase64: base64,
        mimeType: file.type,
        fileName: file.name,
      });
      toast.success(`${docType} enviado! Análise em andamento...`);
      onUploaded();
    } catch (err: any) {
      toast.error(err.message || "Erro ao enviar documento.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
        isDragging ? "border-amber-500 bg-amber-500/10" : "border-zinc-700 hover:border-zinc-500"
      }`}
      onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef} type="file"
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      {uploading ? (
        <div className="flex flex-col items-center gap-2">
          <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
          <span className="text-xs text-zinc-400">Enviando e analisando...</span>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <Upload className="w-5 h-5 text-zinc-500" />
          <span className="text-xs text-zinc-400">{docType}</span>
          <span className="text-xs text-zinc-600">PDF, JPG, PNG • máx 10MB</span>
        </div>
      )}
    </div>
  );
}

// ─── Componente de módulo ─────────────────────────────────────────────────────
function ModuleCard({
  moduleKey, moduleInfo, moduleStatus, verificationId, onRefresh
}: {
  moduleKey: string;
  moduleInfo: { label: string; description: string; mandatory: boolean; docTypes: string[] };
  moduleStatus?: { status: string; score: number; checkCount: number; verifiedCount: number };
  verificationId: number;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(moduleKey === "identity");
  const status = moduleStatus?.status || "unverified";
  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.unverified;
  const score = moduleStatus?.score || 0;

  return (
    <div className={`rounded-xl border transition-all ${
      moduleInfo.mandatory ? "border-amber-500/30 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/50"
    }`}>
      <button
        className="w-full flex items-center gap-3 p-4 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-2xl">{MODULE_ICONS[moduleKey] || "📋"}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-white text-sm">{moduleInfo.label}</span>
            {moduleInfo.mandatory && (
              <span className="text-xs bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-full px-2 py-0.5">
                Obrigatório
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5 truncate">{moduleInfo.description}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {statusCfg.icon}
          <span className={`text-xs font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
          {score > 0 && (
            <span className="text-xs text-zinc-500 ml-1">{Math.round(score)}%</span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-zinc-600" /> : <ChevronRight className="w-4 h-4 text-zinc-600" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-800 pt-4">
          <p className="text-sm text-zinc-400 mb-4">{moduleInfo.description}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {moduleInfo.docTypes.map((docType) => (
              <DocumentUploadCard
                key={docType}
                module={moduleKey}
                docType={docType}
                verificationId={verificationId}
                onUploaded={onRefresh}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────
export default function SIVCVerification() {
  // Só o título do header passa por t() por enquanto: o resto da tela é
  // pt-BR fixo (dívida registrada), mas o menu global é compartilhado e o
  // título ao lado dele precisa acompanhar o idioma escolhido.
  const { t, i18n } = useTranslation();
  const { user, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [consentChecked, setConsentChecked] = useState(false);
  const [starting, setStarting] = useState(false);

  const startMutation = trpc.sivc.startVerification.useMutation();
  const { data: statusData, isLoading, refetch } = trpc.sivc.getStatus.useQuery(undefined, {
    refetchInterval: 10000, // Polling a cada 10s para atualizar OCR
  });
  const { data: modulesData } = trpc.sivc.getModules.useQuery();

  if (!isAuthenticated) {
    navigate("/login");
    return null;
  }

  const handleStart = async () => {
    if (!consentChecked) {
      toast.error("Você precisa aceitar os termos para continuar.");
      return;
    }
    setStarting(true);
    try {
      await startMutation.mutateAsync({ consentGranted: true });
      await refetch();
      toast.success("Verificação iniciada! Envie seus documentos abaixo.");
    } catch (err: any) {
      toast.error(err.message || "Erro ao iniciar verificação.");
    } finally {
      setStarting(false);
    }
  };

  const verification = statusData?.verification;
  const hasVerification = statusData?.hasVerification;
  const modules = modulesData?.modules || {};
  const moduleStatus = statusData?.moduleStatus || {};

  // ─── Tela de consentimento ────────────────────────────────────────────────
  if (!hasVerification) {
    return (
      <div className="min-h-screen bg-transparent text-white">
        <AppHeader title={t("appHeader.menu.verification")} backTo="/dashboard"/>
        <div className="max-w-2xl mx-auto px-4 py-12">
          {/* Header */}
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/30 mb-4">
              <Shield className="w-8 h-8 text-amber-500" />
            </div>
            <h1 className="text-3xl font-black mb-2">
              <span className="text-white">SIVC</span>
              <span className="text-amber-500">: Verificação de Identidade</span>
            </h1>
            <p className="text-zinc-400 text-sm max-w-md mx-auto">
              Envie seus documentos para comprovar quem você é. Com o selo de verificada, as outras empresárias confiam mais em você e você desbloqueia recursos exclusivos.
            </p>
          </div>

          {/* Situação da verificação. Não é o nível de membro: Bronze e Prata
              medem a qualificação do perfil (Governança, 14/09/2026), e a
              verificação de identidade nunca mudou o nível da conta. */}
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-center">
              <div className="text-3xl mb-2">🪪</div>
              <h3 className="font-bold text-white mb-1">Não verificada</h3>
              <p className="text-xs text-zinc-500">Cadastro sem comprovação dos documentos obrigatórios</p>
            </div>
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-center">
              <div className="text-3xl mb-2">✅</div>
              <h3 className="font-bold text-amber-400 mb-1">Verificada</h3>
              <p className="text-xs text-zinc-400">Identidade verificada e nota de pelo menos 80% nos documentos obrigatórios</p>
            </div>
          </div>
          <p className="text-xs text-zinc-500 text-center mb-8">
            A verificação de identidade não muda o seu nível de membro: Bronze e Prata refletem a qualificação do seu perfil.
          </p>

          {/* O que é verificado */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 mb-6">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Eye className="w-4 h-4 text-amber-500" />
              O que é verificado
            </h3>
            <div className="space-y-2">
              {[
                { icon: "🪪", label: "Identidade", desc: "RG, CNH, Passaporte + Comprovante de Endereço", mandatory: true },
                { icon: "🏢", label: "Corporativo", desc: "Número de Cadastro Empresarial, Contrato Social, Certidão da Junta", mandatory: false },
                { icon: "💰", label: "Financeiro", desc: "Balanço, DRE, Open Finance", mandatory: false },
                { icon: "🎓", label: "Acadêmico", desc: "Diplomas, Certificados, Histórico Escolar", mandatory: false },
                { icon: "🔍", label: "Antecedentes", desc: "Certidões, Sanções, Presença Digital", mandatory: false },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-3">
                  <span className="text-lg">{item.icon}</span>
                  <div className="flex-1">
                    <span className="text-sm text-white">{item.label}</span>
                    <span className="text-xs text-zinc-500 ml-2">{item.desc}</span>
                  </div>
                  {item.mandatory && (
                    <span className="text-xs text-amber-400 border border-amber-500/30 rounded-full px-2 py-0.5">Obrigatório</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Consentimento */}
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-5 mb-6">
            <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
              <Lock className="w-4 h-4 text-amber-500" />
              Termos de Consentimento
            </h3>
            <div className="text-xs text-zinc-400 space-y-2 mb-4 max-h-40 overflow-y-auto">
              <p>Ao iniciar a verificação, você concorda que:</p>
              <p>1. Os documentos enviados serão processados por IA para extração e validação de informações.</p>
              <p>2. Seus dados serão armazenados de forma segura e criptografada, conforme a LGPD (Lei 13.709/2018).</p>
              <p>3. As informações verificadas serão usadas exclusivamente para classificação dentro do ecossistema MarquesaMatch.</p>
              <p>4. Você pode solicitar a exclusão dos seus dados a qualquer momento.</p>
              <p>5. Documentos com informações falsas resultarão em suspensão imediata da conta.</p>
            </div>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 accent-amber-500"
              />
              <span className="text-sm text-zinc-300">
                Li e concordo com os termos de consentimento para verificação de identidade no ecossistema MarquesaMatch.
              </span>
            </label>
          </div>

          <button
            onClick={handleStart}
            disabled={!consentChecked || starting}
            className="w-full py-4 rounded-xl font-bold text-black bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {starting ? (
              <><Loader2 className="w-5 h-5 animate-spin" /> Iniciando...</>
            ) : (
              <><ShieldCheck className="w-5 h-5" /> Iniciar Verificação de Identidade</>
            )}
          </button>
        </div>
      </div>
    );
  }

  // ─── Painel de status e upload ────────────────────────────────────────────
  const score = verification?.overallScore || 0;
  const level = verification?.level || "bronze";
  const mandatoryPassed = verification?.mandatoryPassed || false;

  return (
    <div className="min-h-screen bg-transparent text-white">
        <AppHeader title={t("appHeader.menu.verification")} backTo="/dashboard"/>
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header com score */}
        <div className="flex flex-col md:flex-row items-center gap-6 mb-8 p-6 rounded-2xl border border-zinc-800 bg-zinc-900">
          <ScoreRing score={score} size={100} />
          <div className="flex-1 text-center md:text-left">
            <div className="flex items-center gap-2 justify-center md:justify-start mb-1">
              {/* `level` é o nome herdado da coluna: aqui mede a verificação, não o nível de membro. */}
              <span className="text-2xl">{level === "silver" ? "✅" : "🪪"}</span>
              <h2 className="text-xl font-black text-white">
                {level === "silver" ? "Identidade verificada" : "Verificação em andamento"}
              </h2>
              {level === "silver" && (
                <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-full px-2 py-0.5">
                  ✓ Verificado
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-400 mb-3">{verification?.levelMessage}</p>
            <div className="flex flex-wrap gap-3 justify-center md:justify-start">
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                Nota geral: <strong className="text-white">{Math.round(score)}%</strong>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                {mandatoryPassed ? (
                  <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Obrigatórios: <strong className="text-emerald-400">Aprovados</strong></>
                ) : (
                  <><AlertCircle className="w-3.5 h-3.5 text-orange-400" /> Obrigatórios: <strong className="text-orange-400">Pendentes</strong></>
                )}
              </div>
            </div>
          </div>
          {/* Progresso da verificação */}
          {level !== "silver" && (
            <div className="shrink-0 text-center">
              <div className="text-xs text-zinc-500 mb-1">Para concluir a verificação</div>
              <div className="text-sm text-amber-400 font-semibold">
                {mandatoryPassed ? `Faltam ${Math.max(0, 80 - Math.round(score))}% no score` : "Complete os módulos obrigatórios"}
              </div>
            </div>
          )}
        </div>

        {/* Módulos */}
        <div className="mb-6">
          <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-amber-500" />
            Módulos de Verificação
          </h3>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(modules).map(([key, info]: [string, any]) => (
                <ModuleCard
                  key={key}
                  moduleKey={key}
                  moduleInfo={info}
                  moduleStatus={moduleStatus[key]}
                  verificationId={verification?.id}
                  onRefresh={refetch}
                />
              ))}
            </div>
          )}
        </div>

        {/* Documentos enviados */}
        {statusData?.documents && statusData.documents.length > 0 && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
            <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
              <FileText className="w-4 h-4 text-amber-500" />
              Documentos Enviados ({statusData.documents.length})
            </h3>
            <div className="space-y-2">
              {statusData.documents.map((doc: any) => (
                <div key={doc.id} className="flex items-center gap-3 p-3 rounded-lg bg-zinc-800">
                  <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{doc.docType}</p>
                    <p className="text-xs text-zinc-500">{doc.module} • {new Date(doc.createdAt).toLocaleDateString(i18n.language)}</p>
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    {doc.ocrStatus === "processing" && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
                    {doc.ocrStatus === "completed" && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                    {doc.ocrStatus === "failed" && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                    <span className="text-xs text-zinc-500">
                      {doc.ocrStatus === "processing" ? "Analisando" : doc.ocrStatus === "completed" ? `${Math.round(doc.confidenceScore || 0)}%` : "Falhou"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Info sobre o processo */}
        <div className="mt-6 p-4 rounded-xl border border-zinc-800 bg-zinc-900/50">
          <div className="flex gap-3">
            <Info className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
            <div className="text-xs text-zinc-500 space-y-1">
              <p>A análise dos documentos é feita por IA e pode levar até 2 minutos por documento.</p>
              <p>O score é atualizado automaticamente à medida que os documentos são processados.</p>
              <p>Documentos com inconsistências serão sinalizados para revisão manual pela equipe MarquesaMatch.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
