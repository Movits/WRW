import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistenteDeTexto } from "./AssistenteDeTexto";
import { juntarTextoDitado } from "./BotaoDitarTexto";

/**
 * "Gravar áudio" e "Revisar texto" sob um campo livre.
 *
 * O que importa para a pessoa: o áudio vira texto NO CAMPO, somado ao que já
 * estava escrito, para ela revisar; a revisão é só sugestão, e o campo muda
 * apenas quando ela clica em "Usar texto revisado". Nada disso salva nada.
 */

const duble = vi.hoisted(() => ({
  revisar: null as null | ((vars: { texto: string }) => Promise<{ revisado: string; mudou: boolean }>),
  transcrever: null as null | ((vars: { audioBase64: string; mimeType: string; idioma?: string }) => Promise<{ texto: string }>),
  chamadas: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    assistenteTexto: {
      revisar: {
        useMutation: () => ({
          mutateAsync: (vars: { texto: string }) => { duble.chamadas.push(["revisar", vars]); return duble.revisar!(vars); },
          isPending: false,
        }),
      },
      transcrever: {
        useMutation: () => ({
          mutateAsync: (vars: { audioBase64: string; mimeType: string }) => { duble.chamadas.push(["transcrever", vars]); return duble.transcrever!(vars); },
          isPending: false,
        }),
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function Campo({ inicial = "" }: { inicial?: string }) {
  const [valor, setValor] = useState(inicial);
  return (
    <div>
      <textarea aria-label="campo" value={valor} onChange={e => setValor(e.target.value)} />
      <AssistenteDeTexto valor={valor} onChange={setValor} />
    </div>
  );
}

const campo = () => screen.getByLabelText("campo") as HTMLTextAreaElement;

beforeEach(() => {
  duble.chamadas.length = 0;
  duble.revisar = async () => ({ revisado: "Tenho uma loja de roupas há 10 anos.", mudou: true });
  duble.transcrever = async () => ({ texto: "Quero vender para outros estados." });
});

describe("Revisar texto", () => {
  it("mostra a sugestão e só troca o campo quando a pessoa aceita", async () => {
    render(<Campo inicial="tenho uma loja de roupas a 10 anos" />);
    fireEvent.click(screen.getByRole("button", { name: /Revisar texto/ }));

    const regiao = await screen.findByRole("region", { name: /Sugestão de revisão/ });
    expect(duble.chamadas).toEqual([["revisar", { texto: "tenho uma loja de roupas a 10 anos" }]]);
    // O que muda fica à vista: a palavra tirada riscada, a nova destacada.
    expect([...regiao.querySelectorAll("del")].map(el => el.textContent)).toEqual(["tenho", "a", "anos"]);
    expect([...regiao.querySelectorAll("ins")].map(el => el.textContent)).toEqual(["Tenho", "há", "anos."]);
    expect(campo().value).toBe("tenho uma loja de roupas a 10 anos");

    fireEvent.click(screen.getByRole("button", { name: /Usar texto revisado/ }));
    expect(campo().value).toBe("Tenho uma loja de roupas há 10 anos.");
    expect(screen.queryByRole("region", { name: /Sugestão de revisão/ })).not.toBeInTheDocument();
  });

  it("descartar mantém o texto da pessoa", async () => {
    render(<Campo inicial="tenho uma loja de roupas a 10 anos" />);
    fireEvent.click(screen.getByRole("button", { name: /Revisar texto/ }));
    await screen.findByRole("region", { name: /Sugestão de revisão/ });

    fireEvent.click(screen.getByRole("button", { name: /Descartar/ }));
    expect(campo().value).toBe("tenho uma loja de roupas a 10 anos");
    expect(screen.queryByRole("region", { name: /Sugestão de revisão/ })).not.toBeInTheDocument();
  });

  it("se ela editar o campo, a sugestão (do texto anterior) some", async () => {
    render(<Campo inicial="tenho uma loja de roupas a 10 anos" />);
    fireEvent.click(screen.getByRole("button", { name: /Revisar texto/ }));
    await screen.findByRole("region", { name: /Sugestão de revisão/ });

    fireEvent.change(campo(), { target: { value: "tenho uma loja de roupas a 12 anos" } });
    expect(screen.queryByRole("region", { name: /Sugestão de revisão/ })).not.toBeInTheDocument();
  });

  it("sem correção a fazer, avisa e não abre sugestão; texto vazio nem chega ao servidor", async () => {
    duble.revisar = async vars => ({ revisado: vars.texto, mudou: false });
    render(<Campo inicial="Sou arquiteta." />);
    fireEvent.click(screen.getByRole("button", { name: /Revisar texto/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Nenhuma correção necessária."));
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    fireEvent.change(campo(), { target: { value: " " } });
    duble.chamadas.length = 0;
    fireEvent.click(screen.getByRole("button", { name: /Revisar texto/ }));
    expect(duble.chamadas).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("Escreva algo antes de pedir a revisão.");
  });

  it("sugestão recusada pelo servidor: avisa e nada muda", async () => {
    duble.revisar = async () => { throw Object.assign(new Error("x"), { data: { code: "UNPROCESSABLE_CONTENT" } }); };
    render(<Campo inicial="sou consultora" />);
    fireEvent.click(screen.getByRole("button", { name: /Revisar texto/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "A sugestão mudava mais do que a escrita e foi descartada. Nada foi alterado.",
    ));
    expect(campo().value).toBe("sou consultora");
  });
});

describe("Gravar áudio", () => {
  const trilhaParada = vi.fn();

  class GravadorFalso {
    static isTypeSupported = (tipo: string) => tipo === "audio/webm;codecs=opus";
    mimeType: string;
    state: "inactive" | "recording" = "inactive";
    ondataavailable: ((evento: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    static criados: GravadorFalso[] = [];
    constructor(_fluxo: unknown, opcoes?: { mimeType?: string }) { this.mimeType = opcoes?.mimeType ?? ""; GravadorFalso.criados.push(this); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["som"], { type: "audio/webm;codecs=opus" }) });
      this.onstop?.();
    }
  }

  beforeEach(() => {
    GravadorFalso.criados = [];
    vi.stubGlobal("MediaRecorder", GravadorFalso);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: trilhaParada }] }) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("grava, transcreve e põe o texto no campo DEPOIS do que já estava escrito", async () => {
    render(<Campo inicial="Tenho uma loja de roupas." />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });

    const parar = await screen.findByRole("button", { name: /Parar e transcrever/ });
    await act(async () => { fireEvent.click(parar); });

    await waitFor(() => expect(campo().value).toBe("Tenho uma loja de roupas. Quero vender para outros estados."));
    const [nome, vars] = duble.chamadas[0] as [string, { audioBase64: string; mimeType: string; idioma: string }];
    expect(nome).toBe("transcrever");
    expect(vars.mimeType).toBe("audio/webm");
    expect(vars.audioBase64).toMatch(/^data:audio\/webm;codecs=opus;base64,/);
    expect(vars.idioma).toBe("pt-BR");
    expect(trilhaParada).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("O texto do áudio foi para o campo. Revise e edite antes de seguir.");
  });

  it("o navegador que grava mp4 manda mp4, o formato que o Gemini transcreve bem (#158)", async () => {
    vi.stubGlobal("MediaRecorder", class extends GravadorFalso {
      static isTypeSupported = (tipo: string) => tipo === "audio/mp4;codecs=mp4a.40.2" || tipo === "audio/webm;codecs=opus";
    });
    render(<Campo inicial="Oi." />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e transcrever/ })); });

    await waitFor(() => expect(campo().value).toBe("Oi. Quero vender para outros estados."));
    expect(GravadorFalso.criados[0].mimeType).toBe("audio/mp4;codecs=mp4a.40.2");
    const [, vars] = duble.chamadas[0] as [string, { audioBase64: string; mimeType: string }];
    expect(vars.mimeType).toBe("audio/mp4");
    expect(vars.audioBase64).toMatch(/^data:audio\/mp4;codecs=mp4a\.40\.2;base64,/);
  });

  it("navegador sem gravação: avisa e não chama o servidor", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    render(<Campo />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });
    expect(toast.error).toHaveBeenCalledWith("Este navegador não grava áudio. Digite o texto.");
    expect(duble.chamadas).toEqual([]);
  });

  it("falha na transcrição: avisa e o campo fica como estava", async () => {
    duble.transcrever = async () => { throw Object.assign(new Error("x"), { data: { code: "SERVICE_UNAVAILABLE" } }); };
    render(<Campo inicial="Texto meu." />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e transcrever/ })); });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Não foi possível transcrever o áudio. Tente de novo ou digite o texto."));
    expect(campo().value).toBe("Texto meu.");
  });

  /** O navegador demora a responder ao pedido de microfone: a resposta sai quando o teste mandar. */
  function microfoneQueDemora() {
    const pedidos: Array<(midia: unknown) => void> = [];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => new Promise(resolve => { pedidos.push(resolve); }) },
    });
    return pedidos;
  }
  const microfone = () => ({ getTracks: () => [{ stop: trilhaParada }] });

  it("duplo clique enquanto o navegador pede o microfone: um só pedido, um só gravador, e o microfone apaga ao parar", async () => {
    const pedidos = microfoneQueDemora();
    render(<Campo inicial="Oi." />);
    const gravar = screen.getByRole("button", { name: /Gravar áudio/ });
    fireEvent.click(gravar);
    fireEvent.click(gravar);
    expect(gravar).toBeDisabled();
    expect(pedidos).toHaveLength(1);

    await act(async () => { pedidos[0](microfone()); });
    expect(GravadorFalso.criados).toHaveLength(1);
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e transcrever/ })); });

    await waitFor(() => expect(campo().value).toBe("Oi. Quero vender para outros estados."));
    expect(trilhaParada).toHaveBeenCalledTimes(1);
    expect(duble.chamadas.filter(([nome]) => nome === "transcrever")).toHaveLength(1);
  });

  it("sair da tela enquanto o navegador pede o microfone: o microfone que chega depois é solto e nada grava", async () => {
    const pedidos = microfoneQueDemora();
    const { unmount } = render(<Campo />);
    fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ }));
    unmount();

    await act(async () => { pedidos[0](microfone()); });
    expect(trilhaParada).toHaveBeenCalledTimes(1);
    expect(GravadorFalso.criados).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("sair da tela GRAVANDO: solta o microfone e não manda nada ao servidor", async () => {
    const { unmount } = render(<Campo />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });
    await screen.findByRole("button", { name: /Parar e transcrever/ });
    unmount();

    expect(trilhaParada).toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(duble.chamadas).toEqual([]);
  });

  it("avançar de etapa durante o \"Transcrevendo…\" não perde o ditado: o texto chega ao campo mesmo assim", async () => {
    let responder: ((resposta: { texto: string }) => void) | undefined;
    duble.transcrever = () => new Promise(resolve => { responder = resolve; });
    function Etapas() {
      const [bio, setBio] = useState("Sou arquiteta.");
      const [etapa, setEtapa] = useState(1);
      return (
        <div>
          {etapa === 1 ? <AssistenteDeTexto valor={bio} onChange={novo => setBio(novo)} /> : <p>Etapa 2</p>}
          <button type="button" onClick={() => setEtapa(2)}>Continuar</button>
          <p data-testid="bio">{bio}</p>
        </div>
      );
    }
    render(<Etapas />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gravar áudio/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Parar e transcrever/ })); });
    await waitFor(() => expect(responder).toBeDefined());
    expect(screen.getByRole("button", { name: /Transcrevendo/ })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByText("Etapa 2")).toBeInTheDocument();
    await act(async () => { responder!({ texto: "Projeto casas de madeira." }); });

    await waitFor(() => expect(screen.getByTestId("bio")).toHaveTextContent("Sou arquiteta. Projeto casas de madeira."));
    expect(toast.success).toHaveBeenCalledWith("O texto do áudio foi para o campo. Revise e edite antes de seguir.");
  });
});

describe("juntarTextoDitado", () => {
  it("soma ao fim, ignora ditado vazio e não duplica espaços", () => {
    expect(juntarTextoDitado("", "  Olá.  ")).toBe("Olá.");
    expect(juntarTextoDitado("Primeira frase.   ", "Segunda.")).toBe("Primeira frase. Segunda.");
    expect(juntarTextoDitado("Fica igual", "   ")).toBe("Fica igual");
  });
});

/**
 * A janela D da revisão do Nicolas na #135: estes dois botões aparecem DENTRO
 * do cadastro, antes da etapa do Termo Geral de Uso. Quem grava a apresentação
 * na segunda etapa manda a própria voz para um serviço de IA antes de ter
 * aceitado termo nenhum — e até 16/09 a tela não dizia isso em lugar nenhum.
 */
describe("aviso de que o texto passa por IA", () => {
  it("aparece junto dos botões, sem depender de clicar em nada", () => {
    render(<AssistenteDeTexto valor="Sou arquiteta." onChange={() => {}} />);

    expect(screen.getByText(/servi[çc]o de intelig[êe]ncia artificial/i)).toBeInTheDocument();
  });

  it("diz que usar é opcional, porque os dois botões são opcionais", () => {
    render(<AssistenteDeTexto valor="" onChange={() => {}} />);

    expect(screen.getByText(/opcional/i)).toBeInTheDocument();
  });
});
