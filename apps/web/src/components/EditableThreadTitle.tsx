import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { cn } from "~/lib/utils";

interface EditableThreadTitleProps {
  value: string;
  onCommit: (nextValue: string, previousValue: string) => Promise<void> | void;
  disabled?: boolean;
  startEditingSignal?: string | number | null;
  className?: string;
  buttonClassName?: string;
  inputClassName?: string;
  preventParentInteraction?: boolean;
  title?: string;
}

export function EditableThreadTitle(props: EditableThreadTitleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(props.value);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastStartEditingSignalRef = useRef(props.startEditingSignal);

  useEffect(() => {
    if (!isEditing) {
      setDraftValue(props.value);
    }
  }, [isEditing, props.value]);

  useEffect(() => {
    if (
      props.startEditingSignal !== undefined &&
      props.startEditingSignal !== null &&
      props.startEditingSignal !== lastStartEditingSignalRef.current
    ) {
      setDraftValue(props.value);
      setIsEditing(true);
    }
    lastStartEditingSignalRef.current = props.startEditingSignal;
  }, [props.startEditingSignal, props.value]);

  useEffect(() => {
    if (!isEditing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [isEditing]);

  const stopParentInteraction = (event: ReactMouseEvent<HTMLElement>) => {
    if (!props.preventParentInteraction) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const beginEditing = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (props.disabled) return;
    stopParentInteraction(event);
    setDraftValue(props.value);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setDraftValue(props.value);
    setIsEditing(false);
  };

  const commitEditing = async () => {
    const nextValue = draftValue;
    setIsEditing(false);
    await props.onCommit(nextValue, props.value);
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commitEditing();
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancelEditing();
  };

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draftValue}
        onChange={(event) => setDraftValue(event.target.value)}
        onKeyDown={onInputKeyDown}
        onBlur={() => {
          void commitEditing();
        }}
        onClick={(event) => {
          if (!props.preventParentInteraction) return;
          event.stopPropagation();
        }}
        className={cn(
          "min-w-0 border border-ring rounded bg-transparent px-1 py-0.5 outline-none",
          props.inputClassName,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      disabled={props.disabled}
      className={cn("min-w-0 truncate text-left", props.buttonClassName)}
      onMouseDown={(event) => {
        if (!props.preventParentInteraction) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={beginEditing}
      title={props.title ?? props.value}
    >
      <span className={cn("truncate", props.className)}>{props.value}</span>
    </button>
  );
}
