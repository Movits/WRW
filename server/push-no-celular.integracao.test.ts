import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { dispositivosDePush, platformNotifications, sessions, users } from "../drizzle/schema";
import { APARELHOS_POR_CONTA, registrarDispositivo, removerDispositivo, rodarPushUmaVez, type EnviarAoExpo, type MensagemDoExpo } from "./push-no-celular";
import { apagarPelaChave } from "./test/apagar-pela-chave";

/**
 * O push no celular contra o MariaDB de teste (DATABASE_URL_TESTES; pulado sem
 * ele): o token preso à sessão, a reserva de cada aviso (um push só, mesmo com
 * duas rodadas), a sessão que caiu cortando o push, o aviso velho e o tipo que
 * não vai, e o token que o Expo diz não existir mais. O Expo é um dublê.
 *
 * Contas fictícias com prefixo só desta execução; tudo é apagado no fim.
 */
const PREFIXO = `tp-${crypto.randomUUID().slice(0, 18)}`;
const temBanco = Boolean(process.env.DATABASE_URL_TESTES);

type Conta = { id: number; sessionToken: string; sessaoId: number };
const contas: Conta[] = [];
let dona: Conta;
let outra: Conta;

const token = (n: number | string) => `ExponentPushToken[${PREFIXO}-${n}]`.replace(/[^A-Za-z0-9_\-[\]]/g, "x");

async function criarConta(nome: string): Promise<Conta> {
  const db = (await getDb())!;
  const openId = `${PREFIXO}-${nome}`;
  await db.insert(users).values({ openId, email: `${openId}@exemplo.test`, name: `Teste ${nome}`, onboardingCompleted: true, isActive: true });
  const [conta] = await db.select({ id: users.id }).from(users).where(eq(users.openId, openId)).limit(1);
  const sessionToken = crypto.randomBytes(32).toString("hex");
  await db.insert(sessions).values({ userId: conta.id, sessionToken, expiresAt: new Date(Date.now() + 86_400_000), isActive: true });
  const [sessao] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.sessionToken, sessionToken)).limit(1);
  const criada = { id: conta.id, sessionToken, sessaoId: sessao.id };
  contas.push(criada);
  return criada;
}

async function avisar(userId: number, extra: Partial<typeof platformNotifications.$inferInsert> = {}) {
  const db = (await getDb())!;
  await db.insert(platformNotifications).values({
    userId, type: "reuniao_pronta", title: "Reunião", actionUrl: "/meetings/abc", parametros: { titulo: "Reunião", resumo: "pronto" }, isRead: false, ...extra,
  });
}

function duble(recibos?: (m: MensagemDoExpo) => { status: "ok" | "error"; details?: { error?: string } }) {
  const enviadas: MensagemDoExpo[] = [];
  const enviar: EnviarAoExpo = vi.fn(async mensagens => {
    enviadas.push(...mensagens);
    return mensagens.map(m => (recibos ? recibos(m) : { status: "ok" as const }));
  });
  return { enviar, enviadas };
}

const rodar = (enviar: EnviarAoExpo) => rodarPushUmaVez(enviar, Date.now(), { userIds: contas.map(c => c.id) });

describe.skipIf(!temBanco)("Push no celular", () => {
  beforeAll(async () => {
    dona = await criarConta("dona");
    outra = await criarConta("outra");
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    const ids = contas.map(c => c.id);
    if (!ids.length) return;
    await apagarPelaChave(db, dispositivosDePush, inArray(dispositivosDePush.userId, ids));
    await apagarPelaChave(db, platformNotifications, inArray(platformNotifications.userId, ids));
    await apagarPelaChave(db, sessions, inArray(sessions.userId, ids));
    await apagarPelaChave(db, users, inArray(users.id, ids));
  });

  it("guarda o token preso à sessão do pedido; token fora do formato ou sessão de outra conta é recusado", async () => {
    expect(await registrarDispositivo({ userId: dona.id, sessionToken: dona.sessionToken, token: token(1), plataforma: "android", idioma: "en-US" })).toEqual({ ok: true });
    expect(await registrarDispositivo({ userId: dona.id, sessionToken: dona.sessionToken, token: "qualquer", plataforma: "android", idioma: "pt" })).toEqual({ ok: false, erro: "TOKEN_INVALIDO" });
    expect(await registrarDispositivo({ userId: dona.id, sessionToken: outra.sessionToken, token: token(2), plataforma: "ios", idioma: "pt" })).toEqual({ ok: false, erro: "SEM_SESSAO" });
    const db = (await getDb())!;
    const [linha] = await db.select().from(dispositivosDePush).where(eq(dispositivosDePush.token, token(1)));
    expect(linha).toMatchObject({ userId: dona.id, sessaoId: dona.sessaoId, plataforma: "android", idioma: "en" });
  });

  it("o mesmo token mandado por outra conta passa para ela", async () => {
    await registrarDispositivo({ userId: outra.id, sessionToken: outra.sessionToken, token: token(1), plataforma: "android", idioma: "pt-BR" });
    const db = (await getDb())!;
    const linhas = await db.select().from(dispositivosDePush).where(eq(dispositivosDePush.token, token(1)));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ userId: outra.id, sessaoId: outra.sessaoId });
    // Volta para a dona, para os testes seguintes.
    await registrarDispositivo({ userId: dona.id, sessionToken: dona.sessionToken, token: token(1), plataforma: "android", idioma: "en" });
  });

  it("o aviso novo vai uma vez só, no idioma do aparelho, e a segunda rodada não repete", async () => {
    await avisar(dona.id);
    const primeira = duble();
    expect(await rodar(primeira.enviar)).toEqual({ enviados: 1 });
    expect(primeira.enviadas).toEqual([expect.objectContaining({ to: token(1), title: "Your meeting is ready", data: { url: "/meetings/abc" } })]);
    const segunda = duble();
    expect(await rodar(segunda.enviar)).toEqual({ enviados: 0 });
    expect(segunda.enviar).not.toHaveBeenCalled();
  });

  it("aviso de outro tipo ou mais velho que a janela não vai", async () => {
    const db = (await getDb())!;
    await avisar(dona.id, { type: "system", parametros: null });
    await avisar(dona.id, { createdAt: new Date(Date.now() - 60 * 60_000) });
    const { enviar } = duble();
    expect(await rodar(enviar)).toEqual({ enviados: 0 });
    // O aviso velho não foi reservado: fica nulo, como os de antes do deploy.
    const velhos = await db.select({ push: platformNotifications.pushEnviadoEm }).from(platformNotifications)
      .where(eq(platformNotifications.userId, dona.id));
    expect(velhos.filter(v => v.push === null)).toHaveLength(2);
  });

  it("o token que o Expo diz não existir mais sai", async () => {
    await registrarDispositivo({ userId: dona.id, sessionToken: dona.sessionToken, token: token(3), plataforma: "ios", idioma: "pt-BR" });
    await avisar(dona.id);
    const { enviar } = duble(m => (m.to === token(3) ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok" }));
    expect(await rodar(enviar)).toEqual({ enviados: 1 });
    const db = (await getDb())!;
    expect(await db.select().from(dispositivosDePush).where(eq(dispositivosDePush.token, token(3)))).toHaveLength(0);
  });

  it("a sessão que caiu (sair da conta) corta o push e o token sai", async () => {
    const db = (await getDb())!;
    await db.update(sessions).set({ isActive: false }).where(eq(sessions.id, dona.sessaoId));
    await avisar(dona.id);
    const { enviar } = duble();
    expect(await rodar(enviar)).toEqual({ enviados: 0 });
    expect(await db.select().from(dispositivosDePush).where(eq(dispositivosDePush.userId, dona.id))).toHaveLength(0);
  });

  it("remover tira só o token da própria conta", async () => {
    await registrarDispositivo({ userId: outra.id, sessionToken: outra.sessionToken, token: token(4), plataforma: "android", idioma: "pt-BR" });
    expect(await removerDispositivo({ userId: dona.id, token: token(4) })).toBe(false);
    expect(await removerDispositivo({ userId: outra.id, token: token(4) })).toBe(true);
  });

  it(`a conta fica com no máximo ${APARELHOS_POR_CONTA} aparelhos; o mais antigo sai`, async () => {
    for (let n = 0; n <= APARELHOS_POR_CONTA; n += 1) {
      await registrarDispositivo({ userId: outra.id, sessionToken: outra.sessionToken, token: token(`m${n}`), plataforma: "android", idioma: "pt-BR", agora: Date.now() + n });
    }
    const db = (await getDb())!;
    const linhas = await db.select({ token: dispositivosDePush.token }).from(dispositivosDePush).where(eq(dispositivosDePush.userId, outra.id));
    expect(linhas).toHaveLength(APARELHOS_POR_CONTA);
    expect(linhas.map(l => l.token)).not.toContain(token("m0"));
  });
});
