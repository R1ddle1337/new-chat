'use client';

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

const mobileBreakpointPx = 980;

function detectCoarsePointerPreference(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return (
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(hover: none) and (pointer: coarse)').matches
  );
}

function detectBottomSheetPreference(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const pointerCoarse = detectCoarsePointerPreference();
  const narrow = window.matchMedia(`(max-width: ${mobileBreakpointPx}px)`).matches;
  return pointerCoarse || narrow;
}

function detectBottomSheetPreferenceAtOpen(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return detectCoarsePointerPreference() || window.innerWidth <= mobileBreakpointPx;
}

export type ModelPickerOption = {
  id: string;
  display_name?: string | null;
};

type ModelPickerProps = {
  options: ModelPickerOption[];
  value: string;
  onChange: (nextModelId: string) => void;
  disabled?: boolean;
};

function getPrimaryLabel(option: ModelPickerOption): string {
  const displayName = option.display_name?.trim();
  return displayName || option.id;
}

function getSecondaryLabel(option: ModelPickerOption): string | null {
  const displayName = option.display_name?.trim();
  return displayName ? option.id : null;
}

function ModelPickerComponent({ options, value, onChange, disabled = false }: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [useBottomSheet, setUseBottomSheet] = useState(() => detectBottomSheetPreference());
  const [hasCoarsePointer, setHasCoarsePointer] = useState(() => detectCoarsePointerPreference());
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);

  const listboxId = useId();
  const searchInputId = `${listboxId}-search`;

  const hasOptions = options.length > 0;
  const isDisabled = disabled || !hasOptions;

  const selectedOption = useMemo(() => {
    return options.find((option) => option.id === value) ?? null;
  }, [options, value]);

  const selectedLabel = selectedOption
    ? getPrimaryLabel(selectedOption)
    : hasOptions
      ? getPrimaryLabel(options[0]!)
      : 'No allowed models';

  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return options;
    }

    return options.filter((option) => {
      const displayName = option.display_name?.trim().toLowerCase() ?? '';
      return option.id.toLowerCase().includes(query) || displayName.includes(query);
    });
  }, [options, search]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const narrowQuery = window.matchMedia(`(max-width: ${mobileBreakpointPx}px)`);
    const pointerCoarseQuery = window.matchMedia('(pointer: coarse)');
    const hoverNoneAndPointerCoarseQuery = window.matchMedia('(hover: none) and (pointer: coarse)');

    const syncUseBottomSheet = () => {
      const pointerCoarse =
        pointerCoarseQuery.matches || hoverNoneAndPointerCoarseQuery.matches;
      setHasCoarsePointer(pointerCoarse);
      setUseBottomSheet(pointerCoarse || narrowQuery.matches);
    };

    const addMediaListener = (query: MediaQueryList, listener: () => void) => {
      if (typeof query.addEventListener === 'function') {
        query.addEventListener('change', listener);
        return;
      }

      query.addListener(listener);
    };

    const removeMediaListener = (query: MediaQueryList, listener: () => void) => {
      if (typeof query.removeEventListener === 'function') {
        query.removeEventListener('change', listener);
        return;
      }

      query.removeListener(listener);
    };

    syncUseBottomSheet();

    addMediaListener(narrowQuery, syncUseBottomSheet);
    addMediaListener(pointerCoarseQuery, syncUseBottomSheet);
    addMediaListener(hoverNoneAndPointerCoarseQuery, syncUseBottomSheet);

    return () => {
      removeMediaListener(narrowQuery, syncUseBottomSheet);
      removeMediaListener(pointerCoarseQuery, syncUseBottomSheet);
      removeMediaListener(hoverNoneAndPointerCoarseQuery, syncUseBottomSheet);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSearch('');
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) {
        return;
      }

      if (rootRef.current?.contains(event.target)) {
        return;
      }

      setIsOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isDisabled && isOpen) {
      setIsOpen(false);
    }
  }, [isDisabled, isOpen]);

  useEffect(() => {
    if (!isOpen || filteredOptions.length === 0) {
      setActiveIndex(0);
      return;
    }

    const selectedIndex = filteredOptions.findIndex((option) => option.id === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [filteredOptions, isOpen, value]);

  useEffect(() => {
    if (!isOpen || filteredOptions.length === 0) {
      return;
    }

    const activeElement = optionsRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    );
    activeElement?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filteredOptions.length, isOpen]);

  useEffect(() => {
    if (!isOpen || !(useBottomSheet || hasCoarsePointer)) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [hasCoarsePointer, isOpen, useBottomSheet]);

  const handleTriggerClick = useCallback(() => {
    if (isDisabled) {
      return;
    }

    if (!isOpen) {
      setHasCoarsePointer(detectCoarsePointerPreference());
      setUseBottomSheet(detectBottomSheetPreferenceAtOpen());
    }

    setIsOpen((current) => !current);
  }, [isDisabled, isOpen]);

  const closePicker = useCallback((focusTrigger: boolean) => {
    setIsOpen(false);
    if (focusTrigger) {
      triggerRef.current?.focus();
    }
  }, []);

  const selectByIndex = useCallback(
    (index: number) => {
      const targetOption = filteredOptions[index];
      if (!targetOption) {
        return;
      }

      onChange(targetOption.id);
      closePicker(true);
    },
    [closePicker, filteredOptions, onChange],
  );

  const moveActive = useCallback(
    (delta: 1 | -1) => {
      if (filteredOptions.length === 0) {
        return;
      }

      setActiveIndex((current) => {
        const next = current + delta;
        if (next < 0) {
          return filteredOptions.length - 1;
        }
        if (next >= filteredOptions.length) {
          return 0;
        }
        return next;
      });
    },
    [filteredOptions.length],
  );

  const handlePanelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(1);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(-1);
        return;
      }

      if (event.key === 'Home') {
        if (filteredOptions.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex(0);
        return;
      }

      if (event.key === 'End') {
        if (filteredOptions.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex(filteredOptions.length - 1);
        return;
      }

      if (event.key === 'Enter') {
        if (filteredOptions.length === 0) {
          return;
        }
        event.preventDefault();
        selectByIndex(activeIndex);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker(true);
        return;
      }

      if (event.key === 'Tab') {
        setIsOpen(false);
      }
    },
    [activeIndex, closePicker, filteredOptions.length, moveActive, selectByIndex],
  );

  const activeOptionId =
    filteredOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const shouldRenderBottomSheet = useBottomSheet || (isOpen && hasCoarsePointer);

  const optionsPanel = (
    <div className="chat-model-panel" onKeyDown={handlePanelKeyDown}>
      <label className="sr-only" htmlFor={searchInputId}>
        Search models
      </label>
      <input
        id={searchInputId}
        ref={searchInputRef}
        className="chat-model-search"
        type="text"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search models"
        autoComplete="off"
        spellCheck={false}
        aria-label="Search models"
      />

      <div
        ref={optionsRef}
        className="chat-model-options"
        role="listbox"
        id={listboxId}
        aria-label="Allowed models"
        aria-activedescendant={activeOptionId}
      >
        {filteredOptions.length === 0 ? (
          <p className="chat-model-empty">No models found</p>
        ) : (
          filteredOptions.map((option, index) => {
            const isSelected = option.id === value;
            const isActive = index === activeIndex;
            const primaryLabel = getPrimaryLabel(option);
            const secondaryLabel = getSecondaryLabel(option);

            return (
              <button
                key={option.id}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-option-index={index}
                className={`chat-model-option${isSelected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onClick={() => selectByIndex(index)}
              >
                <span className="chat-model-option-text">
                  <span className="chat-model-option-primary">{primaryLabel}</span>
                  {secondaryLabel ? (
                    <span className="chat-model-option-secondary">{secondaryLabel}</span>
                  ) : null}
                </span>
                {isSelected ? (
                  <span className="chat-model-option-check" aria-hidden="true">
                    <svg viewBox="0 0 16 16">
                      <path d="m3.5 8.2 2.6 2.8 6.2-6.2" />
                    </svg>
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <div className="chat-model-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`chat-model-pill${isOpen ? ' is-open' : ''}`}
        onClick={handleTriggerClick}
        disabled={isDisabled}
        aria-label="Select model"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
      >
        <span className="chat-model-pill-label" title={selectedLabel}>
          {selectedLabel}
        </span>
        <span className="chat-model-pill-chevron" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="m6 8 4 4 4-4" />
          </svg>
        </span>
      </button>

      {isOpen ? (
        shouldRenderBottomSheet ? (
          <>
            <button
              type="button"
              className="chat-model-sheet-backdrop"
              onClick={() => closePicker(true)}
              aria-label="Close model picker"
            />
            <section
              className="chat-model-sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Select model"
            >
              <header className="chat-model-sheet-header">
                <strong>Select model</strong>
                <button
                  type="button"
                  className="chat-model-sheet-close"
                  onClick={() => closePicker(true)}
                >
                  Done
                </button>
              </header>
              {optionsPanel}
            </section>
          </>
        ) : (
          <div className="chat-model-popover">{optionsPanel}</div>
        )
      ) : null}
    </div>
  );
}

const ModelPicker = memo(ModelPickerComponent);

ModelPicker.displayName = 'ModelPicker';

export default ModelPicker;
