import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { users, voiceProfileConsents, voiceProfiles } from "../drizzle/schema";
import { RECUSAS_DO_PERFIL_DE_VOZ, VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ } from "@shared/perfil-de-voz";
import { UNAUTHED_ERR_MSG } from "@shared/const";

// O bucket da varredura das gravações (limparGravacoesVencidas), que não
// recebe o bucket por parâmetro: um dublê que a prova liga e desliga.
const bucketDaVarredura = vi.hoisted(() => ({ recusar: false, apagadas: [] as string[] }));
vi.mock("./storage", async original => ({
  ...(await original<typeof import("./storage")>()),
  storageApagarTodasAsVersoes: async (chave: string) => {
    if (bucketDaVarredura.recusar) throw new Error("o B2 recusou");
    bucketDaVarredura.apagadas.push(chave);
  },
}));

const {
  amostraDaVozDaDona, desligarPerfilDeVoz, estadoDoPerfilDeVoz, gravarPerfilDeVoz, ouvirPerfilDeVoz, registrarRevogacaoNaExclusao,
  zerarTetoDaAmostraParaTestes,
} = await import("./perfil-de-voz");
type BucketDoPerfil = import("./perfil-de-voz").BucketDoPerfil;
const { ObjetoAusenteNoStorageError } = await import("./storage");
const { limparGravacoesVencidas } = await import("./meeting-service");
const { excluirConta } = await import("./exclusao-de-conta");

/**
 * O perfil de voz (H3d) contra um banco real DE TESTE (sem DATABASE_URL_TESTES,
 * se pula). O bucket é um dublê em memória, injetado: o que se prova é a regra
 * da Cris — sem a caixa não nasce perfil, cada consentimento e cada revogação
 * ficam registrados (com a versão, o idioma e o texto, sem a voz), a exclusão é
 * de vez (o objeto sai do bucket e a linha sai) e, se o bucket recusar, nada
 * muda. E que uma dona não alcança o perfil de outra.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-voz-${crypto.randomUUID()}`;
const OUTRA = `teste-voz-outra-${crypto.randomUUID()}`;
// Uma conta que a prova exclui de verdade, e um openId que nunca teve conta.
const EXCLUIDA = `teste-voz-excluida-${crypto.randomUUID()}`;
const SEM_CONTA = `teste-voz-sem-conta-${crypto.randomUUID()}`;
const TODAS = [DONA, OUTRA, EXCLUIDA, SEM_CONTA];
const QUEM = { ipAddress: "203.0.113.7", userAgent: "vitest-perfil-de-voz" };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(200, 9)]);
// O texto como a tela o manda (client/src/components/PerfilDeVoz.tsx): o servidor confere o hash dele.
const LOCALE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../client/src/i18n/locales/pt-BR.json"), "utf8")).perfilDeVoz;
const CONSENTIMENTO = {
  versaoDoTexto: VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ,
  idioma: "pt-BR",
  textoExibido: `${LOCALE.consent}\n${LOCALE.consentSupport}`,
};
const amostra = (bytes = WEBM, mimeType = "audio/webm") => ({ audioBase64: bytes.toString("base64"), mimeType, duracaoMs: 30_000 });

/** O bucket em memória; `falharAoApagar` simula o B2 recusando. */
function bucketDeTeste() {
  const objetos = new Map<string, Buffer>();
  const apagados: string[] = [];
  let falharAoApagar = false;
  const bucket: BucketDoPerfil = {
    guardar: async (chave, bytes) => { objetos.set(chave, bytes); },
    apagar: async chave => {
      if (falharAoApagar) throw new Error("o B2 recusou");
      apagados.push(chave);
      objetos.delete(chave);
    },
    ler: async chave => {
      const bytes = objetos.get(chave);
      if (!bytes) throw new ObjetoAusenteNoStorageError(chave);
      return bytes;
    },
  };
  return { bucket, objetos, apagados, falhar: (sim: boolean) => { falharAoApagar = sim; } };
}

async function db() { return (await getDb())!; }
const perfilDe = async (ownerId: string) => (await (await db()).select().from(voiceProfiles).where(eq(voiceProfiles.ownerId, ownerId)))[0];
const registroDe = async (ownerId: string) => (await db()).select().from(voiceProfileConsents).where(eq(voiceProfileConsents.ownerId, ownerId)).orderBy(asc(voiceProfileConsents.createdAt));

async function recusa(promessa: Promise<unknown>) {
  try {
    await promessa;
  } catch (erro) {
    return erro as { code?: string; message: string };
  }
  throw new Error("era para recusar");
}

describe.skipIf(!temBanco)("Perfil de voz (integração)", () => {
  beforeEach(async () => {
    const banco = await db();
    await banco.delete(voiceProfiles).where(inArray(voiceProfiles.ownerId, TODAS));
    await banco.delete(voiceProfileConsents).where(inArray(voiceProfileConsents.ownerId, TODAS));
    await banco.delete(users).where(inArray(users.openId, TODAS));
    // Só grava quem tem conta (a exclusão da conta pode passar no meio).
    await banco.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    bucketDaVarredura.recusar = false;
    bucketDaVarredura.apagadas = [];
    zerarTetoDaAmostraParaTestes();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterAll(async () => {
    const banco = await getDb();
    if (!banco) return;
    await banco.delete(voiceProfiles).where(inArray(voiceProfiles.ownerId, TODAS));
    await banco.delete(voiceProfileConsents).where(inArray(voiceProfileConsents.ownerId, TODAS));
    await banco.delete(users).where(inArray(users.openId, TODAS));
  });

  it("sem a caixa marcada, o perfil não nasce e nada vai ao bucket", async () => {
    const { bucket, objetos } = bucketDeTeste();
    const erro = await recusa(gravarPerfilDeVoz(DONA, amostra(), QUEM, bucket));
    expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_PERFIL_DE_VOZ.consentimentoPedido });
    const versaoVelha = await recusa(gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: { ...CONSENTIMENTO, versaoDoTexto: "inventada" } }, QUEM, bucket));
    expect(versaoVelha.message).toBe(RECUSAS_DO_PERFIL_DE_VOZ.consentimentoPedido);
    expect(objetos.size).toBe(0);
    expect(await perfilDe(DONA)).toBeUndefined();
    expect(await registroDe(DONA)).toEqual([]);
  });

  it("com a caixa: o perfil nasce, a amostra vai ao bucket sob o openId, e o consentimento fica registrado com a versão, o idioma e o texto", async () => {
    const { bucket, objetos } = bucketDeTeste();
    const estado = await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket);
    expect(estado).toMatchObject({ ativo: true, duracaoMs: 30_000 });
    expect(Object.keys(estado)).not.toContain("storageKey");
    const perfil = await perfilDe(DONA);
    expect(perfil.storageKey.startsWith(`perfis-de-voz/${DONA}/`)).toBe(true);
    expect(objetos.get(perfil.storageKey)?.equals(WEBM)).toBe(true);
    const [registro] = await registroDe(DONA);
    expect(registro).toMatchObject({
      evento: "consentiu", origem: "dona", versaoDoTexto: VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ, idioma: "pt-BR",
      textoExibido: CONSENTIMENTO.textoExibido, textoHash: crypto.createHash("sha256").update(CONSENTIMENTO.textoExibido).digest("hex"),
      ipAddress: QUEM.ipAddress, userAgent: QUEM.userAgent,
    });
    expect(typeof registro.createdAt).toBe("number");
    // A dona ouve; a fila lê a mesma amostra; a outra conta não tem nada.
    expect(await ouvirPerfilDeVoz(DONA, bucket)).toEqual({ audioBase64: WEBM.toString("base64"), mimeType: "audio/webm" });
    expect((await amostraDaVozDaDona(await db(), DONA, bucket))?.audio.equals(WEBM)).toBe(true);
    expect(await estadoDoPerfilDeVoz(OUTRA)).toEqual({ ativo: false });
    expect(await amostraDaVozDaDona(await db(), OUTRA, bucket)).toBeNull();
    expect(await recusa(ouvirPerfilDeVoz(OUTRA, bucket))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DO_PERFIL_DE_VOZ.semPerfil });
  });

  it("regravar troca a amostra: a antiga sai do bucket, sem pedir a caixa de novo e sem registro novo", async () => {
    const { bucket, objetos, apagados } = bucketDeTeste();
    await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket);
    const antiga = (await perfilDe(DONA)).storageKey;
    await gravarPerfilDeVoz(DONA, amostra(MP4, "audio/mp4"), QUEM, bucket);
    const nova = await perfilDe(DONA);
    expect(nova.storageKey).not.toBe(antiga);
    expect(nova.mimeType).toBe("audio/mp4");
    expect(apagados).toEqual([antiga]);
    expect([...objetos.keys()]).toEqual([nova.storageKey]);
    expect((await registroDe(DONA)).map(r => r.evento)).toEqual(["consentiu"]);
  });

  it("regravar com o bucket recusando a exclusão da antiga: o perfil fica com a antiga, e a nova não sobra", async () => {
    const t = bucketDeTeste();
    await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, t.bucket);
    const antiga = (await perfilDe(DONA)).storageKey;
    t.falhar(true);
    const erro = await recusa(gravarPerfilDeVoz(DONA, amostra(MP4, "audio/mp4"), QUEM, t.bucket));
    expect(erro.message).toBe(RECUSAS_DO_PERFIL_DE_VOZ.bucket);
    expect((await perfilDe(DONA)).storageKey).toBe(antiga);
    expect([...t.objetos.keys()].filter(chave => chave !== antiga)).toHaveLength(1); // a nova ficou só porque o dublê recusa tudo; o log pede a remoção
  });

  it("desligar apaga de vez: o objeto sai do bucket, a linha sai e a revogação fica registrada; o registro sobrevive", async () => {
    const { bucket, objetos, apagados } = bucketDeTeste();
    await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket);
    const chave = (await perfilDe(DONA)).storageKey;
    expect(await desligarPerfilDeVoz(DONA, QUEM, bucket)).toEqual({ ativo: false });
    expect(apagados).toEqual([chave]);
    expect(objetos.size).toBe(0);
    expect(await perfilDe(DONA)).toBeUndefined();
    const registro = await registroDe(DONA);
    expect(registro.map(r => [r.evento, r.origem])).toEqual([["consentiu", "dona"], ["revogou", "dona"]]);
    expect(registro[1]).toMatchObject({ versaoDoTexto: VERSAO_VIGENTE_DO_TEXTO_DO_PERFIL_DE_VOZ, ipAddress: QUEM.ipAddress });
    // Sem perfil: desligar de novo é SEM_PERFIL, e gravar de novo pede a caixa.
    expect(await recusa(desligarPerfilDeVoz(DONA, QUEM, bucket))).toMatchObject({ code: "NOT_FOUND", message: RECUSAS_DO_PERFIL_DE_VOZ.semPerfil });
    expect((await recusa(gravarPerfilDeVoz(DONA, amostra(), QUEM, bucket))).message).toBe(RECUSAS_DO_PERFIL_DE_VOZ.consentimentoPedido);
  });

  it("desligar com o bucket recusando: nada muda (o perfil e a amostra ficam, sem revogação), e a dona tenta de novo", async () => {
    const t = bucketDeTeste();
    await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, t.bucket);
    t.falhar(true);
    expect((await recusa(desligarPerfilDeVoz(DONA, QUEM, t.bucket))).message).toBe(RECUSAS_DO_PERFIL_DE_VOZ.bucket);
    expect(await perfilDe(DONA)).toBeDefined();
    expect((await registroDe(DONA)).map(r => r.evento)).toEqual(["consentiu"]);
    t.falhar(false);
    await desligarPerfilDeVoz(DONA, QUEM, t.bucket);
    expect(await perfilDe(DONA)).toBeUndefined();
  });

  it("a exclusão da conta registra a revogação com a origem dela; sem perfil, nada", async () => {
    const { bucket } = bucketDeTeste();
    expect(await registrarRevogacaoNaExclusao(await db(), DONA)).toBe(false);
    await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket);
    expect(await registrarRevogacaoNaExclusao(await db(), DONA)).toBe(true);
    expect((await registroDe(DONA)).map(r => [r.evento, r.origem])).toEqual([["consentiu", "dona"], ["revogou", "exclusao_da_conta"]]);
    // A exclusão que caiu antes de tirar o perfil e roda de novo não registra outra revogação.
    expect(await registrarRevogacaoNaExclusao(await db(), DONA)).toBe(false);
    expect((await registroDe(DONA)).map(r => r.evento)).toEqual(["consentiu", "revogou"]);
  });

  it("o texto do consentimento que não é o da versão é recusado, e nada vai ao registro", async () => {
    const { bucket, objetos } = bucketDeTeste();
    const erro = await recusa(gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: { ...CONSENTIMENTO, textoExibido: "Autorizo o que a requisição inventou." } }, QUEM, bucket));
    expect(erro).toMatchObject({ code: "PRECONDITION_FAILED", message: RECUSAS_DO_PERFIL_DE_VOZ.consentimentoPedido });
    expect(objetos.size).toBe(0);
    expect(await perfilDe(DONA)).toBeUndefined();
    expect(await registroDe(DONA)).toEqual([]);
  });

  it("sem a conta (a exclusão passou no meio), a gravação é recusada, nada nasce, e a amostra nova sai do bucket", async () => {
    const { bucket, objetos, apagados } = bucketDeTeste();
    const erro = await recusa(gravarPerfilDeVoz(SEM_CONTA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket));
    expect(erro).toMatchObject({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    expect(await perfilDe(SEM_CONTA)).toBeUndefined();
    expect(await registroDe(SEM_CONTA)).toEqual([]);
    expect(apagados).toHaveLength(1);
    expect(objetos.size).toBe(0);
  });

  it("a exclusão da conta com o bucket recusando SÓ a amostra: a linha fica como ponteiro, e a varredura tenta de novo e só então a tira", async () => {
    const banco = await db();
    await banco.insert(users).values({ openId: EXCLUIDA });
    const [conta] = await banco.select({ id: users.id }).from(users).where(eq(users.openId, EXCLUIDA));
    const { bucket } = bucketDeTeste();
    await gravarPerfilDeVoz(EXCLUIDA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket);
    const chave = (await perfilDe(EXCLUIDA)).storageKey;

    const relatorio = await excluirConta(banco, { id: conta.id, openId: EXCLUIDA, email: null }, {
      apagarArquivo: async alvo => { if (alvo.startsWith("perfis-de-voz/")) throw new Error("o B2 recusou"); },
      revogarGoogle: async () => "sem-conexao",
    });
    expect(relatorio.arquivosComFalha).toEqual([chave]);
    expect((await banco.select().from(users).where(eq(users.openId, EXCLUIDA)))).toEqual([]);
    // A linha ficou: é o único ponteiro para a voz. A revogação foi registrada.
    expect((await perfilDe(EXCLUIDA))?.storageKey).toBe(chave);
    expect((await registroDe(EXCLUIDA)).map(r => [r.evento, r.origem])).toEqual([["consentiu", "dona"], ["revogou", "exclusao_da_conta"]]);

    // A varredura acha o perfil sem a conta; com o bucket recusando, a linha fica.
    bucketDaVarredura.recusar = true;
    await limparGravacoesVencidas({ ownerId: EXCLUIDA });
    expect((await perfilDe(EXCLUIDA))?.storageKey).toBe(chave);
    // Com o bucket de volta, a amostra sai com todas as versões, e só então a linha.
    bucketDaVarredura.recusar = false;
    const passada = await limparGravacoesVencidas({ ownerId: EXCLUIDA });
    expect(bucketDaVarredura.apagadas).toEqual([chave]);
    expect(passada.apagadas).toBe(1);
    expect(await perfilDe(EXCLUIDA)).toBeUndefined();
    // O registro fica.
    expect((await registroDe(EXCLUIDA)).map(r => r.evento)).toEqual(["consentiu", "revogou"]);
  });

  it("a varredura não toca no perfil de quem tem conta", async () => {
    const { bucket } = bucketDeTeste();
    await gravarPerfilDeVoz(DONA, { ...amostra(), consentimento: CONSENTIMENTO }, QUEM, bucket);
    await limparGravacoesVencidas({ ownerId: DONA });
    expect(bucketDaVarredura.apagadas).toEqual([]);
    expect(await perfilDe(DONA)).toBeDefined();
  });
});
