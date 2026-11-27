import { DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ehAcessoNegadoNoBucket, storageApagarTodasAsVersoes, storageListarChavesEscondidas } from "./storage";

/**
 * storageApagarTodasAsVersoes: o áudio de reunião sai do bucket de verdade
 * quando a dona exclui a reunião ou a conta (e na varredura do que ficou marcado).
 *
 * O B2 guarda versões: o DeleteObject sem VersionId só põe um marcador por
 * cima, o GET passa a dar 404 e a versão com a voz das participantes continua
 * guardada e cobrada. Sem bucket real: as variáveis STORAGE_* são falsas e o
 * `send` do cliente S3 é dublado, como em storage-leitura.test.ts. O que se
 * trava (a função e boa parte destes testes vêm da PR #134, do Nicolas):
 * - primeiro o HEAD e, se o arquivo ainda está visível, o DELETE simples (ele
 *   deixa de ser servido na hora); depois a listagem das versões pelo Prefix e
 *   um DELETE com VersionId por versão E por marcador;
 * - a chave vai normalizada: sem a barra do começo e sem o "/manus-storage/"
 *   de uma linha legada, em TODAS as chamadas;
 * - chave já escondida (HEAD 404) não ganha outro marcador a cada tentativa;
 * - HEAD cortado pelo prazo lança na hora, sem gastar outro prazo no DELETE;
 * - a listagem é paginada e só a chave EXATA sai;
 * - versão que já não existe conta como apagada; o resto lança no meio, e quem
 *   chama deixa a linha para a próxima varredura;
 * - toda chamada tem o SEU prazo, e o prazo corta um bucket travado.
 */

const VARIAVEIS = ["STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "STORAGE_ENDPOINT", "STORAGE_REGION"] as const;
const guardadas: Partial<Record<(typeof VARIAVEIS)[number], string | undefined>> = {};
const CHAVE = "meetings/dona-1/reuniao-1/recording_abc12345.webm";

type Opcoes = { abortSignal?: AbortSignal } | undefined;
let send: ReturnType<typeof vi.fn>;
const chamadas = () => send.mock.calls as Array<[{ input: Record<string, unknown> }, Opcoes]>;
const nomesDasChamadas = () => chamadas().map(([comando]) => comando.constructor.name);
const apagamentos = () => chamadas().filter(([comando]) => comando instanceof DeleteObjectCommand).map(([comando]) => comando.input);
const listagens = () => chamadas().filter(([comando]) => comando instanceof ListObjectVersionsCommand).map(([comando]) => comando.input);

const ausente = () => Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
const negado = () => Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });

/** Responde a listagem com as páginas dadas, em ordem; o HEAD acha o arquivo visível; aceita todo DELETE. */
function bucketCom(...paginas: Record<string, unknown>[]) {
  const fila = [...paginas];
  send.mockImplementation(async (comando: unknown) => {
    if (comando instanceof ListObjectVersionsCommand) return fila.shift() ?? { IsTruncated: false };
    return {};
  });
}

beforeEach(() => {
  for (const nome of VARIAVEIS) guardadas[nome] = process.env[nome];
  process.env.STORAGE_BUCKET = "bucket-de-teste";
  process.env.STORAGE_ACCESS_KEY_ID = "id-de-teste";
  process.env.STORAGE_SECRET_ACCESS_KEY = "segredo-de-teste";
  process.env.STORAGE_ENDPOINT = "https://s3.exemplo.invalid";
  delete process.env.STORAGE_REGION;
  send = vi.fn();
  vi.spyOn(S3Client.prototype, "send").mockImplementation(((...args: unknown[]) => send(...args)) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const nome of VARIAVEIS) {
    if (guardadas[nome] === undefined) delete process.env[nome];
    else process.env[nome] = guardadas[nome];
  }
});

describe("storageApagarTodasAsVersoes: a voz sai com todas as versões", () => {
  it("1 versão + 1 marcador: HEAD, DELETE simples, listagem pelo Prefix e um DELETE com VersionId para cada um, nessa ordem", async () => {
    bucketCom({
      IsTruncated: false,
      Versions: [{ Key: CHAVE, VersionId: "v-audio" }],
      DeleteMarkers: [{ Key: CHAVE, VersionId: "v-marcador" }],
    });

    await storageApagarTodasAsVersoes(`/${CHAVE}`);

    expect(nomesDasChamadas()).toEqual([
      "HeadObjectCommand", "DeleteObjectCommand", "ListObjectVersionsCommand", "DeleteObjectCommand", "DeleteObjectCommand",
    ]);
    // A chave vai normalizada (sem a barra do começo), como em storageDelete.
    expect(chamadas()[0][0].input).toEqual({ Bucket: "bucket-de-teste", Key: CHAVE });
    expect(apagamentos()[0]).toEqual({ Bucket: "bucket-de-teste", Key: CHAVE });
    expect(listagens()).toEqual([{ Bucket: "bucket-de-teste", Prefix: CHAVE, KeyMarker: undefined, VersionIdMarker: undefined }]);
    expect(apagamentos().slice(1)).toEqual([
      { Bucket: "bucket-de-teste", Key: CHAVE, VersionId: "v-audio" },
      { Bucket: "bucket-de-teste", Key: CHAVE, VersionId: "v-marcador" },
    ]);
  });

  it("linha legada com a chave em \"/manus-storage/...\": o HEAD, o DELETE simples, a listagem e cada DELETE com VersionId vão para a chave REAL", async () => {
    // Sem a normalização, tudo iria para "manus-storage/meetings/...", que não
    // existe: a listagem viria vazia, a função "daria certo", a linha sairia e a
    // voz ficaria no bucket.
    bucketCom({ IsTruncated: false, Versions: [{ Key: CHAVE, VersionId: "v-audio" }] });

    await storageApagarTodasAsVersoes(`/manus-storage/${CHAVE}`);

    expect(nomesDasChamadas()).toEqual(["HeadObjectCommand", "DeleteObjectCommand", "ListObjectVersionsCommand", "DeleteObjectCommand"]);
    expect(chamadas().map(([comando]) => comando.input.Key ?? comando.input.Prefix)).toEqual([CHAVE, CHAVE, CHAVE, CHAVE]);
    expect(apagamentos().at(-1)).toEqual({ Bucket: "bucket-de-teste", Key: CHAVE, VersionId: "v-audio" });
  });

  it("listagem paginada, com versões e um marcador espalhados pelas páginas: segue NextKeyMarker e NextVersionIdMarker até a última, e só então apaga cada uma", async () => {
    bucketCom(
      {
        IsTruncated: true, NextKeyMarker: CHAVE, NextVersionIdMarker: "v-2",
        Versions: [{ Key: CHAVE, VersionId: "v-1" }, { Key: CHAVE, VersionId: "v-2" }],
      },
      {
        IsTruncated: true, NextKeyMarker: CHAVE, NextVersionIdMarker: "m-1",
        DeleteMarkers: [{ Key: CHAVE, VersionId: "m-1" }],
      },
      { IsTruncated: false, Versions: [{ Key: CHAVE, VersionId: "v-3" }] },
    );

    await storageApagarTodasAsVersoes(CHAVE);

    expect(listagens()).toEqual([
      { Bucket: "bucket-de-teste", Prefix: CHAVE, KeyMarker: undefined, VersionIdMarker: undefined },
      { Bucket: "bucket-de-teste", Prefix: CHAVE, KeyMarker: CHAVE, VersionIdMarker: "v-2" },
      { Bucket: "bucket-de-teste", Prefix: CHAVE, KeyMarker: CHAVE, VersionIdMarker: "m-1" },
    ]);
    // Nenhum DELETE com VersionId antes de a última página chegar.
    const ultimaListagem = nomesDasChamadas().lastIndexOf("ListObjectVersionsCommand");
    expect(chamadas().slice(0, ultimaListagem).filter(([comando]) => comando.input.VersionId)).toEqual([]);
    expect(apagamentos().slice(1).map(entrada => entrada.VersionId)).toEqual(["v-1", "v-2", "m-1", "v-3"]);
  });

  it("página truncada sem marcador de continuação: para, em vez de pedir a primeira página para sempre", async () => {
    bucketCom({ IsTruncated: true, Versions: [{ Key: CHAVE, VersionId: "v-1" }] });
    await storageApagarTodasAsVersoes(CHAVE);
    expect(listagens()).toHaveLength(1);
    expect(apagamentos().slice(1).map(entrada => entrada.VersionId)).toEqual(["v-1"]);
  });

  it("chave que só COMEÇA igual (mesmo Prefix, outra Key) não é tocada", async () => {
    bucketCom({
      IsTruncated: false,
      Versions: [{ Key: CHAVE, VersionId: "v-audio" }, { Key: `${CHAVE}.bak`, VersionId: "v-outro-arquivo" }],
      DeleteMarkers: [{ Key: `${CHAVE}2`, VersionId: "v-outro-marcador" }],
    });

    await storageApagarTodasAsVersoes(CHAVE);

    expect(apagamentos().slice(1)).toEqual([{ Bucket: "bucket-de-teste", Key: CHAVE, VersionId: "v-audio" }]);
  });

  it("sem versão nenhuma (bucket sem versionamento): só HEAD, o DELETE simples e a listagem vazia, sem erro", async () => {
    bucketCom({ IsTruncated: false });
    await expect(storageApagarTodasAsVersoes(CHAVE)).resolves.toBeUndefined();
    expect(apagamentos()).toEqual([{ Bucket: "bucket-de-teste", Key: CHAVE }]);
  });

  it("toda chamada leva o SEU prazo: um abortSignal ainda não vencido, distinto a cada chamada", async () => {
    bucketCom({ IsTruncated: false, Versions: [{ Key: CHAVE, VersionId: "v-1" }] });
    await storageApagarTodasAsVersoes(CHAVE);
    expect(chamadas()).toHaveLength(4);
    for (const [, opcoes] of chamadas()) {
      expect(opcoes?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(opcoes?.abortSignal?.aborted).toBe(false);
    }
    // Um sinal só para todas viraria orçamento da função inteira, e as últimas
    // versões de uma chave com muitas seriam cortadas a cada passada.
    expect(new Set(chamadas().map(([, opcoes]) => opcoes?.abortSignal)).size).toBe(chamadas().length);
  });
});

describe("storageApagarTodasAsVersoes: tentar de novo não empilha marcadores", () => {
  it("chave já escondida (HEAD 404, a tentativa anterior pôs o marcador e a listagem falhou): NÃO há outro DELETE simples, e as versões saem", async () => {
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof HeadObjectCommand) throw ausente();
      if (comando instanceof ListObjectVersionsCommand) {
        return { IsTruncated: false, Versions: [{ Key: CHAVE, VersionId: "v-audio" }], DeleteMarkers: [{ Key: CHAVE, VersionId: "m-1" }] };
      }
      return {};
    });

    await storageApagarTodasAsVersoes(CHAVE);

    expect(nomesDasChamadas()).toEqual(["HeadObjectCommand", "ListObjectVersionsCommand", "DeleteObjectCommand", "DeleteObjectCommand"]);
    expect(apagamentos()).toEqual([
      { Bucket: "bucket-de-teste", Key: CHAVE, VersionId: "v-audio" },
      { Bucket: "bucket-de-teste", Key: CHAVE, VersionId: "m-1" },
    ]);
  });

  it("com a listagem negada, cada nova tentativa sobre a chave já escondida não põe marcador nenhum", async () => {
    // Bucket com versões, semântica do S3: DELETE sem VersionId empilha um marcador.
    const pilha: Array<{ VersionId: string; marcador: boolean }> = [{ VersionId: "v-audio", marcador: false }];
    const recusa = negado();
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof HeadObjectCommand) {
        if (pilha.at(-1)?.marcador) throw ausente();
        return {};
      }
      if (comando instanceof ListObjectVersionsCommand) throw recusa;
      if (comando instanceof DeleteObjectCommand && !comando.input.VersionId) pilha.push({ VersionId: `m-${pilha.length}`, marcador: true });
      return {};
    });

    for (let tentativa = 0; tentativa < 3; tentativa++) {
      await expect(storageApagarTodasAsVersoes(CHAVE)).rejects.toBe(recusa);
    }

    expect(pilha.filter(item => item.marcador)).toHaveLength(1);
    expect(apagamentos()).toEqual([{ Bucket: "bucket-de-teste", Key: CHAVE }]);
  });

  it.each([
    ["TimeoutError, de AbortSignal.timeout", () => new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["AbortError, do SDK ao abortar", () => Object.assign(new Error("Request aborted"), { name: "AbortError" })],
  ])("HEAD cortado pelo prazo (%s): LANÇA na hora, sem gastar outro prazo no DELETE simples nem na listagem", async (_rotulo, criarErro) => {
    const prazo = criarErro();
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof HeadObjectCommand) throw prazo;
      if (comando instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      return {};
    });

    await expect(storageApagarTodasAsVersoes(CHAVE)).rejects.toBe(prazo);

    expect(nomesDasChamadas()).toEqual(["HeadObjectCommand"]);
  });

  it("HEAD com outro erro (sem permissão, por exemplo): segue para o DELETE simples, porque tirar o arquivo do ar vem primeiro", async () => {
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof HeadObjectCommand) throw Object.assign(new Error("Forbidden"), { name: "Forbidden", $metadata: { httpStatusCode: 403 } });
      if (comando instanceof ListObjectVersionsCommand) return { IsTruncated: false };
      return {};
    });

    await storageApagarTodasAsVersoes(CHAVE);

    expect(nomesDasChamadas()).toEqual(["HeadObjectCommand", "DeleteObjectCommand", "ListObjectVersionsCommand"]);
    expect(apagamentos()).toEqual([{ Bucket: "bucket-de-teste", Key: CHAVE }]);
  });
});

describe("storageApagarTodasAsVersoes: o que pode dar errado no bucket", () => {
  it("versão que já não existe (outra instância chegou antes): NoSuchVersion e 404 contam como apagada, e o resto segue", async () => {
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof HeadObjectCommand) return {};
      if (comando instanceof ListObjectVersionsCommand) {
        return { IsTruncated: false, Versions: [{ Key: CHAVE, VersionId: "v-1" }, { Key: CHAVE, VersionId: "v-2" }, { Key: CHAVE, VersionId: "v-3" }] };
      }
      const versao = (comando as DeleteObjectCommand).input.VersionId;
      if (versao === "v-1") throw Object.assign(new Error("The specified version does not exist."), { name: "NoSuchVersion" });
      if (versao === "v-2") throw Object.assign(new Error("UnknownError"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      return {};
    });

    await expect(storageApagarTodasAsVersoes(CHAVE)).resolves.toBeUndefined();
    expect(apagamentos().slice(1).map(entrada => entrada.VersionId)).toEqual(["v-1", "v-2", "v-3"]);
  });

  it("falha NO MEIO, na segunda de três versões listadas em duas páginas: LANÇA ali, a primeira já saiu e a terceira fica para a próxima varredura", async () => {
    // Quem chama (a varredura, a leitura, as exclusões) só apaga a linha do
    // áudio se esta função resolver: com a rejeição, a linha fica e a próxima
    // passada recomeça pela listagem, que já não traz a v-1.
    const recusa = negado();
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof HeadObjectCommand) return {};
      if (comando instanceof ListObjectVersionsCommand) {
        return comando.input.VersionIdMarker
          ? { IsTruncated: false, Versions: [{ Key: CHAVE, VersionId: "v-3" }] }
          : { IsTruncated: true, NextKeyMarker: CHAVE, NextVersionIdMarker: "m-1", Versions: [{ Key: CHAVE, VersionId: "v-1" }], DeleteMarkers: [{ Key: CHAVE, VersionId: "m-1" }] };
      }
      if ((comando as DeleteObjectCommand).input.VersionId === "m-1") throw recusa;
      return {};
    });

    await expect(storageApagarTodasAsVersoes(CHAVE)).rejects.toBe(recusa);

    expect(listagens()).toHaveLength(2);
    expect(apagamentos().slice(1).map(entrada => entrada.VersionId)).toEqual(["v-1", "m-1"]);
  });

  it("chave sem permissão de listar (AccessDenied): LANÇA, mas o DELETE simples já foi, e o arquivo deixa de ser servido", async () => {
    const recusa = negado();
    send.mockImplementation(async (comando: unknown) => {
      if (comando instanceof ListObjectVersionsCommand) throw recusa;
      return {};
    });

    await expect(storageApagarTodasAsVersoes(CHAVE)).rejects.toBe(recusa);
    expect(apagamentos()).toEqual([{ Bucket: "bucket-de-teste", Key: CHAVE }]);
  });

  it("o prazo corta um bucket travado, e UM prazo só: o HEAD estoura e nada mais é chamado", async () => {
    send.mockImplementation((_comando: unknown, opcoes?: { abortSignal?: AbortSignal }) => new Promise((_resolver, rejeitar) => {
      opcoes?.abortSignal?.addEventListener("abort", () => rejeitar(opcoes.abortSignal?.reason));
    }));
    await expect(storageApagarTodasAsVersoes(CHAVE, 20)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(nomesDasChamadas()).toEqual(["HeadObjectCommand"]);
  });

  it("sem variáveis, o erro nomeia as variáveis certas e nada sai para a rede", async () => {
    delete process.env.STORAGE_BUCKET;
    await expect(storageApagarTodasAsVersoes(CHAVE)).rejects.toThrow(/STORAGE_BUCKET/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ehAcessoNegadoNoBucket: permissão negada é falha do sistema, não de um arquivo", () => {
  it("reconhece AccessDenied pelo nome, pelo código e pelo 403; não confunde com 404, prazo ou erro qualquer", () => {
    expect(ehAcessoNegadoNoBucket(negado())).toBe(true);
    expect(ehAcessoNegadoNoBucket({ Code: "AccessDenied" })).toBe(true);
    expect(ehAcessoNegadoNoBucket({ name: "Forbidden", $metadata: { httpStatusCode: 403 } })).toBe(true);
    expect(ehAcessoNegadoNoBucket(ausente())).toBe(false);
    expect(ehAcessoNegadoNoBucket(Object.assign(new Error("prazo"), { name: "TimeoutError" }))).toBe(false);
    expect(ehAcessoNegadoNoBucket(new Error("socket hang up"))).toBe(false);
    expect(ehAcessoNegadoNoBucket(null)).toBe(false);
  });
});

describe("storageListarChavesEscondidas: o passivo que o DELETE antigo só escondeu", () => {
  it("devolve só as chaves cuja versão MAIS RECENTE é um marcador, em ordem, seguindo as páginas", async () => {
    const escondida = "meetings/dona-1/reuniao-1/recording_aaaa1111.webm";
    const outraEscondida = "meetings/dona-2/reuniao-9/partes/0003-bbbb2222.m4a";
    const visivel = "meetings/dona-1/reuniao-2/recording_cccc3333.webm";
    bucketCom(
      {
        IsTruncated: true, NextKeyMarker: outraEscondida, NextVersionIdMarker: "m-2",
        Versions: [{ Key: escondida, VersionId: "v-1", IsLatest: false }, { Key: visivel, VersionId: "v-3", IsLatest: true }],
        DeleteMarkers: [{ Key: outraEscondida, VersionId: "m-2", IsLatest: true }],
      },
      {
        IsTruncated: false,
        // A chave visível já foi apagada uma vez e voltou: o marcador dela é antigo.
        DeleteMarkers: [{ Key: escondida, VersionId: "m-1", IsLatest: true }, { Key: visivel, VersionId: "m-0", IsLatest: false }],
      },
    );

    expect(await storageListarChavesEscondidas("/meetings/")).toEqual([escondida, outraEscondida]);

    expect(nomesDasChamadas()).toEqual(["ListObjectVersionsCommand", "ListObjectVersionsCommand"]);
    expect(listagens()).toEqual([
      { Bucket: "bucket-de-teste", Prefix: "meetings/", KeyMarker: undefined, VersionIdMarker: undefined },
      { Bucket: "bucket-de-teste", Prefix: "meetings/", KeyMarker: outraEscondida, VersionIdMarker: "m-2" },
    ]);
    // Só lê: nenhum DELETE.
    expect(apagamentos()).toEqual([]);
    // Cada página com o seu prazo.
    for (const [, opcoes] of chamadas()) expect(opcoes?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("prefixo vazio é recusado antes de qualquer chamada: a listagem nunca varre o bucket inteiro", async () => {
    await expect(storageListarChavesEscondidas("")).rejects.toThrow(/Prefixo obrigatório/);
    await expect(storageListarChavesEscondidas("/")).rejects.toThrow(/Prefixo obrigatório/);
    expect(send).not.toHaveBeenCalled();
  });

  it("a recusa do bucket SOBE: o script não pode dizer \"nada a apagar\" sem ter listado", async () => {
    const recusa = negado();
    send.mockRejectedValue(recusa);
    await expect(storageListarChavesEscondidas("meetings/")).rejects.toBe(recusa);
  });
});
