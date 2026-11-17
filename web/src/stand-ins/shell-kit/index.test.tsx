import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONTEXT_VERSION, ShellFrame, ShellIcon, type ShellContext } from "./index";

const CONTEXT: ShellContext = {
  version: CONTEXT_VERSION,
  user: { id: "u1", name: "Aluna da Já Chegou", email: null, roles: [] },
  brand: { name: "Já Chegou", product: "Contas a pagar", logo: null },
  navigation: [
    {
      key: "pagar",
      label: "Contas a pagar",
      items: [
        { key: "fila", label: "Fila de aprovação", href: "/pagar/fila", icon: "list-checks" },
        { key: "hoje", label: "Lista do dia", href: "/pagar/hoje" },
      ],
    },
  ],
  account_menu: [],
  administration: [],
  home: "/pagar/fila",
  theme: "dark",
  account: null,
  sidebar: "expanded",
};

describe("#53/AC-2 ShellFrame, o substituto da moldura do Shell", () => {
  it("#53/AC-2: mostra a marca como link para a página inicial, a pessoa, e a tela numa área principal", () => {
    render(<ShellFrame context={CONTEXT} zone="pagar"><p>Tela</p></ShellFrame>);
    const brand = screen.getByRole("link", { name: /Já Chegou/ });
    expect(brand.getAttribute("href")).toBe("/pagar/fila");
    expect(brand.textContent).toContain("Contas a pagar");
    expect(screen.getByText("Aluna da Já Chegou")).toBeTruthy();
    expect(within(screen.getByRole("main")).getByText("Tela")).toBeTruthy();
  });

  it("#53/AC-2: o menu é uma navegação com nome, um link por item, e marca a página atual", () => {
    window.history.replaceState(null, "", "/pagar/fila/35261100");
    render(<ShellFrame context={CONTEXT} zone="pagar" />);
    const nav = screen.getByRole("navigation", { name: "Menu" });
    expect(within(nav).getByText("Contas a pagar")).toBeTruthy();
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Fila de aprovação", "Lista do dia"]);
    expect(within(nav).getByRole("link", { name: "Fila de aprovação" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Lista do dia" }).hasAttribute("aria-current")).toBe(false);
  });

  it("#53/AC-2: a zone e o tema vão para a moldura", () => {
    const { container } = render(<ShellFrame context={CONTEXT} zone="pagar" />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.getAttribute("data-zone")).toBe("pagar");
    expect(frame.getAttribute("data-theme")).toBe("dark");
  });

  it("#53/AC-2: o ícone do registro some do leitor de tela, e o nome que falta não desenha nada", () => {
    const { container, rerender } = render(<ShellIcon name="calendar" />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    rerender(<ShellIcon name="nao-existe" />);
    expect(container.querySelector("svg")).toBeNull();
    rerender(<ShellIcon name={undefined} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
