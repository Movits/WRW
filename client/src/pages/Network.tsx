import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EnrichmentChat } from "@/components/EnrichmentChat";
import { ErroDeConsulta } from "@/components/ErroDeConsulta";
import { trpc } from "@/lib/trpc";
import {
  prepararImagemParaEnvio,
  LADO_MAXIMO_FOTO_DE_CONTATO,
  LADO_MAXIMO_CARTAO_DE_VISITA,
  type ImagemParaEnviar,
} from "@/lib/reduzir-imagem";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  Plus, Search, X, Phone, Mail, Linkedin, Instagram,
  MapPin, Briefcase, Tag, Edit2, Trash2, ExternalLink,
  ChevronLeft, User, MessageCircle, Globe, FileText,
  Shield, Lock, Sparkles, History, RotateCcw, Calendar
} from "lucide-react";
import { getLoginUrl } from "@/const";
import { Link } from "wouter";
import { AutorizacaoAcervoOuro } from "@/components/AutorizacaoAcervoOuro";
import { AlertaDeCompletude } from "@/components/CompletudeDoContato";
import { camposFaltantes } from "@shared/completude-do-contato";

// ─── Tags de perfil predefinidas ─────────────────────────────────────────────
// Os valores em si permanecem em português: é o que fica salvo no contato
// (profileTags) e usado para comparação/seleção. A chave de i18n abaixo só
// controla o RÓTULO exibido — troque o idioma sem migrar dado nenhum.
const PROFILE_TAGS = [
  "Empresária", "Investidora", "Diplomata", "Autoridade Pública",
  "Advogada", "Pesquisadora", "Fornecedora", "Compradora", "Executiva", "Outro"
];

const PROFILE_TAG_LABEL_KEYS: Record<string, string> = {
  "Empresária": "network.tagEmpresaria",
  "Investidora": "network.tagInvestidora",
  "Diplomata": "network.tagDiplomata",
  "Autoridade Pública": "network.tagAutoridadePublica",
  "Advogada": "network.tagAdvogada",
  "Pesquisadora": "network.tagPesquisadora",
  "Fornecedora": "network.tagFornecedora",
  "Compradora": "network.tagCompradora",
  "Executiva": "network.tagExecutiva",
  "Outro": "network.tagOutro",
};

// Traduz o rótulo visível de uma tag de perfil, mantendo o valor salvo intacto.
function tagLabel(t: (key: string) => string, tag: string): string {
  const key = PROFILE_TAG_LABEL_KEYS[tag];
  return key ? t(key) : tag;
}

// ─── Tipos ───────────────────────────────────────────────────────────────────
type Contact = {
  id: number;
  fullName: string;
  photoUrl?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  instagram?: string | null;
  profileTags?: string[] | null;
  cardImageUrl?: string | null;
  notes?: string | null;
  enrichmentStatus?: string | null;
  nivelVisibilidade?: "privado" | "ouro" | "publico" | null;
  // Meu Network Inteligente (spec de 14/09, itens 13 e 14)
  codigoAnonimo?: string | null;
  disponivelRedeGlobal?: boolean | null;
  createdAt: number;
  updatedAt: number;
};

// Etapa 8 — os três níveis, na linguagem de quem escolhe. O padrão é privado:
// nada vira público sem a dona pedir, e dá para mudar a qualquer momento.
// Função (não constante) porque rotulo/descricao dependem de t() — só existe dentro de um componente.
function getNiveisDeVisibilidade(t: (key: string) => string) {
  return [
    { valor: "privado" as const, rotulo: t("network.nivelPrivadoRotulo"), descricao: t("network.nivelPrivadoDescricao") },
    { valor: "ouro" as const, rotulo: t("network.nivelOuroRotulo"), descricao: t("network.nivelOuroDescricao") },
    { valor: "publico" as const, rotulo: t("network.nivelPublicoRotulo"), descricao: t("network.nivelPublicoDescricao") },
  ];
}

// ─── Formulário vazio ─────────────────────────────────────────────────────────
const emptyForm = () => ({
  fullName: "", photoUrl: "", cardImageUrl: "", jobTitle: "", company: "",
  country: "", state: "", city: "",
  phone: "", whatsapp: "", email: "",
  linkedinUrl: "", instagram: "",
  profileTags: [] as string[],
  notes: "",
  nivelVisibilidade: "privado" as "privado" | "ouro" | "publico",
});

// ─── Avatar ───────────────────────────────────────────────────────────────────
function Avatar({ name, photoUrl, size = 48 }: { name: string; photoUrl?: string | null; size?: number }) {
  const initials = name.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
  if (photoUrl) {
    // A lista de contatos pode ter dezenas de avatares; `lazy` só baixa os que
    // entram na tela e `async` tira a decodificação do caminho de desenho.
    return <img src={photoUrl} alt={name} loading="lazy" decoding="async"
      className="rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <div className="rounded-full flex items-center justify-center font-bold text-white bg-gradient-to-br from-amber-500 to-amber-700"
      style={{ width: size, height: size, fontSize: size * 0.35 }}>
      {initials || "?"}
    </div>
  );
}

// ─── Tag chip ─────────────────────────────────────────────────────────────────
function TagChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium border transition-all duration-150 active:scale-95 ${
        selected
          ? "bg-amber-500 border-amber-500 text-[#151312] font-bold"
          : "bg-white/5 border-white/20 text-white/60 hover:border-white/40 hover:text-white"
      }`}>
      {label}
    </button>
  );
}

// ─── Card de contato na lista ─────────────────────────────────────────────────
function ContactCard({ contact, onView, onEdit, onDelete }: {
  contact: Contact;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="relative p-4 rounded-2xl bg-white/5 border border-white/10 hover:border-amber-500/30 transition-all duration-200 cursor-pointer group"
      onClick={onView}>
      <div className="flex items-start gap-3">
        <Avatar name={contact.fullName} photoUrl={contact.photoUrl} size={48} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <p className="font-semibold text-white truncate">{contact.fullName}</p>
              {contact.enrichmentStatus === "active" && (
                <span className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs animate-pulse">
                  <Sparkles size={9} /> {t("network.badgeIA")}
                </span>
              )}
              {/* Etapa 10: o nível escolhido fica visível na lista — a dona
                  enxerga de relance o que está compartilhado com quem. */}
              {contact.nivelVisibilidade === "ouro" && (
                <span className="flex-shrink-0 px-2 py-0.5 rounded-full bg-amber-400/10 border border-amber-300/40 text-amber-300 text-xs">{t("network.badgeOuro")}</span>
              )}
              {contact.nivelVisibilidade === "publico" && (
                <span className="flex-shrink-0 px-2 py-0.5 rounded-full bg-sky-400/10 border border-sky-300/40 text-sky-300 text-xs">{t("network.badgePublico")}</span>
              )}
            </div>
            <button type="button"
              className="text-white/30 hover:text-white/70 transition-colors p-1 rounded-lg hover:bg-white/10 flex-shrink-0 z-10"
              onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}>
              <span className="text-lg leading-none">···</span>
            </button>
          </div>
          {contact.jobTitle && <p className="text-sm text-white/50 truncate">{contact.jobTitle}{contact.company ? ` · ${contact.company}` : ""}</p>}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {contact.country && (
              <span className="flex items-center gap-1 text-xs text-white/35">
                <MapPin size={10} />{contact.city ? `${contact.city}, ` : ""}{contact.country}
              </span>
            )}
            {contact.profileTags?.slice(0, 2).map(tag => (
              <span key={tag} className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400/80 text-xs">{tagLabel(t, tag)}</span>
            ))}
          </div>
        </div>
      </div>
      {/* Menu contextual */}
      {menuOpen && (
        <div className="absolute right-4 top-12 z-20 bg-[#211e1b] border border-white/15 rounded-xl shadow-2xl py-1 min-w-[140px]"
          onClick={e => e.stopPropagation()}>
          <button className="w-full px-4 py-2 text-sm text-white/70 hover:bg-white/8 text-left flex items-center gap-2"
            onClick={() => { setMenuOpen(false); onView(); }}>
            <User size={13} /> {t("network.verPerfil")}
          </button>
          <button className="w-full px-4 py-2 text-sm text-white/70 hover:bg-white/8 text-left flex items-center gap-2"
            onClick={() => { setMenuOpen(false); onEdit(); }}>
            <Edit2 size={13} /> {t("network.editar")}
          </button>
          <button className="w-full px-4 py-2 text-sm text-red-400/80 hover:bg-red-500/10 text-left flex items-center gap-2"
            onClick={() => { setMenuOpen(false); onDelete(); }}>
            <Trash2 size={13} /> {t("network.excluir")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Formulário multi-step ────────────────────────────────────────────────────
function ContactForm({ initial, onSave, onClose, loading }: {
  initial?: Partial<Contact>;
  onSave: (data: ReturnType<typeof emptyForm>) => void;
  onClose: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<ReturnType<typeof emptyForm>>({
    fullName:    initial?.fullName    ?? "",
    photoUrl:    initial?.photoUrl    ?? "",
    cardImageUrl: initial?.cardImageUrl ?? "",
    jobTitle:    initial?.jobTitle    ?? "",
    company:     initial?.company     ?? "",
    country:     initial?.country     ?? "",
    state:       initial?.state       ?? "",
    city:        initial?.city        ?? "",
    phone:       initial?.phone       ?? "",
    whatsapp:    initial?.whatsapp    ?? "",
    email:       initial?.email       ?? "",
    linkedinUrl: initial?.linkedinUrl ?? "",
    instagram:   initial?.instagram   ?? "",
    profileTags: initial?.profileTags ?? [],
    notes:       initial?.notes       ?? "",
    nivelVisibilidade: initial?.nivelVisibilidade ?? "privado",
  });

  const set = (k: keyof typeof form, v: unknown) => setForm(p => ({ ...p, [k]: v }));

  // Foto e cartão de visita (etapa 1, critérios 4 e 5): upload real de
  // arquivo. O contato pode nem existir ainda (tela de criação) — por isso o
  // endpoint devolve só a URL do proxy, sem contactId, e ela fica guardada
  // no formulário até "Salvar" gravar de fato, exatamente como o campo de
  // texto funcionava antes.
  const TIPOS_DE_IMAGEM = ["image/jpeg", "image/png", "image/webp"] as const;
  const uploadPhotoMut = trpc.network.uploadPhoto.useMutation();
  const uploadCardMut = trpc.network.uploadCard.useMutation();
  // A imagem é REDUZIDA no navegador antes de subir (ver lib/reduzir-imagem.ts):
  // a foto para 512 px no lado maior, o cartão para 1600 px, porque no cartão o
  // conteúdo é texto e precisa continuar legível. O teto de 10 MB abaixo segue
  // valendo sobre o arquivo ESCOLHIDO — é o teto de abuso, e quem decide o
  // tamanho do que sobe é a redução.
  // Reduzir uma foto de celular leva alguns décimos de segundo, e nesse
  // intervalo a mutação ainda não começou: sem este estado o campo continuaria
  // dizendo "enviar foto" e aceitaria um segundo arquivo por cima do primeiro.
  const [preparandoImagem, setPreparandoImagem] = useState<"photoUrl" | "cardImageUrl" | null>(null);
  const enviarImagem = async (
    e: React.ChangeEvent<HTMLInputElement>,
    campo: "photoUrl" | "cardImageUrl",
    mut: typeof uploadPhotoMut,
    ladoMaximo: number,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite escolher o mesmo arquivo de novo
    if (!file) return;
    if (!(TIPOS_DE_IMAGEM as readonly string[]).includes(file.type)) {
      toast.error(t("network.uploadFormatoNaoSuportado"));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t("network.uploadArquivoMuitoGrande"));
      return;
    }
    let imagem: ImagemParaEnviar;
    setPreparandoImagem(campo);
    try {
      imagem = await prepararImagemParaEnvio(file, ladoMaximo);
    } catch {
      toast.error(t("network.uploadErroLerArquivo"));
      return;
    } finally {
      setPreparandoImagem(null);
    }
    mut.mutate(
      { fileName: file.name, mimeType: imagem.mimeType, dataBase64: imagem.dataBase64 },
      {
        onSuccess: res => set(campo, res.url),
        onError: err => toast.error(err.message || t("network.uploadErroEnviarImagem")),
      },
    );
  };
  const toggleTag = (tag: string) => {
    set("profileTags", form.profileTags.includes(tag)
      ? form.profileTags.filter(t => t !== tag)
      : [...form.profileTags, tag]);
  };

  const STEPS = [
    t("network.formStepBasico"),
    t("network.formStepLocalizacao"),
    t("network.formStepDigital"),
    t("network.formStepCartao"),
  ];
  const NIVEIS_DE_VISIBILIDADE = getNiveisDeVisibilidade(t);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-[#211e1b] border border-white/15 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="font-bold text-white">{initial?.id ? t("network.formTituloEditar") : t("network.formTituloNovo")}</h2>
            <p className="text-xs text-white/40 mt-0.5">{t("network.formEtapaProgresso", { step, total: STEPS.length, etapa: STEPS[step - 1] })}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors p-1">
            <X size={18} />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-white/10">
          <div className="h-full bg-amber-500 transition-all duration-300" style={{ width: `${(step / STEPS.length) * 100}%` }} />
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {step === 1 && (
            <>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelNomeCompleto")}</label>
                <Input value={form.fullName} onChange={e => set("fullName", e.target.value)}
                  placeholder={t("network.placeholderNomeCompleto")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelCargo")}</label>
                <Input value={form.jobTitle} onChange={e => set("jobTitle", e.target.value)}
                  placeholder={t("network.placeholderCargo")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelEmpresa")}</label>
                <Input value={form.company} onChange={e => set("company", e.target.value)}
                  placeholder={t("network.placeholderEmpresa")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelPais")}</label>
                  <Input value={form.country} onChange={e => set("country", e.target.value)}
                    placeholder={t("network.placeholderPais")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
                <div>
                  <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelEstado")}</label>
                  <Input value={form.state} onChange={e => set("state", e.target.value)}
                    placeholder={t("network.placeholderEstado")}
                    className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
                </div>
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelCidade")}</label>
                <Input value={form.city} onChange={e => set("city", e.target.value)}
                  placeholder={t("network.placeholderCidade")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelTelefone")}</label>
                <Input value={form.phone} onChange={e => set("phone", e.target.value)}
                  placeholder={t("network.placeholderTelefone")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelWhatsapp")}</label>
                <Input value={form.whatsapp} onChange={e => set("whatsapp", e.target.value)}
                  placeholder={t("network.placeholderTelefone")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelEmail")}</label>
                <Input value={form.email} onChange={e => set("email", e.target.value)}
                  placeholder={t("network.placeholderEmail")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelLinkedin")}</label>
                <Input value={form.linkedinUrl} onChange={e => set("linkedinUrl", e.target.value)}
                  placeholder={t("network.placeholderLinkedin")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelInstagram")}</label>
                <Input value={form.instagram} onChange={e => set("instagram", e.target.value.replace(/^@/, ""))}
                  placeholder={t("network.placeholderInstagram")}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-3 block">{t("network.labelPerfilTags")}</label>
                <div className="flex flex-wrap gap-2">
                  {PROFILE_TAGS.map(tag => (
                    <TagChip key={tag} label={tagLabel(t, tag)} selected={form.profileTags.includes(tag)} onClick={() => toggleTag(tag)} />
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelFotoContato")}</label>
                  {form.photoUrl ? (
                    <div className="relative">
                      <img src={form.photoUrl} alt={t("network.altFotoContato")} className="w-full h-24 rounded-xl object-cover border border-white/10" />
                      <button type="button" onClick={() => set("photoUrl", "")}
                        className="absolute top-1 right-1 bg-black/70 rounded-full p-1 text-white/70 hover:text-white">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center h-24 rounded-xl border border-dashed border-white/15 bg-white/5 cursor-pointer hover:border-amber-500/40 text-white/40 text-xs gap-1">
                      {uploadPhotoMut.isPending || preparandoImagem === "photoUrl" ? t("network.enviandoImagem") : t("network.enviarFoto")}
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                        disabled={uploadPhotoMut.isPending || preparandoImagem === "photoUrl"}
                        onChange={e => void enviarImagem(e, "photoUrl", uploadPhotoMut, LADO_MAXIMO_FOTO_DE_CONTATO)} />
                    </label>
                  )}
                </div>
                <div>
                  <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.tituloCartaoVisita")}</label>
                  {form.cardImageUrl ? (
                    <div className="relative">
                      <img src={form.cardImageUrl} alt={t("network.altCartaoVisita")} className="w-full h-24 rounded-xl object-cover border border-white/10" />
                      <button type="button" onClick={() => set("cardImageUrl", "")}
                        className="absolute top-1 right-1 bg-black/70 rounded-full p-1 text-white/70 hover:text-white">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <label className="flex flex-col items-center justify-center h-24 rounded-xl border border-dashed border-white/15 bg-white/5 cursor-pointer hover:border-amber-500/40 text-white/40 text-xs gap-1">
                      {uploadCardMut.isPending || preparandoImagem === "cardImageUrl" ? t("network.enviandoImagem") : t("network.enviarCartao")}
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden"
                        disabled={uploadCardMut.isPending || preparandoImagem === "cardImageUrl"}
                        onChange={e => void enviarImagem(e, "cardImageUrl", uploadCardMut, LADO_MAXIMO_CARTAO_DE_VISITA)} />
                    </label>
                  )}
                </div>
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelNotas")}</label>
                <Textarea value={form.notes} onChange={e => set("notes", e.target.value)}
                  placeholder={t("network.placeholderNotas")}
                  rows={5}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/25 focus:border-amber-500/50 resize-none" />
              </div>
              <div>
                <label className="text-xs text-white/50 uppercase tracking-wider mb-1.5 block">{t("network.labelVisibilidade")}</label>
                <div className="space-y-2">
                  {NIVEIS_DE_VISIBILIDADE.map(nivel => (
                    <button key={nivel.valor} type="button"
                      onClick={() => set("nivelVisibilidade", nivel.valor)}
                      className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${form.nivelVisibilidade === nivel.valor ? "border-amber-500/60 bg-amber-500/10" : "border-white/10 bg-white/5 hover:border-white/25"}`}>
                      <span className={`text-sm font-semibold ${form.nivelVisibilidade === nivel.valor ? "text-amber-300" : "text-white/80"}`}>{nivel.rotulo}</span>
                      <span className="block text-xs text-white/40 mt-0.5">{nivel.descricao}</span>
                    </button>
                  ))}
                </div>
                {/* A autorização do acervo Ouro só faz sentido no instante em que
                    ela escolhe compartilhar: sem o termo aceito o contato some do
                    acervo sem explicação, porque o servidor reavalia o consentimento
                    a cada leitura. */}
                {form.nivelVisibilidade === "ouro" && <AutorizacaoAcervoOuro />}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 bg-white/2">
          <Button variant="ghost" onClick={step === 1 ? onClose : () => setStep(s => s - 1)}
            className="text-white/50 hover:text-white/80">
            {step === 1 ? t("network.cancelar") : t("network.voltar")}
          </Button>
          {step < STEPS.length ? (
            <Button onClick={() => setStep(s => s + 1)}
              disabled={step === 1 && !form.fullName.trim()}
              className="bg-amber-500 hover:bg-amber-400 text-[#151312] font-bold">
              {t("network.proximo")}
            </Button>
          ) : (
            <Button onClick={() => onSave(form)} disabled={loading || !form.fullName.trim()}
              className="bg-amber-500 hover:bg-amber-400 text-[#151312] font-bold">
              {loading ? t("network.salvando") : t("network.salvar")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Detalhe do contato ───────────────────────────────────────────────────────
function ContactDetail({ contact: contatoDaLista, onEdit, onClose }: {
  contact: Contact;
  /** Recebe o contato FRESCO (network.get), não o retrato da lista: é ele que o formulário de edição precisa abrir. */
  onEdit: (contato: Contact) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<"info" | "history">("info");

  // O contato da lista é um retrato de quando a lista foi carregada. O chat
  // de enriquecimento grava telefone, empresa etc. no servidor e invalida
  // network.get: lendo por aqui, o perfil aberto mostra o dado assim que ele
  // chega, sem fechar e reabrir. Até a primeira resposta, vale o retrato.
  const fresco = trpc.network.get.useQuery(
    { id: contatoDaLista.id },
    { refetchOnWindowFocus: false }
  );
  const contact: Contact = fresco.data ?? contatoDaLista;

  // Histórico de enriquecimento. Em erro, a aba não pode dizer "nenhum
  // enriquecimento ainda": o histórico existe, o servidor é que não respondeu.
  const { data: historyData, isError: historicoFalhou, error: erroDoHistorico, refetch: recarregarHistorico } = trpc.enrichment.getHistory.useQuery(
    { contactId: contact.id, limit: 30 },
    { refetchOnWindowFocus: false }
  );

  // Contextos em que este contato apareceu (onde e como se conheceram). Em
  // erro, a seção não some em silêncio — mostra o erro no lugar dela.
  const { data: contextosDoContato, isError: contextosFalharam, error: erroDosContextos, refetch: recarregarContextos } = trpc.contexts.listByContact.useQuery(
    { contactId: contact.id },
    { refetchOnWindowFocus: false }
  );

  // Possui / procura é dado da AGENDA: o chat grava sem termo de cruzamento e
  // a vitrine já o expõe, então ver e remover precisa morar aqui, e não só na
  // tela de Conexões Inteligentes (que fica inteira atrás do termo).
  const utils = trpc.useUtils();

  // Desfazer reverte no servidor o que a confirmação gravou (campo, tag,
  // nota); tudo que lê o contato precisa ser refeito depois.
  const undoMut = trpc.enrichment.undoSuggestion.useMutation({
    onSuccess: (r) => {
      toast.success(r.reverted ? t("network.toastDesfeito") : t("network.toastDesfeitoValorAlterado"));
      utils.enrichment.getHistory.invalidate({ contactId: contact.id });
      utils.network.get.invalidate({ id: contact.id });
      utils.network.list.invalidate();
      utils.network.assetsNeeds.invalidate({ contactId: contact.id });
    },
    onError: (e) => {
      // O servidor não achou a sugestão como aplicada: já tinha sido desfeita
      // (antes, ou por outra aba agora). A lista na tela está velha — o
      // histórico é refeito (o botão some) e o aviso diz o porquê, não "erro".
      if (e.data?.code === "NOT_FOUND") {
        toast.info(t("network.toastJaDesfeita"));
        utils.enrichment.getHistory.invalidate({ contactId: contact.id });
        return;
      }
      toast.error(t("network.erroDesfazer"));
    },
  });
  const {
    data: possuiProcura,
    isError: erroPossuiProcura,
    refetch: recarregarPossuiProcura,
  } = trpc.network.assetsNeeds.useQuery(
    { contactId: contact.id },
    { refetchOnWindowFocus: false }
  );
  const aoRemoverItem = {
    onSuccess: () => {
      toast.success(t("network.toastItemRemovido"));
      utils.network.assetsNeeds.invalidate({ contactId: contact.id });
    },
    onError: () => toast.error(t("network.erroRemoverItem")),
  };
  const removeAssetMut = trpc.network.removeAsset.useMutation(aoRemoverItem);
  const removeNeedMut = trpc.network.removeNeed.useMutation(aoRemoverItem);
  const removendoItem = removeAssetMut.isPending || removeNeedMut.isPending;

  // Meu Network Inteligente: o que falta neste contato (Quem Sou, O Que Tenho,
  // O Que Preciso), pela mesma régua do painel. Só com possui/procura lido: em
  // erro ou carregando não se sabe o que falta, e o alerta não afirma nada.
  const faltando = possuiProcura && !erroPossuiProcura
    ? camposFaltantes({
        fullName: contact.fullName, phone: contact.phone, whatsapp: contact.whatsapp, email: contact.email,
        totalTenho: possuiProcura.possui.length, totalPreciso: possuiProcura.procura.length,
      })
    : [];
  const chatDoContato = useRef<HTMLDivElement>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg bg-[#211e1b] border border-white/15 rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors flex items-center gap-1.5 text-sm">
            <ChevronLeft size={16} /> {t("network.minhaRede")}
          </button>
          {/* O formulário abre com o contato fresco: com o retrato da lista,
              "Editar" depois de o chat confirmar o telefone abria o campo
              vazio, e Salvar mandava phone: null por cima do dado confirmado. */}
          <Button size="sm" onClick={() => onEdit(contact)} variant="outline"
            className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10 bg-transparent">
            <Edit2 size={13} className="mr-1" /> {t("network.editar")}
          </Button>
        </div>

        {/* Abas */}
        <div className="flex border-b border-white/8">
          <button onClick={() => setActiveTab("info")}
            className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
              activeTab === "info" ? "text-amber-400 border-b-2 border-amber-400" : "text-white/40 hover:text-white/60"
            }`}>
            <User size={12} /> {t("network.abaPerfil")}
          </button>
          <button onClick={() => setActiveTab("history")}
            className={`flex-1 py-2.5 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
              activeTab === "history" ? "text-amber-400 border-b-2 border-amber-400" : "text-white/40 hover:text-white/60"
            }`}>
            <History size={12} /> {t("network.abaHistoricoIA")}
            {historyData && historyData.total > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs">{historyData.total}</span>
            )}
          </button>
        </div>

        {activeTab === "info" && (<>
        {/* Perfil */}
        <div className="px-6 pt-6 pb-4 flex items-start gap-4">
          <Avatar name={contact.fullName} photoUrl={contact.photoUrl} size={72} />
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold text-white">{contact.fullName}</h2>
            {contact.jobTitle && <p className="text-sm text-white/60 mt-0.5">{contact.jobTitle}{contact.company ? ` · ${contact.company}` : ""}</p>}
            {(contact.city || contact.country) && (
              <p className="flex items-center gap-1 text-xs text-white/40 mt-1">
                <MapPin size={11} />{[contact.city, contact.state, contact.country].filter(Boolean).join(", ")}
              </p>
            )}
            {/* Etapa 10: o nível também no detalhe — a lista e o formulário já mostram. */}
            <p className="text-xs mt-1.5">
              {contact.nivelVisibilidade === "ouro" && <span className="px-2 py-0.5 rounded-full bg-amber-400/10 border border-amber-300/40 text-amber-300">{t("network.detalheNivelOuro")}</span>}
              {contact.nivelVisibilidade === "publico" && <span className="px-2 py-0.5 rounded-full bg-sky-400/10 border border-sky-300/40 text-sky-300">{t("network.detalheNivelPublico")}</span>}
              {(!contact.nivelVisibilidade || contact.nivelVisibilidade === "privado") && <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/15 text-white/45">{t("network.detalheNivelPrivado")}</span>}
            </p>
            {contact.profileTags && contact.profileTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {contact.profileTags.map(tag => (
                  <span key={tag} className="px-2.5 py-0.5 rounded-full bg-amber-500/12 border border-amber-500/25 text-amber-400/90 text-xs font-medium">{tagLabel(t, tag)}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {faltando.length > 0 && (
          <AlertaDeCompletude
            faltando={faltando}
            aoCompletarPorTexto={() => chatDoContato.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          />
        )}

        {/* Meu Network Inteligente: ID anônimo, SIM/NÃO da rede global e o
            atalho para o perfil do contato, onde ficam as sugestões da IA, o
            completar por voz, as conexões e a memória de relacionamento. */}
        <Link href={`/meu-network-inteligente/contatos/${contact.id}`}
          className="mx-6 mb-4 block rounded-xl border border-[#c98f70]/25 bg-[#c98f70]/[0.06] p-4 transition-colors hover:border-[#c98f70]/45">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-[#efcba8]">{t("networkPanel.title")}</span>
            {contact.codigoAnonimo && <code className="font-mono text-xs font-bold text-[#efcba8]">{contact.codigoAnonimo}</code>}
          </span>
          <span className="mt-1 block text-xs text-white/60">
            {contact.disponivelRedeGlobal ? t("networkInteligente.detailLink.availableYes") : t("networkInteligente.detailLink.availableNo")}
          </span>
          <span className="mt-1 block text-sm font-semibold text-[#c98f70]">{t("networkInteligente.detailLink.open")} →</span>
        </Link>

        {/* Comunicação */}
        {(contact.phone || contact.whatsapp || contact.email) && (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Phone size={11} /> {t("network.tituloComunicacao")}</p>
            <div className="space-y-2">
              {contact.phone && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60">{t("network.labelTelefone")}</span>
                  <span className="text-sm text-white font-medium">{contact.phone}</span>
                </div>
              )}
              {contact.whatsapp && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60">{t("network.labelWhatsapp")}</span>
                  <a href={`https://wa.me/${contact.whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-green-400 font-medium flex items-center gap-1 hover:text-green-300">
                    {contact.whatsapp} <ExternalLink size={11} />
                  </a>
                </div>
              )}
              {contact.email && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60">{t("network.labelEmail")}</span>
                  <a href={`mailto:${contact.email}`}
                    className="text-sm text-amber-400 font-medium flex items-center gap-1 hover:text-amber-300">
                    {contact.email} <ExternalLink size={11} />
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Presença digital */}
        {(contact.linkedinUrl || contact.instagram) && (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Globe size={11} /> {t("network.tituloPresencaDigital")}</p>
            <div className="space-y-2">
              {contact.linkedinUrl && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60 flex items-center gap-1.5"><Linkedin size={13} /> {t("network.rotuloLinkedin")}</span>
                  <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-blue-400 font-medium flex items-center gap-1 hover:text-blue-300">
                    {t("network.abrirPerfil")} <ExternalLink size={11} />
                  </a>
                </div>
              )}
              {contact.instagram && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60 flex items-center gap-1.5"><Instagram size={13} /> {t("network.labelInstagram")}</span>
                  <a href={`https://instagram.com/${contact.instagram}`} target="_blank" rel="noopener noreferrer"
                    className="text-sm text-pink-400 font-medium flex items-center gap-1 hover:text-pink-300">
                    @{contact.instagram} <ExternalLink size={11} />
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cartão de visita */}
        {contact.cardImageUrl && (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><FileText size={11} /> {t("network.tituloCartaoVisita")}</p>
            <img src={contact.cardImageUrl} alt={t("network.altCartaoVisita")} className="w-full rounded-xl border border-white/10 object-contain max-h-48" />
          </div>
        )}

        {/* Contextos — onde e como se conheceram (etapa 5) */}
        {contextosFalharam ? (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Calendar size={11} /> {t("network.tituloContextos")}</p>
            <ErroDeConsulta erro={erroDosContextos} aoTentarDeNovo={() => recarregarContextos()} />
          </div>
        ) : contextosDoContato && contextosDoContato.length > 0 && (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Calendar size={11} /> {t("network.tituloContextos")}</p>
            <div className="space-y-2">
              {contextosDoContato.map(cc => (
                <div key={cc.linkId} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white/70 truncate">{cc.name}</span>
                  <span className="text-xs text-white/35 flex-shrink-0">
                    {[cc.typeName, cc.city ?? cc.country].filter(Boolean).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Possui / Procura — o que o chat de enriquecimento registrou; a dona
            remove aqui sem depender do termo do Smart Match. A consulta que
            FALHA (banco fora, sessão caída) diz isso e oferece tentar de novo:
            antes a seção sumia em silêncio, e "nada registrado" ou seção
            nenhuma é o que a dona leria antes de refazer de cabeça um dado
            que ainda existe. Mesmas chaves do ErrorBoundary. */}
        {(possuiProcura || erroPossuiProcura) && (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Tag size={11} /> {t("network.tituloPossuiProcura")}</p>
            {erroPossuiProcura || !possuiProcura ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-400/25 bg-red-500/8 px-3 py-2">
                <p className="text-xs text-red-200/80">{t("errorBoundary.title")}</p>
                <button
                  type="button"
                  onClick={() => recarregarPossuiProcura()}
                  className="text-xs font-medium text-amber-300 hover:text-amber-200 transition-colors"
                >
                  {t("errorBoundary.retryButton")}
                </button>
              </div>
            ) : possuiProcura.possui.length === 0 && possuiProcura.procura.length === 0 ? (
              <p className="text-xs text-white/35">{t("network.semPossuiProcura")}</p>
            ) : (
              <div className="space-y-3">
                {([
                  { rotulo: t("network.rotuloPossui"), itens: possuiProcura.possui, cor: "border-emerald-400/30 text-emerald-200/80", remover: (id: number) => removeAssetMut.mutate({ id }) },
                  { rotulo: t("network.rotuloProcura"), itens: possuiProcura.procura, cor: "border-sky-300/30 text-sky-200/80", remover: (id: number) => removeNeedMut.mutate({ id }) },
                ] as const).filter(grupo => grupo.itens.length > 0).map(grupo => (
                  <div key={grupo.rotulo}>
                    <p className="text-xs text-white/50 mb-1.5">{grupo.rotulo}</p>
                    <ul className="flex flex-wrap gap-2">
                      {grupo.itens.map(item => (
                        <li key={item.id} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${grupo.cor}`}>
                          {item.label}{item.category ? <span className="text-white/35"> · {item.category}</span> : null}
                          <button
                            type="button"
                            aria-label={t("intelligentMatches.removerAriaLabel", { label: item.label })}
                            title={t("intelligentMatches.removerTooltip")}
                            disabled={removendoItem}
                            onClick={() => grupo.remover(item.id)}
                            className="rounded-full p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"
                          >
                            <X size={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Notas */}
        {contact.notes && (
          <div className="px-6 py-4 border-t border-white/8">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5"><FileText size={11} /> {t("network.tituloNotas")}</p>
            <p className="text-sm text-white/70 whitespace-pre-wrap leading-relaxed">{contact.notes}</p>
          </div>
        )}

        {/* Rodapé */}
        <div className="px-6 py-3 border-t border-white/8 bg-white/2">
          <p className="text-xs text-white/25">
            {t("network.rodapeDatas", {
              criado: new Date(contact.createdAt).toLocaleDateString(i18n.language),
              atualizado: new Date(contact.updatedAt).toLocaleDateString(i18n.language),
            })}
          </p>
        </div>
        {/* Chat de Enriquecimento com IA — o "Completar por texto" do alerta rola até aqui */}
        <div ref={chatDoContato}>
          <EnrichmentChat contactId={contact.id} contactName={contact.fullName} />
        </div>
        </>)}

        {/* Aba Histórico IA */}
        {activeTab === "history" && (
          <div className="px-4 py-4">
            {historicoFalhou ? (
              <ErroDeConsulta erro={erroDoHistorico} aoTentarDeNovo={() => recarregarHistorico()} />
            ) : !historyData || historyData.data.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Sparkles size={36} className="text-white/15 mb-3" />
                <p className="text-sm text-white/40">{t("network.semHistoricoIA")}</p>
                <p className="text-xs text-white/25 mt-1">{t("network.dicaIniciarChat")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-white/35 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <History size={11} /> {t("network.totalAlteracoesIA", { total: historyData.total })}
                </p>
                {historyData.data.map((item: any) => {
                  const fieldLabels: Record<string, string> = {
                    phone: t("network.campoTelefoneIA"), whatsapp: t("network.campoWhatsappIA"), email: t("network.campoEmailIA"),
                    company: t("network.campoEmpresaIA"), job_title: t("network.campoCargoIA"), city: t("network.campoCidadeIA"),
                    country: t("network.campoPaisIA"), linkedin_url: t("network.campoLinkedinIA"), instagram_handle: t("network.campoInstagramIA"),
                    asset_tag: t("network.campoAtivoIA"), need_tag: t("network.campoNecessidadeIA"), context_link: t("network.campoContextoIA"),
                    relationship_type: t("network.campoRelacionamentoIA"),
                  };
                  const label = fieldLabels[item.fieldType] ?? item.fieldType;
                  const isUndone = item.status === "undone";
                  const isIgnored = item.status === "ignored";
                  return (
                    <div key={item.id} className={`p-3 rounded-xl border transition-colors ${
                      isUndone ? "bg-white/3 border-white/8 opacity-50" :
                      isIgnored ? "bg-white/3 border-white/8" :
                      "bg-white/5 border-white/10"
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-amber-400/80 font-medium">{label}</p>
                          <p className={`text-sm mt-0.5 ${isUndone ? "line-through text-white/30" : isIgnored ? "text-white/30 italic" : "text-white"}`}>
                            {isIgnored ? t("network.naoPreenchido") : (item.appliedValue ?? item.suggestedValue)}
                          </p>
                          <p className="text-xs text-white/25 mt-1">
                            {isIgnored ? t("network.statusIgnorado") :
                             isUndone ? t("network.statusDesfeito") :
                             item.status === "edited" ? t("network.statusEditado") :
                             t("network.statusConfirmado")}
                            {item.actionedAt && ` · ${new Date(item.actionedAt).toLocaleDateString(i18n.language)}`}
                          </p>
                        </div>
                        {!isIgnored && !isUndone && (
                          // Sugestão aplicada antes de existir o retrato do valor
                          // anterior não tem como voltar: o botão fica, desligado, e
                          // explica por quê.
                          <button className="flex-shrink-0 p-1.5 rounded-lg text-white/25 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:hover:text-white/25 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                            disabled={!item.podeDesfazer || undoMut.isPending}
                            onClick={() => undoMut.mutate({ suggestionId: item.id })}
                            title={item.podeDesfazer ? t("network.tituloDesfazer") : t("network.desfazerIndisponivel")}>
                            <RotateCcw size={12} />
                          </button>
                        )}
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

// ─── Página principal ─────────────────────────────────────────────────────────
export default function Network() {
  const { t } = useTranslation();
  const { user, isAuthenticated, loading: authLoading } = useAuth();
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [viewContact, setViewContact] = useState<Contact | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  // Atalho do painel Meu Network Inteligente: /network?contato=<id> abre o
  // detalhe daquele contato. A posse é do servidor (network.get filtra pela
  // dona): id de outra pessoa ou inexistente dá erro, e nada abre.
  const [contatoDoLink, setContatoDoLink] = useState<number | null>(() => {
    const id = Number(new URLSearchParams(window.location.search).get("contato"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  });
  const contatoLinkado = trpc.network.get.useQuery(
    { id: contatoDoLink ?? 0 },
    { enabled: isAuthenticated && contatoDoLink !== null, retry: false, refetchOnWindowFocus: false },
  );
  useEffect(() => {
    if (contatoDoLink === null || (!contatoLinkado.data && !contatoLinkado.isError)) return;
    if (contatoLinkado.data) setViewContact(contatoLinkado.data);
    else toast.error(t("networkPanel.contactNotFound"));
    setContatoDoLink(null);
    // Tira o ?contato= da barra: recarregar a página não reabre o detalhe.
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [contatoDoLink, contatoLinkado.data, contatoLinkado.isError, t]);

  // Debounce da busca
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = { current: null as ReturnType<typeof setTimeout> | null };
  const handleSearch = (v: string) => {
    setSearch(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setDebouncedSearch(v); setPage(1); }, 300) as ReturnType<typeof setTimeout>;
  };

  const { data, isLoading, isError, error, refetch, fetchStatus, isSuccess } = trpc.network.list.useQuery(
    { q: debouncedSearch || undefined, tag: filterTag || undefined, page, limit: 20 },
    { enabled: isAuthenticated }
  );

  // `data` sozinho não distingue a resposta que o servidor acabou de dar da
  // resposta VELHA que o React Query guardou para esta mesma página. Quando a
  // página 2 esvazia, a entrada [["network","list"],{page:2,limit:20}] fica no
  // cache com {data: [], total: 20} por até 5 minutos (main.tsx cria
  // `new QueryClient()`, gcTime padrão). Se a rede voltar a ter 21 contatos, o
  // primeiro "Próxima →" recebe esse total velho ANTES da resposta nova, o
  // clamp dispara e a tela volta sozinha para a página 1 — o clique some.
  //
  // A condição é `fetchStatus === "idle"`, e não `!isFetching`: o React Query
  // tem TRÊS estados de busca ("fetching", "paused", "idle"). Sem rede ele nem
  // tenta buscar e marca "paused" — `isFetching` é false, `isSuccess` continua
  // true com o dado velho no cache, e o clamp voltaria a agir sobre o total
  // velho. Só "idle" quer dizer que a consulta DESTA página já assentou: o
  // total é o que o servidor respondeu, para a página que está sendo pedida.
  const respostaFrescaDaPagina = isSuccess && fetchStatus === "idle";

  // Excluir o único contato da última página deixava a tela presa: a consulta
  // continuava pedindo a página 2, o servidor devolvia lista vazia com
  // total 20, e a paginação sumia (só aparece com total > 20) — "20 contato"
  // sobre "Sua rede está vazia", sem caminho de volta além de recarregar.
  // Quando o total cai abaixo da página atual, volta para a última que existe.
  useEffect(() => {
    if (data && respostaFrescaDaPagina && page > 1 && page > Math.max(1, Math.ceil(data.total / 20))) {
      setPage(Math.max(1, Math.ceil(data.total / 20)));
    }
  }, [data, respostaFrescaDaPagina, page]);

  const createMut = trpc.network.create.useMutation({
    onSuccess: (data) => {
      toast.success(t("network.toastContatoAdicionado"));
      setShowForm(false);
      refetch();
      // Iniciar enriquecimento automaticamente
      if (data?.id) {
        startEnrichMut.mutate({ contactId: data.id });
      }
    },
    onError: (e) => toast.error(t("network.toastErroSalvar") + e.message),
  });
  const startEnrichMut = trpc.enrichment.startSession.useMutation({
    onSuccess: () => {
      toast.success(t("network.toastEnriquecimentoIniciado"), { duration: 4000 });
      refetch();
    },
    onError: () => { /* silencioso — pode já existir sessão */ },
  });
  const updateMut = trpc.network.update.useMutation({
    // setShowForm(false) é obrigatório: os dois caminhos de edição ligam
    // showForm, e o modal renderiza com (showForm || editContact). Só zerar
    // editContact deixava o formulário aberto como "Novo Contato" com os
    // dados recém-editados — e o 2º Salvar criava uma duplicata que
    // compartilhava a foto no bucket.
    //
    // Mas fechar sem olhar DE QUEM era o salvamento apagava trabalho alheio:
    // quem salva a Ana, fecha o modal e abre outro ("+ Novo", ou a edição de
    // outra pessoa) via esse formulário sumir — com o que já tinha digitado —
    // assim que a resposta atrasada da Ana chegava, sob o toast "Contato
    // atualizado!". `vars.id` diz de qual contato era o envio; só fecha se o
    // formulário aberto ainda for o dele. O aviso e o refetch da lista
    // continuam acontecendo sempre: o salvamento aconteceu de verdade.
    onSuccess: (_dados, vars) => {
      toast.success(t("network.toastContatoAtualizado"));
      if (editContact?.id === vars.id) { setShowForm(false); setEditContact(null); }
      refetch();
    },
    onError: (e) => toast.error(t("network.toastErroAtualizar") + e.message),
  });
  const deleteMut = trpc.network.delete.useMutation({
    onSuccess: () => { toast.success(t("network.toastContatoRemovido")); setDeleteId(null); refetch(); },
    onError: (e) => toast.error(t("network.toastErroExcluir") + e.message),
  });

  const handleSave = (form: ReturnType<typeof emptyForm>) => {
    const payload = {
      fullName:    form.fullName,
      photoUrl:    form.photoUrl || null,
      cardImageUrl: form.cardImageUrl || null,
      jobTitle:    form.jobTitle || null,
      company:     form.company  || null,
      country:     form.country  || null,
      state:       form.state    || null,
      city:        form.city     || null,
      phone:       form.phone    || null,
      whatsapp:    form.whatsapp || null,
      email:       form.email    || null,
      linkedinUrl: form.linkedinUrl || null,
      instagram:   form.instagram   || null,
      profileTags: form.profileTags.length > 0 ? form.profileTags : null,
      notes:       form.notes    || null,
      nivelVisibilidade: form.nivelVisibilidade,
    };
    if (editContact) {
      updateMut.mutate({ id: editContact.id, ...payload });
    } else {
      createMut.mutate(payload);
    }
  };

  if (authLoading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#151312]">
      <div className="w-8 h-8 border-2 border-amber-500/40 border-t-amber-500 rounded-full animate-spin" />
    </div>
  );

  if (!isAuthenticated) return (
    <div className="min-h-screen flex items-center justify-center bg-[#151312] p-6">
      <div className="text-center">
        <Lock size={40} className="text-amber-500/60 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">{t("network.areaRestrita")}</h2>
        <p className="text-white/50 mb-6">{t("network.mensagemLogin")}</p>
        <a href={getLoginUrl()} className="px-6 py-3 bg-amber-500 text-[#151312] font-bold rounded-xl hover:bg-amber-400 transition-colors">
          {t("network.botaoEntrar")}
        </a>
      </div>
    </div>
  );

  const contacts: Contact[] = data?.data ?? [];
  const total = data?.total ?? 0;
  // Nunca menor que a página aberta: quando o clamp está parado (sem rede,
  // erro, resposta velha), `total` pode ser o de antes e o denominador ficaria
  // atrás do numerador.
  const totalDePaginas = Math.max(page, Math.ceil(total / 20));

  return (
    <div className="min-h-screen bg-[#151312] text-white">
      {/* Header */}
      <div className="sticky top-16 z-10 bg-[#151312]/95 backdrop-blur-sm border-b border-white/8 px-4 sm:px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-white/40 hover:text-white/70 transition-colors">
              <ChevronLeft size={20} />
            </Link>
            <div>
              <h1 className="font-bold text-white text-lg leading-tight">{t("network.minhaRede")}</h1>
              <p className="text-xs text-white/35 flex items-center gap-1">
                <Shield size={10} /> {t("network.privadoCriptografado")}
              </p>
            </div>
          </div>
          <Button onClick={() => { setEditContact(null); setShowForm(true); }}
            className="bg-amber-500 hover:bg-amber-400 text-[#151312] font-bold gap-1.5">
            <Plus size={16} /> {t("network.botaoNovo")}
          </Button>
        </div>
      </div>

      {/* max-w-6xl é a largura padrão das telas de app (Oportunidades, Reuniões,
          Conexões Inteligentes, Painel da Presidente). Esta tela estava presa em
          max-w-2xl (672px) e aparecia como uma coluna de celular no meio de um
          monitor largo — relatado pela cliente em 13/09/2026. */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 space-y-4">
        {/* Busca */}
        <div className="relative">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30" />
          <Input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder={t("network.placeholderBusca")}
            className="pl-10 bg-white/5 border-white/10 text-white placeholder:text-white/30 focus:border-amber-500/50" />
          {search && (
            <button onClick={() => { setSearch(""); setDebouncedSearch(""); setPage(1); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Filtros por tag */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          <button onClick={() => { setFilterTag(""); setPage(1); }}
            className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-all ${
              !filterTag ? "bg-amber-500 border-amber-500 text-[#151312] font-bold" : "bg-white/5 border-white/20 text-white/60 hover:border-white/40"
            }`}>
            {t("network.filtroTodos")}
          </button>
          {PROFILE_TAGS.map(tag => (
            <button key={tag} onClick={() => { setFilterTag(tag === filterTag ? "" : tag); setPage(1); }}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                filterTag === tag ? "bg-amber-500 border-amber-500 text-[#151312] font-bold" : "bg-white/5 border-white/20 text-white/60 hover:border-white/40"
              }`}>
              {tagLabel(t, tag)}
            </button>
          ))}
        </div>

        {/* Contador — some em erro: "0 contatos" afirmaria um número que
            ninguém consultou. */}
        {!isLoading && !isError && (
          <p className="text-xs text-white/30">
            {total === 0
              ? t("network.contadorZero")
              : (debouncedSearch || filterTag)
                ? t("network.contadorContatosEncontrados", { count: total })
                : t("network.contadorContatos", { count: total })}
          </p>
        )}

        {/* Lista */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-2xl bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : isError ? (
          // Consulta falhou (banco fora do ar, 429, 500) não é rede vazia:
          // o convite para "adicionar o primeiro contato" gerava duplicatas
          // quando o banco voltava.
          <ErroDeConsulta erro={error} aoTentarDeNovo={() => refetch()} />
        ) : contacts.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-4">
              <User size={28} className="text-amber-500/50" />
            </div>
            <h3 className="text-white/60 font-medium mb-1">
              {debouncedSearch || filterTag ? t("network.contadorZero") : t("network.redeVazia")}
            </h3>
            <p className="text-white/30 text-sm mb-6">
              {debouncedSearch || filterTag
                ? t("network.dicaSemResultado")
                : t("network.dicaRedeVazia")}
            </p>
            {!debouncedSearch && !filterTag && (
              <Button onClick={() => setShowForm(true)}
                className="bg-amber-500 hover:bg-amber-400 text-[#151312] font-bold gap-1.5">
                <Plus size={16} /> {t("network.botaoAdicionarContato")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {contacts.map(c => (
              <ContactCard key={c.id} contact={c}
                onView={() => setViewContact(c)}
                onEdit={() => { setEditContact(c); setShowForm(true); }}
                onDelete={() => setDeleteId(c.id)}
              />
            ))}
          </div>
        )}

        {/* Paginação — aparece também com `page > 1`, e não só com
            `total > 20`: fora da página 1 a saída não pode depender do clamp.
            O clamp só age sobre resposta fresca, então em qualquer estado em
            que ele fique parado (sem rede, consulta em erro, resposta velha do
            cache) a tela ficaria numa página vazia sem "← Anterior" — o beco
            sem saída que este bloco existe para não deixar acontecer. Na
            página 1 vazia continua não havendo paginação. */}
        {(total > 20 || page > 1) && (
          <div className="flex items-center justify-center gap-3 pt-4">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}
              className="border-white/15 text-white/60 bg-transparent hover:bg-white/8">
              {t("network.paginaAnterior")}
            </Button>
            {/* "Página 2 de 1" não existe: fora da página 1, o denominador
                nunca é menor que a página aberta. */}
            <span className="text-xs text-white/40">{t("network.paginaContador", { page, total: totalDePaginas })}</span>
            <Button variant="outline" size="sm" disabled={page >= totalDePaginas} onClick={() => setPage(p => p + 1)}
              className="border-white/15 text-white/60 bg-transparent hover:bg-white/8">
              {t("network.paginaProxima")}
            </Button>
          </div>
        )}
      </div>

      {/* Modais */}
      {(showForm || editContact) && (
        // A key força instância nova ao trocar de contato (ou entre editar e
        // novo): o formulário só lê `initial` na montagem, então a mesma
        // instância reaproveitada carregava os campos de outro contato.
        <ContactForm
          key={editContact?.id ?? "novo"}
          initial={editContact ?? undefined}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditContact(null); }}
          loading={createMut.isPending || updateMut.isPending}
        />
      )}

      {viewContact && (
        <ContactDetail
          contact={viewContact}
          // `viewContact` é o retrato de quando a lista foi clicada; o detalhe
          // entrega o contato fresco que ele mesmo leu do servidor.
          onEdit={(fresco) => { setEditContact(fresco); setViewContact(null); setShowForm(true); }}
          onClose={() => setViewContact(null)}
        />
      )}

      {/* Confirmação de exclusão */}
      {deleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-[#211e1b] border border-white/15 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <h3 className="font-bold text-white mb-2">{t("network.confirmarExclusaoTitulo")}</h3>
            <p className="text-sm text-white/50 mb-6">{t("network.confirmarExclusaoTexto")}</p>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setDeleteId(null)} className="flex-1 border-white/15 text-white/60 bg-transparent hover:bg-white/8">
                {t("network.cancelar")}
              </Button>
              <Button onClick={() => deleteMut.mutate({ id: deleteId! })} disabled={deleteMut.isPending}
                className="flex-1 bg-red-500 hover:bg-red-400 text-white font-bold">
                {deleteMut.isPending ? t("network.excluindo") : t("network.excluir")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
