import { afterEach, describe, expect, it } from "vitest";
import { rotasNaBarraDoApp } from "./barra-do-app";

type JanelaDoApp = Window & { __wrwRotasDaBarraDoApp?: unknown };

afterEach(() => {
  delete (window as JanelaDoApp).__wrwRotasDaBarraDoApp;
});

describe("rotasNaBarraDoApp", () => {
  it("no navegador (sem o app), não há rota na barra", () => {
    expect(rotasNaBarraDoApp()).toEqual([]);
  });

  it("dentro do app, devolve as rotas que o app gravou", () => {
    (window as JanelaDoApp).__wrwRotasDaBarraDoApp = ["/dashboard", "/network", "/meetings", "/opportunities", "/agenda"];
    expect(rotasNaBarraDoApp()).toEqual(["/dashboard", "/network", "/meetings", "/opportunities", "/agenda"]);
  });

  it("ignora o que não é lista de rotas", () => {
    (window as JanelaDoApp).__wrwRotasDaBarraDoApp = "/meetings";
    expect(rotasNaBarraDoApp()).toEqual([]);
    (window as JanelaDoApp).__wrwRotasDaBarraDoApp = ["/meetings", 7, null, "https://outro.site/x", "agenda"];
    expect(rotasNaBarraDoApp()).toEqual(["/meetings"]);
  });
});
