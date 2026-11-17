import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Button, Input, Text } from "barte-design-system";
import type { Tone } from "./tone";

export interface DecisionOption<T extends string> {
  value: T;
  label: ReactNode;
  tone?: Tone;
  /** Uma linha menor sob o rótulo ("Proposta do sistema"). (#53) */
  description?: ReactNode;
  /** A observação passa a ser obrigatória nesta opção. (#53) */
  noteRequired?: boolean;
  /** O texto do botão enquanto esta opção está marcada. (#53) */
  submitLabel?: string;
}

/** Os textos do formulário; `done: null` esconde o "registrada" (quem usa já troca a tela). */
export interface DecisionFormTexts {
  noteLabel: string;
  submit: string;
  submitting: string;
  choose: string;
  noteRequired: string;
  failed: string;
  done: string | null;
}

export interface DecisionFormProps<T extends string> {
  options: readonly DecisionOption<T>[];
  onSubmit: (decision: { value: T; note: string }) => void | Promise<unknown>;
  /** Opção já marcada ao abrir. Padrão: nenhuma, para a decisão ser sempre um gesto explícito. (#53) */
  defaultValue?: T;
  /** Opção marcada, controlada por fora. Sem ela, o formulário guarda a escolha (`defaultValue`). (#53) */
  value?: T;
  /** Avisa a opção que a pessoa marcou, controlada ou não. (#53) */
  onValueChange?: (value: T) => void;
  /** Conteúdo que depende da opção: depois da mensagem de erro e antes da observação, como no kit real. (#53) */
  children?: ReactNode;
  /** Desabilita só o botão de registrar. (#53) */
  submitDisabled?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  submitting?: boolean;
  error?: string;
  minNoteLength?: number;
  maxNoteLength?: number;
  disabled?: boolean;
  texts?: { [K in keyof DecisionFormTexts]?: DecisionFormTexts[K] };
  className?: string;
}

const DEFAULT_TEXTS: DecisionFormTexts = {
  noteLabel: "Observação",
  submit: "Registrar",
  submitting: "Enviando…",
  choose: "Escolha uma opção.",
  noteRequired: "Explique a decisão para registrá-la.",
  failed: "Não foi possível registrar a decisão. Tente de novo.",
  done: "Decisão registrada.",
};

/**
 * Registrar uma decisão (aprovar, devolver, recusar…): as opções vêm por prop com o tom de cada uma, e a observação
 * passa a ser obrigatória nas que pedem justificativa. Cuida do "enviando", do erro e do "registrada". Mesmas props
 * do kit real, com as quatro que o patch `patches/@barte-ai-services+barte-ui-kit+0.2.0.patch` lhe dá.
 */
export function DecisionForm<T extends string>({
  options,
  onSubmit,
  defaultValue,
  value,
  onValueChange,
  children,
  submitDisabled,
  title,
  description,
  submitting: submittingProp,
  error: errorProp,
  minNoteLength = 1,
  maxNoteLength,
  disabled,
  texts,
  className,
}: DecisionFormProps<T>): ReactElement {
  const t = { ...DEFAULT_TEXTS, ...texts };
  const id = useId();
  const [inner, setInner] = useState<T | undefined>(defaultValue);
  const [note, setNote] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const current = value !== undefined ? value : inner;
  const selected = options.find((o) => o.value === current);
  const busy = Boolean(submittingProp) || sending;
  const locked = Boolean(disabled) || busy;

  const problem = !selected ? t.choose : selected.noteRequired && note.trim().length < minNoteLength ? t.noteRequired : null;
  const shown = (attempted ? problem : null) ?? failure ?? errorProp ?? null;

  const choose = (index: number) => {
    const option = options[index];
    if (!option || locked) return;
    radios.current[index]?.focus();
    setInner(option.value);
    onValueChange?.(option.value);
    setFailure(null);
    setDone(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    choose((index + step + options.length) % options.length);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (problem || !selected || locked) return;
    setSending(true);
    setFailure(null);
    try {
      await onSubmit({ value: selected.value, note: note.trim() });
      setDone(true);
    } catch (error: unknown) {
      setFailure(error instanceof Error && error.message ? error.message : t.failed);
    } finally {
      setSending(false);
    }
  };

  const focusable = Math.max(0, options.findIndex((o) => o.value === current));

  return (
    <form className={`bk-decision${className ? ` ${className}` : ""}`} onSubmit={submit} noValidate>
      {title ? <h3 id={`${id}-title`} className="bk-decision__title">{title}</h3> : null}
      {description ? <p className="bk-decision__description">{description}</p> : null}
      <div role="radiogroup" aria-labelledby={title ? `${id}-title` : undefined} className="bk-decision__options">
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={(el) => {
              radios.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={option.value === current}
            disabled={locked}
            tabIndex={index === focusable ? 0 : -1}
            className={`bk-decision__option bk-decision__option--${option.tone ?? "neutral"}`}
            onClick={() => choose(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <span className="bk-decision__label">{option.label}</span>
            {option.description ? <span className="bk-decision__hint">{option.description}</span> : null}
          </button>
        ))}
      </div>
      {shown ? (
        <Text as="p" variant="body-sm" color="var(--accent-red)" role="alert">
          {shown}
        </Text>
      ) : null}
      {children}
      <Input
        type="textarea"
        label={t.noteLabel}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        disabled={locked}
        {...(maxNoteLength ? { maxLength: maxNoteLength } : {})}
      />
      {done && t.done ? (
        <Text as="p" variant="body-sm" color="var(--accent-green)" role="status">
          {t.done}
        </Text>
      ) : null}
      <div className="bk-decision__actions">
        <Button type="submit" size="sm" loading={busy} disabled={Boolean(disabled) || Boolean(submitDisabled)}>
          {selected?.submitLabel ?? t.submit}
        </Button>
      </div>
    </form>
  );
}
