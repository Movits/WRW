import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { trpc } from "@/lib/trpc";
import { MENSAGEM_BANCO_INDISPONIVEL } from "@shared/const";
import { RECUSAS_DO_AUDIO, ROTA_DO_AUDIO_BAIXADO, VALIDADE_DO_ENDERECO_DO_AUDIO_MS } from "@shared/baixar-audio";
import { BaixarAudioDaReuniao, FOLGA_DO_ENDERECO_MS, tamanhoNaTela } from "./BaixarAudioDaReuniao";

/**
 * "Baixar o áudio" no detalhe da reunião (H8c). O React Query e os hooks do
 * tRPC são os de verdade; só a rede é um link falso, que responde com
 * `rede.resposta` (ou segura o pedido com `rede.segurar`). O toque no link de
 * salvar é observado no document, depois do React: o teste lê se a tela o
 * deixou seguir (o download) ou o parou, e só então o para, porque o jsdom não
 * navega. O que o servidor faz está em server/baixar-audio-*.test.ts e
 * server/rota-do-audio-baixado.test.ts.
 */

const ID = "8b1f6a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const FICHA = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const PREPARADO = {
  endereco: `${ROTA_DO_AUDIO_BAIXADO}/${FICHA}`,
  nomeDoArquivo: "Reunião importadora Santos - 2026-11-18.m4a",
  validadeMs: VALIDADE_DO_ENDERECO_DO_AUDIO_MS,
  tamanhoEstimadoBytes: 28_800_000,
};

type Resposta = typeof PREPARADO | Error;
const rede = {
  resposta: PREPARADO as Resposta,
  segurar: false,
  chamadas: [] as unknown[],
  pendentes: [] as Array<(resposta: Resposta) => void>,
};

function linkFalso(): TRPCLink<never> {
  return () => ({ op }) => observable(observer => {
    const responder = (resposta: Resposta) => {
      if (resposta instanceof Error) return observer.error(resposta instanceof TRPCClientError ? resposta : TRPCClientError.from(resposta));
      observer.next({ result: { type: "data", data: resposta } } as never);
      observer.complete();
    };
    if (op.path !== "meetings.baixarAudio") {
      responder(new Error(`rota não simulada: ${op.path}`));
      return () => undefined;
    }
    rede.chamadas.push(op.input);
    const resposta = rede.resposta;
    if (rede.segurar) rede.pendentes.push(responder);
    else void Promise.resolve().then(() => responder(resposta));
    return () => undefined;
  });
}

// Erro como o servidor devolve: o envelope tRPC traz data.code, e a mensagem é o código da recusa.
const erroDoServidor = (code: string, message: string) => TRPCClientError.from({ error: { code: -32000, message, data: { code, httpStatus: 400 } } });

// Cada toque num link: a tela o deixou seguir (o download) ou o parou?
const toques: Array<{ href: string | null; download: string | null; seguiu: boolean }> = [];
function observarToques(evento: MouseEvent) {
  const link = (evento.target as Element | null)?.closest?.("a");
  if (!link) return;
  toques.push({ href: link.getAttribute("href"), download: link.getAttribute("download"), seguiu: !evento.defaultPrevented });
  evento.preventDefault();
}

/**
 * O relógio do prazo do endereço na mão do teste: o setTimeout que a tela arma
 * com o prazo (validadeMs menos a folga) não corre sozinho, para o resultado não
 * depender da carga da máquina. O teste o dispara, ou confere que a tela o
 * desarmou. Os outros setTimeout (o React Query, a Testing Library) passam.
 */
const PRAZO_DO_TESTE_MS = 7_777;
const relogiosDoPrazo = new Map<number, { disparar: () => void; desarmado: boolean }>();
let soltarORelogio: (() => void) | null = null;
function segurarORelogioDoPrazo() {
  const armar = window.setTimeout.bind(window);
  const desarmar = window.clearTimeout.bind(window);
  let proximo = 900_000;
  const armado = vi.spyOn(window, "setTimeout").mockImplementation(((acao: () => void, ms?: number, ...resto: unknown[]) => {
    if (ms !== PRAZO_DO_TESTE_MS) return armar(acao, ms, ...resto);
    const id = proximo++;
    relogiosDoPrazo.set(id, { disparar: acao, desarmado: false });
    return id;
  }) as typeof window.setTimeout);
  const desarmado = vi.spyOn(window, "clearTimeout").mockImplementation(((id?: number) => {
    const relogio = id === undefined ? undefined : relogiosDoPrazo.get(id);
    if (relogio) relogio.desarmado = true;
    else desarmar(id);
  }) as typeof window.clearTimeout);
  // O projeto client zera os dublês antes de cada teste (mockReset), o que deixaria
  // o setTimeout mudo no teste seguinte: o afterEach devolve os originais.
  soltarORelogio = () => { armado.mockRestore(); desarmado.mockRestore(); };
}
const armados = () => Array.from(relogiosDoPrazo.values()).filter(relogio => !relogio.desarmado);

function abrir(props: { duracaoSegundos?: number } = {}) {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [linkFalso() as never] });
  return render(<trpc.Provider client={client} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <BaixarAudioDaReuniao meetingId={ID} duracaoSegundos={props.duracaoSegundos ?? 3600} nomeSugerido="Reunião: importadora / Santos - 2026-11-18"/>
    </QueryClientProvider>
  </trpc.Provider>);
}
const botaoDaPagina = () => screen.getByRole("button", { name: "Baixar o áudio" });
const dialogo = () => screen.getByRole("dialog", { name: "Baixar o áudio da reunião" });
const preparar = () => fireEvent.click(within(dialogo()).getByRole("button", { name: "Preparar o arquivo" }));
const linkDeSalvar = () => within(dialogo()).getByRole("link", { name: "Salvar o arquivo" });

beforeEach(() => {
  rede.resposta = PREPARADO;
  rede.segurar = false;
  rede.chamadas = [];
  rede.pendentes = [];
  toques.length = 0;
  relogiosDoPrazo.clear();
  document.addEventListener("click", observarToques);
});
afterEach(async () => {
  document.removeEventListener("click", observarToques);
  // A página sai antes de o idioma voltar (o afterEach do arquivo roda antes do cleanup do setup).
  cleanup();
  await act(async () => { await i18n.changeLanguage("pt-BR"); });
  soltarORelogio?.();
  soltarORelogio = null;
});

describe("Baixar o áudio — o aviso vem antes", () => {
  it("o botão abre o aviso, com os dois formatos (MP3 marcado) e o tamanho aproximado; nada é pedido ainda", () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    expect(dialogo()).toHaveAccessibleDescription(/O arquivo leva a gravação inteira desta reunião, com a voz de todas as pessoas que falaram\. Depois de baixado, ele fica fora da Marquesa Global Match e não é apagado quando você exclui a reunião ou a conta/);
    expect(within(dialogo()).getByRole("radio", { name: "MP3: toca em qualquer aparelho" })).toBeChecked();
    expect(within(dialogo()).getByRole("radio", { name: "M4A: o mesmo tamanho, com som um pouco melhor" })).not.toBeChecked();
    // Uma hora a 64 kbps: 28,8 MB.
    expect(dialogo()).toHaveTextContent("Tamanho aproximado: 29 MB.");
    expect(within(dialogo()).queryByRole("link")).not.toBeInTheDocument();
    expect(rede.chamadas).toEqual([]);
  });

  it("Cancelar (ou Esc) fecha sem pedir nada ao servidor, e o foco volta ao botão", () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(botaoDaPagina()).toHaveFocus();
    fireEvent.click(botaoDaPagina());
    fireEvent.keyDown(dialogo(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rede.chamadas).toEqual([]);
  });
});

describe("Baixar o áudio — preparar e salvar", () => {
  it("preparar pede o áudio desta reunião no formato escolhido, com o nome sugerido; o link leva ao endereço e ao nome que o servidor devolveu", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    fireEvent.click(within(dialogo()).getByRole("radio", { name: /^M4A/ }));
    preparar();
    const link = await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    expect(rede.chamadas).toEqual([{ meetingId: ID, formato: "m4a", nome: "Reunião: importadora / Santos - 2026-11-18" }]);
    expect(link).toHaveAttribute("href", `/api/reunioes/baixar-audio/${FICHA}`);
    expect(link).toHaveAttribute("download", "Reunião importadora Santos - 2026-11-18.m4a");
    expect(link).toHaveFocus();
    expect(dialogo()).toHaveTextContent("Pronto. Toque em “Salvar o arquivo” em até 2 min.");
    // Com o endereço na mão, o formato não muda mais: ele é o do arquivo preparado.
    expect(within(dialogo()).getByRole("radio", { name: /^M4A/ })).toBeDisabled();
    expect(within(dialogo()).getByRole("radio", { name: /^M4A/ })).toBeChecked();
    // Nenhuma chave nem URL do bucket chega à tela: só o endereço da ficha.
    expect(dialogo().innerHTML).not.toMatch(/meetings\/|manus-storage|X-Amz|backblaze/i);
  });

  it("o link serve uma vez: o primeiro toque segue (o download), o aviso diz que começou, e o segundo toque é parado", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    fireEvent.click(await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" }));
    expect(dialogo()).toHaveTextContent("O download começou.");
    expect(linkDeSalvar()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(linkDeSalvar());
    expect(toques).toEqual([
      { href: `/api/reunioes/baixar-audio/${FICHA}`, download: PREPARADO.nomeDoArquivo, seguiu: true },
      { href: `/api/reunioes/baixar-audio/${FICHA}`, download: PREPARADO.nomeDoArquivo, seguiu: false },
    ]);
    expect(rede.chamadas).toHaveLength(1);
  });

  it("sem o toque, o link sai antes de o endereço vencer, e 'Preparar de novo' pede outro (e o servidor audita de novo)", async () => {
    segurarORelogioDoPrazo();
    rede.resposta = { ...PREPARADO, validadeMs: FOLGA_DO_ENDERECO_MS + PRAZO_DO_TESTE_MS };
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    // Um relógio só, armado com o prazo do endereço menos a folga.
    expect(armados()).toHaveLength(1);
    act(() => armados()[0].disparar());
    expect(within(dialogo()).getByText("O prazo para salvar o arquivo passou. Prepare de novo.")).toBeInTheDocument();
    expect(within(dialogo()).queryByRole("link")).not.toBeInTheDocument();
    expect(within(dialogo()).getByRole("radio", { name: /^MP3/ })).toBeEnabled();
    rede.resposta = PREPARADO;
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Preparar de novo" }));
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    expect(rede.chamadas).toHaveLength(2);
    expect(toques).toEqual([]);
  });

  it("depois do toque, o relógio do prazo é desarmado: o aviso do download que já começou fica", async () => {
    segurarORelogioDoPrazo();
    rede.resposta = { ...PREPARADO, validadeMs: FOLGA_DO_ENDERECO_MS + PRAZO_DO_TESTE_MS };
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    const link = await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    expect(armados()).toHaveLength(1);
    fireEvent.click(link);
    expect(armados()).toEqual([]);
    expect(relogiosDoPrazo.size).toBe(1);
    expect(dialogo()).toHaveTextContent("O download começou.");
    expect(dialogo()).not.toHaveTextContent("O prazo para salvar o arquivo passou");
    expect(toques).toEqual([{ href: `/api/reunioes/baixar-audio/${FICHA}`, download: PREPARADO.nomeDoArquivo, seguiu: true }]);
  });

  it("enquanto o servidor prepara, o aviso diz 'Preparando' e os botões e os formatos esperam; Esc não fecha", async () => {
    rede.segurar = true;
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    expect(await within(dialogo()).findByText("Preparando o arquivo…")).toBeInTheDocument();
    expect(within(dialogo()).getByRole("button", { name: "Preparar o arquivo" })).toBeDisabled();
    expect(within(dialogo()).getByRole("button", { name: "Cancelar" })).toBeDisabled();
    expect(within(dialogo()).getByRole("radio", { name: /^M4A/ })).toBeDisabled();
    fireEvent.keyDown(dialogo(), { key: "Escape" });
    expect(dialogo()).toBeInTheDocument();
    await act(async () => { rede.pendentes[0](PREPARADO); });
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
  });

  // Conferência de tela do pacote 4b: com o arquivo preparado, os dois rádios
  // ficavam do mesmo cinza (o fieldset travado), e não se via o formato do
  // arquivo. O escolhido fica em destaque, com a marca; o outro se apaga.
  it("com o arquivo preparado, o formato escolhido fica em destaque e o outro se apaga; antes de preparar, os dois estão iguais", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    const rotuloDe = (nome: RegExp) => within(dialogo()).getByRole("radio", { name: nome }).closest("label")!;
    expect(rotuloDe(/^MP3/)).not.toHaveAttribute("data-escolhido");
    expect(rotuloDe(/^MP3/).className).toBe(rotuloDe(/^M4A/).className);
    fireEvent.click(within(dialogo()).getByRole("radio", { name: /^M4A/ }));
    preparar();
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    expect(rotuloDe(/^M4A/)).toHaveAttribute("data-escolhido");
    expect(rotuloDe(/^M4A/)).toHaveClass("font-semibold", "text-amber-100");
    expect(rotuloDe(/^M4A/).querySelector("svg")).not.toBeNull();
    expect(rotuloDe(/^MP3/)).not.toHaveAttribute("data-escolhido");
    expect(rotuloDe(/^MP3/)).toHaveClass("text-white/40");
    expect(rotuloDe(/^MP3/).querySelector("svg")).toBeNull();
  });

  // Conferência de tela do pacote 4b: o árabe dizia "خلال 2 دقيقة"; com 2 o
  // substantivo vai ao dual (دقيقتين), e de 3 a 10, ao plural (دقائق).
  it.each([
    // O endereço vale 2 min (VALIDADE_DO_ENDERECO_DO_AUDIO_MS): o caso da captura.
    [VALIDADE_DO_ENDERECO_DO_AUDIO_MS, "خلال دقيقتين.", "خلال 2 دقيقة"],
    [1 * 60_000, "خلال دقيقة واحدة.", "خلال 1 دقيقة"],
    [5 * 60_000, "خلال 5 دقائق.", "خلال 5 دقيقة"],
    [15 * 60_000, "خلال 15 دقيقة.", "خلال 15 دقائق"],
  ])("em árabe, o prazo de %i ms concorda com o número", async (validadeMs, certo, errado) => {
    await act(async () => { await i18n.changeLanguage("ar"); });
    rede.resposta = { ...PREPARADO, validadeMs };
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "تنزيل الصوت" }));
    const aviso = screen.getByRole("dialog", { name: "تنزيل صوت الاجتماع" });
    fireEvent.click(within(aviso).getByRole("button", { name: "تجهيز الملف" }));
    await within(aviso).findByRole("link", { name: "حفظ الملف" });
    expect(aviso).toHaveTextContent(certo);
    expect(aviso).not.toHaveTextContent(errado);
  });

  it("Fechar descarta o endereço: o próximo áudio é pedido de novo", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    fireEvent.click(within(dialogo()).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(botaoDaPagina()).toHaveFocus();
    fireEvent.click(botaoDaPagina());
    expect(within(dialogo()).queryByRole("link")).not.toBeInTheDocument();
    preparar();
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    expect(rede.chamadas).toHaveLength(2);
  });
});

describe("Baixar o áudio — as recusas, no idioma da tela, sem link", () => {
  it.each([
    ["o áudio que não está mais guardado", "PRECONDITION_FAILED", RECUSAS_DO_AUDIO.vencido, "O áudio desta reunião não está mais guardado e não pode ser baixado. A transcrição continua aqui."],
    ["a reunião sem áudio guardado", "PRECONDITION_FAILED", RECUSAS_DO_AUDIO.ausente, "Esta reunião não tem áudio guardado para baixar."],
    ["a gravação que ainda chega", "PRECONDITION_FAILED", RECUSAS_DO_AUDIO.aindaGravando, "A gravação ainda está chegando. Espere ela terminar para baixar o áudio."],
    ["o teto da dona", "TOO_MANY_REQUESTS", RECUSAS_DO_AUDIO.demais, "Muitos áudios baixados na última hora. Aguarde um pouco e tente de novo."],
    ["a instância ocupada", "TOO_MANY_REQUESTS", RECUSAS_DO_AUDIO.ocupado, "O servidor está preparando outros áudios agora. Tente de novo em alguns minutos."],
    ["o servidor sem o ffmpeg", "INTERNAL_SERVER_ERROR", RECUSAS_DO_AUDIO.indisponivel, "Baixar o áudio está indisponível no momento. Tente de novo mais tarde."],
    ["a reunião de outra conta (ou excluída)", "NOT_FOUND", "Reunião não encontrada.", "Reunião não encontrada. Ela pode ter sido excluída, ou o link é de outra conta."],
    ["o banco fora do ar", "INTERNAL_SERVER_ERROR", MENSAGEM_BANCO_INDISPONIVEL, MENSAGEM_BANCO_INDISPONIVEL],
    ["a frase que a tela não conhece (nunca o texto cru)", "PRECONDITION_FAILED", "Alguma frase do servidor em português.", "Não foi possível preparar o áudio. Tente de novo."],
    ["a validação da entrada", "BAD_REQUEST", "[{\"code\":\"invalid_enum_value\"}]", "Não foi possível preparar o áudio. Tente de novo."],
  ])("%s", async (_caso, codigo, mensagem, naTela) => {
    rede.resposta = erroDoServidor(codigo, mensagem);
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    expect(await within(dialogo()).findByRole("alert")).toHaveTextContent(naTela);
    expect(within(dialogo()).queryByRole("link")).not.toBeInTheDocument();
    expect(within(dialogo()).getByRole("button", { name: "Preparar o arquivo" })).toBeEnabled();
  });

  it("a rede fora (sem o envelope do servidor): o aviso genérico do áudio", async () => {
    rede.resposta = new Error("Failed to fetch");
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    expect(await within(dialogo()).findByRole("alert")).toHaveTextContent("Não foi possível preparar o áudio. Tente de novo.");
  });

  it("com a tela em inglês, o aviso e a recusa saem em inglês", async () => {
    await act(async () => { await i18n.changeLanguage("en"); });
    rede.resposta = erroDoServidor("PRECONDITION_FAILED", RECUSAS_DO_AUDIO.vencido);
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Download audio" }));
    const aviso = screen.getByRole("dialog", { name: "Download the meeting audio" });
    expect(aviso).toHaveTextContent("Approximate size: 29 MB.");
    fireEvent.click(within(aviso).getByRole("button", { name: "Prepare the file" }));
    expect(await within(aviso).findByRole("alert")).toHaveTextContent("This meeting's audio is no longer stored and cannot be downloaded.");
  });
});

describe("Baixar o áudio — no app instalado", () => {
  it("a dica de abrir no navegador aparece só no app instalado", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((consulta: string) => ({ matches: consulta === "(display-mode: standalone)", media: consulta, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    try {
      abrir();
      fireEvent.click(botaoDaPagina());
      preparar();
      await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
      expect(dialogo()).toHaveTextContent("No app instalado, se o download não começar, abra esta reunião no navegador e baixe o áudio por lá.");
    } finally {
      cleanup();
      window.matchMedia = original;
    }
  });

  it("no navegador, a dica não aparece", async () => {
    abrir();
    fireEvent.click(botaoDaPagina());
    preparar();
    await within(dialogo()).findByRole("link", { name: "Salvar o arquivo" });
    expect(dialogo()).not.toHaveTextContent("No app instalado");
  });
});

describe("tamanhoNaTela", () => {
  it("megabytes inteiros, no idioma da tela, nunca menos de 1", () => {
    expect(tamanhoNaTela(28_800_000, "pt-BR")).toBe("29 MB");
    expect(tamanhoNaTela(28_800_000, "en")).toBe("29 MB");
    expect(tamanhoNaTela(1_000, "pt-BR")).toBe("1 MB");
    expect(tamanhoNaTela(0, "pt-BR")).toBe("1 MB");
    // 12 h, o teto da gravação em partes: ~346 MB.
    expect(tamanhoNaTela(345_600_000, "de")).toBe("346 MB");
    expect(tamanhoNaTela(28_800_000, "ar")).not.toMatch(/NaN|undefined/);
  });
});
