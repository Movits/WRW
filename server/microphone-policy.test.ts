import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Política de microfone para reuniões", () => {
  const serverSource = fs.readFileSync(path.resolve(process.cwd(), "server/_core/index.ts"), "utf8");

  it("permite microfone somente para o próprio domínio", () => {
    expect(serverSource).toContain("microphone=(self)");
    expect(serverSource).not.toContain("microphone=*");
  });

  it("o envio único saiu (G14, parte 2): o áudio de reunião não tem mais o limite ampliado do JSON, e o global segue em 5 MB", () => {
    expect(serverSource).not.toContain("meetings.submitRecording");
    expect(serverSource).toContain('app.use(express.json({ limit: "5mb" }))');
  });
});
