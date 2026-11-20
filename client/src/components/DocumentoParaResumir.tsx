import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Camera, CircleAlert, FileText, Images, Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { ocupar } from "@/lib/sessao-ocupada";
import { enviarDocumento } from "@/lib/envio-do-documento";
import { FotoIlegivel, fotosParaPdf } from "@/lib/pdf-de-fotos";
import { mensagemDaRecusaDoDocumento, traduzirMensagemDoServidor } from "@/lib/mensagem-de-erro";
import { DOCUMENTO_BYTES_MAX, FOTOS_POR_DOCUMENTO_MAX, type OrigemDeDocumento } from "@shared/documento-da-reuniao";
import { VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO } from "@shared/aviso-do-documento";
import type { IdiomaDaReuniao } from "@shared/idioma-da-reuniao";

/**
 * O resumo de um documento, no gravador (H12 e H12b do desenho do gravador):
 * um PDF, ou as fotos de um texto (no celular, pela câmera; no computador, por
 * arquivo), que o aparelho junta num PDF, uma página por foto
 * (lib/pdf-de-fotos.ts). O título e o idioma são os do gravador; o aviso e a
 * autorização são os do documento, com a versão que vai gravada na reunião
 * (shared/aviso-do-documento.ts), como o aviso de gravação na G4.
 *
 * O envio: a reunião nasce (meetings.iniciarDocumento), o PDF vai cru pela rota
 * binária (lib/envio-do-documento.ts) e a tela vai ao detalhe, onde a leitura
 * em segundo plano aparece como "lendo o documento". Recusado o arquivo, a
 * reunião que nasceu para ele é excluída, para não ficar "recebendo" na lista;
 * só a queda de rede no meio a deixa, porque o servidor pode ter recebido.
 */

type Foto = { id: string; arquivo: File; url: string };

const MB = 1_000_000;

/** Começa por "%PDF-" nos primeiros 1024 bytes, como o servidor confere. */
async function pareceUmPdf(arquivo: Blob) {
  const inicio = new Uint8Array(await arquivo.slice(0, 1024).arrayBuffer());
  const assinatura = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i + assinatura.length <= inicio.length; i++) {
    if (assinatura.every((byte, j) => inicio[i + j] === byte)) return true;
  }
  return false;
}

export function DocumentoParaResumir(props: {
  titulo: string;
  idioma: IdiomaDaReuniao;
  /** O aviso do título (vazio, curto ou longo), ou null quando ele serve. */
  validarTitulo: () => string | null;
  /** Ocupado enquanto prepara e envia: o gravador trava o título e o idioma. */
  aoMudarOcupado: (ocupado: boolean) => void;
  aoEnviar: (meetingId: string) => void;
  aoVoltar: () => void;
}) {
  const { t, i18n } = useTranslation();
  const utils = trpc.useUtils();
  const iniciarDocumento = trpc.meetings.iniciarDocumento.useMutation();
  const [origem, setOrigem] = useState<OrigemDeDocumento>("pdf");
  const [pdf, setPdf] = useState<File | null>(null);
  const [fotos, setFotos] = useState<Foto[]>([]);
  const [autorizado, setAutorizado] = useState(false);
  const [fase, setFase] = useState<"parada" | "preparando" | "enviando">("parada");
  const [prontas, setProntas] = useState(0);
  const [erro, setErro] = useState<string | null>(null);
  const entradaDoPdf = useRef<HTMLInputElement | null>(null);
  const entradaDaCamera = useRef<HTMLInputElement | null>(null);
  const entradaDasFotos = useRef<HTMLInputElement | null>(null);
  const ocupado = fase !== "parada";

  // As miniaturas são URLs do próprio aparelho: saem da memória ao tirar a foto e ao sair da tela.
  const fotosNaTela = useRef<Foto[]>([]);
  fotosNaTela.current = fotos;
  useEffect(() => () => { for (const foto of fotosNaTela.current) URL.revokeObjectURL(foto.url); }, []);

  function escolherPdf(arquivo: File | undefined) {
    setErro(null);
    if (!arquivo) return;
    if (arquivo.type && arquivo.type !== "application/pdf" && !/\.pdf$/i.test(arquivo.name)) return setErro(t("meetings.document.errorNotPdf"));
    if (arquivo.size > DOCUMENTO_BYTES_MAX) return setErro(t("meetings.document.errorTooLarge", { mb: DOCUMENTO_BYTES_MAX / MB }));
    setPdf(arquivo);
  }

  function acrescentarFotos(lista: FileList | null) {
    setErro(null);
    const novas = Array.from(lista ?? []).filter(arquivo => !arquivo.type || arquivo.type.startsWith("image/"));
    if (!novas.length) return;
    const cabem = Math.max(0, FOTOS_POR_DOCUMENTO_MAX - fotos.length);
    if (novas.length > cabem) setErro(t("meetings.document.photosLimit", { quantidade: FOTOS_POR_DOCUMENTO_MAX }));
    setFotos(atuais => [...atuais, ...novas.slice(0, cabem).map(arquivo => ({ id: crypto.randomUUID(), arquivo, url: URL.createObjectURL(arquivo) }))]);
  }

  function tirarFoto(id: string) {
    setFotos(atuais => {
      const saindo = atuais.find(foto => foto.id === id);
      if (saindo) URL.revokeObjectURL(saindo.url);
      return atuais.filter(foto => foto.id !== id);
    });
  }

  const temArquivo = origem === "pdf" ? pdf !== null : fotos.length > 0;

  async function enviar() {
    setErro(null);
    const avisoDoTitulo = props.validarTitulo();
    if (avisoDoTitulo) return setErro(avisoDoTitulo);
    if (!autorizado) return setErro(t("meetings.document.consentRequired"));
    if (!temArquivo) return setErro(origem === "pdf" ? t("meetings.document.choosePdfFirst") : t("meetings.document.takePhotoFirst"));
    // Até o fim do envio a sessão fica ocupada: sair da conta ou fechar a aba pede confirmação.
    const liberar = ocupar("enviando");
    props.aoMudarOcupado(true);
    try {
      let arquivo: Blob;
      if (origem === "pdf" && pdf) {
        if (!(await pareceUmPdf(pdf))) return setErro(t("meetings.document.errorNotPdf"));
        arquivo = pdf;
      } else {
        setProntas(0);
        setFase("preparando");
        arquivo = await fotosParaPdf(fotos.map(foto => foto.arquivo), { aoAvancar: setProntas });
        if (arquivo.size > DOCUMENTO_BYTES_MAX) return setErro(t("meetings.document.photosTooLarge", { mb: DOCUMENTO_BYTES_MAX / MB }));
      }
      setFase("enviando");
      const { id } = await iniciarDocumento.mutateAsync({
        title: props.titulo.trim(), language: props.idioma, consentGranted: true,
        consentNoticeVersion: VERSAO_VIGENTE_DO_AVISO_DO_DOCUMENTO, origem,
      });
      // A queda de rede ganha uma segunda tentativa: o mesmo arquivo de novo é
      // reconhecido pelo servidor e não duplica nada.
      let resultado = await enviarDocumento(id, arquivo);
      if (resultado.tipo === "recusado" && resultado.codigo === "REDE") resultado = await enviarDocumento(id, arquivo);
      if (resultado.tipo === "recebido") {
        void utils.meetings.list.invalidate();
        for (const foto of fotos) URL.revokeObjectURL(foto.url);
        setFotos([]);
        setPdf(null);
        setAutorizado(false);
        toast.success(t("meetings.document.sent"));
        props.aoEnviar(id);
        return;
      }
      if (resultado.codigo === "REDE") {
        // O servidor pode ter recebido: a reunião fica, e a lista diz como ela está.
        void utils.meetings.list.invalidate();
        return setErro(t("meetings.document.errorConnection"));
      }
      // Recusa: a reunião que nasceu para este arquivo sai, sem esperar.
      void utils.client.meetings.delete.mutate({ meetingId: id }).catch(() => {}).finally(() => { void utils.meetings.list.invalidate(); });
      setErro(mensagemDaRecusaDoDocumento(resultado.codigo, t));
    } catch (falha) {
      if (falha instanceof FotoIlegivel) setErro(t("meetings.document.photoUnreadable", { numero: falha.posicao + 1 }));
      else setErro((falha instanceof Error && traduzirMensagemDoServidor(falha.message, t)) || t("meetings.document.errorTryAgain"));
    } finally {
      setFase("parada");
      props.aoMudarOcupado(false);
      liberar();
    }
  }

  const botaoDaOrigem = (valor: OrigemDeDocumento, rotulo: string, Icone: typeof FileText) => (
    <button type="button" aria-pressed={origem === valor} disabled={ocupado} onClick={() => { setOrigem(valor); setErro(null); }}
      className={`flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-50 ${origem === valor ? "bg-[#c98f70] font-bold text-[#1a120c]" : "text-white/70 hover:bg-white/5"}`}>
      <Icone size={16}/> {rotulo}
    </button>
  );

  return <div className="space-y-5">
    <button type="button" disabled={ocupado} onClick={props.aoVoltar} className="inline-flex items-center gap-2 text-sm text-white/55 hover:text-white disabled:opacity-40"><ArrowLeft size={16} className="rtl:rotate-180"/> {t("meetings.document.backToRecording")}</button>
    <div>
      <h2 className="text-lg font-semibold">{t("meetings.document.heading")}</h2>
      <p className="mt-1 text-sm text-white/55">{t("meetings.document.intro")}</p>
    </div>
    <div role="group" aria-label={t("meetings.document.heading")} className="flex gap-1 rounded-xl border border-white/10 p-1">
      {botaoDaOrigem("pdf", t("meetings.document.pdfOption"), FileText)}
      {botaoDaOrigem("foto", t("meetings.document.photoOption"), Camera)}
    </div>

    <input ref={entradaDoPdf} type="file" accept="application/pdf,.pdf" className="hidden" data-testid="entrada-do-pdf"
      onChange={evento => { escolherPdf(evento.target.files?.[0]); evento.currentTarget.value = ""; }}/>
    <input ref={entradaDaCamera} type="file" accept="image/*" capture="environment" className="hidden" data-testid="entrada-da-camera"
      onChange={evento => { acrescentarFotos(evento.target.files); evento.currentTarget.value = ""; }}/>
    <input ref={entradaDasFotos} type="file" accept="image/*" multiple className="hidden" data-testid="entrada-das-fotos"
      onChange={evento => { acrescentarFotos(evento.target.files); evento.currentTarget.value = ""; }}/>

    {origem === "pdf" ? <div className="space-y-2">
      <button type="button" disabled={ocupado} onClick={() => entradaDoPdf.current?.click()} className="w-full rounded-xl border border-white/20 text-white/80 hover:bg-white/5 py-3 inline-flex justify-center items-center gap-2 text-sm disabled:opacity-40">
        <FileText size={17}/> {pdf ? t("meetings.document.changePdf") : t("meetings.document.choosePdf")}
      </button>
      {pdf && <p dir="auto" className="min-w-0 break-words text-sm text-white/70">{pdf.name} · {t("meetings.document.sizeMb", { mb: (pdf.size / MB).toLocaleString(i18n.language, { maximumFractionDigits: 1 }) })}</p>}
      <p className="text-xs text-white/40">{t("meetings.document.pdfLimit", { mb: DOCUMENTO_BYTES_MAX / MB })}</p>
    </div> : <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" disabled={ocupado || fotos.length >= FOTOS_POR_DOCUMENTO_MAX} onClick={() => entradaDaCamera.current?.click()} className="rounded-xl border border-white/20 text-white/80 hover:bg-white/5 py-3 inline-flex justify-center items-center gap-2 text-sm disabled:opacity-40"><Camera size={17}/> {t("meetings.document.takePhoto")}</button>
        <button type="button" disabled={ocupado || fotos.length >= FOTOS_POR_DOCUMENTO_MAX} onClick={() => entradaDasFotos.current?.click()} className="rounded-xl border border-white/20 text-white/80 hover:bg-white/5 py-3 inline-flex justify-center items-center gap-2 text-sm disabled:opacity-40"><Images size={17}/> {t("meetings.document.choosePhotos")}</button>
      </div>
      {fotos.length > 0 && <ol aria-label={t("meetings.document.photosListLabel")} className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {fotos.map((foto, posicao) => <li key={foto.id} className="relative overflow-hidden rounded-lg border border-white/10 bg-black/20">
          <img src={foto.url} alt={t("meetings.document.photoAlt", { numero: posicao + 1 })} className="aspect-[3/4] w-full object-cover"/>
          <span className="absolute bottom-1 start-1 rounded bg-black/70 px-1.5 text-xs text-white">{posicao + 1}</span>
          <button type="button" disabled={ocupado} onClick={() => tirarFoto(foto.id)} aria-label={t("meetings.document.removePhoto", { numero: posicao + 1 })} className="absolute top-1 end-1 rounded-full bg-black/70 p-1 text-white hover:bg-red-500 disabled:opacity-40"><X size={14}/></button>
        </li>)}
      </ol>}
      <p className="text-xs text-white/40">{t("meetings.document.photosHint", { quantidade: FOTOS_POR_DOCUMENTO_MAX })}</p>
    </div>}

    <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-100/80"><CircleAlert size={17} className="inline me-2"/>{t("meetings.document.notice")}</div>
    <label className="flex items-start gap-3 rounded-xl border border-white/10 p-4 cursor-pointer">
      <input type="checkbox" checked={autorizado} disabled={ocupado} onChange={evento => setAutorizado(evento.target.checked)} className="mt-1 accent-amber-400"/>
      <span className="text-sm text-white/70">{t("meetings.document.consentLabel")}</span>
    </label>

    {erro && <p role="alert" className="rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{erro}</p>}
    {ocupado
      ? <div role="status" className="w-full rounded-xl bg-white/8 py-4 text-center text-white/70"><Loader2 className="inline animate-spin me-2" size={17}/>
        {fase === "preparando" ? t("meetings.document.preparingPhotos", { prontas, total: fotos.length }) : t("meetings.document.sending")}
      </div>
      : <button type="button" onClick={enviar} disabled={!temArquivo || !autorizado} className="w-full rounded-xl bg-[#c98f70] text-[#1a120c] font-bold py-4 inline-flex justify-center items-center gap-2 disabled:opacity-50">
        <Send size={18} className="rtl:-scale-x-100"/> {t("meetings.document.sendButton")}
      </button>}
  </div>;
}
