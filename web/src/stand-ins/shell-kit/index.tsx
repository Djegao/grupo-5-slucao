/**
 * O substituto local de `@barte-ai-services/shell-kit` (0.1.0-rc.25.1), pacote privado do GitHub Packages que este
 * fork não lê (#53). O `vite.config.ts` e o `tsconfig.json` apontam para cá só quando o pacote real não está
 * instalado. A moldura aqui é uma barra lateral com o menu e a área da tela; o Shell de verdade desenha mais
 * (conta, administração, recolher a barra), que a tela não usa.
 */
import type { ComponentType, ReactElement, ReactNode } from "react";
import { Buildings, Calendar, ChartBar, GearSix, House, ListChecks, Receipt, Truck, type IconProps } from "@phosphor-icons/react";
import { Link, usePathname } from "../../router";

/** A versão do contexto que o Shell entrega; o `fetchShellContext` recusa outra. */
export const CONTEXT_VERSION = 1 as const;

export interface NavItem {
  key: string;
  label: string;
  href: string;
  /** A zone do Shell dona do caminho. */
  zone?: string;
  /** O nome de um ícone do registro (`ShellIcon`). */
  icon?: string;
}

export interface NavGroup {
  key: string;
  label: string;
  items: NavItem[];
}

export interface ShellUser {
  id: string;
  name: string;
  email: string | null;
  roles: string[];
}

export interface ShellBrand {
  name: string;
  product: string;
  logo: string | null;
}

export interface ShellContext {
  version: typeof CONTEXT_VERSION;
  user: ShellUser;
  brand: ShellBrand;
  navigation: NavGroup[];
  account_menu: NavItem[];
  administration: NavItem[];
  home: string;
  theme: "light" | "dark";
  account: { id: string; name: string } | null;
  sidebar: "expanded" | "collapsed";
}

/** O registro de ícones: o Shell só desenha o que está aqui, e o nome que falta deixa o item sem ícone. */
const ICONS: Record<string, ComponentType<IconProps>> = {
  "list-checks": ListChecks,
  calendar: Calendar,
  receipt: Receipt,
  "chart-bar": ChartBar,
  truck: Truck,
  buildings: Buildings,
  house: House,
  gear: GearSix,
};

export function ShellIcon({ name, size = 20 }: { name: string | undefined; size?: number }): ReactElement | null {
  const Icon = name ? ICONS[name] : undefined;
  return Icon ? <Icon size={size} aria-hidden="true" /> : null;
}

function Menu({ group, current }: { group: NavGroup; current: string }): ReactElement {
  return (
    <div className="sk-group">
      <p className="sk-group__label">{group.label}</p>
      <ul className="sk-group__items">
        {group.items.map((item) => {
          const active = current === item.href || current.startsWith(`${item.href}/`);
          return (
            <li key={item.key}>
              <Link href={item.href} className="sk-item" {...(active ? { "aria-current": "page" as const } : {})}>
                <ShellIcon name={item.icon} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface ShellFrameProps {
  context: ShellContext;
  /** A zone desta tela no Shell. */
  zone: string;
  children?: ReactNode;
}

/** A moldura: o menu à esquerda, a pessoa e a marca, e a tela na área principal. */
export function ShellFrame({ context, zone, children }: ShellFrameProps): ReactElement {
  const current = usePathname();
  return (
    <div className="sk-frame" data-zone={zone} data-theme={context.theme}>
      <aside className="sk-sidebar">
        <a className="sk-brand" href={context.home}>
          <span className="sk-brand__name">{context.brand.name}</span>
          <span className="sk-brand__product">{context.brand.product}</span>
        </a>
        <nav aria-label="Menu" className="sk-nav">
          {context.navigation.map((group) => (
            <Menu key={group.key} group={group} current={current} />
          ))}
        </nav>
        <p className="sk-user">{context.user.name}</p>
      </aside>
      <main className="sk-main">{children}</main>
    </div>
  );
}
