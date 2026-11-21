import { DrizzleQueryError, getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { auditLogs, meetings } from "../drizzle/schema";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * O que o módulo do link aberto decide sem o banco: o formato do token e o
 * endereço do áudio. As consultas estão em link-aberto-da-reuniao.integracao.test.ts,
 * contra um MariaDB de verdade.
 */

const consultasAoBanco = vi.hoisted(() => ({ total: 0, banco: null as unknown }));
vi.mock("./db", () => ({
  getDb: async () => null,
  exigirDb: async () => {
    consultasAoBanco.total += 1;
    if (consultasAoBanco.banco) return consultasAoBanco.banco;
    throw new Error("banco dublado: o teste conta quem chegou aqui");
  },
}));

const {
  chaveDoAudioDoLink,
  enderecoDoAudioDoLink,
  exigirReuniaoDoLink,
  gerarTokenDoLink,
  ligarLinkAberto,
  LinkAbertoRecusado,
  mudarAudioDoLink,
  novaSenhaDoLink,
  tirarSenhaDoLink,
  verReuniaoPeloLink,
} = await import("./link-aberto-da-reuniao");
const { comCookiesDoPedido, cookieDaEntrada } = await import("./senha-do-link-aberto");

describe("o token do link", () => {
  it("tem 32 caracteres de base64url (192 bits) e não se repete", () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => gerarTokenDoLink()));
    expect(tokens.size).toBe(2000);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("o áudio sai pela rota do link, com o token, sem chave do bucket", () => {
    expect(enderecoDoAudioDoLink("A".repeat(32))).toBe(`/reuniao-aberta/${"A".repeat(32)}/audio`);
  });
});

describe("token fora do formato não chega ao banco", () => {
  it.each([
    ["vazio", ""],
    ["curto (link cortado)", "A".repeat(31)],
    ["longo", "A".repeat(33)],
    ["com caractere fora do base64url", `${"A".repeat(31)}=`],
    ["com barra", `${"A".repeat(16)}/${"A".repeat(15)}`],
  ])("%s: NOT_FOUND sem consultar", async (_caso, token) => {
    consultasAoBanco.total = 0;
    await expect(verReuniaoPeloLink(token)).rejects.toBeInstanceOf(LinkAbertoRecusado);
    await expect(exigirReuniaoDoLink(token)).rejects.toMatchObject({ codigo: "NOT_FOUND" });
    await expect(chaveDoAudioDoLink(token)).resolves.toBeNull();
    expect(consultasAoBanco.total).toBe(0);
  });

  it("no formato, consulta: e a falha do banco sobe como erro, não vira 'link não encontrado'", async () => {
    consultasAoBanco.total = 0;
    await expect(verReuniaoPeloLink("A".repeat(32))).rejects.toThrow("banco dublado");
    await expect(chaveDoAudioDoLink("A".repeat(32))).rejects.toThrow("banco dublado");
    expect(consultasAoBanco.total).toBe(2);
  });
});

/**
 * A prova da autorização é o que deixa a voz das pessoas aberta: o link só
 * liga se a linha de auditoria entra. Aqui, uma transação dublada mostra que o
 * insert da auditoria está DENTRO dela e que a falha dele desfaz tudo; que o
 * banco de verdade desfaz o UPDATE no rollback é garantia do MySQL, e o caminho
 * feliz roda contra o MariaDB em link-aberto-da-reuniao.integracao.test.ts.
 */
describe("ligar: sem a linha de auditoria, o link não liga", () => {
  const PROVA = { userId: 7, ipAddress: "203.0.113.7", userAgent: "vitest", idioma: "pt-BR", textoExibido: "Confirmo." };

  function transacaoDublada(insert: () => Promise<unknown>) {
    const passos: string[] = [];
    const inserido: { valores?: { details?: unknown } } = {};
    // A linha como o banco a devolve: o link já ligado, sem senha e com o áudio (H23).
    const tx = {
      update: () => ({ set: () => ({ where: async () => { passos.push("update"); } }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => { passos.push("select"); return [{ status: "ready", shareToken: "A".repeat(32), sharePasswordHash: null, shareAudio: true }]; } }) }) }),
      insert: () => ({ values: async (valores: { details?: unknown }) => { passos.push("insert"); inserido.valores = valores; return insert(); } }),
    };
    const banco = {
      transaction: async (trabalho: (t: typeof tx) => Promise<unknown>) => {
        passos.push("begin");
        try {
          const resultado = await trabalho(tx);
          passos.push("commit");
          return resultado;
        } catch (erro) {
          passos.push("rollback");
          throw erro;
        }
      },
    };
    return { banco, passos, inserido };
  }

  it("o insert da auditoria falha: a transação volta atrás e ligar lança, sem devolver token", async () => {
    const { banco, passos } = transacaoDublada(async () => { throw new Error("audit_logs recusou"); });
    consultasAoBanco.banco = banco;
    try {
      await expect(ligarLinkAberto("dona", "reuniao", PROVA)).rejects.toThrow("audit_logs recusou");
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(passos).toEqual(["begin", "update", "select", "insert", "rollback"]);
  });

  it("a auditoria entra: ligar devolve o token, e a linha leva a frase, o idioma e o hash da frase", async () => {
    const { banco, passos, inserido } = transacaoDublada(async () => undefined);
    consultasAoBanco.banco = banco;
    try {
      await expect(ligarLinkAberto("dona", "reuniao", PROVA)).resolves.toBe("A".repeat(32));
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(passos).toEqual(["begin", "update", "select", "insert", "commit"]);
    const { createHash } = await import("node:crypto");
    // Sem a versão (a aba aberta antes da H3b, com a frase antiga), a linha leva a 1;
    // e diz como o link ficou (H23): aqui, sem senha e com o áudio.
    expect(inserido.valores?.details).toEqual({
      autorizacaoDasPessoas: true, versaoDaAutorizacao: 1, idioma: "pt-BR", textoExibido: "Confirmo.",
      textoHash: createHash("sha256").update("Confirmo.").digest("hex"),
      comSenha: false, incluirAudio: true,
    });
  });

  it("a caixa que fala dos nomes das vozes manda a versão 2, e a linha a guarda junto da frase (H3b)", async () => {
    const { banco, inserido } = transacaoDublada(async () => undefined);
    consultasAoBanco.banco = banco;
    try {
      await expect(ligarLinkAberto("dona", "reuniao", { ...PROVA, versaoDaAutorizacao: 2 })).resolves.toBe("A".repeat(32));
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(inserido.valores?.details).toMatchObject({ autorizacaoDasPessoas: true, versaoDaAutorizacao: 2, textoExibido: "Confirmo." });
  });

  it("versão fora da lista não vira 2: só a caixa nova grava a versão que mostra os nomes", async () => {
    const { banco, inserido } = transacaoDublada(async () => undefined);
    consultasAoBanco.banco = banco;
    try {
      await ligarLinkAberto("dona", "reuniao", { ...PROVA, versaoDaAutorizacao: 3 as never });
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(inserido.valores?.details).toMatchObject({ versaoDaAutorizacao: 1 });
  });
});

/**
 * A leitura da confirmação da dona (H3b) é a consulta mais pesada da página do
 * link (ORDER BY id DESC em audit_logs). Se o banco cai nela, e só nela, ver
 * sobe o erro: um `vozes: {}` no lugar mostraria "Falante n" a quem tem o link,
 * e ninguém veria a queda. Aqui cada tabela responde o que o teste combina, e
 * as outras não têm linha; o caminho feliz contra o MariaDB está em
 * link-aberto-da-reuniao.integracao.test.ts.
 */
describe("ver pelo link: a leitura da confirmação da dona cai (H3b)", () => {
  const TOKEN = "A".repeat(32);
  // O link sem senha e com o áudio, como a linha sai do banco (H23).
  const REUNIAO_DO_LINK = {
    id: "reuniao", ownerId: "dona", title: "Reunião", status: "ready", createdAt: Date.now(), shareToken: TOKEN,
    audioPipeline: "single", contaAtiva: true, speakerNames: { F1: "Ana" }, sharePasswordHash: null, shareAudio: true,
  };

  /** A cadeia do drizzle (join, where, orderBy, limit ou o await direto) termina na resposta da tabela. */
  function bancoPorTabela(respostas: Map<unknown, () => Promise<unknown[]>>) {
    const consulta = (tabela: unknown) => {
      const responder = () => (respostas.get(tabela) ?? (async () => []))();
      const elo: Record<string, unknown> = {};
      Object.assign(elo, {
        innerJoin: () => elo,
        where: () => elo,
        orderBy: () => elo,
        limit: () => responder(),
        then: (resolver: (linhas: unknown[]) => unknown, rejeitar: (motivo: unknown) => unknown) => responder().then(resolver, rejeitar),
      });
      return elo;
    };
    return { select: () => ({ from: (tabela: unknown) => consulta(tabela) }) };
  }

  async function verCom(auditoria: () => Promise<unknown[]>) {
    consultasAoBanco.banco = bancoPorTabela(new Map<unknown, () => Promise<unknown[]>>([
      [meetings, async () => [REUNIAO_DO_LINK]],
      [auditLogs, auditoria],
    ]));
    try {
      return await verReuniaoPeloLink(TOKEN);
    } finally {
      consultasAoBanco.banco = null;
    }
  }

  it("com a confirmação que fala dos nomes, o mesmo banco dublado traz os nomes: a leitura chega à auditoria", async () => {
    await expect(verCom(async () => [{ details: { autorizacaoDasPessoas: true, versaoDaAutorizacao: 2 } }])).resolves.toMatchObject({ vozes: { F1: "Ana" } });
  });

  it("o banco cai na leitura da auditoria: ver sobe o erro do driver, e não devolve a reunião com vozes vazio", async () => {
    const queda = new DrizzleQueryError(
      "select `details` from `audit_logs` where (`audit_logs`.`action` = ? and `audit_logs`.`resourceId` = ?) order by `audit_logs`.`id` desc limit ?",
      ["MEETING_OPEN_LINK_ON", "reuniao", 1],
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3306"), { code: "ECONNREFUSED" }),
    );
    await expect(verCom(async () => { throw queda; })).rejects.toBe(queda);
  });
});

/**
 * A senha e o áudio do link (H23) no que o módulo decide sem o banco: o link
 * com senha não lê nada da reunião sem a entrada de quem a acertou, e o link
 * sem o áudio nem consulta a gravação. Cada tabela responde o que o teste
 * combina, e o teste vê quais foram consultadas; o caminho inteiro, contra o
 * MariaDB, está em link-com-senha.integracao.test.ts.
 */
describe("a senha e o áudio do link (H23), com o banco dublado", () => {
  const TOKEN = "B".repeat(32);
  const HASH = "scrypt$16384$8$1$c2FsLWRvLXRlc3Rl$aGFzaC1kby10ZXN0ZS1jb20tMzItYnl0ZXMtYWJj";
  const LINHA = {
    id: "reuniao", ownerId: "dona", title: "Reunião", status: "ready", createdAt: Date.now(), shareToken: TOKEN,
    audioPipeline: "single", contaAtiva: true, speakerNames: null, sharePasswordHash: null as string | null, shareAudio: true,
  };
  const GRAVACAO = { id: "g", storageKey: "meetings/dona/reuniao/recording.mp4", storageUrl: "/manus-storage/x", mimeType: "audio/mp4", durationSeconds: 60, expiresAt: Date.now() + 86_400_000, createdAt: 1 };

  function bancoQueAnota(linha: typeof LINHA) {
    const consultadas: string[] = [];
    const consulta = (tabela: unknown) => {
      const nome = getTableName(tabela as typeof meetings);
      consultadas.push(nome);
      const responder = async () => (nome === "meetings" ? [linha] : nome === "meeting_recordings" ? [GRAVACAO] : []);
      const elo: Record<string, unknown> = {};
      Object.assign(elo, {
        innerJoin: () => elo, where: () => elo, orderBy: () => elo, limit: () => responder(),
        then: (resolver: (linhas: unknown[]) => unknown, rejeitar: (motivo: unknown) => unknown) => responder().then(resolver, rejeitar),
      });
      return elo;
    };
    return { banco: { select: () => ({ from: (tabela: unknown) => consulta(tabela) }) }, consultadas };
  }

  async function comBanco<T>(linha: typeof LINHA, trabalho: () => Promise<T>) {
    const { banco, consultadas } = bancoQueAnota(linha);
    consultasAoBanco.banco = banco;
    try {
      return { resultado: await trabalho().catch(erro => erro), consultadas };
    } finally {
      consultasAoBanco.banco = null;
    }
  }

  it("com senha e sem a entrada, ver recusa com UNAUTHORIZED depois de ler só a linha do link: nem transcrição, nem gravação", async () => {
    const { resultado, consultadas } = await comBanco({ ...LINHA, sharePasswordHash: HASH }, () => verReuniaoPeloLink(TOKEN));
    expect(resultado).toBeInstanceOf(LinkAbertoRecusado);
    expect(resultado).toMatchObject({ codigo: "UNAUTHORIZED" });
    expect(consultadas).toEqual(["meetings"]);
    const audio = await comBanco({ ...LINHA, sharePasswordHash: HASH }, () => chaveDoAudioDoLink(TOKEN));
    expect(audio.resultado).toBeNull();
    expect(audio.consultadas).toEqual(["meetings"]);
  });

  it("com senha e a entrada de quem a acertou (o cookie, no contexto do pedido), ver abre e o áudio sai", async () => {
    const entrada = cookieDaEntrada(TOKEN, HASH);
    const cookies = `outro=1; ${entrada.nome}=${entrada.valor}`;
    const { resultado } = await comBanco({ ...LINHA, sharePasswordHash: HASH }, () => comCookiesDoPedido(cookies, () => verReuniaoPeloLink(TOKEN)));
    expect(resultado).toMatchObject({ titulo: "Reunião", audioIncluido: true, gravacao: { url: `/reuniao-aberta/${TOKEN}/audio` } });
    const audio = await comBanco({ ...LINHA, sharePasswordHash: HASH }, () => comCookiesDoPedido(cookies, () => chaveDoAudioDoLink(TOKEN)));
    expect(audio.resultado).toBe(GRAVACAO.storageKey);
  });

  it("a entrada de outro link, ou da senha anterior, não abre: o cookie é preso ao token e ao hash", async () => {
    const deOutroLink = cookieDaEntrada("C".repeat(32), HASH);
    const daSenhaAnterior = cookieDaEntrada(TOKEN, `${HASH}x`);
    for (const entrada of [deOutroLink, daSenhaAnterior]) {
      // O nome do cookie de outro link é outro; aqui ele vai com o nome deste link, para só a assinatura decidir.
      const cookies = `${cookieDaEntrada(TOKEN, HASH).nome}=${entrada.valor}`;
      const { resultado } = await comBanco({ ...LINHA, sharePasswordHash: HASH }, () => comCookiesDoPedido(cookies, () => verReuniaoPeloLink(TOKEN)));
      expect(resultado).toMatchObject({ codigo: "UNAUTHORIZED" });
    }
  });

  it("sem o áudio, ver nem consulta a gravação, e a rota do áudio não acha chave", async () => {
    const { resultado, consultadas } = await comBanco({ ...LINHA, shareAudio: false }, () => verReuniaoPeloLink(TOKEN));
    expect(resultado).toMatchObject({ gravacao: null, gravacaoExpirada: false, gravacaoSaindo: false, audioIncluido: false });
    expect(consultadas).not.toContain("meeting_recordings");
    expect(consultadas).not.toContain("meeting_audio_slices");
    const audio = await comBanco({ ...LINHA, shareAudio: false }, () => chaveDoAudioDoLink(TOKEN));
    expect(audio.resultado).toBeNull();
    expect(audio.consultadas).toEqual(["meetings"]);
  });

  /** A transação da dona: a linha travada (select ... for update), o UPDATE e a auditoria. */
  function transacaoDaDona(linha: Record<string, unknown> | undefined, insert: () => Promise<unknown>) {
    const passos: string[] = [];
    const inserido: { valores?: Record<string, unknown> } = {};
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async (modo: string) => { passos.push(`select ${modo}`); return linha ? [linha] : []; } }) }) }) }),
      update: () => ({ set: (valores: Record<string, unknown>) => ({ where: async () => { passos.push(`update ${Object.keys(valores).sort().join(",")}`); } }) }),
      insert: () => ({ values: async (valores: Record<string, unknown>) => { passos.push("insert"); inserido.valores = valores; return insert(); } }),
    };
    const banco = {
      transaction: async (trabalho: (t: typeof tx) => Promise<unknown>) => {
        passos.push("begin");
        try {
          const resultado = await trabalho(tx);
          passos.push("commit");
          return resultado;
        } catch (erro) {
          passos.push("rollback");
          throw erro;
        }
      },
    };
    return { banco, passos, inserido };
  }
  const PROVA = { userId: 7, ipAddress: "203.0.113.7", userAgent: "vitest" };
  const LIGADO = { status: "ready", shareToken: TOKEN, sharePasswordHash: null, shareAudio: true };

  it("senha nova: a auditoria falha, a transação volta atrás e a senha não sai", async () => {
    const { banco, passos } = transacaoDaDona(LIGADO, async () => { throw new Error("audit_logs recusou"); });
    consultasAoBanco.banco = banco;
    try {
      await expect(novaSenhaDoLink("dona", "reuniao", PROVA)).rejects.toThrow("audit_logs recusou");
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(passos).toEqual([
      "begin", "select update",
      "update sharePasswordFailedAt,sharePasswordFailures,sharePasswordHash,sharePasswordLockedUntil",
      "insert", "rollback",
    ]);
  });

  it("senha nova: com a auditoria, sai a senha de 6 dígitos, e a linha diz se foi troca, sem a senha nem o hash", async () => {
    const { banco, passos, inserido } = transacaoDaDona({ ...LIGADO, sharePasswordHash: HASH }, async () => undefined);
    consultasAoBanco.banco = banco;
    let senha = "";
    try {
      senha = await novaSenhaDoLink("dona", "reuniao", PROVA);
    } finally {
      consultasAoBanco.banco = null;
    }
    expect(senha).toMatch(/^[0-9]{6}$/);
    expect(passos.at(-1)).toBe("commit");
    expect(inserido.valores).toMatchObject({ userId: 7, action: "MEETING_OPEN_LINK_PASSWORD_ON", resourceId: "reuniao", ipAddress: "203.0.113.7", details: { troca: true } });
    expect(JSON.stringify(inserido.valores)).not.toContain(senha);
    expect(JSON.stringify(inserido.valores)).not.toContain("scrypt");
  });

  it("tirar a senha e mudar o áudio: a auditoria que falha desfaz a mudança; pedir o que já está não grava nada", async () => {
    for (const [nome, chamar, linha] of [
      ["tirar", () => tirarSenhaDoLink("dona", "reuniao", PROVA), { ...LIGADO, sharePasswordHash: HASH }],
      ["áudio", () => mudarAudioDoLink("dona", "reuniao", false, PROVA), LIGADO],
    ] as const) {
      const { banco, passos } = transacaoDaDona(linha, async () => { throw new Error("audit_logs recusou"); });
      consultasAoBanco.banco = banco;
      try {
        await expect(chamar(), nome).rejects.toThrow("audit_logs recusou");
      } finally {
        consultasAoBanco.banco = null;
      }
      expect(passos.at(-1), nome).toBe("rollback");
    }
    for (const [nome, chamar, linha] of [
      ["tirar sem senha", () => tirarSenhaDoLink("dona", "reuniao", PROVA), LIGADO],
      ["áudio igual", () => mudarAudioDoLink("dona", "reuniao", true, PROVA), LIGADO],
    ] as const) {
      const { banco, passos } = transacaoDaDona(linha, async () => undefined);
      consultasAoBanco.banco = banco;
      try {
        await chamar();
      } finally {
        consultasAoBanco.banco = null;
      }
      expect(passos, nome).toEqual(["begin", "select update", "commit"]);
    }
  });

  it("link desligado ou reunião de outra dona: recusa antes de gravar, com o código que a tela traduz", async () => {
    for (const [linha, codigo] of [[undefined, "NOT_FOUND"], [{ ...LIGADO, status: "deleted" }, "NOT_FOUND"], [{ ...LIGADO, shareToken: null }, "PRECONDITION_FAILED"]] as const) {
      const { banco, passos } = transacaoDaDona(linha, async () => undefined);
      consultasAoBanco.banco = banco;
      try {
        await expect(novaSenhaDoLink("dona", "reuniao", PROVA)).rejects.toMatchObject({ codigo });
      } finally {
        consultasAoBanco.banco = null;
      }
      expect(passos).toEqual(["begin", "select update", "rollback"]);
    }
  });
});
