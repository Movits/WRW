import { describe, expect, it } from "vitest";
import { destinoDaFonte } from "./destino-da-fonte";

/**
 * O "Abrir fonte" da Memória. Os documentos de reunião indexados antes de esta
 * mudança entrar no ar guardam o href da lista (/meetings); o detalhe se abre
 * pelo meetingId, que todos eles têm.
 */
describe("destinoDaFonte", () => {
  it("reunião abre o próprio detalhe, mesmo com o href antigo da lista", () => {
    expect(destinoDaFonte({ sourceType: "meeting", metadata: { href: "/meetings", meetingId: "m-1" } })).toBe("/meetings/m-1");
  });

  it("reunião sem meetingId segue o href gravado", () => {
    expect(destinoDaFonte({ sourceType: "meeting", metadata: { href: "/meetings" } })).toBe("/meetings");
  });

  it("contato e contexto seguem o href gravado", () => {
    expect(destinoDaFonte({ sourceType: "contact", metadata: { href: "/network", contactId: 3 } })).toBe("/network");
    expect(destinoDaFonte({ sourceType: "context", metadata: { href: "/contexts", contextId: "c-1" } })).toBe("/contexts");
  });

  it("sem href nem meetingId, não há para onde abrir", () => {
    expect(destinoDaFonte({ sourceType: "contact", metadata: {} })).toBeNull();
    expect(destinoDaFonte({ sourceType: "meeting", metadata: { href: 7, meetingId: "" } })).toBeNull();
  });
});
