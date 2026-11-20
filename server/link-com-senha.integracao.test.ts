import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes"; });
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "./db";
import { auditLogs, meetingRecordings, meetingTranscripts, meetings, users } from "../drizzle/schema";
import {
  ACAO_AUDIO_DO_LINK,
  ACAO_SENHA_DO_LINK_LIGADA,
  ACAO_SENHA_DO_LINK_TIRADA,
  chaveDoAudioDoLink,
  desligarLinkAberto,
  gerarTokenDoLink,
  ligarLinkAberto,
  ligarLinkAbertoComOpcoes,
  LinkAbertoRecusado,
  mudarAudioDoLink,
  novaSenhaDoLink,
  registrarRotasDoLinkAberto,
  tirarSenhaDoLink,
  verReuniaoPeloLink,
} from "./link-aberto-da-reuniao";
import { ACAO_LINK_BLOQUEADO, entrarNoLink, freioDaEntradaPorRede } from "./entrada-no-link-aberto";
import { comCookiesDoPedido, DURACAO_DA_ENTRADA_MS, ESPERA_INICIAL_MS, TENTATIVAS_LIVRES } from "./senha-do-link-aberto";
import { getPrivateMeeting } from "./meeting-service";
import { resumoGuardadoPeloLink } from "./resumo-guardado";
import { mapaMentalPeloLink } from "./mapa-mental-guardado";
import { appRouter } from "./routers";

/**
 * O link aberto com senha e sem o áudio (H23, HN-57 do HiNoter) contra um
 * banco real DE TESTE (migração 0022). No CI é o MariaDB criado do zero por
 * scripts/criar-banco.mjs; sem DATABASE_URL_TESTES o teste se pula
 * (server/test/setup-banco.ts troca a DATABASE_URL por ela). O que só o banco
 * de verdade prova:
 *
 * - a senha certa abre e a errada não; o banco guarda só o hash;
 * - o freio do link, com a linha travada: as tentativas em paralelo entram uma
 *   de cada vez e a 6ª já espera; o freio da rede segura quem varre links;
 * - trocar a senha derruba a anterior e a entrada de quem a usou;
 * - sem o áudio, a página não traz a gravação e a rota do áudio responde 404;
 * - o link ligado antes da H23 segue sem senha e com o áudio;
 * - outra dona leva NOT_FOUND e não muda nada;
 * - cada mudança da dona entra na auditoria, na mesma transação.
 *
 * Donas e reuniões com id aleatório: a limpeza no fim só alcança o que este
 * arquivo criou.
 */
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);
const DONA = `teste-senha-link-${crypto.randomUUID()}`;
const OUTRA = `teste-senha-link-${crypto.randomUUID()}`;
const COM_SENHA = crypto.randomUUID();
const SEM_AUDIO = crypto.randomUUID();
const ANTIGO = crypto.randomUUID();
const DESLIGADO = crypto.randomUUID();
const REUNIOES = [COM_SENHA, SEM_AUDIO, ANTIGO, DESLIGADO];
const AGORA = Date.now();
const chave = (id: string) => `meetings/${DONA}/${id}/recording.mp4`;
// userId fora de qualquer conta real: a limpeza das linhas de auditoria vai por ele.
const PROVA = {
  userId: 2_000_000_000 + Math.floor(Math.random() * 100_000_000), ipAddress: "203.0.113.7", userAgent: "vitest-link-com-senha",
  idioma: "pt-BR", textoExibido: "Confirmo que todas as pessoas que falaram nesta reunião autorizaram compartilhar.",
};
const PROVA_DA_OUTRA = { userId: PROVA.userId + 1, ipAddress: "198.51.100.99", userAgent: "vitest-outra" };

const reuniao = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ownerId: DONA, title: `Reunião ${id.slice(0, 8)}`, status: "ready" as const,
  consentGranted: true, consentAt: AGORA, createdAt: AGORA, updatedAt: AGORA, ...extra,
});

async function recusaDe(promessa: Promise<unknown>): Promise<LinkAbertoRecusado> {
  try {
    await promessa;
  } catch (erro) {
    if (erro instanceof LinkAbertoRecusado) return erro;
    throw erro;
  }
  throw new Error("era para recusar");
}

/** A senha que não é a do link: um algarismo trocado. */
const outraSenha = (senha: string) => `${(Number(senha[0]) + 1) % 10}${senha.slice(1)}`;

async function linhaDoLink(id: string) {
  const db = (await getDb())!;
  const [linha] = await db.select({
    shareToken: meetings.shareToken, hash: meetings.sharePasswordHash, audio: meetings.shareAudio,
    falhas: meetings.sharePasswordFailures, ultimaFalhaEm: meetings.sharePasswordFailedAt, bloqueadoAte: meetings.sharePasswordLockedUntil,
  }).from(meetings).where(eq(meetings.id, id));
  return linha;
}

async function auditoria(acao: string, id: string) {
  const db = (await getDb())!;
  return db.select().from(auditLogs).where(and(eq(auditLogs.action, acao), eq(auditLogs.resourceId, id))).orderBy(auditLogs.id);
}

/** Entra com a senha e devolve o cabeçalho Cookie que o navegador mandaria depois. */
async function entrarDeVerdade(token: string, senha: string, ip: string) {
  const resultado = await entrarNoLink(token, senha, ip);
  if (!resultado.entrou) throw new Error(`a senha não entrou: ${JSON.stringify(resultado)}`);
  return `${resultado.cookie.nome}=${resultado.cookie.valor}`;
}

// A rota do áudio pelo HTTP de verdade, com a busca da chave de verdade e a assinatura dublada.
const assinar = vi.fn(async (chaveDoAudio: string) => `https://bucket.exemplo/${chaveDoAudio}?assinada=1`);
let servidor: Server;
let base = "";
const pedirAudio = (token: string, cookie?: string) =>
  fetch(`${base}/reuniao-aberta/${token}/audio`, { redirect: "manual", headers: cookie ? { cookie } : {} });

describe.skipIf(!temBanco)("Link aberto com senha e sem o áudio (H23) no banco (integração)", () => {
  beforeAll(async () => {
    const db = (await getDb())!;
    await db.insert(users).values([{ openId: DONA }, { openId: OUTRA }]);
    // ANTIGO é o link ligado antes da H23: o token gravado, e as colunas novas no padrão da migração.
    await db.insert(meetings).values([reuniao(COM_SENHA), reuniao(SEM_AUDIO), reuniao(ANTIGO, { shareToken: gerarTokenDoLink() }), reuniao(DESLIGADO)]);
    await db.insert(meetingTranscripts).values(REUNIOES.map(id => ({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, transcript: "Combinamos a entrega na sexta.", language: "pt-BR", createdAt: AGORA, updatedAt: AGORA,
    })));
    await db.insert(meetingRecordings).values(REUNIOES.map(id => ({
      id: crypto.randomUUID(), meetingId: id, ownerId: DONA, storageKey: chave(id), storageUrl: `/manus-storage/${chave(id)}`,
      mimeType: "audio/mp4", sizeBytes: 1024, durationSeconds: 90, expiresAt: AGORA + 86_400_000, createdAt: AGORA,
    })));
    const app = express();
    registrarRotasDoLinkAberto(app, { acharChave: chaveDoAudioDoLink, assinar });
    await new Promise<void>(pronto => { servidor = app.listen(0, "127.0.0.1", () => pronto()); });
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (servidor) await new Promise(fim => servidor.close(fim));
    const db = await getDb();
    if (!db) return;
    await db.delete(meetingRecordings).where(eq(meetingRecordings.ownerId, DONA));
    await db.delete(meetingTranscripts).where(eq(meetingTranscripts.ownerId, DONA));
    await db.delete(meetings).where(eq(meetings.ownerId, DONA));
    await db.delete(users).where(inArray(users.openId, [DONA, OUTRA]));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, [PROVA.userId, PROVA_DA_OUTRA.userId]));
    await db.delete(auditLogs).where(and(isNull(auditLogs.userId), inArray(auditLogs.resourceId, REUNIOES)));
  });

  beforeEach(async () => {
    freioDaEntradaPorRede.esquecer();
    // Cada teste começa com os links desligados (o ANTIGO fica como a migração o deixou).
    for (const id of [COM_SENHA, SEM_AUDIO, DESLIGADO]) await desligarLinkAberto(DONA, id);
  });

  it("ligar com senha: a senha sai uma vez, o banco guarda só o hash, e tudo o que o link abre pede a senha", async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    expect(senha).toMatch(/^[0-9]{6}$/);
    const linha = await linhaDoLink(COM_SENHA);
    expect(linha).toMatchObject({ shareToken: token, audio: true, falhas: 0, bloqueadoAte: null });
    expect(linha.hash).toMatch(/^scrypt\$/);
    expect(linha.hash).not.toContain(senha!);

    // Sem a entrada: a página, o resumo, o mapa e o áudio recusam.
    expect((await recusaDe(verReuniaoPeloLink(token))).codigo).toBe("UNAUTHORIZED");
    expect((await recusaDe(resumoGuardadoPeloLink(token))).codigo).toBe("UNAUTHORIZED");
    expect((await recusaDe(mapaMentalPeloLink(token))).codigo).toBe("UNAUTHORIZED");
    expect(await chaveDoAudioDoLink(token)).toBeNull();
    expect((await pedirAudio(token)).status).toBe(404);

    // Ligar de novo (duplo clique, outra aba) devolve o mesmo link, e nenhuma senha nova sai.
    expect(await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true })).toEqual({ token, senha: null });
    expect((await linhaDoLink(COM_SENHA)).hash).toBe(linha.hash);

    // O detalhe da dona diz que o link pede senha, sem o hash nem o freio.
    const detalhe = await getPrivateMeeting(DONA, COM_SENHA);
    expect(detalhe?.meeting).toMatchObject({ shareToken: token, linkComSenha: true, linkComAudio: true });
    const chaves = Object.keys(detalhe!.meeting);
    for (const proibida of ["sharePasswordHash", "sharePasswordFailures", "sharePasswordFailedAt", "sharePasswordLockedUntil", "shareAudio"]) {
      expect(chaves).not.toContain(proibida);
    }
    expect(JSON.stringify(detalhe)).not.toContain("scrypt");

    // A auditoria de ligar diz como o link ficou.
    expect((await auditoria("MEETING_OPEN_LINK_ON", COM_SENHA)).at(-1)!.details).toMatchObject({ comSenha: true, incluirAudio: true });
  });

  it("a senha certa abre (o cookie leva à reunião e ao áudio); a errada não", async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    expect(await entrarNoLink(token, outraSenha(senha!), "203.0.113.20")).toEqual({ entrou: false, motivo: "senha" });

    const cookie = await entrarDeVerdade(token, senha!, "203.0.113.21");
    const vista = await comCookiesDoPedido(cookie, () => verReuniaoPeloLink(token));
    expect(vista).toMatchObject({ titulo: `Reunião ${COM_SENHA.slice(0, 8)}`, audioIncluido: true, gravacao: { url: `/reuniao-aberta/${token}/audio` } });
    expect(await comCookiesDoPedido(cookie, () => chaveDoAudioDoLink(token))).toBe(chave(COM_SENHA));
    const resposta = await pedirAudio(token, cookie);
    expect(resposta.status).toBe(307);
    expect(resposta.headers.get("location")).toBe(`https://bucket.exemplo/${chave(COM_SENHA)}?assinada=1`);
    // O cookie de um link não abre outro link com senha.
    const outro = await ligarLinkAbertoComOpcoes(DONA, DESLIGADO, PROVA, { comSenha: true });
    expect((await recusaDe(comCookiesDoPedido(cookie, () => verReuniaoPeloLink(outro.token)))).codigo).toBe("UNAUTHORIZED");
  });

  it("pelo router público: entrar grava o cookie HttpOnly de 12 horas, e é com ele que `ver` abre", async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    const gravados: Array<{ nome: string; valor: string; opcoes: Record<string, unknown> }> = [];
    const visitante = (cookie?: string) => appRouter.createCaller({
      user: null,
      req: { headers: cookie ? { cookie } : {}, ip: "203.0.113.30", socket: {}, protocol: "https" },
      res: { cookie: (nome: string, valor: string, opcoes: Record<string, unknown>) => gravados.push({ nome, valor, opcoes }), clearCookie: () => {} },
    } as never);

    await expect(visitante().reuniaoAberta.ver({ token })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(visitante().reuniaoAberta.entrar({ token, senha: outraSenha(senha!) })).resolves.toEqual({ entrou: false, motivo: "senha" });
    expect(gravados).toEqual([]);
    // A senha chega como a tela a manda: os algarismos do teclado árabe valem como 0-9.
    const emArabe = senha!.replace(/[0-9]/g, d => String.fromCodePoint(0x0660 + Number(d)));
    await expect(visitante().reuniaoAberta.entrar({ token, senha: emArabe })).resolves.toEqual({ entrou: true });
    expect(gravados).toHaveLength(1);
    expect(gravados[0].opcoes).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: true, maxAge: DURACAO_DA_ENTRADA_MS });
    const cookie = `${gravados[0].nome}=${gravados[0].valor}`;
    await expect(visitante(cookie).reuniaoAberta.ver({ token })).resolves.toMatchObject({ titulo: `Reunião ${COM_SENHA.slice(0, 8)}` });
    await expect(visitante(cookie).reuniaoAberta.resumoGuardado({ token })).resolves.toBeDefined();
  });

  it("link que não existe, desligado, sem senha ou cortado: a mesma resposta da senha errada", async () => {
    const [antigo] = await (await getDb())!.select({ token: meetings.shareToken }).from(meetings).where(eq(meetings.id, ANTIGO));
    // Um link com senha que a dona desligou: nem a senha que valia abre.
    const desligado = await ligarLinkAbertoComOpcoes(DONA, DESLIGADO, PROVA, { comSenha: true });
    await desligarLinkAberto(DONA, DESLIGADO);
    const casos = [
      ["não existe", gerarTokenDoLink(), "482913"], ["desligado", desligado.token, desligado.senha!],
      ["sem senha", antigo.token!, "482913"], ["cortado", "abc", "482913"],
    ] as const;
    for (const [caso, token, senha] of casos) {
      expect(await entrarNoLink(token, senha, `198.51.100.${caso.length}`), caso).toEqual({ entrou: false, motivo: "senha" });
    }
  });

  it(`o teto do link: ${TENTATIVAS_LIVRES} erradas seguidas, de redes diferentes, e a seguinte espera, até com a senha certa; a espera dobra; a certa depois dela entra e zera`, async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    const errada = outraSenha(senha!);
    const bloqueiosAntes = (await auditoria(ACAO_LINK_BLOQUEADO, COM_SENHA)).length;
    const T0 = Date.now();
    for (let i = 0; i < TENTATIVAS_LIVRES; i++) {
      expect(await entrarNoLink(token, errada, `198.51.100.${10 + i}`, T0)).toEqual({ entrou: false, motivo: "senha" });
    }
    expect(await linhaDoLink(COM_SENHA)).toMatchObject({ falhas: TENTATIVAS_LIVRES, ultimaFalhaEm: T0, bloqueadoAte: T0 + ESPERA_INICIAL_MS });
    // A senha certa, de outra rede, na espera: nem é conferida.
    expect(await entrarNoLink(token, senha!, "198.51.100.40", T0 + 1000)).toEqual({ entrou: false, motivo: "espera", segundos: 59 });

    // O começo da espera vai à auditoria, com o IP de quem a abriu; sem a senha.
    const bloqueios = (await auditoria(ACAO_LINK_BLOQUEADO, COM_SENHA)).slice(bloqueiosAntes);
    expect(bloqueios).toHaveLength(1);
    expect(bloqueios[0]).toMatchObject({
      userId: null, resource: "meetings", ipAddress: `198.51.100.${10 + TENTATIVAS_LIVRES - 1}`, status: "blocked", riskLevel: "medium",
      details: { falhasSeguidas: TENTATIVAS_LIVRES, esperaSegundos: ESPERA_INICIAL_MS / 1000 },
    });
    expect(JSON.stringify(bloqueios[0])).not.toContain(senha!);

    // Passada a espera, mais uma errada dobra a espera.
    const T1 = T0 + ESPERA_INICIAL_MS + 1000;
    expect(await entrarNoLink(token, errada, "198.51.100.41", T1)).toEqual({ entrou: false, motivo: "senha" });
    expect((await linhaDoLink(COM_SENHA)).bloqueadoAte).toBe(T1 + 2 * ESPERA_INICIAL_MS);
    expect(await entrarNoLink(token, senha!, "198.51.100.42", T1 + 1000)).toMatchObject({ entrou: false, motivo: "espera" });

    // Passada a segunda, a certa entra e o freio volta a zero.
    const T2 = T1 + 2 * ESPERA_INICIAL_MS + 1000;
    expect(await entrarNoLink(token, senha!, "198.51.100.43", T2)).toMatchObject({ entrou: true });
    expect(await linhaDoLink(COM_SENHA)).toMatchObject({ falhas: 0, ultimaFalhaEm: null, bloqueadoAte: null });
  });

  it(`tentativas em paralelo: a linha travada as enfileira, e só ${TENTATIVAS_LIVRES} são conferidas antes da espera`, async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    const T0 = Date.now();
    const resultados = await Promise.all(Array.from({ length: TENTATIVAS_LIVRES + 3 }, (_, i) =>
      entrarNoLink(token, outraSenha(senha!), `192.0.2.${i + 1}`, T0)));
    expect(resultados.filter(r => !r.entrou && r.motivo === "senha")).toHaveLength(TENTATIVAS_LIVRES);
    expect(resultados.filter(r => !r.entrou && r.motivo === "espera")).toHaveLength(3);
    expect((await linhaDoLink(COM_SENHA)).falhas).toBe(TENTATIVAS_LIVRES);
  });

  it("o teto da rede: quem varre links de uma rede só espera na 6ª, inclusive no link certo com a senha certa; outra rede segue", async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    // O IPv6 conta pelo /56: trocar o fim do endereço não dá tentativas novas.
    for (let i = 0; i < TENTATIVAS_LIVRES; i++) {
      expect(await entrarNoLink(gerarTokenDoLink(), "482913", `2001:db8:0:1::${i + 1}`)).toEqual({ entrou: false, motivo: "senha" });
    }
    expect(await entrarNoLink(token, senha!, "2001:db8:0:2::99")).toMatchObject({ entrou: false, motivo: "espera" });
    // O link não pagou pelas tentativas nos outros links, e a outra rede entra.
    expect((await linhaDoLink(COM_SENHA)).falhas).toBe(0);
    expect(await entrarNoLink(token, senha!, "2001:db8:1::1")).toMatchObject({ entrou: true });
  });

  it("trocar a senha invalida a anterior: a senha velha não entra, e quem entrou com ela perde a entrada", async () => {
    const { token, senha: antiga } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    const cookieAntigo = await entrarDeVerdade(token, antiga!, "203.0.113.40");
    await entrarNoLink(token, outraSenha(antiga!), "203.0.113.41");
    expect((await linhaDoLink(COM_SENHA)).falhas).toBe(1);

    const nova = await novaSenhaDoLink(DONA, COM_SENHA, PROVA);
    expect(nova).toMatch(/^[0-9]{6}$/);
    // Senha nova, freio zerado e o mesmo link.
    expect(await linhaDoLink(COM_SENHA)).toMatchObject({ shareToken: token, falhas: 0 });
    if (nova !== antiga) expect(await entrarNoLink(token, antiga!, "203.0.113.42")).toEqual({ entrou: false, motivo: "senha" });
    expect((await recusaDe(comCookiesDoPedido(cookieAntigo, () => verReuniaoPeloLink(token)))).codigo).toBe("UNAUTHORIZED");
    expect((await pedirAudio(token, cookieAntigo)).status).toBe(404);
    const cookieNovo = await entrarDeVerdade(token, nova, "203.0.113.43");
    await expect(comCookiesDoPedido(cookieNovo, () => verReuniaoPeloLink(token))).resolves.toMatchObject({ audioIncluido: true });

    const linhas = await auditoria(ACAO_SENHA_DO_LINK_LIGADA, COM_SENHA);
    expect(linhas.at(-1)).toMatchObject({ userId: PROVA.userId, ipAddress: PROVA.ipAddress, userAgent: PROVA.userAgent, details: { troca: true } });
    expect(JSON.stringify(linhas)).not.toContain(nova);
  });

  it("tirar a senha: o link volta a abrir sem ela; pôr de novo pede a senha nova", async () => {
    const { token } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    await tirarSenhaDoLink(DONA, COM_SENHA, PROVA);
    expect((await linhaDoLink(COM_SENHA)).hash).toBeNull();
    await expect(verReuniaoPeloLink(token)).resolves.toMatchObject({ audioIncluido: true });
    expect((await pedirAudio(token)).status).toBe(307);
    expect(await auditoria(ACAO_SENHA_DO_LINK_TIRADA, COM_SENHA)).toHaveLength(1);
    // Tirar o que não existe não é erro nem vai à auditoria.
    await tirarSenhaDoLink(DONA, COM_SENHA, PROVA);
    expect(await auditoria(ACAO_SENHA_DO_LINK_TIRADA, COM_SENHA)).toHaveLength(1);

    const senha = await novaSenhaDoLink(DONA, COM_SENHA, PROVA);
    expect((await recusaDe(verReuniaoPeloLink(token))).codigo).toBe("UNAUTHORIZED");
    expect((await auditoria(ACAO_SENHA_DO_LINK_LIGADA, COM_SENHA)).at(-1)!.details).toEqual({ troca: false });
    await expect(entrarNoLink(token, senha, "203.0.113.50")).resolves.toMatchObject({ entrou: true });
  });

  it("sem o áudio, o servidor recusa o áudio: a página não traz a gravação e a rota responde 404, também com a senha certa", async () => {
    const semSenha = await ligarLinkAbertoComOpcoes(DONA, SEM_AUDIO, PROVA, { incluirAudio: false });
    expect(semSenha.senha).toBeNull();
    expect(await verReuniaoPeloLink(semSenha.token)).toMatchObject({ gravacao: null, gravacaoExpirada: false, gravacaoSaindo: false, audioIncluido: false });
    expect(await chaveDoAudioDoLink(semSenha.token)).toBeNull();
    assinar.mockClear();
    expect((await pedirAudio(semSenha.token)).status).toBe(404);
    expect(assinar).not.toHaveBeenCalled();
    expect((await getPrivateMeeting(DONA, SEM_AUDIO))?.meeting).toMatchObject({ linkComSenha: false, linkComAudio: false });

    // Com senha e sem o áudio: a entrada certa abre o texto, e o áudio continua fora.
    await desligarLinkAberto(DONA, SEM_AUDIO);
    const comSenha = await ligarLinkAbertoComOpcoes(DONA, SEM_AUDIO, PROVA, { comSenha: true, incluirAudio: false });
    const cookie = await entrarDeVerdade(comSenha.token, comSenha.senha!, "203.0.113.60");
    expect(await comCookiesDoPedido(cookie, () => verReuniaoPeloLink(comSenha.token))).toMatchObject({ gravacao: null, audioIncluido: false });
    expect((await pedirAudio(comSenha.token, cookie)).status).toBe(404);

    // A dona devolve o áudio ao link: volta na hora, com a auditoria.
    await mudarAudioDoLink(DONA, SEM_AUDIO, true, PROVA);
    expect((await pedirAudio(comSenha.token, cookie)).status).toBe(307);
    expect(await comCookiesDoPedido(cookie, () => verReuniaoPeloLink(comSenha.token))).toMatchObject({ audioIncluido: true, gravacao: { durationSeconds: 90 } });
    await mudarAudioDoLink(DONA, SEM_AUDIO, false, PROVA);
    expect((await pedirAudio(comSenha.token, cookie)).status).toBe(404);
    const linhas = await auditoria(ACAO_AUDIO_DO_LINK, SEM_AUDIO);
    expect(linhas.map(linha => linha.details)).toEqual([{ incluirAudio: true }, { incluirAudio: false }]);
  });

  it("o link ligado antes da H23 segue sem senha e com o áudio; ligar pela aba antiga também", async () => {
    const [antigo] = await (await getDb())!.select({ token: meetings.shareToken }).from(meetings).where(eq(meetings.id, ANTIGO));
    expect(await linhaDoLink(ANTIGO)).toMatchObject({ hash: null, audio: true, falhas: 0, bloqueadoAte: null });
    await expect(verReuniaoPeloLink(antigo.token!)).resolves.toMatchObject({ audioIncluido: true, gravacao: { durationSeconds: 90 } });
    expect(await chaveDoAudioDoLink(antigo.token!)).toBe(chave(ANTIGO));
    expect((await getPrivateMeeting(DONA, ANTIGO))?.meeting).toMatchObject({ linkComSenha: false, linkComAudio: true });

    // A aba aberta antes do deploy liga sem escolher nada: sem senha e com o áudio.
    const token = await ligarLinkAberto(DONA, DESLIGADO, PROVA);
    expect(await linhaDoLink(DESLIGADO)).toMatchObject({ shareToken: token, hash: null, audio: true });
    await expect(verReuniaoPeloLink(token)).resolves.toMatchObject({ audioIncluido: true });
  });

  it("outra dona leva NOT_FOUND em tudo, e nada muda; link desligado é PRECONDITION_FAILED", async () => {
    const { token } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    const antes = await linhaDoLink(COM_SENHA);
    expect((await recusaDe(novaSenhaDoLink(OUTRA, COM_SENHA, PROVA_DA_OUTRA))).codigo).toBe("NOT_FOUND");
    expect((await recusaDe(tirarSenhaDoLink(OUTRA, COM_SENHA, PROVA_DA_OUTRA))).codigo).toBe("NOT_FOUND");
    expect((await recusaDe(mudarAudioDoLink(OUTRA, COM_SENHA, false, PROVA_DA_OUTRA))).codigo).toBe("NOT_FOUND");
    expect((await recusaDe(ligarLinkAbertoComOpcoes(OUTRA, COM_SENHA, { ...PROVA, userId: PROVA_DA_OUTRA.userId }, { comSenha: false }))).codigo).toBe("NOT_FOUND");
    expect((await recusaDe(desligarLinkAberto(OUTRA, COM_SENHA))).codigo).toBe("NOT_FOUND");
    expect(await linhaDoLink(COM_SENHA)).toEqual(antes);
    expect((await recusaDe(verReuniaoPeloLink(token))).codigo).toBe("UNAUTHORIZED");
    const daOutra = await (await getDb())!.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.userId, PROVA_DA_OUTRA.userId));
    expect(daOutra).toEqual([]);

    // Com o link desligado não há senha nem áudio para mudar.
    for (const mudar of [() => novaSenhaDoLink(DONA, DESLIGADO, PROVA), () => tirarSenhaDoLink(DONA, DESLIGADO, PROVA), () => mudarAudioDoLink(DONA, DESLIGADO, false, PROVA)]) {
      expect((await recusaDe(mudar())).codigo).toBe("PRECONDITION_FAILED");
    }
  });

  it("desligar apaga a senha e o freio: o endereço antigo some, e o link novo sai com o que a dona escolher", async () => {
    const { token, senha } = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: true });
    const cookie = await entrarDeVerdade(token, senha!, "203.0.113.70");
    await entrarNoLink(token, outraSenha(senha!), "203.0.113.71");
    await desligarLinkAberto(DONA, COM_SENHA);
    expect(await linhaDoLink(COM_SENHA)).toMatchObject({ shareToken: null, hash: null, falhas: 0, bloqueadoAte: null });
    expect((await recusaDe(comCookiesDoPedido(cookie, () => verReuniaoPeloLink(token)))).codigo).toBe("NOT_FOUND");
    const novo = await ligarLinkAbertoComOpcoes(DONA, COM_SENHA, PROVA, { comSenha: false });
    expect(novo.senha).toBeNull();
    await expect(verReuniaoPeloLink(novo.token)).resolves.toMatchObject({ audioIncluido: true });
  });
});
