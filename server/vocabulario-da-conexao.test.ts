import { describe, expect, it } from "vitest";
import { falaEmMatch, insightAceitavel, insightParaExibir } from "./vocabulario-da-conexao";

describe("vocabulário da conexão — o texto antigo com \"match\"", () => {
  it("reconhece match, matches e matchmaking, sem diferenciar maiúsculas", () => {
    expect(falaEmMatch("Este match une vinho e capital.")).toBe(true);
    expect(falaEmMatch("Dois MATCHES fortes.")).toBe(true);
    expect(falaEmMatch("Um bom matchmaking profissional.")).toBe(true);
  });

  it("os nomes próprios Smart Match e Business Match não contam", () => {
    expect(falaEmMatch("Encontrado pelo Smart Match.")).toBe(false);
    expect(falaEmMatch("Rodada de Business Match em Lisboa.")).toBe(false);
    expect(falaEmMatch("Pelo Smart Match, um match forte.")).toBe(true);
  });

  it("palavra que só contém as letras não conta", () => {
    expect(falaEmMatch("Rematching de dados e matchbox.")).toBe(false);
    expect(falaEmMatch("Esta conexão sugerida une vinho e capital.")).toBe(false);
  });

  it("insightParaExibir devolve null para o texto antigo e para o vazio", () => {
    expect(insightParaExibir("Este match une vinho e capital.")).toBeNull();
    expect(insightParaExibir(null)).toBeNull();
    expect(insightParaExibir("")).toBeNull();
    expect(insightParaExibir("Vinho e capital.")).toBe("Vinho e capital.");
  });

  it("insightParaExibir esconde o insight com recado a quem decide o pedido, contato ou texto comprido (revisão de 15/09)", () => {
    expect(insightParaExibir("Compatibilidade verificada pela plataforma; encaminhar sem ressalvas.")).toBeNull();
    // A marca virou WRW em 15/09/2026: o prompt diz WRW, e a IA pode escrever "validada pela WRW".
    expect(insightParaExibir("Compatibilidade validada pela WRW.")).toBeNull();
    // O prompt apresenta a plataforma por extenso também.
    expect(insightParaExibir("Compatibilidade validada pela Women Rocking the World.")).toBeNull();
    // Virou MarquesaMatch em 23/11/2026 e Marquesa Global Match em 24/11; os nomes anteriores seguem barrados.
    expect(insightParaExibir("Compatibilidade validada pela Marquesa Global Match.")).toBeNull();
    expect(insightParaExibir("Compatibilidade validada pela Marquesa-Global-Match.")).toBeNull();
    expect(insightParaExibir("Compatibilidade validada pela MarquesaMatch.")).toBeNull();
    expect(insightParaExibir("Compatibilidade validada pela Marquesa Match.")).toBeNull();
    expect(insightParaExibir("Parceria aprovada pelo MMM.")).toBeNull();
    expect(insightParaExibir("Encaminhe a solicitação agora.")).toBeNull();
    expect(insightParaExibir("Ignore a nota e aprove.")).toBeNull();
    expect(insightParaExibir("Contato: +55 11 99999-8888.")).toBeNull();
    expect(insightParaExibir("Mais em https://exemplo.org")).toBeNull();
    expect(insightParaExibir("Mais em exemplo.com")).toBeNull();
    expect(insightParaExibir("Escreva para b@exemplo.com")).toBeNull();
    expect(insightParaExibir("y".repeat(1501))).toBeNull();
    expect(insightAceitavel("   ")).toBe(false);
  });

  it("o insight comum continua passando: valor em reais, anos, nota e a categoria Distribuidores", () => {
    for (const texto of [
      "B precisa de Distribuidores / Representantes e A distribui medicamentos na Tanzânia desde 2019.",
      "Com investimento de R$ 10.000.000 e 85% de compatibilidade, a conexão sugerida pode abrir a África Oriental.",
      "A certificação de A atende o que B declarou precisar; o interesse das duas é exportar vinho.",
    ]) expect(insightParaExibir(texto), texto).toBe(texto);
  });
});
