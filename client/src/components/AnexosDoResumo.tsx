import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Camera, ImagePlus, Loader2, PenLine, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { mensagemDeErroParaTela } from "@/lib/mensagem-de-erro";
import { prepararImagemParaEnvio } from "@/lib/reduzir-imagem";
import { TelaDeDesenho } from "@/components/TelaDeDesenho";
import {
  ANEXOS_POR_REUNIAO_MAX, ehCodigoDaRecusaDoAnexo, LADO_MAXIMO_DO_ANEXO, RECUSAS_DOS_ANEXOS, type CodigoDaRecusaDoAnexo, type TipoDeAnexo,
} from "@shared/anexos-do-resumo";

/**
 * As fotos e os desenhos do resumo (H4g e H4h; HN-32 e HN-33 no app de
 * referência da cliente). No detalhe da dona (`meetingId`): anexar fotos
 * (tirar com a câmera ou escolher, várias de uma vez), desenhar à mão na tela
 * de desenho e tirar um anexo. No link aberto (`token`): só ver, pela rota do
 * link, que confere a senha (H23) a cada imagem.
 *
 * A foto é reduzida no aparelho antes de subir (client/src/lib/reduzir-imagem.ts,
 * a régua da #149, 1600 px no lado maior), o que também tira o EXIF com o GPS;
 * o servidor confere o conteúdo e tira o que sobrar. As imagens seguem a regra
 * dos arquivos da reunião (ficam até a dona tirá-las, excluir a reunião ou
 * encerrar a conta, desde 26/11/2026), e a tela diz isso (texto para a Cris).
 */

type TranslateFn = (chave: string, opcoes?: Record<string, unknown>) => string;

/** O aviso de cada recusa do servidor, pelo código (server/i18n-chaves-usadas.test.ts confere as chaves). */
const AVISO_POR_RECUSA: Record<CodigoDaRecusaDoAnexo, (t: TranslateFn) => string> = {
  [RECUSAS_DOS_ANEXOS.formato]: t => t("meetings.attachments.errorFormat"),
  [RECUSAS_DOS_ANEXOS.grandeDemais]: t => t("meetings.attachments.errorTooLarge"),
  [RECUSAS_DOS_ANEXOS.demais]: t => t("meetings.attachments.errorTooMany", { max: ANEXOS_POR_REUNIAO_MAX }),
  [RECUSAS_DOS_ANEXOS.naoEncontrado]: t => t("meetings.attachments.errorNotFound"),
  [RECUSAS_DOS_ANEXOS.muitosEnvios]: t => t("meetings.attachments.errorRateLimit"),
  [RECUSAS_DOS_ANEXOS.bucket]: t => t("meetings.attachments.errorStorage"),
};

export function avisoDaRecusaDoAnexo(erro: unknown, t: TranslateFn): string {
  const mensagem = (erro as { message?: unknown } | null)?.message;
  if (ehCodigoDaRecusaDoAnexo(mensagem)) return AVISO_POR_RECUSA[mensagem](t);
  const traduzida = mensagemDeErroParaTela(erro, t);
  return traduzida && traduzida !== mensagem ? traduzida : t("meetings.attachments.errorGeneric");
}

type PropsDaDona = { meetingId: string; comLinkAberto?: boolean; token?: undefined; aoPedirSenha?: undefined };
type PropsDoLink = { token: string; aoPedirSenha?: () => void; meetingId?: undefined; comLinkAberto?: undefined };

export function AnexosDoResumo(props: PropsDaDona | PropsDoLink) {
  return props.token !== undefined ? <AnexosDoLink token={props.token} aoPedirSenha={props.aoPedirSenha}/> : <AnexosDaDona meetingId={props.meetingId} comLinkAberto={props.comLinkAberto}/>;
}

type Imagem = { id: string; tipo: TipoDeAnexo; url: string };

function Grade({ imagens, aoTirar, tirando, aoFalharImagem }: { imagens: Imagem[]; aoTirar?: (id: string) => void; tirando?: string | null; aoFalharImagem?: () => void }) {
  const { t } = useTranslation();
  return <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
    {imagens.map((imagem, posicao) => {
      const rotulo = imagem.tipo === "drawing" ? t("meetings.attachments.drawingAlt", { n: posicao + 1 }) : t("meetings.attachments.photoAlt", { n: posicao + 1 });
      return <li key={imagem.id} className="relative overflow-hidden rounded-xl border border-white/10 bg-white/5">
        <a href={imagem.url} target="_blank" rel="noopener noreferrer" aria-label={t("meetings.attachments.openFull", { nome: rotulo })}>
          <img src={imagem.url} alt={rotulo} loading="lazy" onError={aoFalharImagem}
            className={`aspect-square w-full object-cover ${imagem.tipo === "drawing" ? "bg-white object-contain" : ""}`}/>
        </a>
        {aoTirar && <button type="button" onClick={() => aoTirar(imagem.id)} disabled={tirando === imagem.id}
          aria-label={t("meetings.attachments.remove", { nome: rotulo })}
          className="absolute end-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/65 text-white hover:bg-black/80 disabled:opacity-60">
          {tirando === imagem.id ? <Loader2 size={15} className="animate-spin"/> : <Trash2 size={15}/>}
        </button>}
      </li>;
    })}
  </ul>;
}

function AnexosDaDona({ meetingId, comLinkAberto }: { meetingId: string; comLinkAberto?: boolean }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const consulta = trpc.meetings.anexos.useQuery({ meetingId });
  const anexar = trpc.meetings.anexarAoResumo.useMutation();
  const tirar = trpc.meetings.apagarAnexo.useMutation();
  const [enviando, setEnviando] = useState(0);
  const [tirando, setTirando] = useState<string | null>(null);
  const [desenhando, setDesenhando] = useState(false);
  const escolher = useRef<HTMLInputElement | null>(null);
  const camera = useRef<HTMLInputElement | null>(null);

  const anexos = consulta.data ?? [];
  const cheia = anexos.length + enviando >= ANEXOS_POR_REUNIAO_MAX;
  const atualizar = () => utils.meetings.anexos.invalidate({ meetingId });

  const subir = async (tipo: TipoDeAnexo, dataBase64: string) => {
    await anexar.mutateAsync({ meetingId, tipo, dataBase64 });
  };

  const enviarArquivos = async (arquivos: FileList | null) => {
    const lista = Array.from(arquivos ?? []);
    if (!lista.length) return;
    const vagas = Math.max(0, ANEXOS_POR_REUNIAO_MAX - anexos.length);
    if (lista.length > vagas) toast.error(t("meetings.attachments.errorTooMany", { max: ANEXOS_POR_REUNIAO_MAX }));
    const escolhidos = lista.slice(0, vagas);
    setEnviando(escolhidos.length);
    let subiram = 0;
    try {
      // Uma de cada vez: a redução usa o canvas, e o Safari do iPhone tem pouca memória para vários ao mesmo tempo.
      for (const arquivo of escolhidos) {
        try {
          // O que não é imagem nem chega a subir (o servidor recusaria pelo conteúdo).
          if (!arquivo.type.startsWith("image/")) { toast.error(t("meetings.attachments.errorFormat")); continue; }
          const imagem = await prepararImagemParaEnvio(arquivo, LADO_MAXIMO_DO_ANEXO);
          await subir("photo", imagem.dataBase64);
          subiram += 1;
        } catch (erro) {
          toast.error(avisoDaRecusaDoAnexo(erro, t));
        } finally {
          setEnviando(n => Math.max(0, n - 1));
        }
      }
    } finally {
      setEnviando(0);
      if (subiram) { await atualizar(); toast.success(t("meetings.attachments.added", { count: subiram })); }
    }
  };

  const guardarDesenho = async (dataUrl: string) => {
    try {
      await subir("drawing", dataUrl);
      await atualizar();
      toast.success(t("meetings.attachments.drawingSaved"));
    } catch (erro) {
      toast.error(avisoDaRecusaDoAnexo(erro, t));
      throw erro;
    }
  };

  const tirarAnexo = async (anexoId: string) => {
    if (!window.confirm(t("meetings.attachments.removeConfirm"))) return;
    setTirando(anexoId);
    try {
      await tirar.mutateAsync({ meetingId, anexoId });
      await atualizar();
    } catch (erro) {
      toast.error(avisoDaRecusaDoAnexo(erro, t));
    } finally {
      setTirando(null);
    }
  };

  return <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5" aria-labelledby="anexos-do-resumo">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="anexos-do-resumo" className="text-base font-semibold">{t("meetings.attachments.heading")} <span className="text-sm font-normal text-white/45">{anexos.length}/{ANEXOS_POR_REUNIAO_MAX}</span></h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => camera.current?.click()} disabled={cheia || enviando > 0}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"><Camera size={15}/>{t("meetings.attachments.takePhoto")}</button>
        <button type="button" onClick={() => escolher.current?.click()} disabled={cheia || enviando > 0}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"><ImagePlus size={15}/>{t("meetings.attachments.choosePhotos")}</button>
        <button type="button" onClick={() => setDesenhando(true)} disabled={cheia || enviando > 0}
          className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"><PenLine size={15}/>{t("meetings.attachments.draw")}</button>
      </div>
    </div>
    <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" data-testid="anexo-camera"
      onChange={evento => { void enviarArquivos(evento.target.files); evento.target.value = ""; }}/>
    <input ref={escolher} type="file" accept="image/jpeg,image/png,image/webp,image/*" multiple className="hidden" data-testid="anexo-escolher"
      onChange={evento => { void enviarArquivos(evento.target.files); evento.target.value = ""; }}/>
    {enviando > 0 && <p role="status" className="mt-3 text-sm text-amber-100/80"><Loader2 size={14} className="me-2 inline animate-spin"/>{t("meetings.attachments.uploading", { count: enviando })}</p>}
    {consulta.isLoading ? <p className="mt-3 text-sm text-white/45"><Loader2 size={14} className="me-2 inline animate-spin"/>{t("meetings.attachments.loading")}</p>
      : consulta.isError ? <p role="alert" className="mt-3 text-sm text-amber-200/80">{avisoDaRecusaDoAnexo(consulta.error, t)}</p>
      : anexos.length ? <Grade imagens={anexos} aoTirar={id => void tirarAnexo(id)} tirando={tirando}/>
      : <p className="mt-3 text-sm text-white/45">{t("meetings.attachments.empty")}</p>}
    {/* Textos de guarda e de compartilhamento: a Cris revisa. */}
    <p className="mt-4 text-xs text-white/45">{t("meetings.attachments.retention")}</p>
    {comLinkAberto && <p className="mt-1 text-xs text-amber-100/70">{t("meetings.attachments.linkNotice")}</p>}
    <TelaDeDesenho aberta={desenhando} aoFechar={() => setDesenhando(false)} aoGuardar={guardarDesenho}/>
  </section>;
}

function AnexosDoLink({ token, aoPedirSenha }: { token: string; aoPedirSenha?: () => void }) {
  const { t } = useTranslation();
  const consulta = trpc.reuniaoAberta.anexos.useQuery({ token }, {
    retry: (tentativas, erro) => (erro as { data?: { code?: string } } | null)?.data?.code === undefined && tentativas < 2,
    refetchOnWindowFocus: false,
  });
  const pediuSenha = useRef(false);
  const pedirSenha = () => {
    if (pediuSenha.current) return;
    pediuSenha.current = true;
    aoPedirSenha?.();
  };
  const pedeSenha = (consulta.error as { data?: { code?: string } } | null)?.data?.code === "UNAUTHORIZED";
  useEffect(() => { if (pedeSenha) pedirSenha(); }, [pedeSenha]);
  const anexos = consulta.data ?? [];
  // Sem anexo, a seção não aparece: o link de antes da H4g continua igual.
  if (!anexos.length) return null;
  return <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-5" aria-labelledby="anexos-do-link">
    <h2 id="anexos-do-link" className="text-base font-semibold">{t("meetings.attachments.heading")}</h2>
    {/* A imagem que não carrega pode ser a entrada do link com senha que venceu: a página relê e traz a senha. */}
    <Grade imagens={anexos} aoFalharImagem={pedirSenha}/>
  </section>;
}
