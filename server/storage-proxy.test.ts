import { describe, expect, it } from "vitest";
import { podeBaixarChave, type BuscarSala } from "./_core/storageProxy";
import { storagePut } from "./storage";

process.env.JWT_SECRET ??= "jwt-secret-somente-para-testes";

/**
 * A matriz de posse do proxy de arquivos.
 *
 * Existe por causa de um furo real: a rota /manus-storage/* redirecionava
 * QUALQUER requisição, sem sessão, para a URL assinada — documento de Deal
 * Room sob NDA e RG do SIVC a um GET anônimo de distância. A autenticação é
 * testada pela rota (401 antes de tudo); aqui se trava a segunda pergunta,
 * "o arquivo é seu?", que é lógica pura e injetável.
 */

const bronze = { id: 10, openId: "email_bronze", role: "bronze" as string | null };
const ouro = { id: 20, openId: "email_ouro", role: "gold" as string | null };
const dona = { id: 30, openId: "email_dona", role: "silver" as string | null };

const salaDe = (ownerId: number, interestedId: number): BuscarSala =>
  async roomId => (roomId === 77 ? { ownerId, interestedId } : null);
const semSala: BuscarSala = async () => null;

describe("Storage — quem pode baixar o quê", () => {
  it("gravação de reunião: só a dona", async () => {
    const chave = "meetings/email_dona/m-1/recording.webm";
    expect(await podeBaixarChave(dona, chave, semSala)).toBe(true);
    expect(await podeBaixarChave(bronze, chave, semSala)).toBe(false);
    // nem Ouro: reunião é da agenda particular, não há papel que atravesse
    expect(await podeBaixarChave(ouro, chave, semSala)).toBe(false);
  });

  it("foto ou documento de contexto: só a dona", async () => {
    const chave = "contexts/email_dona/ctx-1/foto_ab12cd34.jpg";
    expect(await podeBaixarChave(dona, chave, semSala)).toBe(true);
    expect(await podeBaixarChave(bronze, chave, semSala)).toBe(false);
    // nem Ouro: contexto é da agenda particular, como a reunião
    expect(await podeBaixarChave(ouro, chave, semSala)).toBe(false);
  });

  it("documento do SIVC (RG, CPF): só a dona", async () => {
    const chave = "sivc/30/ver-1/1700000000-rg.png";
    expect(await podeBaixarChave(dona, chave, semSala)).toBe(true);
    expect(await podeBaixarChave(bronze, chave, semSala)).toBe(false);
    expect(await podeBaixarChave(ouro, chave, semSala)).toBe(false);
  });

  it("deal room: as partes da sala sim, estranha não", async () => {
    const chave = "deal-rooms/77/1700000000-contrato.pdf";
    const sala = salaDe(dona.id, 40);
    expect(await podeBaixarChave(dona, chave, sala)).toBe(true);     // parte
    expect(await podeBaixarChave(bronze, chave, sala)).toBe(false);  // estranha
  });

  it("deal room: Ouro+ acessa — espelho da política atual do tRPC, não decisão nova", async () => {
    // Se a decisão de produto pendente sobre a Deal Room mudar a régua, este
    // teste e o dealRoom.ts mudam juntos.
    const chave = "deal-rooms/77/1700000000-contrato.pdf";
    expect(await podeBaixarChave(ouro, chave, salaDe(1, 2))).toBe(true);
  });

  it("deal room: sala inexistente ou id malformado negam", async () => {
    expect(await podeBaixarChave(dona, "deal-rooms/999/x.pdf", semSala)).toBe(false);
    expect(await podeBaixarChave(dona, "deal-rooms/abc/x.pdf", semSala)).toBe(false);
    expect(await podeBaixarChave(dona, "deal-rooms/-1/x.pdf", semSala)).toBe(false);
  });

  it("imagem gerada: qualquer logada", async () => {
    expect(await podeBaixarChave(bronze, "generated/1700000000.png", semSala)).toBe(true);
  });

  it("prefixo desconhecido: NEGADO por padrão — regra nova exige código novo", async () => {
    expect(await podeBaixarChave(ouro, "outra-coisa/arquivo.pdf", semSala)).toBe(false);
    expect(await podeBaixarChave(ouro, "opportunities/1/doc.pdf", semSala)).toBe(false);
    expect(await podeBaixarChave(ouro, "", semSala)).toBe(false);
  });

  it("amostra do perfil de voz (H3d): NEGADA a todas, inclusive à dona, Ouro e presidente", async () => {
    // A amostra só sai pelo perfilDeVoz.ouvir (URL assinada curta, da própria
    // dona). Se alguém escrever aqui uma regra para perfis-de-voz/, este teste
    // quebra de propósito: a garantia não pode depender do "prefixo desconhecido".
    const chave = "perfis-de-voz/email_dona/amostra.webm";
    const presidente = { id: 40, openId: "email_presidente", role: "president" as string | null };
    const admin = { id: 50, openId: "email_admin", role: "admin" as string | null };
    for (const quem of [dona, bronze, ouro, presidente, admin]) {
      expect(await podeBaixarChave(quem, chave, semSala)).toBe(false);
    }
  });

  it("um openId não vira dono de reunião alheia por prefixo parcial", async () => {
    // email_dona NÃO pode casar com email_dona_2
    const chave = "meetings/email_dona_2/m-9/recording.webm";
    expect(await podeBaixarChave(dona, chave, semSala)).toBe(false);
  });
});

describe("Storage — configuração", () => {
  it.skipIf(Boolean(process.env.STORAGE_BUCKET))(
    "sem variáveis, o erro nomeia as variáveis CERTAS",
    async () => {
      // A mensagem antiga mandava configurar BUILT_IN_FORGE_API_URL — variável
      // errada, que ainda era fallback do endpoint de LLM: seguir a mensagem
      // quebrava duas coisas. A nova nomeia STORAGE_*.
      await expect(storagePut("x/y.txt", "conteudo")).rejects.toThrow(/STORAGE_BUCKET/);
      await expect(storagePut("x/y.txt", "conteudo")).rejects.not.toThrow(/FORGE/);
    },
  );
});
